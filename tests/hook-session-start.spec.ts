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
import { Buffer } from 'node:buffer'
import { HOOK_MAX_BYTES, renderSessionStart, runHook } from '../src/host/hook/modes.ts'
import { createToolHandlers } from '../src/host/mcp/tools.ts'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'

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

  it('stays inside the size the harness injects inline', () => {
    // Measured on Claude Code 2.1.322: a SessionStart hook whose stdout is 10,000
    // bytes is injected as text, and 11,000 bytes is written to a file with only a
    // ~2 KB preview injected instead. A snapshot of a full store is 12 KB or more,
    // which silently dropped the project lanes the session needed most.
    const root = mkdtempSync(join(tmpdir(), 'hook-start4-'))
    const store = new MaestroMemoryStore(root)
    store.add('user', `u${'u'.repeat(3000)}`)
    store.add('memory', `m${'m'.repeat(3000)}`)
    store.add('key', `THE-KEY-MARKER ${'k'.repeat(3000)}`, '/work/x', { summary: 'a key rule' })
    store.add('project', `p${'p'.repeat(4000)}`, '/work/x')

    const out = renderSessionStart({ cwd: '/work/x' }, { root })
    expect(Buffer.byteLength(out, 'utf8')).toBeLessThanOrEqual(HOOK_MAX_BYTES)
    // And the lane that matters for a session still survived the cut.
    expect(out).toContain('THE-KEY-MARKER')
  })

  it('says how many suggestions are waiting for approval', () => {
    // The queue is invisible from Claude otherwise: nothing lists it, so a
    // suggestion sits there until someone happens to open the DSH Memory view.
    const root = mkdtempSync(join(tmpdir(), 'hook-start5-'))
    seed(root)
    const entry = (content: string) =>
      `${JSON.stringify({ time: '2026-11-10T09:00:00.000Z', target: 'key', content, reason: 'worth keeping' })}\n`
    writeFileSync(join(root, 'SUGGESTIONS.jsonl'), entry('rule one') + entry('rule two'))

    const out = renderSessionStart({ cwd: '/work/x' }, { root })
    expect(out).toMatch(/2 suggestions? (is|are) waiting/i)
    expect(out).toMatch(/DSH Memory view/i)
  })

  it('adds no notice when nothing is waiting', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-start6-'))
    seed(root)
    expect(renderSessionStart({ cwd: '/work/x' }, { root })).not.toMatch(/waiting for approval/i)
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
