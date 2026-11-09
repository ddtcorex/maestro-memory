/**
 * storage/migrate.ts — one-time move of the store to the resolved root.
 *
 * Two moves share this code. 4.0 renamed the package and moved the store inside the
 * DSH home (`dsh-maestro-memory` to `maestro-memory`). 5.0 moves it out of the DSH
 * home entirely, to `~/.maestro-memory` by default. Both write a marker, and both
 * refuse rather than merge.
 *
 * Rules that keep live data safe:
 * - it never merges: when the target and a legacy root both exist it refuses and
 *   writes nothing, because "which one is newer" is not a decision a boot hook may make;
 * - it never moves anything in a mode the caller chose: a test or a dry-boot that
 *   resolved its own root must not reach the live store;
 * - it never deletes a source it has not verified: the cross-device fallback and the
 *   post-move check compare file count and byte total before anything is removed;
 * - it writes `migrated-v5.json` for this move and keeps `migrated-v4` for the
 *   previous one, because the sync preflight and Health still read it.
 */

import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { withLockSync } from './atomic-store.ts'
import { maestroMetaDir, type StoreRootMode } from './layout.ts'

export const LEGACY_ROOT_NAME = 'dsh-maestro-memory'
export const CURRENT_ROOT_NAME = 'maestro-memory'
export const MIGRATION_MARKER = 'migrated-v4'
/** Marker for the 5.0 move out of the DSH home. The v4 marker keeps travelling. */
export const MIGRATION_MARKER_V5 = 'migrated-v5.json'

export type MigrationStatus = 'moved' | 'created' | 'already' | 'refused' | 'failed' | 'skipped'

export interface MigrationResult {
  status: MigrationStatus
  /** The directory the store used before 4.0. */
  from: string
  /** The directory the store uses from 4.0 on. */
  to: string
  /** How the move happened, when one happened. */
  method?: 'rename' | 'copy'
  /** Files and bytes moved, for the boot log and for verification. */
  files?: number
  bytes?: number
  /** Why a `refused` or `failed` result happened. */
  reason?: string
}

interface Inventory {
  files: number
  bytes: number
}

export interface MigrateParams {
  /** The root the resolver chose. Migration must not derive it again. */
  root: string
  /** How the resolver chose it. Only `default` may move a store. */
  mode: StoreRootMode
  /** The DSH home, where the legacy roots live. */
  dshHome: string
  /** Rename primitive; injected by tests to simulate EXDEV and permission errors. */
  rename?: (from: string, to: string) => void
}

function inventory(dir: string): Inventory {
  const out: Inventory = { files: 0, bytes: 0 }
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
      else if (entry.name.startsWith('.maestro.lock')) continue
      else {
        out.files += 1
        out.bytes += statSync(full).size
      }
    }
  }
  walk(dir)
  return out
}

function copyTree(from: string, to: string): void {
  mkdirSync(to, { recursive: true })
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    const src = join(from, entry.name)
    const dest = join(to, entry.name)
    if (entry.isDirectory()) copyTree(src, dest)
    else copyFileSync(src, dest)
  }
}

function writeMarker(target: string, payload: Record<string, unknown>, markerName: string = MIGRATION_MARKER): string | null {
  try {
    const marker = join(maestroMetaDir(target), markerName)
    mkdirSync(dirname(marker), { recursive: true, mode: 0o700 })
    writeFileSync(marker, JSON.stringify(payload, null, 2), 'utf8')
    return null
  } catch (error: any) {
    return error?.message ?? String(error)
  }
}

/**
 * Migrate the store root if the pre-4.0 directory is present.
 *
 * Runs before the first store read, so no reader ever sees a half-moved tree.
 */
/**
 * Never throws: a boot hook that throws takes the memory row down with it, and the
 * reason the user sees is unrelated to the cause. A live lock, an unreadable source or
 * a rename that fails mid-flight all come back as `failed` with the reason.
 */
export function migrateMemoryRoot(params: MigrateParams): MigrationResult {
  try {
    return migrateMemoryRootInner(params)
  } catch (error: any) {
    return {
      status: 'failed',
      from: params.dshHome,
      to: params.root,
      reason: `migration threw: ${error?.message ?? String(error)}; inspect both roots before retrying`,
    }
  }
}

function migrateMemoryRootInner(params: MigrateParams): MigrationResult {
  const target = params.root
  const sources = [join(params.dshHome, CURRENT_ROOT_NAME), join(params.dshHome, LEGACY_ROOT_NAME)]
  const present = sources.filter((source) => existsSync(source))
  const from = present[0] ?? sources[0]

  // A caller that resolved a different root owns that arrangement. Moving anything
  // here would reach into the live store from a test or a dry-boot.
  if (params.mode !== 'default') {
    return { status: 'skipped', from, to: target, reason: `${params.mode} mode; nothing moved` }
  }

  if (existsSync(join(maestroMetaDir(target), MIGRATION_MARKER_V5))) {
    return { status: 'already', from, to: target }
  }

  // Ambiguity in any direction is a human decision, never a boot decision: two legacy
  // roots, or a legacy root beside a store already at the target.
  const ambiguous = present.length > 1 || (present.length === 1 && existsSync(target))
  if (ambiguous) {
    const seen = [...present, ...(existsSync(target) ? [target] : [])]
    return {
      status: 'refused',
      from,
      to: target,
      reason: `the store exists at ${seen.join(' and ')}; a human decides which one is live, nothing was changed`,
    }
  }

  if (present.length) {
    const source = present[0]
    const before = inventory(source)
    const rename = params.rename ?? renameSync
    let method: 'rename' | 'copy' = 'rename'
    // The store's own lock, so a second process cannot observe a half-moved tree.
    const moved = withLockSync(source, (): { error?: string; method?: 'rename' | 'copy' } => {
      try {
        rename(source, target)
      } catch (error: any) {
        if (error?.code !== 'EXDEV') return { error: error?.message ?? String(error) }
        return copyThenRemove(source, target, before)
      }
      return {}
    })
    if (moved.error) {
      return { status: 'failed', from: source, to: target, reason: moved.error, files: before.files, bytes: before.bytes }
    }
    if (moved.method) method = moved.method
    // The lock we took lived inside the directory that just moved; leaving it behind
    // would be a stray file in the new store forever.
    rmSync(join(target, '.maestro.lock'), { force: true })

    const after = inventory(target)
    if (after.files !== before.files || after.bytes !== before.bytes) {
      return {
        status: 'failed',
        from: source,
        to: target,
        method,
        files: before.files,
        bytes: before.bytes,
        reason: `integrity check failed (${after.files}/${after.bytes} of ${before.files}/${before.bytes})`,
      }
    }

    // A moved store inherits the source mode, and at $HOME there is no 0700 parent to
    // protect it any more. Both directories are narrowed here, before any marker lands.
    try {
      chmodSync(target, 0o700)
      mkdirSync(maestroMetaDir(target), { recursive: true, mode: 0o700 })
      chmodSync(maestroMetaDir(target), 0o700)
    } catch {}

    // Both markers are written, in that order: readers that only know v4 keep working,
    // and the presence of v5 is what says the move finished.
    const v4 = readMarkerV4(target)
    const markerError =
      writeMarker(target, v4 ?? { at: new Date().toISOString(), from: source, to: target }, MIGRATION_MARKER) ??
      writeMarker(
        target,
        { at: new Date().toISOString(), from: source, to: target, mode: params.mode, method },
        MIGRATION_MARKER_V5,
      )
    const result: MigrationResult = { status: 'moved', from: source, to: target, method, files: before.files, bytes: before.bytes }
    if (markerError) result.reason = `marker not written: ${markerError}`
    return result
  }

  // Fresh machine: there is nothing to move, so the only job is to declare a current
  // root. 0700 because at $HOME the store is no longer protected by a 0700 parent.
  mkdirSync(target, { recursive: true, mode: 0o700 })
  const markerError =
    writeMarker(target, { at: new Date().toISOString(), from: null, to: target, mode: params.mode }, MIGRATION_MARKER_V5) ??
    writeMarker(target, { at: new Date().toISOString(), from: null, to: target }, MIGRATION_MARKER)
  const created: MigrationResult = { status: 'created', from, to: target }
  if (markerError) created.reason = `marker not written: ${markerError}`
  return created
}

function readMarkerV4(target: string): Record<string, unknown> | null {
  try {
    const raw = readFileSync(join(maestroMetaDir(target), MIGRATION_MARKER), 'utf8')
    return JSON.parse(raw) as Record<string, unknown>
  } catch {
    return null
  }
}

function copyThenRemove(source: string, target: string, before: Inventory): { error?: string; method?: 'copy' } {
  try {
    copyTree(source, target)
    const after = inventory(target)
    if (after.files !== before.files || after.bytes !== before.bytes) {
      return { error: `copy verification failed (${after.files}/${after.bytes} of ${before.files}/${before.bytes})` }
    }
    rmSync(source, { recursive: true, force: true })
    return { method: 'copy' }
  } catch (error: any) {
    return { error: error?.message ?? String(error) }
  }
}

/** True when this machine's store root is at the post-4.0 path. */
export function hasMigrationMarker(root: string): boolean {
  return existsSync(join(maestroMetaDir(root), MIGRATION_MARKER))
}
