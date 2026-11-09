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
import { createStoreSearch } from '../memory/search/store-index.ts'
import { formatHit, resolveTracks, REFUSAL_NO_QUERY } from '../memory/search/presentation.ts'
import { renderSnapshotWithStats } from '../prompt/snapshot.ts'
import { SuggestionQueue, enqueueSuggestion } from '../review/queue.ts'
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
const KEY_GATE_MESSAGE =
  'key is gated — use memory_suggest target=key with reason (direct memory add for key is CLI-only)'
const CID_REQUIRED = 'cwd is required for the project and key tracks'

function asCwd(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null
}

export function createToolHandlers(opts: HandlerOptions): ToolHandlers {
  const store = new MaestroMemoryStore(opts.root)
  const search = createStoreSearch({ root: opts.root })
  const queue = opts.queue ?? new SuggestionQueue(suggestionsPath(opts.root))

  /** Up to three existing entries that read like the one just written. */
  function nearestNote(content: string, justAddedId: string): string {
    try {
      const hits = search.query(content.slice(0, 200), { cwd: null, tracks: ['memory', 'user'], limit: 3 })
      const others = hits.filter((hit) => hit.id !== justAddedId)
      return others.map(formatHit).join('\n')
    } catch {
      return ''
    }
  }

  return {
    search(args) {
      const cwd = asCwd(args.cwd)
      const tracks = resolveTracks(typeof args.tracks === 'string' ? args.tracks : undefined, cwd !== null)
      if (!Array.isArray(tracks)) return { text: tracks.error }
      const id = typeof args.id === 'string' ? args.id.trim() : ''
      if (id) return { text: search.open(id, { cwd, tracks }) ?? `not found: ${id}` }
      const query = typeof args.query === 'string' ? args.query.trim() : ''
      if (!query) return { text: REFUSAL_NO_QUERY }
      const limit = Number.isFinite(Number(args.limit)) ? Number(args.limit) : undefined
      const hits = search.query(query, { cwd, tracks, limit })
      if (!hits.length) return { text: `no match for ${JSON.stringify(query)}` }
      if (args.full === true) {
        return { text: hits.map((hit) => `${formatHit(hit)}\n${search.open(hit.id, { cwd, tracks }) ?? ''}`).join('\n') }
      }
      return { text: hits.map(formatHit).join('\n') }
    },

    context(args) {
      const cwd = asCwd(args.cwd)
      const branch = typeof args.branch === 'string' && args.branch.trim() ? args.branch.trim() : undefined
      // No session fields on purpose: this text must never trigger the USER.md
      // bootstrap write that a DSH session performs on its first turn.
      const rendered = renderSnapshotWithStats(store, { cwd, branch })
      return { text: rendered.text }
    },

    list(args) {
      const target = String(args.target ?? '').trim()
      if (!ADD_TARGETS.has(target)) return { text: `unknown target ${target}` }
      const cwd = asCwd(args.cwd)
      if ((target === 'project' || target === 'key') && !cwd) return { text: CID_REQUIRED }
      const listOpts: Record<string, unknown> = {}
      if (typeof args.filter === 'string' && args.filter.trim()) listOpts.filter = args.filter.trim()
      if (Number.isFinite(Number(args.limit))) listOpts.limit = Number(args.limit)
      if (args.recent === true) listOpts.recent = true
      if (typeof args.date === 'string' && args.date.trim()) listOpts.date = args.date.trim()
      const entries = store.list(target as any, cwd ?? undefined, listOpts as any)
      return { text: entries.length ? entries.join('\n---\n') : 'no entries' }
    },

    add(args) {
      const target = String(args.target ?? '').trim()
      if (!ADD_TARGETS.has(target)) return { text: `unknown target ${target}` }
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      if (!content) return { text: 'empty content' }
      const cwd = asCwd(args.cwd)
      // A foreign agent never writes key directly: it goes through the same queue
      // a DSH model uses, so a human still approves the long-lived track.
      if (target === 'key') return { text: KEY_GATE_MESSAGE }
      if (target === 'project' && !cwd) return { text: CID_REQUIRED }
      const addOpts: Record<string, unknown> = {}
      if (typeof args.summary === 'string' && args.summary.trim()) addOpts.summary = args.summary.trim()
      if (typeof args.branches === 'string' && args.branches.trim()) addOpts.branches = args.branches.trim()
      if (typeof args.date === 'string' && args.date.trim()) addOpts.date = args.date.trim()
      const res = store.add(target as any, content, cwd ?? undefined, addOpts as any)
      if (!res.ok) return { text: `add failed: ${res.error}` }
      if ((res as any).duplicate) return { text: 'duplicate: an identical entry already exists' }
      const head = `added ${(res as any).id ?? ''}`.trim()
      // add() dedupes only on an identical body, so several agents slowly collect
      // variants of one rule until they crowd the text the prompt can show. Showing
      // what already looks like it, at write time, is cheaper than a similarity gate
      // and still lets the write through.
      const similar = nearestNote(content, (res as any).id ?? '')
      return { text: similar ? `${head}\nsimilar:\n${similar}` : head }
    },

    suggest(args) {
      const target = String(args.target ?? '').trim()
      const content = typeof args.content === 'string' ? args.content.trim() : ''
      const reason = typeof args.reason === 'string' ? args.reason.trim() : ''
      if (!content) return { text: 'empty content' }
      if (!reason) return { text: 'empty reason' }
      // A key suggestion queued without a cwd is re-homed to the approver's own
      // session on approval, or fails forever, so it is refused up front.
      if (target === 'key' && !asCwd(args.cwd)) {
        return { text: 'cwd is required for a key suggestion (the entry belongs to a project)' }
      }
      const res = enqueueSuggestion(queue, target, content, reason)
      if (!res.ok) return { text: res.message ?? 'failed' }
      return { text: (res as any).hits ? `queued (deduped hits=${(res as any).hits})` : `queued (${res.queued})` }
    },
  }
}
