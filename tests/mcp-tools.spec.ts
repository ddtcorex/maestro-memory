import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createToolHandlers } from '../src/host/mcp/tools.ts'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'

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
  // The store refuses to write over a non-canonical file, so fixtures end with
  // the canonical trailing newline isCanonical() requires.
  writeFileSync(full, body.endsWith('\n') ? body : `${body}\n`)
}

describe('mcp tool layer', () => {
  it('searches and opens', () => {
    seed('MEMORY.md', '[2026-09-01] [id:aaaaaaaa] phpcs runs on internal api')
    const h = createToolHandlers({ root })
    expect(h.search({ query: 'phpcs' }).text).toContain('aaaaaaaa')
    expect(h.search({ id: 'aaaaaaaa' }).text).toContain('phpcs runs')
    expect(h.search({ id: 'ffffffff' }).text).toBe('not found: ffffffff')
  })

  it('refuses a cwd-scoped WRITE without cwd, while reads fall back to the process cwd', () => {
    const h = createToolHandlers({ root })
    expect(h.add({ target: 'project', content: 'x' }).text).toMatch(/cwd is required/)
    // A read with no cwd is not an error: it reads the directory the server was
    // started in, which is what a foreign client expects.
    expect(h.search({ query: 'nothing here', tracks: 'key' }).text).toMatch(/no match/)
  })

  it('refuses a key write and names both ways to get the human decision', () => {
    const h = createToolHandlers({ root })
    const out = h.add({ target: 'key', content: 'rule', cwd: '/work/x' })
    expect(out.text).toMatch(/ask/i)
    expect(out.text).toContain('approved:true')
    expect(out.text).toContain('memory_suggest')
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

  it('shows the nearest existing entries after a write', () => {
    const h = createToolHandlers({ root })
    seed('MEMORY.md', '[2026-09-01] [id:aaaaaaaa] always run phpcs on internal api before commit')
    const out = h.add({ target: 'memory', content: 'run phpcs on internal api before committing' })
    expect(out.text).toContain('added')
    expect(out.text).toContain('aaaaaaaa')
  })

  it('renders session-free context from a cwd', () => {
    seed('MEMORY.md', '[2026-09-01] [id:aaaaaaaa] a durable note')
    const h = createToolHandlers({ root })
    const out = h.context({ cwd: '/work/x' }).text
    expect(out).toContain('a durable note')
    expect(out).not.toContain('# Session')
  })
})

// --- review follow-up: the two review-focus inputs that came out half-built ---

describe('mcp tool layer — review follow-up', () => {
  it('defaults reads to the process cwd so a client that omits cwd still sees project memory', async () => {
    const { projectKeyPath } = await import('../src/host/storage/layout.ts')
    const keyFile = projectKeyPath(root, process.cwd())
    mkdirSync(join(keyFile, '..'), { recursive: true })
    writeFileSync(keyFile, '[2026-09-01] [id:aaaaaaaa] a project key rule\n')
    const h = createToolHandlers({ root })
    expect(h.context({}).text).toContain('a project key rule')
    expect(h.search({ query: 'project key rule' }).text).toContain('aaaaaaaa')
    expect(h.list({ target: 'key' }).text).toContain('a project key rule')
  })

  it('stores the cwd of a key suggestion instead of dropping it', async () => {
    const { readFileSync } = await import('node:fs')
    const { suggestionsPath } = await import('../src/host/storage/layout.ts')
    const h = createToolHandlers({ root })
    h.suggest({ target: 'key', content: 'a project key rule', reason: 'why', cwd: '/work/proj-x' })
    const raw = readFileSync(suggestionsPath(root), 'utf8').trim().split('\n').filter(Boolean)
    expect(raw).toHaveLength(1)
    expect(JSON.parse(raw[0]).cwd).toBe('/work/proj-x')
  })

  it('never lists the entry it just wrote as its own near-duplicate, and reports an id', () => {
    const h = createToolHandlers({ root })
    const out = h.add({ target: 'memory', content: 'a note that exists nowhere else at all' })
    expect(out.text).toMatch(/added [0-9a-f]{8}/)
    const [, afterAdded] = out.text.split('\n')
    expect(afterAdded ?? '').not.toContain('exists nowhere else')
  })

  it('includes key entries in the near-duplicate check when a cwd is given', async () => {
    const { projectKeyPath } = await import('../src/host/storage/layout.ts')
    const keyFile = projectKeyPath(root, '/work/proj-x')
    mkdirSync(join(keyFile, '..'), { recursive: true })
    writeFileSync(keyFile, '[2026-09-01] [id:aaaaaaaa] always run phpcs on internal api before commit\n')
    const h = createToolHandlers({ root })
    const out = h.add({ target: 'memory', content: 'run phpcs on internal api before committing', cwd: '/work/proj-x' })
    expect(out.text).toContain('aaaaaaaa')
  })

  it('does not leave a dangling body line when full is set and a hit cannot be reopened', () => {
    seed('MEMORY.md', '[2026-09-01] [id:aaaaaaaa] phpcs runs on internal api')
    const h = createToolHandlers({ root })
    const text = h.search({ query: 'phpcs', full: true }).text
    expect(text.endsWith('\n')).toBe(false)
  })

  it('names the existing entry when a write is deduplicated', () => {
    const h = createToolHandlers({ root })
    const first = h.add({ target: 'memory', content: 'an identical note about one subject' })
    const firstId = /added ([0-9a-f]{8})/.exec(first.text)?.[1]
    expect(firstId).toBeTruthy()
    const second = h.add({ target: 'memory', content: 'an identical note about one subject' })
    expect(second.text).toMatch(/duplicate/i)
    expect(second.text).toContain(firstId!)
  })

  it('uses the spec verbatim cwd refusal on the write path', async () => {
    const { REFUSAL_CWD_REQUIRED } = await import('../src/host/memory/search/presentation.ts')
    const h = createToolHandlers({ root })
    expect(h.add({ target: 'project', content: 'x' }).text).toBe(REFUSAL_CWD_REQUIRED)
  })

  it('renders exactly the snapshot the DSH binding renders', async () => {
    const { renderSnapshotWithStats } = await import('../src/host/prompt/snapshot.ts')
    const { MaestroMemoryStore } = await import('../src/host/memory/store.ts')
    seed('MEMORY.md', '[2026-09-01] [id:aaaaaaaa] a durable note')
    const h = createToolHandlers({ root })
    const expected = renderSnapshotWithStats(new MaestroMemoryStore(root), { cwd: '/work/x' }).text
    expect(h.context({ cwd: '/work/x' }).text).toBe(expected)
  })
})

describe('binding parity', () => {
  it('returns byte-identical output to the DSH tool for the same store and query', async () => {
    const { apply } = await import('../src/host/index.ts')
    seed('MEMORY.md', '[2026-09-01] [id:aaaaaaaa] phpcs runs on the internal api only\n')
    const dshCtx: any = {
      tools: { register: (t: any) => { dshCtx.state.tools.push(t); return () => {} } },
      systemPrompt: { context: () => () => {} },
      connection: { rpc: { handle: () => () => {}, call: async () => ({ ok: true, value: {} }) } },
      effect: (fn: any) => fn(),
      on: () => () => {},
      get: () => undefined,
      state: { tools: [] },
    }
    apply(dshCtx, { memoryDir: root })
    const dsh = dshCtx.state.tools.find((t: any) => t.name === 'memory_search')
    const dshOut = (await dsh.execute({ query: 'phpcs internal api', cwd: '/work/x' }, { signal: { aborted: false } }))
      .content[0].text
    const mcpOut = createToolHandlers({ root }).search({ query: 'phpcs internal api', cwd: '/work/x' }).text
    expect(mcpOut).toBe(dshOut)
  })
})

describe('key writes need in-chat consent', () => {
  it('refuses a key write that does not carry the human decision', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-key-'))
    const handlers = createToolHandlers({ root })
    const res = handlers.add({ target: 'key', content: 'a rule nobody approved', cwd: '/work/x' })
    expect(res.text).toMatch(/ask/i)
    expect(res.text).toContain('approved:true')
    expect(new MaestroMemoryStore(root).list('key', '/work/x')).toHaveLength(0)
  })

  it('writes the key entry once the human agreed in the session', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-key2-'))
    const handlers = createToolHandlers({ root })
    const res = handlers.add({
      target: 'key',
      content: 'phpcs runs before merge',
      cwd: '/work/x',
      approved: true,
      summary: 'phpcs before merge',
    })
    expect(res.text).toMatch(/^added /)
    expect(new MaestroMemoryStore(root).list('key', '/work/x')).toHaveLength(1)
  })

  it('drops the queued suggestion for the rule it just wrote', () => {
    // Found live: the model queued the rule, then wrote it after the human said
    // yes, and the queue kept the obsolete row. The session-start notice then
    // reports a suggestion for something already in the store.
    const root2 = mkdtempSync(join(tmpdir(), 'mcp-key4-'))
    const handlers = createToolHandlers({ root: root2 })
    const q = () =>
      readFileSync(join(root2, 'SUGGESTIONS.jsonl'), 'utf8').split('\n').filter((l) => l.trim()).length
    handlers.suggest({ target: 'key', content: 'phpcs must pass before merge', reason: 'a rule', cwd: '/work/x' })
    expect(q()).toBe(1)
    handlers.add({ target: 'key', content: 'phpcs must pass before merge', cwd: '/work/x', approved: true })
    expect(q()).toBe(0)
  })

  it('still requires a project for a key write, because key is per project', () => {
    const root = mkdtempSync(join(tmpdir(), 'mcp-key3-'))
    const handlers = createToolHandlers({ root })
    const res = handlers.add({ target: 'key', content: 'a rule', approved: true })
    expect(res.text).toMatch(/cwd/i)
  })
})
