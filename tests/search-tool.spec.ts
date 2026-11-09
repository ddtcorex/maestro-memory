import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { apply } from '../src/host/index.ts'

let root: string
const CWD = '/work/example-project'

async function seed(files: Record<string, string>): Promise<void> {
  for (const [rel, body] of Object.entries(files)) {
    const full = join(root, rel)
    await mkdir(join(full, '..'), { recursive: true })
    await writeFile(full, body, 'utf8')
  }
}

function fakeCtx() {
  const tools: any[] = []
  return {
    tools: { register: (t: any) => { tools.push(t); return () => {} } },
    systemPrompt: { context: () => () => {} },
    connection: { rpc: { handle: () => () => {}, call: async () => ({ ok: true, value: {} }) } },
    effect: (fn: any) => fn(),
    on: () => () => {},
    get: () => undefined,
    state: { tools },
  } as any
}

function searchTool(): any {
  const ctx = fakeCtx()
  apply(ctx, { memoryDir: root })
  const tool = ctx.state.tools.find((t: any) => t.name === 'memory_search')
  expect(tool, 'memory_search must be registered').toBeDefined()
  return tool
}

async function run(args: Record<string, unknown>): Promise<string> {
  const result = await searchTool().execute(args, { signal: { aborted: false } })
  return result.content.map((c: any) => c.text).join('\n')
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'maestro-search-tool-'))
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

describe('the memory_search tool', () => {
  it('returns compact hits with id, track, date and a preview', async () => {
    await seed({ 'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] the public-api lint gate runs phpcs only on internal api' })
    const out = await run({ query: 'phpcs' })
    expect(out).toMatch(/aaaaaaaa/)
    expect(out).toMatch(/memory/)
    expect(out).toMatch(/2026-09-01/)
    expect(out).toContain('phpcs')
  })

  it('opens one entry in full when given an id', async () => {
    await seed({ 'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] the whole body of the note lives here' })
    const out = await run({ id: 'aaaaaaaa' })
    expect(out).toContain('the whole body of the note lives here')
  })

  it('reports an unknown id instead of inventing content', async () => {
    await seed({ 'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] something' })
    const out = await run({ id: 'ffffffff' })
    expect(out).toMatch(/not found/i)
  })

  it('clamps the limit to 25', async () => {
    const entries = Array.from({ length: 40 }, (_, i) => `[2026-09-01] [id:${String(i).padStart(8, '0')}] shared token ${i}`)
    await seed({ 'MEMORY.md': entries.join('\n§\n') })
    const out = await run({ query: 'shared', limit: 999 })
    expect(out.split('\n').filter((line) => /^[0-9a-f]{8}/.test(line.trim()))).toHaveLength(25)
  })

  it('scopes the search to the requested tracks', async () => {
    await seed({
      'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] shared word',
      'daily/2026-09-02.md': '[2026-09-02] [id:dddddddd] shared word',
    })
    const out = await run({ query: 'shared', tracks: 'memory' })
    expect(out).toContain('aaaaaaaa')
    expect(out).not.toContain('dddddddd')
  })

  it('asks for a cwd when a cwd-scoped track is requested', async () => {
    await seed({ 'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] shared word' })
    const out = await run({ query: 'shared', cwd: CWD })
    expect(out).toContain('aaaaaaaa')
    const missing = await run({ query: 'shared', tracks: 'key' })
    expect(missing).toMatch(/cwd/i)
  })

  it('says so when the query matches nothing', async () => {
    await seed({ 'MEMORY.md': '[2026-09-01] [id:aaaaaaaa] something else entirely' })
    const out = await run({ query: 'kubernetes' })
    expect(out).toMatch(/no match/i)
  })
})
