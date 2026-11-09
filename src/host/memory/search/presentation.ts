/**
 * search/presentation.ts — how a hit reaches the model.
 *
 * Two bindings format search results (the DSH tool and the MCP adapter). If each
 * carried its own copy of the line format, the default track set and the refusal
 * strings, they would drift silently: same store, two answers. Everything a
 * caller sees is decided here.
 */

import type { SearchHit, SearchTrack } from './index.ts'

export const DEFAULT_TRACKS_WITH_CWD: SearchTrack[] = ['key', 'project', 'memory', 'user']

/**
 * `daily` is 2,381 of the 4,039 live entries and mostly turn noise; searching it
 * by default tripled the first-query index build for little return, so it stays
 * opt-in.
 */
export const DEFAULT_TRACKS_WITHOUT_CWD: SearchTrack[] = ['memory', 'user']

export const REFUSAL_NO_QUERY = 'query is required (or pass id to open one entry)'
export const REFUSAL_CWD_REQUIRED =
  'cwd is required for the key and project tracks (pass cwd, or restrict tracks)'

const VALID_TRACKS: SearchTrack[] = ['key', 'project', 'daily', 'memory', 'user']

/** One hit, in the exact shape both bindings print. */
export function formatHit(hit: SearchHit): string {
  return `${hit.id}  ${hit.track}  ${hit.date ?? '-'}  ${hit.score.toFixed(2)}  ${hit.preview}`
}

export function formatHits(hits: SearchHit[]): string {
  return hits.map(formatHit).join('\n')
}

/**
 * Parse a comma-separated `tracks` argument.
 *
 * An explicit request for a cwd-scoped track without a cwd is a caller mistake and
 * is refused; an omitted argument falls back to the curated default, because a
 * model that just wants to find an entry does not owe this tool a cwd.
 */
export function resolveTracks(raw: string | undefined, hasCwd: boolean): SearchTrack[] | { error: string } {
  if (raw === undefined || raw.trim() === '') {
    return hasCwd ? [...DEFAULT_TRACKS_WITH_CWD] : [...DEFAULT_TRACKS_WITHOUT_CWD]
  }
  const requested = raw
    .split(',')
    .map((t) => t.trim().toLowerCase())
    .filter(Boolean)
  // A typo must not widen the search to everything: that reads as "found nothing"
  // for a scoped query and as "found everything" for an unscoped one.
  const unknown = requested.filter((t) => !(VALID_TRACKS as string[]).includes(t))
  if (unknown.length) {
    return { error: `unknown track: ${unknown.join(', ')} (expected ${VALID_TRACKS.join(', ')})` }
  }
  const wanted = requested as SearchTrack[]
  if (!wanted.length) return hasCwd ? [...DEFAULT_TRACKS_WITH_CWD] : [...DEFAULT_TRACKS_WITHOUT_CWD]
  if (!hasCwd && (wanted.includes('key') || wanted.includes('project'))) {
    return { error: REFUSAL_CWD_REQUIRED }
  }
  return wanted
}
