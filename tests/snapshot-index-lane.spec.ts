import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'
import { renderSnapshotWithStats } from '../src/host/prompt/snapshot.ts'

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
    expect(Buffer.byteLength(lane, 'utf8')).toBeLessThanOrEqual(1024)
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
