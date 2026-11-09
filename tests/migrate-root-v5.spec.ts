import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { migrateMemoryRoot } from '../src/host/storage/migrate.ts'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'

function seedStore(dir: string): void {
  mkdirSync(join(dir, '.maestro-memory'), { recursive: true })
  writeFileSync(join(dir, 'MEMORY.md'), '[2026-09-01] [id:aaaaaaaa] a rule\n')
  writeFileSync(join(dir, '.maestro-memory', 'migrated-v4'), JSON.stringify({ from: '/old', to: dir }))
}

describe('migrateMemoryRoot v5', () => {
  it('moves the v4 root to the neutral root and writes both markers', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'mig-dsh-'))
    const home = mkdtempSync(join(tmpdir(), 'mig-home-'))
    seedStore(join(dshHome, 'maestro-memory'))
    const root = join(home, '.maestro-memory')
    const res = migrateMemoryRoot({ root, mode: 'default', dshHome })
    expect(res.status).toBe('moved')
    expect(existsSync(join(root, 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(dshHome, 'maestro-memory'))).toBe(false)
    expect(existsSync(join(root, '.maestro-memory', 'migrated-v4'))).toBe(true)
    expect(existsSync(join(root, '.maestro-memory', 'migrated-v5.json'))).toBe(true)
    expect(JSON.parse(readFileSync(join(root, '.maestro-memory', 'migrated-v5.json'), 'utf8'))).toMatchObject({
      from: join(dshHome, 'maestro-memory'),
      to: root,
      mode: 'default',
    })
  })

  it('moves a pre-4.0 root too', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'mig-dsh2-'))
    const home = mkdtempSync(join(tmpdir(), 'mig-home2-'))
    seedStore(join(dshHome, 'dsh-maestro-memory'))
    const res = migrateMemoryRoot({ root: join(home, '.maestro-memory'), mode: 'default', dshHome })
    expect(res.status).toBe('moved')
  })

  it('refuses when the target and a source both exist', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'mig-dsh3-'))
    const home = mkdtempSync(join(tmpdir(), 'mig-home3-'))
    seedStore(join(dshHome, 'maestro-memory'))
    seedStore(join(home, '.maestro-memory'))
    const res = migrateMemoryRoot({ root: join(home, '.maestro-memory'), mode: 'default', dshHome })
    expect(res.status).toBe('refused')
    expect(existsSync(join(dshHome, 'maestro-memory'))).toBe(true)
  })

  it('never moves anything outside default mode', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'mig-dsh4-'))
    seedStore(join(dshHome, 'maestro-memory'))
    const res = migrateMemoryRoot({ root: '/tmp/elsewhere-store', mode: 'env', dshHome })
    expect(res.status).toBe('skipped')
    expect(existsSync(join(dshHome, 'maestro-memory'))).toBe(true)
  })

  it('creates a fresh root 0700 with from: null', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'mig-dsh5-'))
    const home = mkdtempSync(join(tmpdir(), 'mig-home5-'))
    const root = join(home, '.maestro-memory')
    const res = migrateMemoryRoot({ root, mode: 'default', dshHome })
    expect(res.status).toBe('created')
    expect(statSync(root).mode & 0o777).toBe(0o700)
    expect(JSON.parse(readFileSync(join(root, '.maestro-memory', 'migrated-v5.json'), 'utf8')).from).toBeNull()
  })

  it('is a no-op once the store carries the v5 marker', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'mig-dsh6-'))
    const home = mkdtempSync(join(tmpdir(), 'mig-home6-'))
    const root = join(home, '.maestro-memory')
    migrateMemoryRoot({ root, mode: 'default', dshHome })
    expect(migrateMemoryRoot({ root, mode: 'default', dshHome }).status).toBe('already')
  })

  it('serves the same entries after the move as before it', () => {
    const dshHome = mkdtempSync(join(tmpdir(), 'mig-dsh7-'))
    const home = mkdtempSync(join(tmpdir(), 'mig-home7-'))
    seedStore(join(dshHome, 'maestro-memory'))
    writeFileSync(join(dshHome, 'maestro-memory', 'USER.md'), '[2026-09-02] [id:bbbbbbbb] user note\n')
    const before = new MaestroMemoryStore(join(dshHome, 'maestro-memory')).list('memory' as any, undefined)
    const root = join(home, '.maestro-memory')
    migrateMemoryRoot({ root, mode: 'default', dshHome })
    expect(new MaestroMemoryStore(root).list('memory' as any, undefined)).toEqual(before)
  })
})
