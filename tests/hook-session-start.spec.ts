/**
 * `session-start` must print what the MCP tool `memory_context` prints, because
 * two different answers to "what does this project remember" is worse than one
 * answer that is merely incomplete. The parity test drives the two entry points
 * that exist in production rather than rendering twice with one function.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { renderSessionStart, runHook } from '../src/host/hook/modes.ts'
import { createToolHandlers } from '../src/host/mcp/tools.ts'

function seed(root: string) {
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'MEMORY.md'), '[2026-09-01] [id:aaaaaaaa] a durable rule\n')
}

describe('session start hook', () => {
  it('prints the same text the memory_context tool returns', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-start-'))
    seed(root)
    const fromTool = createToolHandlers({ root }).context({ cwd: '/work/x' }).text
    expect(renderSessionStart({ cwd: '/work/x' }, { root })).toBe(fromTool)
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

  it('follows MAESTRO_MEMORY_DIR, so a hook never reaches the live store', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-start3-'))
    seed(root)
    const previous = process.env.MAESTRO_MEMORY_DIR
    process.env.MAESTRO_MEMORY_DIR = root
    try {
      // No resolveRoot seam: this exercises the resolver the shipped bin uses.
      expect(runHook('session-start', { cwd: '/work/x' })).toContain('a durable rule')
    } finally {
      if (previous === undefined) delete process.env.MAESTRO_MEMORY_DIR
      else process.env.MAESTRO_MEMORY_DIR = previous
    }
  })
})
