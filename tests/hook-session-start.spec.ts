/**
 * `session-start` must print exactly what DSH injects, because two different
 * renderers for the same store is how an agent ends up with two different
 * beliefs about the project.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSessionStart } from '../src/host/hook/modes.ts'
import { renderSnapshotWithStats } from '../src/host/prompt/snapshot.ts'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'

function seed(root: string) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'MEMORY.md'), '[2026-09-01] [id:aaaaaaaa] a durable rule\n')
}

describe('session start hook', () => {
  it('prints the same snapshot DSH injects', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-start-'))
    seed(root)
    const expected = renderSnapshotWithStats(new MaestroMemoryStore(root), { cwd: '/work/x' }).text
    expect(renderSessionStart({ cwd: '/work/x' }, { root })).toBe(expected)
  })

  it('prints the global part and a notice when the payload has no cwd', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-start2-'))
    seed(root)
    const out = renderSessionStart({}, { root })
    expect(out).toContain('a durable rule')
    expect(out).toMatch(/no project directory/i)
  })

  it('says nothing when the store cannot be read', () => {
    expect(renderSessionStart({ cwd: '/work/x' }, { root: '/definitely/missing/store' })).toBe('')
  })
})
