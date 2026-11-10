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

import { accessSync, constants as fsConstants } from 'node:fs'
import { basename } from 'node:path'
import { MaestroMemoryStore } from '../memory/store.ts'
import { renderSnapshotWithStats } from '../prompt/snapshot.ts'
import { appendEntryAtomicSync, readEntriesSync } from '../storage/atomic-store.ts'
import { dailyPath, resolveStoreRoot } from '../storage/layout.ts'

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
function asPayload(text: string): Record<string, unknown> {
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
export function parseHookArgs(
  argv: string[],
  readStdin: () => string = () => '',
): { mode: HookMode | null; payload: Record<string, unknown> } {
  const raw = argv.find((arg) => !arg.startsWith('-'))
  const mode = raw && KNOWN_MODES.includes(raw) ? (raw as HookMode) : null
  if (!mode) return { mode: null, payload: {} }
  let text = ''
  try {
    text = String(readStdin() ?? '')
  } catch (error: any) {
    debug(`stdin read failed: ${error?.message ?? error}`)
  }
  if (!text.trim()) return { mode, payload: {} }
  return { mode, payload: asPayload(text) }
}

export interface HookDeps {
  /** Test seam: stands in for the store resolver. */
  resolveRoot?: () => string
  now?: () => Date
}

export interface ModeContext {
  root: string
  now: () => Date
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
    return run(payload ?? {}, { root, now: deps.now ?? (() => new Date()) }) ?? ''
  } catch (error: any) {
    debug(`${mode} failed: ${error?.message ?? error}`)
    return ''
  }
}

/** Said once, instead of guessing which project the session belongs to. */
export const NO_CWD_NOTICE = '(no project directory in the hook payload; showing global memory only)'

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
    const text = renderSnapshotWithStats(store, { cwd }).text
    return cwd ? text : `${text}\n\n${NO_CWD_NOTICE}`
  } catch (error: any) {
    debug(`session-start render failed: ${error?.message ?? error}`)
    return ''
  }
}

RUNNERS['session-start'] = (payload, ctx) => renderSessionStart(payload, { root: ctx.root })

/** UTC on purpose: the storage layer keeps its own calendar, and a diary line
 * that printed local time in a UTC-dated file would read as the wrong day. */
function dayStamp(now: Date): string {
  const mm = String(now.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(now.getUTCDate()).padStart(2, '0')
  return `${now.getUTCFullYear()}-${mm}-${dd}`
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

/**
 * The session id, under both spellings.
 *
 * Measured on the installed harness (2.1.322): every hook payload carries
 * `session_id`, never `sessionId`. The camel case stays supported because it costs
 * one `||`, and a payload that changes spelling must not silently lose dedup.
 */
function sessionIdOf(payload: Record<string, any>): string {
  return text(payload?.session_id) || text(payload?.sessionId)
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
  const hh = String(now.getUTCHours()).padStart(2, '0')
  const mm = String(now.getUTCMinutes()).padStart(2, '0')
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
export function recordSessionEnd(payload: Record<string, any>, opts: { root: string; now?: Date }): string {
  const now = opts.now ?? new Date()
  const date = dayStamp(now)
  const line = buildSessionLine(payload, now)
  const sessionId = sessionIdOf(payload)
  try {
    const file = dailyPath(opts.root, date)
    if (sessionId) {
      const marker = `[session:${sessionId}]`
      if (readEntriesSync(file).some((entry) => entry.includes(marker))) return ''
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
