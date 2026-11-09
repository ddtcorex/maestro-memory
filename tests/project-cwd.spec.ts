import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { projectHash, normalizeProjectCwd } from '../src/host/storage/layout.ts'

describe('project cwd normalisation', () => {
  it('hashes a symlinked path the same as its target', () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-cwd-'))
    try {
      const real = join(root, 'real')
      const link = join(root, 'link')
      mkdirSync(real)
      symlinkSync(real, link)
      expect(projectHash(link)).toBe(projectHash(real))
      expect(normalizeProjectCwd(link)).toBe(normalizeProjectCwd(real))
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('falls back to the raw string when the path does not exist', () => {
    const missing = '/definitely/not/here/maestro'
    expect(normalizeProjectCwd(missing)).toBe(missing)
    expect(projectHash(missing)).toHaveLength(12)
  })

  it('still throws on an empty cwd', () => {
    expect(() => projectHash('')).toThrow()
  })
})
