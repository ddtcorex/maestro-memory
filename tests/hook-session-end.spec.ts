/**
 * `session-end` leaves one mechanical line per session: no model, no diff, no
 * guess. The dedup rule is the point of the test below — two sessions ending in
 * the same minute are two sessions, and one session ending twice is one.
 */
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSessionLine, recordSessionEnd } from '../src/host/hook/modes.ts'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'

describe('session end hook', () => {
  it('builds one line with time, project, branch and tool count', () => {
    const line = buildSessionLine(
      { cwd: '/work/acme-shop', branch: 'feat/x', toolCalls: 42 },
      new Date('2026-11-10T09:05:00Z'),
    )
    expect(line).toBe('[09:05] session ended · acme-shop · feat/x · 42 tools')
  })

  it('writes exactly one line, and a repeat for the same session adds nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end-'))
    const payload = { cwd: '/work/acme-shop', sessionId: 's-1' }
    const now = new Date('2026-11-10T09:05:00Z')
    recordSessionEnd(payload, { root, now })
    recordSessionEnd(payload, { root, now })
    const body = readFileSync(join(root, 'daily', '2026-11-10.md'), 'utf8')
    expect(body.trim().split('\n').filter(Boolean)).toHaveLength(1)
  })

  it('stores the documented line verbatim, with nothing appended', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end3-'))
    const now = new Date('2026-11-10T09:05:00Z')
    recordSessionEnd({ cwd: '/work/acme-shop', branch: 'feat/x', toolCalls: 42, sessionId: 's-1' }, { root, now })
    const body = readFileSync(join(root, 'daily', '2026-11-10.md'), 'utf8')
    expect(body.trim()).toBe('[09:05] session ended · acme-shop · feat/x · 42 tools [session:s-1]')
  })

  it('reads the session id the harness actually sends, and dedups on it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end4-'))
    const payload = { cwd: '/work/acme-shop', hook_event_name: 'SessionEnd', session_id: '55f8e355' }
    recordSessionEnd(payload, { root, now: new Date('2026-11-10T09:05:00Z') })
    recordSessionEnd(payload, { root, now: new Date('2026-11-10T09:40:00Z') })
    const body = readFileSync(join(root, 'daily', '2026-11-10.md'), 'utf8')
    expect(body).toContain('[session:55f8e355]')
    expect(body.split('§').filter((entry) => entry.trim())).toHaveLength(1)
  })

  it('reports zero tools and no branch when the payload carries neither', () => {
    const line = buildSessionLine(
      { cwd: '/work/acme-shop', session_id: 'x' },
      new Date('2026-11-10T09:05:00Z'),
    )
    expect(line).toBe('[09:05] session ended · acme-shop · - · 0 tools [session:x]')
  })

  it('records a different session in the same minute separately', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end2-'))
    const now = new Date('2026-11-10T09:05:00Z')
    recordSessionEnd({ cwd: '/work/a', sessionId: 's-1' }, { root, now })
    recordSessionEnd({ cwd: '/work/b', sessionId: 's-2' }, { root, now })
    const store = new MaestroMemoryStore(root)
    expect(store.list('daily' as any, undefined, { date: '2026-11-10' } as any)).toHaveLength(2)
  })
})
