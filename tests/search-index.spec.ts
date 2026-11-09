import { describe, it, expect } from 'vitest'
import { buildIndex, searchIndex, type IndexedEntry } from '../src/host/memory/search/index.ts'

function entry(id: string, text: string, date: string, track: IndexedEntry['track'] = 'key'): IndexedEntry {
  return { id, text, date, track }
}

const FIXTURE: IndexedEntry[] = [
  entry('aaaaaaaa', '[2026-09-01] [id:aaaaaaaa] the public-api lint gate runs phpcs on internal/api only', '2026-09-01'),
  entry('bbbbbbbb', '[2026-10-20] [id:bbbbbbbb] reviewer changes are proven on the local gitlab rig first', '2026-10-20'),
  entry('cccccccc', '[2026-10-25] [id:cccccccc] govard builds a fresh binary for local testing', '2026-10-25'),
  entry('dddddddd', '[2026-10-28] [id:dddddddd] mobile drawer needs a fresh screenshot at 390px', '2026-10-28'),
  entry('eeeeeeee', '[2026-10-29] [id:eeeeeeee] unrelated note about python packaging', '2026-10-29'),
  entry('ffffffff', '[2026-10-30] [id:ffffffff] updated note about python packaging again', '2026-10-30'),
]

describe('search index', () => {
  it('ranks a distinctive old term above a newer entry without it', () => {
    const index = buildIndex(FIXTURE)
    const hits = searchIndex(index, 'phpcs')
    expect(hits[0]?.id).toBe('aaaaaaaa')
    expect(hits.map((h) => h.id)).not.toContain('eeeeeeee')
  })

  it('scores a rarer term above a term that appears everywhere', () => {
    const index = buildIndex(FIXTURE)
    // "gitlab" appears once, "packaging" twice, so an entry matching only the
    // rare term outranks one matching only the common term. (BM25 sums over the
    // matched terms, so comparing entries that match a different NUMBER of terms
    // would test term count, not idf.)
    const hits = searchIndex(index, 'packaging gitlab')
    expect(hits[0]?.id).toBe('bbbbbbbb')
    expect(hits.map((h) => h.id)).toEqual(expect.arrayContaining(['eeeeeeee', 'ffffffff']))
    expect(hits.findIndex((h) => h.id === 'bbbbbbbb')).toBeLessThan(hits.findIndex((h) => h.id === 'eeeeeeee'))
  })

  it('returns nothing for a term that is not in the corpus', () => {
    const index = buildIndex(FIXTURE)
    expect(searchIndex(index, 'kubernetes')).toEqual([])
  })

  it('lets a recency bonus lift a newer entry when relevance is equal', () => {
    // Identical text and length, only the date differs: the bonus is the only
    // thing that can order these two.
    const index = buildIndex([
      entry('oooooooo', '[2026-10-01] [id:oooooooo] cache invalidation detail', '2026-10-01'),
      entry('nnnnnnnn', '[2026-10-30] [id:nnnnnnnn] cache invalidation detail', '2026-10-30'),
    ])
    const hits = searchIndex(index, 'cache invalidation')
    expect(hits[0]?.id).toBe('nnnnnnnn')
    expect(hits[1]?.id).toBe('oooooooo')
  })

  it('weights the key track above daily for an equally relevant hit', () => {
    const index = buildIndex([
      entry('kkkkkkkk', '[2026-10-01] [id:kkkkkkkk] cache invalidation detail', '2026-10-01', 'key'),
      entry('dddddddd', '[2026-10-01] [id:dddddddd] cache invalidation detail', '2026-10-01', 'daily'),
    ])
    const hits = searchIndex(index, 'cache invalidation')
    expect(hits[0]?.track).toBe('key')
  })

  it('matches a diacritic query against an ASCII entry and the other way round', () => {
    const index = buildIndex([
      entry('vvvvvvvv', '[2026-10-01] [id:vvvvvvvv] danh sach khach hang', '2026-10-01'),
    ])
    expect(searchIndex(index, 'danh sách').map((h) => h.id)).toEqual(['vvvvvvvv'])
    expect(searchIndex(index, 'khách hàng').map((h) => h.id)).toEqual(['vvvvvvvv'])
  })

  it('returns the score, date and track with each hit', () => {
    const index = buildIndex(FIXTURE)
    const [hit] = searchIndex(index, 'phpcs')
    expect(hit).toMatchObject({ id: 'aaaaaaaa', track: 'key', date: '2026-09-01' })
    expect(hit!.score).toBeGreaterThan(0)
  })
})
