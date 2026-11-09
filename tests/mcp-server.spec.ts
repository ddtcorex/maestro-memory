import { describe, it, expect } from 'vitest'
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveServerRoot } from '../src/host/mcp/main.ts'

/**
 * The one test that proves the transport works: a real process, the real protocol
 * frames, the real store. Node loads the TypeScript entry directly, so `pnpm test`
 * does not need a build first.
 */
describe('mcp server process', () => {
  it('answers initialize, tools/list and one tools/call, then exits on stdin close', async () => {
    const home = mkdtempSync(join(tmpdir(), 'maestro-mcp-home-'))
    const child = spawn(
      process.execPath,
      ['--experimental-transform-types', join(process.cwd(), 'src/host/mcp/main.ts')],
      { env: { ...process.env, DSH_HOME: home, NODE_NO_WARNINGS: '1' }, stdio: ['pipe', 'pipe', 'pipe'] },
    )

    let buffer = ''
    const replies: any[] = []
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.trim()) continue
        try {
          replies.push(JSON.parse(line))
        } catch {}
      }
    })

    const send = (payload: unknown) => child.stdin.write(`${JSON.stringify(payload)}\n`)
    const waitFor = async (id: number) => {
      for (let i = 0; i < 100; i++) {
        const found = replies.find((r) => r.id === id)
        if (found) return found
        await new Promise((r) => setTimeout(r, 50))
      }
      throw new Error(`no reply for id ${id}; got ${JSON.stringify(replies)}`)
    }

    try {
      send({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'test', version: '1' } },
      })
      const init = await waitFor(1)
      expect(init.result?.protocolVersion).toBeTruthy()

      send({ jsonrpc: '2.0', method: 'notifications/initialized' })
      send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} })
      const list = await waitFor(2)
      expect(list.result.tools.map((t: any) => t.name)).toEqual([
        'memory_search',
        'memory_context',
        'memory_list',
        'memory_add',
        'memory_suggest',
      ])
      // The wire annotation is what a client uses to tell reads from writes.
      expect(list.result.tools[0].annotations).toMatchObject({ readOnlyHint: true })
      expect(list.result.tools[3].annotations).toMatchObject({ readOnlyHint: false })

      send({
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'memory_search', arguments: { query: 'anything' } },
      })
      const call = await waitFor(3)
      expect(call.result.content[0]).toMatchObject({ type: 'text' })
    } finally {
      child.stdin.end()
      const code = await new Promise<number | null>((resolve) => child.on('exit', resolve))
      rmSync(home, { recursive: true, force: true })
      expect(code).toBe(0)
    }
  }, 30_000)

  it('starts when the entry is reached through a symlink, the way a bin install does', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'maestro-mcp-bin-'))
    const link = join(dir, 'maestro-memory-mcp')
    symlinkSync(join(process.cwd(), 'src/host/mcp/main.ts'), link)
    const child = spawn(process.execPath, ['--experimental-transform-types', link], {
      env: { ...process.env, DSH_HOME: join(dir, 'home'), NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let out = ''
    child.stdout.on('data', (chunk) => { out += chunk.toString('utf8') })
    try {
      child.stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } } })}\n`,
      )
      for (let i = 0; i < 60 && !out.includes('protocolVersion'); i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(out).toContain('protocolVersion')
    } finally {
      child.stdin.end()
      await new Promise((resolve) => child.on('exit', resolve))
      rmSync(dir, { recursive: true, force: true })
    }
  }, 20_000)

  it('serves the home it was told to use, not the one in the environment', () => {
    expect(resolveServerRoot({ dshHome: '/tmp/probe-home-opt' })).toBe('/tmp/probe-home-opt/maestro-memory')
    expect(resolveServerRoot({ dshHome: '/tmp/probe-home-opt', memoryDir: '/custom/dir' })).toBe('/custom/dir')
  })

  it('reports a refused boot migration on stderr instead of serving silently', async () => {
    const root = mkdtempSync(join(tmpdir(), 'maestro-mcp-refuse-'))
    const dshHome = join(root, '.dsh')
    // Default mode (DSH_HOME is <tmp home>/.dsh) with both roots present: refusal.
    mkdirSync(join(dshHome, 'dsh-maestro-memory'), { recursive: true })
    mkdirSync(join(dshHome, 'maestro-memory'), { recursive: true })
    writeFileSync(join(dshHome, 'dsh-maestro-memory', 'MEMORY.md'), 'old\n')
    writeFileSync(join(dshHome, 'maestro-memory', 'MEMORY.md'), 'new\n')
    const child = spawn(process.execPath, ['--experimental-transform-types', join(process.cwd(), 'src/host/mcp/main.ts')], {
      env: { ...process.env, HOME: root, DSH_HOME: dshHome, NODE_NO_WARNINGS: '1' },
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    let err = ''
    child.stderr.on('data', (chunk) => { err += chunk.toString('utf8') })
    try {
      for (let i = 0; i < 60 && !err.includes('migration'); i++) {
        await new Promise((r) => setTimeout(r, 50))
      }
      expect(err).toMatch(/migration refused/i)
    } finally {
      child.stdin.end()
      await new Promise((resolve) => child.on('exit', resolve))
      rmSync(root, { recursive: true, force: true })
    }
  }, 20_000)
})
