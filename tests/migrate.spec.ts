import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { migrateMemoryRoot, MIGRATION_MARKER, MIGRATION_MARKER_V5, LEGACY_ROOT_NAME } from '../src/host/storage/migrate.ts'

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'maestro-migrate-'))
})

afterEach(() => {
  rmSync(home, { recursive: true, force: true })
})

function seed(dir: string, files: Record<string, string>): void {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(dir, rel)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, body, 'utf8')
  }
}

function countFiles(dir: string): number {
  if (!existsSync(dir)) return 0
  let n = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) n += countFiles(join(dir, entry.name))
    else n += 1
  }
  return n
}

const dshHome = () => join(home, '.dsh')
const legacyRoot = () => join(dshHome(), LEGACY_ROOT_NAME)
const v4Root = () => join(dshHome(), 'maestro-memory')
const targetRoot = () => join(home, '.maestro-memory')
const markerPath = () => join(targetRoot(), '.maestro-memory', MIGRATION_MARKER_V5)
const migrate = (extra: Record<string, unknown> = {}) =>
  migrateMemoryRoot({ root: targetRoot(), mode: 'default', dshHome: dshHome(), ...(extra as any) })

describe('migrateMemoryRoot', () => {
  it('moves the legacy root into place and leaves a marker', () => {
    seed(legacyRoot(), {
      'MEMORY.md': 'a\n§\nb',
      'USER.md': 'u',
      'daily/2026-11-01.md': 'd',
      '.maestro-memory/delimiter-repaired-v3': '{"at":"x"}',
    })

    const res = migrate()

    expect(res.status).toBe('moved')
    expect(res.method).toBe('rename')
    expect(existsSync(legacyRoot())).toBe(false)
    expect(readFileSync(join(targetRoot(), 'MEMORY.md'), 'utf8')).toBe('a\n§\nb')
    expect(existsSync(join(targetRoot(), 'daily', '2026-11-01.md'))).toBe(true)
    expect(existsSync(markerPath())).toBe(true)
    // The earlier repair flag travels with the directory: no repair re-runs.
    expect(existsSync(join(targetRoot(), '.maestro-memory', 'delimiter-repaired-v3'))).toBe(true)
  })

  it('refuses when both directories exist and changes nothing', () => {
    seed(legacyRoot(), { 'MEMORY.md': 'old' })
    seed(targetRoot(), { 'MEMORY.md': 'new' })

    const res = migrate()

    expect(res.status).toBe('refused')
    expect(readFileSync(join(legacyRoot(), 'MEMORY.md'), 'utf8')).toBe('old')
    expect(readFileSync(join(targetRoot(), 'MEMORY.md'), 'utf8')).toBe('new')
    expect(existsSync(markerPath())).toBe(false)
  })

  it('is idempotent: a second run on a migrated store is a no-op', () => {
    seed(legacyRoot(), { 'MEMORY.md': 'a' })

    expect(migrate().status).toBe('moved')
    const second = migrate()

    expect(second.status).toBe('already')
    expect(existsSync(legacyRoot())).toBe(false)
    // MEMORY.md plus the marker directory holding both markers.
    expect(countFiles(targetRoot())).toBe(3)
  })

  it('falls back to copy when rename crosses devices, and removes the source only after verifying', () => {
    seed(legacyRoot(), {
      'MEMORY.md': 'a',
      'projects/abc/KEY.md': 'k',
      'daily/2026-11-02.md': 'd',
    })

    const res = migrate({
      rename: () => {
        const err: any = new Error('cross-device link')
        err.code = 'EXDEV'
        throw err
      },
    })

    expect(res.status).toBe('moved')
    expect(res.method).toBe('copy')
    expect(existsSync(legacyRoot())).toBe(false)
    expect(readFileSync(join(targetRoot(), 'projects', 'abc', 'KEY.md'), 'utf8')).toBe('k')
    expect(existsSync(markerPath())).toBe(true)
  })

  it('reports a failure and keeps the source when rename fails for another reason', () => {
    seed(legacyRoot(), { 'MEMORY.md': 'a' })

    const res = migrate({
      rename: () => {
        const err: any = new Error('permission denied')
        err.code = 'EACCES'
        throw err
      },
    })

    expect(res.status).toBe('failed')
    expect(existsSync(join(legacyRoot(), 'MEMORY.md'))).toBe(true)
    expect(existsSync(markerPath())).toBe(false)
  })

  it('writes the marker on a fresh machine with no legacy directory', () => {
    const res = migrate()

    expect(res.status).toBe('created')
    expect(existsSync(markerPath())).toBe(true)
  })

  it('never touches a store the operator pointed somewhere else', () => {
    seed(legacyRoot(), { 'MEMORY.md': 'old' })
    const custom = join(home, 'elsewhere')

    const res = migrateMemoryRoot({ root: custom, mode: 'configured', dshHome: dshHome() })

    expect(res.status).toBe('skipped')
    expect(readFileSync(join(legacyRoot(), 'MEMORY.md'), 'utf8')).toBe('old')
    expect(existsSync(custom)).toBe(false)
  })

  it('moves nothing in isolated mode, so a dry-boot cannot touch the live store', () => {
    const isolated = join(home, 'isolated-dsh')
    seed(join(isolated, LEGACY_ROOT_NAME), { 'MEMORY.md': 'a' })

    const res = migrateMemoryRoot({ root: join(isolated, 'maestro-memory'), mode: 'isolated', dshHome: isolated })

    expect(res.status).toBe('skipped')
    expect(existsSync(join(isolated, LEGACY_ROOT_NAME, 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(isolated, 'maestro-memory'))).toBe(false)
    expect(existsSync(join(home, '.maestro-memory'))).toBe(false)
  })

  it('records what it did in the marker', () => {
    seed(legacyRoot(), { 'MEMORY.md': 'a' })

    migrate()

    const marker = JSON.parse(readFileSync(markerPath(), 'utf8'))
    expect(marker.from).toBe(legacyRoot())
    expect(marker.to).toBe(targetRoot())
    expect(typeof marker.at).toBe('string')
  })
})
