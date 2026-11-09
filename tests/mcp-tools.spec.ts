import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolHandlers } from '../src/host/mcp/tools.ts'

let root: string
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-mcp-'))
})
afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function seed(rel: string, body: string): void {
  const full = join(root, rel)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
}

describe('mcp tool layer', () => {
  it('searches and opens', () => {
    seed('MEMORY.md', '[2026-09-01] [id:aaaaaaaa] phpcs runs on internal api')
    const h = createToolHandlers({ root })
    expect(h.search({ query: 'phpcs' }).text).toContain('aaaaaaaa')
    expect(h.search({ id: 'aaaaaaaa' }).text).toContain('phpcs runs')
    expect(h.search({ id: 'ffffffff' }).text).toBe('not found: ffffffff')
  })

  it('refuses an explicit cwd-scoped search without cwd', () => {
    const h = createToolHandlers({ root })
    expect(h.search({ query: 'x', tracks: 'key' }).text).toMatch(/cwd is required/)
  })

  it('refuses a key write and points at the queue', () => {
    const h = createToolHandlers({ root })
    const out = h.add({ target: 'key', content: 'rule', cwd: '/work/x' })
    expect(out.text).toMatch(/gated|queue/i)
  })

  it('refuses a key suggestion without cwd', () => {
    const h = createToolHandlers({ root })
    expect(h.suggest({ target: 'key', content: 'rule', reason: 'why' }).text).toMatch(/cwd/)
  })

  it('writes a memory entry and lists it back', () => {
    const h = createToolHandlers({ root })
    h.add({ target: 'memory', content: 'durable note' })
    expect(h.list({ target: 'memory' }).text).toContain('durable note')
  })

  it('never writes without a cwd on a cwd-scoped track', () => {
    const h = createToolHandlers({ root })
    expect(h.add({ target: 'project', content: 'x' }).text).toMatch(/cwd/)
  })

  it('renders session-free context from a cwd', () => {
    seed('MEMORY.md', '[2026-09-01] [id:aaaaaaaa] a durable note')
    const h = createToolHandlers({ root })
    const out = h.context({ cwd: '/work/x' }).text
    expect(out).toContain('a durable note')
    expect(out).not.toContain('# Session')
  })
})
