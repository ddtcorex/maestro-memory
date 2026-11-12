/**
 * storage/layout.ts — path resolution for five memory files, four todo files,
 * archives, metadata, and legacy project hash.
 * Pure, no Cordis import. Uses node:path + node:crypto.
 */

import { createHash } from 'node:crypto'
import { existsSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, sep } from 'node:path'

/**
 * The DSH home directory: `DSH_HOME` when set and non-blank, else `~/.dsh`.
 *
 * This must be honoured, not inferred. A dry-boot, a test process and any
 * `DSH_HOME=…` run carry their own home on purpose; resolving `homedir()`
 * directly means such a process reaches the LIVE store. That is not theory: on
 * 2026-11-09 a dry-boot ran the boot migration against the real store because
 * this function did not exist.
 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  const raw = env?.DSH_HOME
  if (typeof raw === 'string' && raw.trim().length > 0) return raw.trim()
  return join(homedir(), '.dsh')
}

export type StoreRootMode = 'configured' | 'env' | 'isolated' | 'default'

export interface StoreRoot {
  root: string
  mode: StoreRootMode
}

function realpathOr(value: string): string {
  try {
    return realpathSync.native(value)
  } catch {
    return value
  }
}

/**
 * Resolve the canonical memories root and say how it was chosen.
 *
 * The mode is not decoration: only `default` may move a legacy store, and only
 * `default` writes markers. A test or a dry-boot that sets its own home must never
 * migrate the real store, and a caller cannot tell those apart from the path alone.
 *
 * The isolation branch exists because production sets `DSH_HOME=<home>/.dsh`, so
 * "DSH_HOME is set" cannot mean "isolated". It compares real paths instead, and both
 * sides are realpath'd so a `$HOME` reached through a symlink is not mistaken for an
 * isolated run (which would freeze the store in place forever).
 */
export function resolveStoreRoot(
  opts: { memoryDir?: string | null; env?: NodeJS.ProcessEnv; home?: string } = {},
): StoreRoot {
  if (opts.memoryDir) return { root: opts.memoryDir, mode: 'configured' }
  const env = opts.env ?? process.env
  const envDir = typeof env.MAESTRO_MEMORY_DIR === 'string' ? env.MAESTRO_MEMORY_DIR.trim() : ''
  if (envDir) return { root: envDir, mode: 'env' }

  const home = realpathOr(opts.home ?? homedir())
  const dshDefault = join(home, '.dsh')
  const rawDsh = typeof env.DSH_HOME === 'string' && env.DSH_HOME.trim() ? env.DSH_HOME.trim() : ''
  if (rawDsh && realpathOr(rawDsh) !== dshDefault) {
    return { root: join(rawDsh, 'maestro-memory'), mode: 'isolated' }
  }
  return { root: join(home, '.maestro-memory'), mode: 'default' }
}

/** Resolve just the root, for the many callers that do not care how it was chosen. */
export function resolveMemoryRoot(memoryDir: string | null | undefined): string {
  if (memoryDir) return memoryDir
  return resolveStoreRoot().root
}

/**
 * The canonical form of a project directory: the real path when it exists.
 *
 * The bucket is `sha1(cwd)`, so without this an agent launched through a symlink
 * writes to a different project than one launched on the real path, silently.
 * A path that does not exist (a stale session header) falls back to the raw
 * string rather than throwing.
 */
export function normalizeProjectCwd(cwd: string): string {
  if (!cwd) return cwd
  try {
    return realpathSync.native(cwd)
  } catch {
    return cwd
  }
}

/** 12-hex project hash for a cwd (sha1(realpath(cwd)).slice(0,12)) */
export function projectHash(cwd: string): string {
  if (!cwd) throw new Error('projectHash: cwd is required')
  return createHash('sha1').update(normalizeProjectCwd(cwd)).digest('hex').slice(0, 12)
}

/** Legacy alias — same as projectHash, explicit for spec compliance. */
export const legacyProjectHash = projectHash

export function globalMemoryPath(root: string): string {
  return join(root, 'MEMORY.md')
}
export function userMemoryPath(root: string): string {
  return join(root, 'USER.md')
}
export function globalArchivePath(root: string): string {
  return join(root, 'MEMORY-archive.md')
}
export function userArchivePath(root: string): string {
  return join(root, 'USER-archive.md')
}
export function suggestionsPath(root: string): string {
  return join(root, 'SUGGESTIONS.jsonl')
}
export function dailyDir(root: string): string {
  return join(root, 'daily')
}
/** Reject non-YYYY-MM-DD values before they are interpolated into a path (path-traversal guard). */
function assertDate(date: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error(`invalid date "${date}" (expected YYYY-MM-DD)`)
  }
}
export function dailyPath(root: string, date: string): string {
  assertDate(date)
  return join(root, 'daily', `${date}.md`)
}
export function dailyTodoPath(root: string, date: string): string {
  assertDate(date)
  return join(root, 'daily', `${date}.todo.md`)
}
export function projectDir(root: string, cwd: string): string {
  return join(root, 'projects', projectHash(cwd))
}
/**
 * The project directories whose memory a session in `cwd` reads, nearest first:
 * the cwd itself, then each ancestor, keeping only those with a bucket.
 *
 * A bucket is `sha1(realpath(dir))`, so a session started in a sub-repo of a
 * workspace would otherwise read an empty bucket while the workspace holds every
 * rule. The walk stops below `home`: the home directory and anything above it
 * are never a project, and pulling them in would attach one catch-all bucket to
 * every session on the machine.
 */
export function projectChain(root: string, cwd: string, home: string = homedir()): string[] {
  if (!cwd) return []
  const start = normalizeProjectCwd(cwd)
  const stop = normalizeProjectCwd(home)
  const chain: string[] = []
  let dir = start
  for (;;) {
    if (dir === stop || stop.startsWith(dir.endsWith(sep) ? dir : dir + sep)) break
    if (existsSync(projectDir(root, dir))) chain.push(dir)
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return chain
}
export function projectMemoryPath(root: string, cwd: string): string {
  return join(projectDir(root, cwd), 'MEMORY.md')
}
export function projectKeyPath(root: string, cwd: string): string {
  return join(projectDir(root, cwd), 'KEY.md')
}
export function projectReferencePath(root: string, cwd: string): string {
  return join(projectDir(root, cwd), 'REFERENCE.md')
}
export function projectKeyArchivePath(root: string, cwd: string): string {
  return join(projectDir(root, cwd), 'KEY-archive.md')
}
export function projectArchivePath(root: string, cwd: string): string {
  if (!cwd) throw new Error('projectArchivePath: cwd is required')
  return join(projectDir(root, cwd), 'MEMORY-archive.md')
}
export function projectArchiveDir(root: string, cwd: string): string {
  if (!cwd) throw new Error('projectArchiveDir: cwd is required')
  return projectDir(root, cwd)
}
export function projectTodoPath(root: string, cwd: string): string {
  return join(projectDir(root, cwd), 'TODOS.md')
}
export function lifeTodoPath(root: string): string {
  return join(root, 'TODOS-life.md')
}
export function workTodoPath(root: string): string {
  return join(root, 'TODOS-work.md')
}
export function maestroMetaDir(root: string): string {
  return join(root, '.maestro-memory')
}
export function todoArchivePath(root: string): string {
  return join(root, 'TODO-archive.md')
}


/**
 * Resolve all five memory files at once (pure).
 */
export function allMemoryPaths(root: string, cwd: string, date: string): {
  memory: string
  user: string
  daily: string
  project: string
  key: string
} {
  return {
    memory: globalMemoryPath(root),
    user: userMemoryPath(root),
    daily: dailyPath(root, date),
    project: projectMemoryPath(root, cwd),
    key: projectKeyPath(root, cwd),
  }
}

/**
 * Resolve all four todo files at once (pure).
 */
export function allTodoPaths(root: string, cwd: string, date: string): {
  life: string
  work: string
  project: string
  daily: string
} {
  return {
    life: lifeTodoPath(root),
    work: workTodoPath(root),
    project: projectTodoPath(root, cwd),
    daily: dailyTodoPath(root, date),
  }
}

/**
 * Resolve all archive files at once (pure).
 */
export function allArchivePaths(root: string, cwd: string): {
  memory: string
  user: string
  key: string
  todo: string
  projectMemoryArchive: string
} {
  return {
    memory: globalArchivePath(root),
    user: userArchivePath(root),
    key: projectKeyArchivePath(root, cwd),
    todo: todoArchivePath(root),
    projectMemoryArchive: projectArchivePath(root, cwd),
  }
}
