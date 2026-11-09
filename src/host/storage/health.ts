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
}

export function readHealth(opts: { root: string }): StoreHealth {
  const meta = maestroMetaDir(opts.root)
  return {
    storeRoot: opts.root,
    markerV4: existsSync(join(meta, MIGRATION_MARKER)),
    markerV5: existsSync(join(meta, MIGRATION_MARKER_V5)),
  }
}
