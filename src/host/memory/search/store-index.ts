/**
 * search/store-index.ts — a searchable view over the on-disk store.
 *
 * The index is built lazily on the first query and rebuilt only when the store
 * files change (a fingerprint over path, mtime and size). Measured on the live
 * store: 130 files, 4,039 entries, 79 ms to read and 124 ms to index, so there is
 * nothing to persist and nothing to keep warm between processes.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { parseEntries } from '../../storage/legacy-format.ts'
import {
  dailyPath,
  globalMemoryPath,
  projectKeyPath,
  projectMemoryPath,
  userMemoryPath,
} from '../../storage/layout.ts'
import { buildIndex, searchIndex, type IndexedEntry, type SearchHit, type SearchIndex, type SearchTrack } from './index.ts'

const ENTRY_ID_RE = /\[id:\s*([0-9a-f]{8})\]/i
const DEFAULT_MAX_ENTRIES = 50_000

export interface StoreSearchOptions {
  /** Store root; defaults to the resolved memory root. */
  root: string
  maxEntries?: number
  /** Test seam: called whenever the store is scanned. */
  onScan?: () => void
}

export interface QueryOptions {
  cwd?: string | null
  tracks?: readonly SearchTrack[]
  limit?: number
}

export interface StoreSearch {
  query(text: string, opts?: QueryOptions): SearchHit[]
  /** Full entry text for an id, or null when it is gone. */
  open(id: string, opts?: QueryOptions): string | null
}

interface ScannedFile {
  path: string
  track: SearchTrack
}

function defaultFiles(root: string, cwd: string | null): ScannedFile[] {
  const files: ScannedFile[] = [
    { path: globalMemoryPath(root), track: 'memory' },
    { path: userMemoryPath(root), track: 'user' },
  ]
  if (cwd) {
    files.push({ path: projectMemoryPath(root, cwd), track: 'project' })
    files.push({ path: projectKeyPath(root, cwd), track: 'key' })
  }
  try {
    const dir = join(root, 'daily')
    for (const name of readdirSync(dir)) {
      if (name.endsWith('.md')) files.push({ path: dailyPath(root, name.slice(0, -3)), track: 'daily' })
    }
  } catch {}
  return files
}

function fingerprint(files: ScannedFile[]): string {
  const hash = createHash('sha1')
  for (const file of files) {
    try {
      const st = statSync(file.path)
      hash.update(`${file.path}\t${st.mtimeMs}\t${st.size}\n`)
    } catch {
      hash.update(`${file.path}\tmissing\n`)
    }
  }
  return hash.digest('hex')
}

function syntheticId(text: string): string {
  return createHash('sha1').update(text).digest('hex').slice(0, 8)
}

function entryId(text: string): string {
  const match = ENTRY_ID_RE.exec(text)
  return match ? match[1]!.toLowerCase() : syntheticId(text)
}

export function createStoreSearch(opts: StoreSearchOptions): StoreSearch {
  const maxEntries = opts.maxEntries ?? DEFAULT_MAX_ENTRIES
  let cached: { key: string; files: ScannedFile[]; index: SearchIndex; entries: IndexedEntry[] } | null = null

  function collect(cwd: string | null, tracks?: readonly SearchTrack[]): { index: SearchIndex; entries: IndexedEntry[] } {
    const files = defaultFiles(opts.root, cwd)
    const key = fingerprint(files)
    if (cached && cached.key === key) return cached

    opts.onScan?.()
    const wanted = tracks && tracks.length ? new Set(tracks) : null
    const entries: IndexedEntry[] = []
    for (const file of files) {
      if (wanted && !wanted.has(file.track)) continue
      if (!existsSync(file.path)) continue
      let text = ''
      try {
        text = readFileSync(file.path, 'utf8')
      } catch {
        continue
      }
      for (const raw of parseEntries(text)) {
        entries.push({
          id: entryId(raw),
          text: raw,
          date: /^\[(\d{4}-\d{2}-\d{2})/.exec(raw.replace(ENTRY_ID_RE, '').trim())?.[1] ?? null,
          track: file.track,
        })
        if (entries.length > maxEntries) {
          throw new Error(
            `memory store too large to index: more than ${maxEntries} entries; narrow the query with tracks`,
          )
        }
      }
    }

    const index = buildIndex(entries)
    cached = { key, files, index, entries }
    return cached
  }

  return {
    query(text, queryOpts = {}) {
      const { index } = collect(queryOpts.cwd ?? null, queryOpts.tracks)
      return searchIndex(index, text, { limit: queryOpts.limit, tracks: queryOpts.tracks })
    },
    open(id, queryOpts = {}) {
      const { entries } = collect(queryOpts.cwd ?? null, queryOpts.tracks)
      const wanted = String(id ?? '').toLowerCase()
      return entries.find((entry) => entry.id === wanted)?.text ?? null
    },
  }
}
