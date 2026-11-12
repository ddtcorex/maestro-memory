import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'
import { renderSnapshotWithStats, SNAPSHOT_SECTION_CAPS, SNAPSHOT_SECTION_MAX_ENTRIES } from '../src/host/prompt/snapshot.ts'
import { HOOK_MAX_BYTES, renderSessionStart } from '../src/host/hook/modes.ts'
import { projectReferencePath } from '../src/host/storage/layout.ts'

let root: string
let store: MaestroMemoryStore
const CWD = '/work/example-project'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-index-lane-'))
  store = new MaestroMemoryStore(root)
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

function render(): string {
  return renderSnapshotWithStats(store, { cwd: CWD, sessionId: 's-test', sessionName: null } as any).text
}

describe('snapshot index lane', () => {
  it('lists ids and summaries of entries the key lane did not include', () => {
    for (let i = 0; i < 20; i++) {
      store.add('key', `older entry ${i} about topic ${i}`, CWD, { summary: `older summary ${i}` })
    }
    const text = render()
    expect(text).toContain('# Key Memory Index')
    expect(text).toMatch(/\[id:[0-9a-f]{8}\] older summary/)
  })

  it('never repeats an id already shown in full', () => {
    for (let i = 0; i < 20; i++) {
      store.add('key', `entry ${i}`, CWD, { summary: `summary ${i}` })
    }
    const text = render()
    const keySection = text.split('# Project Key Memory')[1]?.split('# Key Memory Index')[0] ?? ''
    const keyIds = [...keySection.matchAll(/\[id:([0-9a-f]{8})\]/g)].map((m) => m[1])
    const indexSection = text.split('# Key Memory Index')[1]?.split('\n---')[0] ?? ''
    const indexIds = [...indexSection.matchAll(/\[id:([0-9a-f]{8})\]/g)].map((m) => m[1])
    expect(keyIds.length).toBeGreaterThan(0)
    expect(indexIds.length).toBeGreaterThan(0)
    expect(indexIds.filter((id) => keyIds.includes(id))).toEqual([])
  })

  it('keeps the lane inside its byte budget', () => {
    for (let i = 0; i < 60; i++) {
      store.add('key', `entry ${i}`, CWD, { summary: `a deliberately long summary for entry ${i} that pads the lane` })
    }
    const text = render()
    const lane = text.split('# Key Memory Index')[1]?.split('\n---')[0] ?? ''
    expect(Buffer.byteLength(lane, 'utf8')).toBeLessThanOrEqual(SNAPSHOT_SECTION_CAPS.keyIndex + 64)
  })

  it('lists more entries by summary than the key lane injects in full', () => {
    for (let i = 0; i < 40; i++) {
      store.add('key', `rule ${i}: ${'detail '.repeat(60)}`, CWD, { summary: `rule ${i} about a convention that matters for this project` })
    }
    const text = render()
    const keyLane = text.split('# Project Key Memory')[1]?.split('# Key Memory Index')[0] ?? ''
    const indexLines = (text.split('# Key Memory Index')[1] ?? '').split('\n').filter((l) => l.startsWith('- '))
    const fullEntries = [...keyLane.matchAll(/\[id:[0-9a-f]{8}\]/g)].length
    expect(fullEntries).toBeLessThanOrEqual(SNAPSHOT_SECTION_MAX_ENTRIES.key)
    expect(indexLines.length).toBeGreaterThanOrEqual(20)
    expect(indexLines.length).toBeGreaterThan(fullEntries * 3)
  })

  it('takes the index budget from caps.keyIndex', () => {
    for (let i = 0; i < 40; i++) store.add('key', `entry ${i}`, CWD, { summary: `summary number ${i} padded to a realistic width` })
    const text = renderSnapshotWithStats(store, { cwd: CWD } as any, { caps: { keyIndex: 300 } }).text
    const lines = (text.split('# Key Memory Index')[1] ?? '').split('\n').filter((l) => l.startsWith('- '))
    expect(lines.length).toBeGreaterThan(0)
    expect(Buffer.byteLength(lines.join('\n'), 'utf8')).toBeLessThanOrEqual(300)
  })

  it('a worst-case store renders through the hook within budget, note intact', () => {
    for (let i = 0; i < 10; i++) store.add('memory', `global rule ${i} ${'g'.repeat(500)}`, undefined, { summary: `g${i}` })
    for (let i = 0; i < 10; i++) store.add('user', `user pref ${i} ${'u'.repeat(500)}`, undefined, { summary: `u${i}` })
    for (let i = 0; i < 200; i++) store.add('key', `key ${i} ${'k'.repeat(800)}`, CWD, { summary: `key rule ${i} with a summary of realistic length for the index` })
    for (let i = 0; i < 6; i++) store.add('project', `progress ${i} ${'p'.repeat(700)}`, CWD)
    store.add('daily', `today ${'d'.repeat(600)}`)
    const ref = projectReferencePath(root, CWD)
    mkdirSync(dirname(ref), { recursive: true })
    writeFileSync(ref, `# Reference\n${'r'.repeat(5000)}`)
    const text = renderSessionStart({ cwd: CWD }, { root })
    expect(Buffer.byteLength(text, 'utf8')).toBeLessThanOrEqual(HOOK_MAX_BYTES)
    expect(text).not.toContain('cut to stay inside the harness hook limit')
    expect(text).toContain('# Key Memory Index')
  })

  it('renders before the discipline note, which stays last', () => {
    for (let i = 0; i < 20; i++) store.add('key', `entry ${i}`, CWD, { summary: `s${i}` })
    const text = render()
    const laneAt = text.indexOf('# Key Memory Index')
    const noteAt = text.indexOf('End of every turn')
    expect(laneAt).toBeGreaterThan(-1)
    expect(noteAt).toBeGreaterThan(laneAt)
    expect(text.trimEnd().endsWith('(bounded, max 8).')).toBe(true)
  })

  it('adds nothing when every entry is already injected', () => {
    store.add('key', 'only entry', CWD, { summary: 'only summary' })
    expect(render()).not.toContain('# Key Memory Index')
  })
})
