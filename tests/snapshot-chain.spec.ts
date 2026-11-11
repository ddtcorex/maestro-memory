/**
 * A session started in a sub-repo of a workspace must see the workspace's key
 * memory too. Buckets are `sha1(realpath(cwd))`, so without a chain a session in
 * `ws/sub` reads an empty bucket while `ws/` holds every rule. Writes are not
 * part of this: a project write still lands in the cwd's own bucket.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'
import { renderSnapshotWithStats } from '../src/host/prompt/snapshot.ts'
import { projectChain, projectDir } from '../src/host/storage/layout.ts'

let root: string
let base: string
let store: MaestroMemoryStore
let home: string
let ws: string
let sub: string

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-chain-store-'))
  base = mkdtempSync(join(tmpdir(), 'maestro-chain-fs-'))
  home = join(base, 'home')
  ws = join(home, 'work', 'ws')
  sub = join(ws, 'sub')
  mkdirSync(sub, { recursive: true })
  store = new MaestroMemoryStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(base, { recursive: true, force: true })
})

const bucket = (dir: string) => mkdirSync(projectDir(root, dir), { recursive: true })
const render = (cwd: string) => renderSnapshotWithStats(store, { cwd, home } as any).text

describe('projectChain', () => {
  it('includes cwd and ancestors with buckets, nearest first', () => {
    bucket(sub)
    bucket(ws)
    expect(projectChain(root, sub, home)).toEqual([sub, ws])
  })

  it('skips ancestors without a bucket', () => {
    bucket(ws)
    expect(projectChain(root, sub, home)).toEqual([ws])
  })

  it('never includes home or anything above it', () => {
    bucket(home)
    bucket(base)
    bucket(ws)
    expect(projectChain(root, sub, home)).toEqual([ws])
    expect(projectChain(root, home, home)).toEqual([])
  })

  it('returns nothing for an empty cwd', () => {
    expect(projectChain(root, '', home)).toEqual([])
  })
})

describe('snapshot over the chain', () => {
  it('renders the workspace key entries in a sub-repo', () => {
    store.add('key', 'workspace rule: never push to master', ws, { summary: 'workspace push rule' })
    const text = render(sub)
    expect(text).toContain('# Project Key Memory')
    expect(text).toContain('workspace rule: never push to master')
  })

  it('lets the nearest bucket win the key budget', () => {
    for (let i = 0; i < 20; i++) store.add('key', `workspace entry ${i} ${'w'.repeat(400)}`, ws, { summary: `ws ${i}` })
    for (let i = 0; i < 4; i++) store.add('key', `sub entry ${i} ${'s'.repeat(400)}`, sub, { summary: `sub ${i}` })
    const text = render(sub)
    const keyLane = text.split('# Project Key Memory')[1].split('\n# ')[0]
    // Every sub-repo entry is kept, the workspace fills what is left newest first,
    // and its oldest entries are the ones the budget drops.
    for (let i = 0; i < 4; i++) expect(keyLane).toContain(`sub entry ${i}`)
    expect(keyLane).toContain('workspace entry 19')
    expect(keyLane).not.toContain('workspace entry 0 ')
  })

  it('renders a cwd with no bucket in the chain exactly as before', () => {
    store.add('memory', 'a global rule')
    const lonely = join(base, 'elsewhere')
    mkdirSync(lonely)
    const withHome = renderSnapshotWithStats(store, { cwd: lonely, home } as any).text
    const plain = renderSnapshotWithStats(store, { cwd: lonely } as any).text
    expect(withHome).toBe(plain)
    expect(withHome).not.toContain('# Project Key Memory')
  })
})
