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
import { MaestroMemoryStore } from '../memory/store.ts'
import { renderSnapshotWithStats } from '../prompt/snapshot.ts'
import { resolveStoreRoot } from '../storage/layout.ts'

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
