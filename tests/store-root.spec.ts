import { describe, it, expect } from 'vitest'
import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readFileSync } from 'node:fs'
import { resolveStoreRoot } from '../src/host/storage/layout.ts'

const table = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'store-root-cases.json'), 'utf8')) as Array<{
  name: string
  opts: any
  expected: { root: string; mode: string }
}>

describe('resolveStoreRoot', () => {
  for (const row of table) {
    it(row.name, () => {
      expect(resolveStoreRoot(row.opts)).toEqual(row.expected)
    })
  }

  it('treats a symlinked home as production, not isolated', () => {
    const real = mkdtempSync(join(tmpdir(), 'root-real-'))
    const link = `${real}-link`
    symlinkSync(real, link)
    expect(resolveStoreRoot({ env: { DSH_HOME: join(real, '.dsh') }, home: link })).toEqual({
      root: join(real, '.maestro-memory'),
      mode: 'default',
    })
  })

  it('does not throw when DSH_HOME does not exist yet', () => {
    const home = mkdtempSync(join(tmpdir(), 'root-home-'))
    expect(resolveStoreRoot({ env: { DSH_HOME: join(home, 'not-yet') }, home }).mode).toBe('isolated')
  })
})
