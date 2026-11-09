/**
 * search/index.ts — BM25 over memory entries.
 *
 * Sized for the measured corpus (4k entries, 3.3 MB, ~19k terms): a plain
 * in-memory inverted index beats a vector database on every axis that matters
 * here — no dependency, no second model, no daemon, and a rebuild costs about
 * 200 ms.
 *
 * Ranking = BM25 (k1 1.2, b 0.75) * track weight * recency bonus.
 */

import { tokenize } from './tokenize.ts'

export type SearchTrack = 'key' | 'project' | 'memory' | 'user' | 'daily'

export interface IndexedEntry {
  id: string
  text: string
  /** `YYYY-MM-DD`, or null when the entry carries no date tag. */
  date: string | null
  track: SearchTrack
}

export interface SearchHit {
  id: string
  track: SearchTrack
  date: string | null
  score: number
  preview: string
}

export interface SearchIndex {
  entries: IndexedEntry[]
  /** term -> [entryIndex, termFrequency] pairs. */
  postings: Map<string, Array<[number, number]>>
  /** Per-entry token count, for the BM25 length normalisation. */
  lengths: number[]
  avgLength: number
  /** term -> number of entries containing it. */
  docFreq: Map<string, number>
}

const K1 = 1.2
const B = 0.75

const TRACK_WEIGHT: Record<SearchTrack, number> = {
  key: 1.0,
  project: 0.9,
  memory: 0.8,
  user: 0.8,
  daily: 0.6,
}

/** Recency half-life in days; an entry this old scores half the bonus of today's. */
const HALF_LIFE_DAYS = 90
const RECENCY_WEIGHT = 0.25

const PREVIEW_CHARS = 160

/** Entry text without ids/tags that would otherwise dominate the preview. */
function previewOf(text: string): string {
  const compact = text.replace(/\[id:[0-9a-z]{8}\]\s*/gi, '').replace(/\s+/g, ' ').trim()
  return compact.length > PREVIEW_CHARS ? `${compact.slice(0, PREVIEW_CHARS - 1)}…` : compact
}

export function buildIndex(entries: readonly IndexedEntry[], now: Date = new Date()): SearchIndex {
  void now
  const postings = new Map<string, Array<[number, number]>>()
  const lengths: number[] = []
  const docFreq = new Map<string, number>()
  let total = 0

  entries.forEach((entry, i) => {
    const tokens = tokenize(entry.text)
    lengths.push(tokens.length)
    total += tokens.length
    const seenHere = new Set<string>()
    const counts = new Map<string, number>()
    for (const token of tokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1)
    }
    for (const [token, count] of counts) {
      const list = postings.get(token)
      if (list) list.push([i, count])
      else postings.set(token, [[i, count]])
      if (!seenHere.has(token)) {
        seenHere.add(token)
        docFreq.set(token, (docFreq.get(token) ?? 0) + 1)
      }
    }
  })

  return {
    entries: [...entries],
    postings,
    lengths,
    avgLength: entries.length ? total / entries.length : 0,
    docFreq,
  }
}

function recencyBonus(date: string | null, now: Date): number {
  if (!date) return 1
  const at = Date.parse(`${date}T00:00:00Z`)
  if (!Number.isFinite(at)) return 1
  const ageDays = Math.max(0, (now.getTime() - at) / 86_400_000)
  const decay = Math.pow(0.5, ageDays / HALF_LIFE_DAYS)
  return 1 + RECENCY_WEIGHT * decay
}

export interface SearchOptions {
  limit?: number
  now?: Date
  tracks?: readonly SearchTrack[]
}

export function searchIndex(index: SearchIndex, query: string, opts: SearchOptions = {}): SearchHit[] {
  const terms = tokenize(query)
  if (terms.length === 0) return []
  const limit = Math.max(1, Math.min(25, opts.limit ?? 8))
  const now = opts.now ?? new Date()
  const allowed = opts.tracks && opts.tracks.length ? new Set(opts.tracks) : null
  const n = index.entries.length
  if (n === 0) return []

  const scores = new Map<number, number>()
  for (const term of terms) {
    const list = index.postings.get(term)
    if (!list) continue
    const df = index.docFreq.get(term) ?? list.length
    const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
    for (const [i, tf] of list) {
      const len = index.lengths[i] ?? 0
      const denom = tf + K1 * (1 - B + (B * len) / (index.avgLength || 1))
      const score = (idf * tf * (K1 + 1)) / (denom || 1)
      scores.set(i, (scores.get(i) ?? 0) + score)
    }
  }

  const hits: SearchHit[] = []
  for (const [i, base] of scores) {
    const entry = index.entries[i]!
    if (allowed && !allowed.has(entry.track)) continue
    const score = base * (TRACK_WEIGHT[entry.track] ?? 1) * recencyBonus(entry.date, now)
    hits.push({
      id: entry.id,
      track: entry.track,
      date: entry.date,
      score,
      preview: previewOf(entry.text),
    })
  }

  hits.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id))
  return hits.slice(0, limit)
}
