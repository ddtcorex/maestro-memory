/**
 * `session-end` leaves one mechanical line per session: no model, no diff, no
 * guess. The dedup rule is the point of several tests below — two sessions ending
 * in the same minute are two sessions, one session re-fired across local midnight
 * is one — and so is the store-root guard, because a hook that creates a second
 * store root stops the real one from ever migrating.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { buildSessionLine, recordSessionEnd } from '../src/host/hook/modes.ts'

/** A wall-clock instant in the calendar the store uses, so the test is zone-free. */
const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m - 1, d, h, min)

/** Entries are separated by the store's delimiter, not by newlines. */
const entriesIn = (file: string) => readFileSync(file, 'utf8').split('§').filter((entry) => entry.trim())

describe('session end hook', () => {
  it('builds one line with time, project, branch and tool count', () => {
    const line = buildSessionLine({ cwd: '/work/acme-shop', branch: 'feat/x', toolCalls: 42 }, at(2026, 11, 10, 9, 5))
    expect(line).toBe('[09:05] session ended · acme-shop · feat/x · 42 tools')
  })

  it('writes exactly one line, and a repeat for the same session adds nothing', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end-'))
    const payload = { cwd: '/work/acme-shop', sessionId: 's-1' }
    recordSessionEnd(payload, { root, now: at(2026, 11, 10, 9, 5) })
    recordSessionEnd(payload, { root, now: at(2026, 11, 10, 9, 5) })
    expect(entriesIn(join(root, 'daily', '2026-11-10.md'))).toHaveLength(1)
  })

  it('stores the documented line verbatim, with nothing appended', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end3-'))
    recordSessionEnd(
      { cwd: '/work/acme-shop', branch: 'feat/x', toolCalls: 42, sessionId: 's-1' },
      { root, now: at(2026, 11, 10, 9, 5) },
    )
    expect(entriesIn(join(root, 'daily', '2026-11-10.md'))[0]?.trim()).toBe(
      '[09:05] session ended · acme-shop · feat/x · 42 tools [session:s-1]',
    )
  })

  it('reads the session id the harness actually sends, and dedups on it', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end4-'))
    const payload = { cwd: '/work/acme-shop', hook_event_name: 'SessionEnd', session_id: '55f8e355' }
    recordSessionEnd(payload, { root, now: at(2026, 11, 10, 9, 5) })
    recordSessionEnd(payload, { root, now: at(2026, 11, 10, 9, 40) })
    const body = readFileSync(join(root, 'daily', '2026-11-10.md'), 'utf8')
    expect(body).toContain('[session:55f8e355]')
    expect(entriesIn(join(root, 'daily', '2026-11-10.md'))).toHaveLength(1)
  })

  it('reports zero tools and no branch when the payload carries neither', () => {
    const line = buildSessionLine({ cwd: '/work/acme-shop', session_id: 'x' }, at(2026, 11, 10, 9, 5))
    expect(line).toBe('[09:05] session ended · acme-shop · - · 0 tools [session:x]')
  })

  it('records a different session in the same minute separately', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end2-'))
    const now = at(2026, 11, 10, 9, 5)
    recordSessionEnd({ cwd: '/work/a', sessionId: 's-1' }, { root, now })
    recordSessionEnd({ cwd: '/work/b', sessionId: 's-2' }, { root, now })
    expect(entriesIn(join(root, 'daily', '2026-11-10.md'))).toHaveLength(2)
  })

  it('keeps one line for a session re-fired just after local midnight', () => {
    const root = mkdtempSync(join(tmpdir(), 'hook-end5-'))
    const payload = { cwd: '/work/acme-shop', session_id: 'late' }
    recordSessionEnd(payload, { root, now: at(2026, 11, 10, 23, 59) })
    recordSessionEnd(payload, { root, now: at(2026, 11, 11, 0, 1) })
    const written = readdirSync(join(root, 'daily')).flatMap((name) => entriesIn(join(root, 'daily', name)))
    expect(written).toHaveLength(1)
  })

  it('keeps the local calendar of the rest of the store when the machine clock is UTC', () => {
    // The store's other writers stamp days from the local calendar, and the prompt's
    // Recent Daily lane reads those days back. A UTC stamp in a UTC-10 zone writes
    // tomorrow's file, which nothing else ever opens. Forced here so a UTC CI runner
    // still catches a regression to UTC.
    const root = mkdtempSync(join(tmpdir(), 'hook-end-tz-'))
    const script = `
      import { recordSessionEnd } from ${JSON.stringify(pathToFileURL(join(process.cwd(), 'src/host/hook/modes.ts')).href)}
      recordSessionEnd({ cwd: '/work/acme-shop', session_id: 'tz' }, { root: process.env.STORE_ROOT, now: new Date(2026, 10, 10, 23, 30) })
    `
    const run = spawnSync(process.execPath, ['--experimental-transform-types', '--input-type=module', '-e', script], {
      env: { ...process.env, TZ: 'Pacific/Honolulu', STORE_ROOT: root, NODE_NO_WARNINGS: '1' },
      encoding: 'utf8',
    })
    expect(run.status).toBe(0)
    expect(readdirSync(join(root, 'daily'))).toEqual(['2026-11-10.md'])
    expect(entriesIn(join(root, 'daily', '2026-11-10.md'))[0]).toContain('[23:30]')
  })

  it('never creates the store root while a legacy store has not moved', () => {
    // The hook is the only writer that runs without the boot migration. If it
    // created the new root first, the migration would find two roots and refuse,
    // and the store would stop being served until a human intervened.
    const home = mkdtempSync(join(tmpdir(), 'hook-end6-'))
    const dshHome = join(home, '.dsh')
    mkdirSync(join(dshHome, 'maestro-memory'), { recursive: true })
    writeFileSync(join(dshHome, 'maestro-memory', 'MEMORY.md'), '[2026-09-01] a legacy rule\n')
    const root = join(home, '.maestro-memory')
    recordSessionEnd({ cwd: '/work/acme-shop', session_id: 's-1' }, { root, now: at(2026, 11, 10, 9, 5), dshHome })
    expect(readdirSync(home)).toEqual(['.dsh'])
  })
})
