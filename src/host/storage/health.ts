/**
 * storage/health.ts — what a health reader may say about the store root.
 *
 * Two moves have happened: 4.0 renamed the store inside the DSH home, and 5.0 moved
 * it out. Both left a marker, and both markers are facts a reader needs: v4 says the
 * package rename completed, v5 says the store left the DSH home. Reading only one of
 * them shows a correct machine as half migrated.
 */

import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { maestroMetaDir } from './layout.ts'
import { MIGRATION_MARKER, MIGRATION_MARKER_V5 } from './migrate.ts'

export interface StoreHealth {
  storeRoot: string
  markerV4: boolean
  markerV5: boolean
  /**
   * A store root that still exists beside the live one.
   *
   * A pre-5.0 client, or a host that was running before the move, recreates
   * `<DSH_HOME>/maestro-memory` on its next write. Nothing breaks immediately, which is
   * exactly why it has to be visible: two stores drift apart while both look fine.
   */
  legacyRoot: string | null
}

export function readHealth(opts: { root: string; dshHome?: string }): StoreHealth {
  const meta = maestroMetaDir(opts.root)
  const candidates = opts.dshHome
    ? [join(opts.dshHome, 'maestro-memory'), join(opts.dshHome, 'dsh-maestro-memory')]
    : []
  const legacyRoot = candidates.find((candidate) => candidate !== opts.root && existsSync(candidate)) ?? null
  return {
    storeRoot: opts.root,
    markerV4: existsSync(join(meta, MIGRATION_MARKER)),
    markerV5: existsSync(join(meta, MIGRATION_MARKER_V5)),
    legacyRoot,
  }
}
