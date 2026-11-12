/**
 * The closing note names the tools the reading host actually has. DSH has
 * `memory` and `maestro_todo`; an MCP client (Claude Code, Codex, Cursor) has
 * `memory_add` and `memory_suggest` and no todo tool, and a note that names a
 * tool the session does not have reads as background rather than as a duty.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MaestroMemoryStore } from '../src/host/memory/store.ts'
import { MCP_CLIENT_TURN_END, renderSnapshotWithStats } from '../src/host/prompt/snapshot.ts'
import { renderSessionStart } from '../src/host/hook/modes.ts'
import { createToolHandlers } from '../src/host/mcp/tools.ts'

let root: string
let store: MaestroMemoryStore
const CWD = '/work/example-project'

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'maestro-turn-end-'))
  store = new MaestroMemoryStore(root)
  store.add('memory', 'a global rule')
  store.add('key', 'a project rule', CWD, { summary: 'project rule' })
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('turn-end note per host', () => {
  it('an mcp host ends with the mcp client note', () => {
    const text = renderSnapshotWithStats(store, { cwd: CWD, host: 'mcp' }).text
    expect(text.trimEnd().endsWith(MCP_CLIENT_TURN_END.trimEnd())).toBe(true)
    for (const word of ['memory_add', 'target=daily', 'memory_suggest', 'target=key']) expect(MCP_CLIENT_TURN_END).toContain(word)
    expect(text).not.toContain('maestro_todo')
    expect(text).not.toContain('End of every turn')
  })

  it('the dsh host keeps its note, byte for byte', () => {
    const implicit = renderSnapshotWithStats(store, { cwd: CWD }).text
    const explicit = renderSnapshotWithStats(store, { cwd: CWD, host: 'dsh' }).text
    expect(explicit).toBe(implicit)
    expect(implicit.trimEnd().endsWith('(bounded, max 8).')).toBe(true)
    expect(implicit).not.toContain(MCP_CLIENT_TURN_END.trim())
  })

  it('a subagent keeps its own cadence on either host', () => {
    const text = renderSnapshotWithStats(store, { cwd: CWD, host: 'mcp', isSubagent: true }).text
    expect(text).toContain('Turn end (subagent session)')
    expect(text).not.toContain(MCP_CLIENT_TURN_END.trim())
  })

  it('the session-start hook renders with the mcp client note', () => {
    const text = renderSessionStart({ cwd: CWD }, { root })
    expect(text.trimEnd().endsWith(MCP_CLIENT_TURN_END.trimEnd())).toBe(true)
  })

  it('the memory_context tool renders with the mcp client note', () => {
    const text = createToolHandlers({ root }).context({ cwd: CWD }).text
    expect(text).toContain(MCP_CLIENT_TURN_END.trim())
  })
})
