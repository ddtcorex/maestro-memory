import { describe, it, expect } from 'vitest'
import { mkdtempSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { makeHandlerBinder } from '../src/host/mcp/main.ts'

describe('mcp handler binder', () => {
  it('binds once and reuses while the root is unchanged', () => {
    const root = mkdtempSync(join(tmpdir(), 'bind-a-'))
    const binder = makeHandlerBinder({ resolveRoot: () => root })
    expect(binder.get().root).toBe(root)
    expect(binder.get().handlers).toBe(binder.get().handlers)
  })

  it('rebinds when the resolved root changes, and never recreates the old root', () => {
    const first = mkdtempSync(join(tmpdir(), 'bind-b-'))
    const second = mkdtempSync(join(tmpdir(), 'bind-c-'))
    let current = first
    const binder = makeHandlerBinder({ resolveRoot: () => current })
    binder.get()
    current = second
    const bound = binder.get()
    expect(bound.root).toBe(second)
    expect(existsSync(join(first, 'MEMORY.md'))).toBe(false)
    expect(existsSync(join(second, 'MEMORY.md'))).toBe(false)
    // Nothing was written just by binding.
    expect(readdirSync(second).filter((f) => f.endsWith('.md'))).toEqual([])
  })

  it('writes through the new root after a rebind', () => {
    const first = mkdtempSync(join(tmpdir(), 'bind-d-'))
    const second = mkdtempSync(join(tmpdir(), 'bind-e-'))
    let current = first
    const binder = makeHandlerBinder({ resolveRoot: () => current })
    binder.get().handlers.add({ target: 'memory', content: 'before the move' })
    current = second
    binder.get().handlers.add({ target: 'memory', content: 'after the move' })
    expect(existsSync(join(second, 'MEMORY.md'))).toBe(true)
    expect(existsSync(join(first, 'MEMORY.md'))).toBe(true)
    expect(binder.get().handlers.list({ target: 'memory' }).text).toContain('after the move')
  })
})
