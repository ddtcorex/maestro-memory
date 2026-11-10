/**
 * The bin as Claude Code actually runs it: a real process, a real payload on
 * stdin, the real exit code. Everything the unit tests reach around — the stdin
 * reader, the stdout write, the invokedDirectly guard, the exit path — is only
 * covered here, and those are the lines that decide whether a hook can block a
 * session.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const entry = join(process.cwd(), 'src/host/hook/main.ts')

/** Run the bin the way npm installs it: through a symlink, with the mode as argv. */
function runBin(args: string[], payload: string, env: Record<string, string> = {}) {
  const bin = join(mkdtempSync(join(tmpdir(), 'hook-bin-')), 'maestro-memory-hook')
  symlinkSync(entry, bin)
  return spawnSync(process.execPath, ['--experimental-transform-types', bin, ...args], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, NODE_NO_WARNINGS: '1', ...env },
  })
}

function seededStore(): string {
  const root = mkdtempSync(join(tmpdir(), 'hook-bin-store-'))
  mkdirSync(root, { recursive: true })
  writeFileSync(join(root, 'MEMORY.md'), '[2026-09-01] [id:aaaaaaaa] a durable rule\n')
  return root
}

describe('hook bin process', () => {
  it('prints the session context for session-start and exits 0', () => {
    const root = seededStore()
    const run = runBin(['session-start'], JSON.stringify({ cwd: '/work/x', session_id: 's-bin' }), {
      MAESTRO_MEMORY_DIR: root,
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toContain('a durable rule')
    expect(run.stderr).toBe('')
  })

  it('writes the diary line for session-end and exits 0', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-bin-end-'))
    const run = runBin(['session-end'], JSON.stringify({ cwd: '/work/acme-shop', session_id: 's-bin' }), {
      MAESTRO_MEMORY_DIR: root,
    })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    const [day] = readdirSync(join(root, 'daily'))
    expect(readFileSync(join(root, 'daily', day as string), 'utf8')).toContain('[session:s-bin]')
  })

  it('exits 0 and prints nothing for an invocation it does not understand', () => {
    const run = runBin(['nonsense'], '', { MAESTRO_MEMORY_DIR: '/definitely/missing/store' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
  })

  it('exits 0 with no mode at all, which is what an incomplete hook wiring sends', () => {
    const run = runBin([], JSON.stringify({ cwd: '/work/x' }), { MAESTRO_MEMORY_DIR: '/definitely/missing/store' })
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })
})
