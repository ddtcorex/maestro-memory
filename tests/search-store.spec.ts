import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createStoreSearch } from '../src/host/memory/search/store-index.ts'

let root: string
const CWD = '/work/example-project'

function seed(files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-search-'))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('store search', () => {
  it('finds an entry in the key track by a word the prompt never shows', () => {
    seed({
      'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] global note about phpcs on internal api',
      'projects/.keep': '',
    })
    const search = createStoreSearch({ root })
    const hits = search.query('phpcs', { cwd: CWD })
    expect(hits[0]?.id).toBe('aaaaaaaa')
    expect(hits[0]?.track).toBe('memory')
  })

  it('opens one entry in full by id', () => {
    seed({ 'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] the full body of the note' })
    const search = createStoreSearch({ root })
    expect(search.open('aaaaaaaa', { cwd: CWD })).toContain('the full body of the note')
    expect(search.open('doesnotexist', { cwd: CWD })).toBeNull()
  })

  it('reuses the index until the store changes', () => {
    seed({ 'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] first note' })
    let reads = 0
    const search = createStoreSearch({ root, onScan: () => { reads += 1 } })
    search.query('first', { cwd: CWD })
    search.query('first', { cwd: CWD })
    expect(reads).toBe(1)
  })

  it('rebuilds after a write so a new entry is findable immediately', () => {
    seed({ 'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] first note' })
    const search = createStoreSearch({ root })
    expect(search.query('watchdog', { cwd: CWD })).toEqual([])

    // A later write changes mtime and size, which the fingerprint sees.
    writeFileSync(
      join(root, 'MEMORY.md'),
      '[2026-09-01] [id:aaaaaaaa] first note\n§\n[2026-11-09] [id:bbbbbbbb] watchdog note',
      'utf8',
    )
    expect(search.query('watchdog', { cwd: CWD })[0]?.id).toBe('bbbbbbbb')
  })

  it('refuses to index beyond the entry cap instead of growing without bound', () => {
    const entries = Array.from({ length: 12 }, (_, i) => `[2026-09-01] [id:${String(i).padStart(8, '0')}] note ${i}`)
    seed({ 'MEMORY.md': entries.join('\n§\n') })
    const search = createStoreSearch({ root, maxEntries: 10 })
    expect(() => search.query('note', { cwd: CWD })).toThrow(/too large/i)
  })

  it('searches only the requested tracks', () => {
    seed({
      'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] shared word',
      'daily/2026-09-02.md': '[2026-09-02] [id:dddddddd] shared word',
    })
    const search = createStoreSearch({ root })
    expect(search.query('shared', { cwd: CWD, tracks: ['memory'] }).map((h) => h.track)).toEqual(['memory'])
  })

  it('gives an entry without an id a stable synthetic id', () => {
    seed({ 'MEMORY.md': '[2026-09-01] entry written before ids existed' })
    const search = createStoreSearch({ root })
    const first = search.query('written', { cwd: CWD })[0]
    expect(first?.id).toMatch(/^[0-9a-f]{8}$/)
    expect(search.open(first!.id, { cwd: CWD })).toContain('written before ids existed')
  })
})
