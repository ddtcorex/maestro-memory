/**
 * hook/modes.ts — what a Claude Code hook can ask this package to do.
 *
 * Two modes, both mechanical: `session-start` prints the bounded snapshot DSH
 * injects, `session-end` appends one diary line. Nothing here calls a model.
 *
 * The whole module is built to fail silently. A hook runs on every session, so a
 * throw here costs the human their session, and a wrong guess about the payload
 * costs them a wrong project. Returning `''` is always allowed; throwing is not.
 */

import { Buffer } from 'node:buffer'
import { accessSync, constants as fsConstants, existsSync } from 'node:fs'
import { basename } from 'node:path'
import { MaestroMemoryStore } from '../memory/store.ts'
import { renderSnapshotWithStats } from '../prompt/snapshot.ts'
import { appendEntryAtomicSync, readEntriesSync } from '../storage/atomic-store.ts'
import { SuggestionQueue } from '../review/queue.ts'
import { readHealth } from '../storage/health.ts'
import { dailyPath, resolveDshHome, resolveStoreRoot, suggestionsPath } from '../storage/layout.ts'

export type HookMode = 'session-start' | 'session-end'

const KNOWN_MODES: readonly string[] = ['session-start', 'session-end']

/** Diagnostics only, and only when asked: a normal run must keep stderr empty. */
export function debug(message: string): void {
  if (process.env.MAESTRO_MEMORY_DEBUG !== '1') return
  try {
    process.stderr.write(`[maestro-memory-hook] ${message}\n`)
  } catch {
    // stderr closed: nothing left to report to
  }
}

/** A payload is a JSON object; anything else (array, string, garbage) is `{}`. */
export function parsePayload(text: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>
    }
  } catch {
    // Malformed payload: the caller still gets its mode, with no fields.
  }
  return {}
}

/**
 * Split the argv and the piped payload.
 *
 * `readStdin` is a parameter, not a read of fd 0: the sync core must never block,
 * and only the bin knows whether a payload is even expected. The default returns
 * nothing, which is exactly the contract a test needs.
 */
/** The mode named on the command line, or null. Flags are skipped, not parsed. */
export function parseHookMode(argv: string[]): HookMode | null {
  const raw = argv.find((arg) => !arg.startsWith('-'))
  return raw && KNOWN_MODES.includes(raw) ? (raw as HookMode) : null
}

export function parseHookArgs(
  argv: string[],
  readStdin: () => string = () => '',
): { mode: HookMode | null; payload: Record<string, unknown> } {
  const mode = parseHookMode(argv)
  if (!mode) return { mode: null, payload: {} }
  let text = ''
  try {
    text = String(readStdin() ?? '')
  } catch (error: any) {
    debug(`stdin read failed: ${error?.message ?? error}`)
  }
  if (!text.trim()) return { mode, payload: {} }
  return { mode, payload: parsePayload(text) }
}

export interface HookDeps {
  /** Test seam: stands in for the store resolver. */
  resolveRoot?: () => string
  now?: () => Date
  /** Test seam: stands in for DSH_HOME when checking for an unmoved store. */
  dshHome?: string
}

export interface ModeContext {
  root: string
  now: () => Date
  dshHome: string
}

type ModeRunner = (payload: Record<string, any>, ctx: ModeContext) => string

/**
 * Filled in by the mode implementations below. An empty slot means "say nothing",
 * which is also what a failed run does: the caller cannot tell a disabled mode
 * from a broken one, and neither may ever stop a session.
 */
const RUNNERS: Partial<Record<HookMode, ModeRunner>> = {}

/**
 * Resolve the store, run the mode, and turn every failure into silence.
 *
 * The root is resolved through {@link resolveStoreRoot} and nowhere else: a hook
 * that derived a path of its own would write to the live store during a test or a
 * dry-boot, which is the incident the resolver exists to prevent.
 */
export function runHook(mode: HookMode, payload: Record<string, any>, deps: HookDeps = {}): string {
  const run = RUNNERS[mode]
  if (!run) return ''
  try {
    const root = deps.resolveRoot ? deps.resolveRoot() : resolveStoreRoot().root
    return run(payload ?? {}, { root, now: deps.now ?? (() => new Date()), dshHome: deps.dshHome ?? resolveDshHome() }) ?? ''
  } catch (error: any) {
    debug(`${mode} failed: ${error?.message ?? error}`)
    return ''
  }
}

/** Said once, instead of guessing which project the session belongs to. */
export const NO_CWD_NOTICE = '(no project directory in the hook payload; showing global memory only)'

/**
 * How many bytes of snapshot this hook may print.
 *
 * Measured on Claude Code 2.1.322: hook stdout of 10,000 bytes is injected as text,
 * and 11,000 bytes is written to a file with a ~2 KB preview injected instead, so
 * everything after the second section disappears from the model's view. A full store
 * renders 12 KB or more, which is exactly that failure, and it dropped the project
 * lanes a session needs. The budget stays a kilobyte below the measured limit because
 * the harness wraps the output in a system reminder.
 */
export const HOOK_MAX_BYTES = 9000

/** Caps used only when the default render does not fit, so a small store keeps the
 *  byte-for-byte parity with `memory_context` that the test above pins. */
const TIGHT_CAPS = { memory: 1024, user: 1024, key: 1536, keyIndex: 3072, recentDaily: 256, autoRecall: 512 } as const

const CLIP_MARKER = '\n[… cut to stay inside the harness hook limit; use memory_search for the rest]'

/** Cut on a character boundary and say so, rather than shipping a mangled tail. */
function clipTo(text: string, max: number): string {
  const budget = Math.max(0, max - Buffer.byteLength(CLIP_MARKER, 'utf8'))
  let out = ''
  let used = 0
  for (const ch of text) {
    const size = Buffer.byteLength(ch, 'utf8')
    if (used + size > budget) break
    out += ch
    used += size
  }
  return `${out}${CLIP_MARKER}`
}

/**
 * One line, only when the approval queue is not empty.
 *
 * Nothing else in a Claude session can see that queue, so a suggestion waits
 * forever if the human never opens the DSH Memory view. The count is the whole
 * message; the decision stays where the queue is reviewed and edited.
 */
function queueNotice(root: string): string {
  try {
    const count = new SuggestionQueue(suggestionsPath(root)).read().length
    if (count === 0) return ''
    const line =
      count === 1
        ? `1 suggestion is waiting for approval; review it in the DSH Memory view.`
        : `${count} suggestions are waiting for approval; review them in the DSH Memory view.`
    return `[maestro-memory] ${line}\n\n`
  } catch (error: any) {
    debug(`queue notice skipped: ${error?.message ?? error}`)
    return ''
  }
}

/** The largest render that still fits: full snapshot, then tighter caps, then a cut. */
function renderWithinBudget(store: MaestroMemoryStore, cwd: string | null, max: number): string {
  const full = renderSnapshotWithStats(store, { cwd, host: 'mcp' }).text
  if (Buffer.byteLength(full, 'utf8') <= max) return full
  const tight = renderSnapshotWithStats(store, { cwd, host: 'mcp' }, { caps: { ...TIGHT_CAPS } }).text
  if (Buffer.byteLength(tight, 'utf8') <= max) return tight
  return clipTo(tight, max)
}

function isReadable(root: string): boolean {
  try {
    accessSync(root, fsConstants.R_OK)
    return true
  } catch {
    return false
  }
}

/**
 * The text `SessionStart` injects: the same bounded snapshot `memory_context`
 * returns, so the two transports cannot disagree about what a project remembers.
 *
 * No cwd means no project lanes. The alternative, falling back to the process
 * working directory, would attach some other project's memory to this session
 * whenever the harness starts the hook somewhere unexpected; one notice line is
 * the cheaper, honest failure. No session fields either: this renderer must never
 * trigger the first-turn USER.md bootstrap write that a real DSH session performs.
 */
export function renderSessionStart(payload: Record<string, any>, opts: { root: string }): string {
  const raw = typeof payload?.cwd === 'string' ? payload.cwd.trim() : ''
  const cwd = raw.length > 0 ? raw : null
  if (!isReadable(opts.root)) {
    debug(`store not readable, saying nothing: ${opts.root}`)
    return ''
  }
  try {
    const store = new MaestroMemoryStore(opts.root)
    const notice = cwd ? '' : `\n\n${NO_CWD_NOTICE}`
    const pending = queueNotice(opts.root)
    const budget = HOOK_MAX_BYTES - Buffer.byteLength(notice, 'utf8') - Buffer.byteLength(pending, 'utf8')
    const text = renderWithinBudget(store, cwd, budget)
    return `${pending}${text}${notice}`
  } catch (error: any) {
    debug(`session-start render failed: ${error?.message ?? error}`)
    return ''
  }
}

RUNNERS['session-start'] = (payload, ctx) => renderSessionStart(payload, { root: ctx.root })

/**
 * The local calendar, the one the rest of the store already uses: `todayStamp()`
 * names daily files from it and the prompt's Recent Daily lane reads those names
 * back. A UTC stamp put a line in a file that nothing else ever opened, which is
 * how one local day ends up split across two files.
 */
function dayStamp(now: Date): string {
  const mm = String(now.getMonth() + 1).padStart(2, '0')
  const dd = String(now.getDate()).padStart(2, '0')
  return `${now.getFullYear()}-${mm}-${dd}`
}

/** The previous local day, for the dedup check that spans local midnight. */
function dayBefore(now: Date): string {
  return dayStamp(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1))
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The session id, under every spelling the payloads use.
 *
 * Measured on the installed harness (2.1.322): every hook payload carries
 * `session_id`, never `sessionId`. The camel case stays supported because it costs
 * one `||`. When neither is there the transcript's own file name is used: it is the
 * session's identity and the payload always carries it, so a harness that renames
 * the id field cannot silently cost one-line-per-session. No marker at all only
 * happens when the payload is empty, and then the identical line is the duplicate.
 */
function sessionIdOf(payload: Record<string, any>): string {
  const direct = text(payload?.session_id) || text(payload?.sessionId)
  if (direct) return direct
  const transcript = text(payload?.transcript_path)
  if (!transcript) return ''
  const name = basename(transcript).replace(/\.jsonl$/i, '')
  return name && name !== '.' ? name : ''
}

/** The project's own name, never the whole path: this line is not a log entry. */
function projectName(cwd: string): string {
  if (!cwd) return 'unknown'
  const trimmed = cwd.replace(/[\\/]+$/, '')
  const name = basename(trimmed)
  return name && name !== '.' ? name : 'unknown'
}

/**
 * One line, mechanically:
 * `[HH:MM] session ended · <project> · <branch> · <n> tools`
 *
 * Every field has a visible fallback, so the line is always parseable and never
 * invents a fact. When the payload carries a session id it is appended as a
 * marker: that is what makes a repeated `session-end` for one session a no-op
 * while two sessions in the same minute each get their own line.
 */
export function buildSessionLine(payload: Record<string, any>, now: Date): string {
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const cwd = text(payload?.cwd)
  const branch = text(payload?.branch) || '-'
  const raw = Number(payload?.toolCalls)
  const tools = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : 0
  const sessionId = sessionIdOf(payload)
  const marker = sessionId ? ` [session:${sessionId}]` : ''
  return `[${hh}:${mm}] session ended · ${projectName(cwd)} · ${branch} · ${tools} tools${marker}`
}

/**
 * Write the line, or write nothing.
 *
 * Runs on session end, so it returns `''` in every outcome: there is nothing to
 * print, and a hook that reported a storage error would be noise in a session
 * that already finished. The dedup check reads the day's entries and looks for
 * the session marker, never for the timestamp.
 */
export function recordSessionEnd(
  payload: Record<string, any>,
  opts: { root: string; now?: Date; dshHome?: string },
): string {
  const now = opts.now ?? new Date()
  const date = dayStamp(now)
  const line = buildSessionLine(payload, now)
  const sessionId = sessionIdOf(payload)
  try {
    // This is the only writer that runs without the boot migration. Creating the
    // new root before the legacy store has moved makes the migration find two
    // roots, and it then refuses: the store stops being served until a human
    // decides which one is live. Checked only against a home we were told about,
    // so a unit test with a scratch root cannot be skipped by machine state.
    if (opts.dshHome && !existsSync(opts.root)) {
      const legacy = readHealth({ root: opts.root, dshHome: opts.dshHome }).legacyRoot
      if (legacy) {
        debug(`no diary line: the store has not moved yet (${legacy} is still live)`)
        return ''
      }
    }
    const file = dailyPath(opts.root, date)
    if (sessionId) {
      const marker = `[session:${sessionId}]`
      // Yesterday as well: a session re-fired just after local midnight must not
      // gain a second line in the new day's file.
      const seen = [file, dailyPath(opts.root, dayBefore(now))].some((candidate) =>
        readEntriesSync(candidate).some((entry) => entry.includes(marker)),
      )
      if (seen) return ''
    }
    // Appended through the same locked writer the store uses, but without
    // `store.add`: that path tags the entry with an auto summary taken from its
    // own text, and a diary line that repeats itself in its header is not the
    // documented shape. Atomicity and duplicate detection are unchanged.
    const res = appendEntryAtomicSync(file, line)
    if (!res.ok) debug(`session-end write failed: ${res.error}`)
    else if (res.duplicate) debug('session-end line already present')
  } catch (error: any) {
    debug(`session-end failed: ${error?.message ?? error}`)
  }
  return ''
}

RUNNERS['session-end'] = (payload, ctx) => recordSessionEnd(payload, { root: ctx.root, now: ctx.now() })
