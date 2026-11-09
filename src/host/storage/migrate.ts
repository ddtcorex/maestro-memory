/**
 * storage/migrate.ts — one-time move of the pre-4.0 store root.
 *
 * The package was renamed from `dsh-maestro-memory` to `maestro-memory`, and the
 * store root follows: `~/.dsh/dsh-maestro-memory` becomes `~/.dsh/maestro-memory`.
 *
 * Rules that keep live data safe:
 * - it never merges: when both directories exist it refuses and writes nothing,
 *   because "which one is newer" is not a decision a boot hook may make;
 * - it never deletes a source it has not verified: the cross-device fallback
 *   compares file count and byte total before removing anything;
 * - it writes a `migrated-v4` marker so a half-migrated machine is visible to the
 *   sync preflight instead of looking like an empty store.
 */

import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { maestroMetaDir } from './layout.ts'

export const LEGACY_ROOT_NAME = 'dsh-maestro-memory'
export const CURRENT_ROOT_NAME = 'maestro-memory'
export const MIGRATION_MARKER = 'migrated-v4'

export type MigrationStatus = 'migrated' | 'already' | 'refused' | 'failed' | 'skipped'

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
  /** Home directory; injected by tests. */
  home?: string
  /** `config.memoryDir`. When set to a custom path the store is not ours to move. */
  memoryDir?: string | null
  /** Rename primitive; injected by tests to simulate EXDEV and permission errors. */
  rename?: (from: string, to: string) => void
}

function inventory(dir: string): Inventory {
  const out: Inventory = { files: 0, bytes: 0 }
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const full = join(current, entry.name)
      if (entry.isDirectory()) walk(full)
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

function writeMarker(target: string, payload: Record<string, unknown>): string | null {
  try {
    const marker = join(maestroMetaDir(target), MIGRATION_MARKER)
    mkdirSync(dirname(marker), { recursive: true })
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
export function migrateMemoryRoot(params: MigrateParams = {}): MigrationResult {
  const home = params.home ?? homedir()
  const defaultRoot = join(home, '.dsh', CURRENT_ROOT_NAME)
  const configured = params.memoryDir ?? null
  const target = configured ?? defaultRoot
  const from = join(home, '.dsh', LEGACY_ROOT_NAME)

  // A custom memoryDir is the operator's own arrangement; leave it alone.
  if (configured && configured !== defaultRoot) {
    return { status: 'skipped', from, to: target, reason: 'custom memoryDir' }
  }

  const hasLegacy = existsSync(from)
  const hasTarget = existsSync(target)

  if (hasLegacy && hasTarget) {
    return {
      status: 'refused',
      from,
      to: target,
      reason: 'both directories exist; a human decides, nothing was changed',
    }
  }

  const rename = params.rename ?? renameSync

  if (hasLegacy) {
    const before = inventory(from)
    let method: 'rename' | 'copy' = 'rename'
    try {
      rename(from, target)
    } catch (error: any) {
      if (error?.code !== 'EXDEV') {
        return {
          status: 'failed',
          from,
          to: target,
          reason: error?.message ?? String(error),
        }
      }
      // Different filesystems: copy, verify, and only then remove the source.
      method = 'copy'
      try {
        copyTree(from, target)
        const after = inventory(target)
        if (after.files !== before.files || after.bytes !== before.bytes) {
          return {
            status: 'failed',
            from,
            to: target,
            method,
            files: before.files,
            bytes: before.bytes,
            reason: `copy verification failed (${after.files}/${after.bytes} of ${before.files}/${before.bytes})`,
          }
        }
        rmSync(from, { recursive: true, force: true })
      } catch (copyError: any) {
        return {
          status: 'failed',
          from,
          to: target,
          method,
          reason: copyError?.message ?? String(copyError),
        }
      }
    }

    const markerError = writeMarker(target, {
      at: new Date().toISOString(),
      from,
      to: target,
      method,
      files: before.files,
      bytes: before.bytes,
    })
    const result: MigrationResult = {
      status: 'migrated',
      from,
      to: target,
      method,
      files: before.files,
      bytes: before.bytes,
    }
    if (markerError) result.reason = `marker not written: ${markerError}`
    return result
  }

  const markerPath = join(maestroMetaDir(target), MIGRATION_MARKER)
  if (existsSync(markerPath)) {
    return { status: 'already', from, to: target }
  }

  // Fresh machine: no legacy store, so the only job is to declare the root is
  // already at the new path, which is what the sync preflight reads.
  mkdirSync(target, { recursive: true })
  const markerError = writeMarker(target, {
    at: new Date().toISOString(),
    from: null,
    to: target,
    method: 'none',
    files: 0,
    bytes: 0,
  })
  const result: MigrationResult = { status: 'already', from, to: target }
  if (markerError) result.reason = `marker not written: ${markerError}`
  return result
}

/** True when this machine's store root is at the post-4.0 path. */
export function hasMigrationMarker(root: string): boolean {
  return existsSync(join(maestroMetaDir(root), MIGRATION_MARKER))
}
