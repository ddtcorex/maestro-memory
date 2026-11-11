/**
 * mcp/tools.ts — the MCP surface as pure functions.
 *
 * The DSH binding in `src/host/index.ts` is Cordis-shaped; this layer is not. Both
 * call the same store, the same search and the same snapshot renderer, so the only
 * thing that differs between an agent inside DSH and an agent outside it is the
 * transport. Keeping the handlers pure is what lets them be tested without
 * spawning a server.
 */

import { MaestroMemoryStore } from '../memory/store.ts'
import { createStoreSearch, entryId } from '../memory/search/store-index.ts'
import { formatHits, resolveTracks, REFUSAL_NO_QUERY, REFUSAL_CWD_REQUIRED } from '../memory/search/presentation.ts'
import { renderSnapshotWithStats } from '../prompt/snapshot.ts'
import { SuggestionQueue, enqueueSuggestion, normalizeWhitespace } from '../review/queue.ts'
import { suggestionsPath } from '../storage/layout.ts'

export interface ToolResult {
  text: string
}

export interface ToolHandlers {
  search(args: Record<string, any>): ToolResult
  context(args: Record<string, any>): ToolResult
  list(args: Record<string, any>): ToolResult
  add(args: Record<string, any>): ToolResult
  suggest(args: Record<string, any>): ToolResult
}

export interface HandlerOptions {
  root: string
  /** Test seam; the queue lives under the store root by default. */
  queue?: SuggestionQueue
}

const ADD_TARGETS = new Set(['memory', 'user', 'project', 'daily', 'key'])
/**
 * How a `key` write is allowed.
 *
 * It used to point at a CLI that does not exist, so the honest path was invisible
 * and the queue was the only way in, which a Claude-only session cannot approve.
 * The gate now lives in the session: the model shows the exact entry, asks with
 * AskUserQuestion, and the call carries the human's answer. Without that answer
 * nothing is written, so a model that forgot to ask gets a refusal it can act on.
 */
const KEY_CONSENT_MESSAGE =
  'key is the long-lived track, so the human has to agree first. Show the exact entry, ask them with AskUserQuestion (write it, edit it, or skip), and only after an explicit yes call memory_add again with target=key, cwd and approved:true. When nobody is there to answer, use memory_suggest target=key with a reason instead.'

/**
 * Remove the queued suggestion that this write just satisfied.
 *
 * Matching is on the normalized body of the key track, which is the same rule the
 * queue uses for its own dedupe, so an edited suggestion is left alone and still
 * needs a decision.
 */
function dropObsoleteSuggestion(queue: SuggestionQueue, content: string): void {
  try {
    const wanted = normalizeWhitespace(content)
    // mutate writes the array it hands you, so the removal has to happen in place.
    queue.mutate((entries) => {
      for (let index = entries.length - 1; index >= 0; index--) {
        const entry = entries[index]!
        if (entry.target === 'key' && normalizeWhitespace(entry.content) === wanted) entries.splice(index, 1)
      }
    })
  } catch {
    // A queue that cannot be rewritten must not fail the write that already landed.
  }
}

function asCwd(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function createToolHandlers(opts: HandlerOptions): ToolHandlers {
  const store = new MaestroMemoryStore(opts.root)
  const search = createStoreSearch({ root: opts.root })
  const queue = opts.queue ?? new SuggestionQueue(suggestionsPath(opts.root))

  /**
   * Reads default to the process working directory.
   *
   * A foreign client usually passes no cwd, and the README tells it to call
   * `memory_context` first. Falling back to the directory the server was started in
   * is the difference between "this project has memory" and "this project is new".
   * Writes stay strict: a wrong read is recoverable, a wrong write is not.
   */
  const readCwd = (value: unknown): string => asCwd(value) ?? process.cwd()

  /** Up to three existing entries that read like the one just written. */
  function nearestNote(content: string, excludeId: string, cwd: string | null): string {
    try {
      // Include the key and project lanes when a cwd is available: those are the
      // lanes the prompt can actually be crowded out of.
      const tracks = cwd ? (['key', 'project', 'memory', 'user'] as const) : (['memory', 'user'] as const)
      const hits = search.query(content.slice(0, 200), { cwd, tracks: [...tracks], limit: 4 })
      return formatHits(hits.filter((hit) => hit.id !== excludeId).slice(0, 3))
    } catch {
      return ''
    }
  }

  return {
    search(args) {
      const cwd = readCwd(args.cwd)
      const tracks = resolveTracks(typeof args.tracks === 'string' ? args.tracks : undefined, true)
      if (!Array.isArray(tracks)) return { text: tracks.error }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id) return { text: search.open(id, { cwd, tracks }) ?? `not found: ${id}` }
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return { text: REFUSAL_NO_QUERY }
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined
      const hits = search.query(query, { cwd, tracks, limit })
      if (!hits.length) return { text: `no match for ${JSON.stringify(query)}` }
      if (args.full === true) {
        const blocks = hits
          .map((hit) => {
            const body = search.open(hit.id, { cwd, tracks })
            return body ? `${formatHits([hit])}\n${body}` : formatHits([hit])
          })
          .join('\n')
        return { text: blocks }
      }
      return { text: formatHits(hits) }
    },

    context(args) {
      const cwd = readCwd(args.cwd)
      const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined
      // No session fields on purpose: this text must never trigger the USER.md
      // bootstrap write that a DSH session performs on its first turn.
      const rendered = renderSnapshotWithStats(store, { cwd, branch, host: 'mcp' })
      return { text: rendered.text }
    },

    list(args) {
      const target = String(args.target ?? '').trim()
      if (!ADD_TARGETS.has(target)) return { text: `unknown target ${target}` }
      const cwd = readCwd(args.cwd)
      const listOpts: Record<string, unknown> = {}
      if (typeof args.filter === 'string' && args.filter.trim()) listOpts.filter = args.filter.trim()
      if (Number.isFinite(Number(args.limit))) listOpts.limit = Number(args.limit)
      if (args.recent === true) listOpts.recent = true
      if (typeof args.date === 'string' && args.date.trim()) listOpts.date = args.date.trim()
      const entries = store.list(target as any, cwd, listOpts as any)
      return { text: entries.length ? entries.join('\n---\n') : 'no entries' }
    },

    add(args) {
      const target = String(args.target ?? '').trim()
      if (!ADD_TARGETS.has(target)) return { text: `unknown target ${target}` }
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (!content) return { text: 'empty content' }
      const cwd = asCwd(args.cwd)
      // The long-lived track requires the human's decision, carried by the call
      // itself, and a project to belong to.
      if (target === 'key') {
        if (args.approved !== true) return { text: KEY_CONSENT_MESSAGE }
        if (!cwd) return { text: REFUSAL_CWD_REQUIRED }
      }
      if (target === 'project' && !cwd) return { text: REFUSAL_CWD_REQUIRED }
      const addOpts: Record<string, unknown> = {}
      if (typeof args.summary === 'string' && args.summary.trim()) addOpts.summary = args.summary.trim()
      if (typeof args.branches === 'string' && args.branches.trim()) addOpts.branches = args.branches.trim()
      if (typeof args.date === 'string' && args.date.trim()) addOpts.date = args.date.trim()
      const res = store.add(target as any, content, cwd ?? undefined, addOpts as any)
      if (!res.ok) return { text: `add failed: ${res.error}` }
      if (res.duplicate) {
        // Name what it collided with: the caller can then open it instead of
        // guessing which entry already exists.
        const existing = nearestNote(content, '', cwd).split('\n')[0]?.trim()
        return { text: existing ? `duplicate — not written; existing: ${existing}` : 'duplicate — not written' }
      }
      // The entry exists now, so a queued suggestion for the same rule is
      // obsolete: leaving it makes the session-start notice count a suggestion
      // for something already written, and a later approval would look like a
      // second entry.
      if (target === 'key' && res.ok && !res.duplicate) {
        dropObsoleteSuggestion(queue, content)
      }
      const id = entryId(res.entry ?? content)
      const similar = nearestNote(content, id, cwd)
      return { text: similar ? `added ${id}\nsimilar:\n${similar}` : `added ${id}` }
    },

    suggest(args) {
      const target = String(args.target ?? '').trim()
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (!content) return { text: 'empty content' }
      if (!reason) return { text: 'empty reason' }
      const cwd = asCwd(args.cwd)
      // A key suggestion queued without a cwd is re-homed to the approver's own
      // session on approval, or fails forever, so it is refused up front.
      if (target === 'key' && !cwd) {
        return { text: REFUSAL_CWD_REQUIRED }
      }
      // The queue reads the project from the caller's session header, so the cwd
      // must travel with the suggestion or the approved entry lands in the wrong
      // project.
      const agent = cwd ? { session: { header: { cwd } } } : undefined
      const res = enqueueSuggestion(queue, target, content, reason, agent)
      if (!res.ok) return { text: res.message ?? 'failed' }
      return { text: res.hits ? `queued (deduped hits=${res.hits})` : `queued (${res.queued})` }
    },
  }
}
