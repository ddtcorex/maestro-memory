/**
 * The Stop hook: a Claude Code session that changed code or shipped something,
 * and wrote nothing to the shared store since, is asked once to write before it
 * stops. Lines here are synthetic, in the transcript shape measured on Claude
 * Code 2.1.322 (`type: "assistant"`, `message.content[]` with `tool_use` blocks,
 * `isSidechain` on every line); none is copied from a real transcript.
 */
import { describe, it, expect } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
// @ts-expect-error plain ESM hook without type declarations
import { decideStop, readTail, STOP_REASON } from '../hooks/stop.mjs'

const script = join(process.cwd(), 'hooks/stop.mjs')

function toolLine(name: string, input: Record<string, unknown> = {}, sidechain = false): string {
  return JSON.stringify({
    type: 'assistant',
    isSidechain: sidechain,
    message: { role: 'assistant', content: [{ type: 'tool_use', id: 'toolu_x', name, input }] },
  })
}
const edit = () => toolLine('Edit', { file_path: '/r/a.ts', old_string: 'a', new_string: 'b' })
const bash = (command: string) => toolLine('Bash', { command, description: 'd' })
function withId(line: string, id: string): string {
  const entry = JSON.parse(line)
  entry.message.content[0].id = id
  return JSON.stringify(entry)
}
function resultLine(id: string, isError: boolean): string {
  return JSON.stringify({
    type: 'user',
    isSidechain: false,
    message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, is_error: isError, content: isError ? 'denied' : 'ok' }] },
  })
}
const userLine = JSON.stringify({ type: 'user', isSidechain: false, message: { role: 'user', content: 'go' } })

const decide = (lines: string[], env: Record<string, string | undefined> = {}, stopHookActive = false) =>
  decideStop(lines, { stopHookActive, env })

describe('decideStop', () => {
  it('does not block when stop_hook_active', () => {
    expect(decide([userLine, edit(), edit(), edit(), edit(), edit()], {}, true)).toEqual({ block: false })
  })

  it('does not block below threshold', () => {
    expect(decide([userLine, edit(), edit(), edit(), edit()])).toEqual({ block: false })
  })

  it('blocks at five file edits since the last write', () => {
    const lines = [
      edit(),
      toolLine('Write', { file_path: '/r/b.ts', content: 'x' }),
      toolLine('NotebookEdit', { notebook_path: '/r/n.ipynb' }),
      edit(),
      edit(),
    ]
    const out = decide(lines)
    expect(out.block).toBe(true)
    expect(out.reason).toBe(STOP_REASON)
    for (const word of ['memory_add', 'target=daily', 'memory_suggest', 'target=key']) {
      expect(out.reason).toContain(word)
    }
  })

  it.each(['git commit -m x', 'git -C /r push origin b', 'git tag v1', 'gh pr merge 3 --squash', 'cd /r && git commit -q -m y'])(
    'blocks at one commit-like command: %s',
    (command) => {
      expect(decide([bash(command)]).block).toBe(true)
    },
  )

  it.each([
    'git -c user.name=x commit -m y',
    'GIT_TRACE=1 git push origin b',
    'env A=b git commit -m z',
    'git --no-pager tag v2',
    'git -C "/a b" commit -m q',
  ])('counts ship commands behind options and env prefixes: %s', (command) => {
    expect(decide([bash(command)]).block).toBe(true)
  })

  it.each([
    'git merge-base HEAD origin/master',
    'git merge-tree a b',
    'git commit-tree abc -m x',
    'git push --dry-run origin b',
    'git commit --dry-run',
    'git merge --abort',
    'git tag -d v1',
    'git tag --delete v1',
    'git tag -n',
    'git tag --contains abc',
    'git tag --list',
    'echo "done; git push later"',
    "printf '%s\\n' 'git commit -m x'",
    "cat > notes.md <<'EOF'\ngit push origin x\nEOF",
    'cat > notes.md <<EOF\ngit commit -m y\nEOF\necho ok',
  ])('does not count non-shipping commands: %s', (command) => {
    expect(decide([bash(command)])).toEqual({ block: false })
  })

  it.each(['grep -n commit file', 'echo "push it"', 'git log --grep=merge', 'git status'])(
    'ignores commands that only mention the words: %s',
    (command) => {
      expect(decide([bash(command)])).toEqual({ block: false })
    },
  )

  it.each(['mcp__plugin_maestro-memory_maestro-memory__memory_add', 'mcp__maestro-memory__memory_suggest'])(
    'the window resets at a memory write under any server prefix: %s',
    (name) => {
      const lines = [edit(), edit(), edit(), edit(), edit(), toolLine(name, { target: 'daily', content: 'x' }), edit()]
      expect(decide(lines)).toEqual({ block: false })
    },
  )

  it('a write earlier than the progress does not discharge it', () => {
    const lines = [toolLine('mcp__m__memory_add', {}), bash('git commit -m z')]
    expect(decide(lines).block).toBe(true)
  })

  it('does not count a call whose result is an error (denied or failed)', () => {
    // Measured live on 2.1.322: five Write calls refused by permissions, then a
    // block. Work that never happened is not progress.
    const lines: string[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(withId(toolLine('Write', { file_path: `/r/${i}.txt`, content: 'x' }), `toolu_${i}`))
      lines.push(resultLine(`toolu_${i}`, true))
    }
    lines.push(withId(bash('git commit -m x'), 'toolu_c'), resultLine('toolu_c', true))
    expect(decide(lines)).toEqual({ block: false })
  })

  it('a memory write that failed does not discharge the duty', () => {
    const lines = [
      bash('git commit -m x'),
      withId(toolLine('mcp__plugin_maestro-memory_maestro-memory__memory_add', { target: 'daily' }), 'toolu_m'),
      resultLine('toolu_m', true),
    ]
    expect(decide(lines).block).toBe(true)
  })

  it('still counts calls whose result succeeded', () => {
    const lines: string[] = []
    for (let i = 0; i < 5; i++) {
      lines.push(withId(toolLine('Write', { file_path: `/r/${i}.txt`, content: 'x' }), `toolu_${i}`))
      lines.push(resultLine(`toolu_${i}`, false))
    }
    expect(decide(lines).block).toBe(true)
  })

  it('asks once per stretch of work: a previous block of ours ends the window', () => {
    // Measured on 2.1.322: the block reaches the model as a meta user line whose
    // string content starts with "Stop hook feedback:" and carries our reason.
    const feedback = JSON.stringify({ type: 'user', isSidechain: false, isMeta: true, message: { role: 'user', content: `Stop hook feedback:\n${STOP_REASON}` } })
    const said = JSON.stringify({ type: 'assistant', isSidechain: false, message: { role: 'assistant', content: [{ type: 'text', text: 'Nothing worth keeping.' }] } })
    const base = [edit(), edit(), edit(), edit(), edit(), feedback, said]
    // A later question-only turn must not be blocked again.
    expect(decide([...base, userLine, said])).toEqual({ block: false })
    // New work after the block starts a new window.
    expect(decide([...base, userLine, bash('git push origin x')]).block).toBe(true)
  })

  it('another hook feedback line does not end the window', () => {
    const other = JSON.stringify({ type: 'user', isSidechain: false, isMeta: true, message: { role: 'user', content: 'Stop hook feedback:\nrun the linter' } })
    expect(decide([edit(), edit(), edit(), edit(), edit(), other]).block).toBe(true)
  })

  it('skips sidechain lines', () => {
    const side = () => toolLine('Edit', {}, true)
    expect(decide([side(), side(), side(), side(), side()])).toEqual({ block: false })
  })

  it('honours MAESTRO_MEMORY_STOP_EDITS', () => {
    expect(decide([edit(), edit()], { MAESTRO_MEMORY_STOP_EDITS: '2' }).block).toBe(true)
  })

  it('honours MAESTRO_MEMORY_STOP_NUDGE=0', () => {
    expect(decide([bash('git commit -m x')], { MAESTRO_MEMORY_STOP_NUDGE: '0' })).toEqual({ block: false })
  })

  it('survives garbage', () => {
    const lines = ['{', '[]', '', 'null', JSON.stringify({ type: 'assistant', message: null }), JSON.stringify({ type: 'assistant', message: { content: 'text' } })]
    expect(() => decide(lines)).not.toThrow()
    expect(decide(lines)).toEqual({ block: false })
  })
})

describe('readTail', () => {
  it('returns only whole lines from the last maxBytes', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stop-tail-')), 't.jsonl')
    writeFileSync(file, 'aaaaaaaaaa\nbbb\nccc\n')
    expect(readTail(file, 9)).toEqual(['bbb', 'ccc'])
  })

  it('returns every line when the file fits', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stop-tail-')), 't.jsonl')
    writeFileSync(file, 'one\ntwo\n')
    expect(readTail(file, 1024)).toEqual(['one', 'two'])
  })
})

function runHook(payload: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [script], {
    input: payload,
    encoding: 'utf8',
    env: { ...process.env, MAESTRO_MEMORY_STOP_NUDGE: '', MAESTRO_MEMORY_STOP_EDITS: '', ...env },
  })
}

describe('stop hook process', () => {
  it('prints nothing and exits 0 for a missing transcript', () => {
    const run = runHook(JSON.stringify({ transcript_path: '/nonexistent/t.jsonl', stop_hook_active: false }))
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
    expect(run.stderr).toBe('')
  })

  it('prints nothing and exits 0 for a payload that is not JSON', () => {
    const run = runHook('not json')
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })

  it('prints the block decision for a qualifying transcript', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stop-run-')), 't.jsonl')
    writeFileSync(file, [userLine, bash('git commit -m x')].join('\n') + '\n')
    const run = runHook(JSON.stringify({ transcript_path: file, stop_hook_active: false }))
    expect(run.status).toBe(0)
    const out = JSON.parse(run.stdout)
    expect(out.decision).toBe('block')
    expect(out.reason).toBe(STOP_REASON)
  })

  it('stays silent on the second stop of the same turn', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'stop-run-')), 't.jsonl')
    writeFileSync(file, bash('git commit -m x') + '\n')
    const run = runHook(JSON.stringify({ transcript_path: file, stop_hook_active: true }))
    expect(run.status).toBe(0)
    expect(run.stdout).toBe('')
  })
})
