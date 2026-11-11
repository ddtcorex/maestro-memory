#!/usr/bin/env node
/**
 * Claude Code `Stop` hook: ask a session that did real work to write it down.
 *
 * The session-start snapshot tells the model to write a daily entry at the end of
 * a turn, but text alone is not enforced, and a Claude Code session also carries
 * the harness's own file memory, which wins. This hook is the check: when the
 * transcript shows progress since the last maestro-memory write (file edits, or a
 * command that commits, pushes, tags or merges), it blocks the stop once and says
 * exactly which tools to call. The model decides what to write; nothing here
 * writes, and nothing calls a model.
 *
 * Plain ESM with no dependencies, run straight from the plugin clone with `node`:
 * it needs only the transcript, so it skips the ~0.7 s `npx` costs the other
 * hooks. Every failure path is silent and exits 0, because a Stop hook that
 * misbehaves traps the session it was meant to help.
 */

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

/** Scan budget: the newest bytes of a transcript, so an 80 MB file stays cheap. */
export const TAIL_BYTES = 8 * 1024 * 1024

const DEFAULT_EDITS = 5

const FILE_TOOLS = new Set(['Edit', 'Write', 'NotebookEdit'])

const MEMORY_WRITE = /__memory_(?:add|suggest)$/

export const STOP_REASON =
  'This session changed code or shipped something and has not written to the shared memory store. ' +
  'Before stopping, call memory_add with target=daily (what changed, the evidence, what is left), ' +
  'and memory_suggest with target=key for any convention, incident or infra decision. ' +
  'If nothing here is worth keeping, say so in one line and stop.'

function debug(message) {
  if (process.env.MAESTRO_MEMORY_DEBUG !== '1') return
  try {
    process.stderr.write(`[maestro-memory-stop] ${message}\n`)
  } catch {
    // stderr closed: nothing left to report to
  }
}

/** Git options that take their value as the next word. */
const GIT_OPTS_WITH_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--exec-path'])

/** `git tag` flags that list, delete or verify instead of creating a tag. */
const TAG_NOT_CREATE = /^(?:-d|--delete|-l|--list|-n\d*|-v|--verify|--contains|--no-contains|--merged|--no-merged|--points-at|--sort(?:=.*)?|--column(?:=.*)?|--format(?:=.*)?)$/

/** Words of one shell segment after the env assignments and wrappers in front. */
function commandWords(segment) {
  const words = segment.replace(/^[\s(]+/, '').split(/\s+/).filter(Boolean)
  let i = 0
  while (i < words.length && (/^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i]) || words[i] === 'env' || words[i] === 'sudo')) i++
  return words.slice(i)
}

/** One shell segment that records work: commit, push, tag creation or a merge. */
function isShipSegment(segment) {
  const words = commandWords(segment)
  if (words[0] === 'gh') return words[1] === 'pr' && words[2] === 'merge'
  if (words[0] !== 'git') return false
  let i = 1
  while (i < words.length && words[i].startsWith('-')) i += GIT_OPTS_WITH_VALUE.has(words[i]) ? 2 : 1
  const verb = words[i]
  const rest = words.slice(i + 1)
  switch (verb) {
    case 'commit':
      return !rest.includes('--dry-run')
    case 'push':
      return !rest.includes('--dry-run') && !rest.includes('-n')
    case 'merge':
      return !rest.includes('--abort') && !rest.includes('--quit')
    case 'tag':
      // `git tag` alone lists; creating one names it, and no list/delete flag is set.
      return !rest.some((w) => TAG_NOT_CREATE.test(w)) && rest.some((w) => !w.startsWith('-'))
    default:
      // `merge-base`, `commit-tree` and the like are different verbs, not these.
      return false
  }
}

/**
 * Whether a Bash command commits, pushes, tags or merges. Heredoc bodies and
 * quoted strings are text, not commands, so they are blanked before the split:
 * a doc written through `cat <<EOF` that mentions `git push` ships nothing. A
 * quoted string becomes one placeholder word so `git -C "/a b" commit` still
 * parses.
 */
export function isShipCommand(command) {
  if (typeof command !== 'string') return false
  const plain = command
    .replace(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1[^\n]*\n[\s\S]*?\n[ \t]*\2[ \t]*(?=\n|$)/g, ' ')
    .replace(/'[^']*'|"(?:[^"\\]|\\.)*"/g, ' Q ')
  return plain.split(/&&|\|\||;|\||\n/).some(isShipSegment)
}

/** Our own earlier block, as Claude Code feeds it back to the model. */
function isOwnFeedback(line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return false
  }
  if (!entry || entry.type !== 'user' || entry.isSidechain === true) return false
  const content = entry.message?.content
  const text = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((block) => (block && typeof block.text === 'string' ? block.text : '')).join('\n')
      : ''
  return text.startsWith('Stop hook feedback:') && text.includes(STOP_REASON)
}

/** The content blocks of a main-thread line of the given type, or `[]`. */
function blocks(line, type) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }
  if (!entry || typeof entry !== 'object' || entry.type !== type || entry.isSidechain === true) return []
  const content = entry.message?.content
  return Array.isArray(content) ? content.filter((block) => block && typeof block === 'object') : []
}

function toolUses(line) {
  return blocks(line, 'assistant').filter((block) => block.type === 'tool_use' && typeof block.name === 'string')
}

/** Ids of tool calls whose result is an error: denied by permissions, or failed. */
function failedIds(line) {
  return blocks(line, 'user')
    .filter((block) => block.type === 'tool_result' && block.is_error === true && typeof block.tool_use_id === 'string')
    .map((block) => block.tool_use_id)
}

function threshold(env) {
  const n = Number.parseInt(env.MAESTRO_MEMORY_STOP_EDITS ?? '', 10)
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_EDITS
}

/**
 * Walk newest first to the last maestro-memory write; block when the work since
 * then reaches the threshold. Never blocks twice in a row (`stopHookActive`).
 */
export function decideStop(lines, { stopHookActive, env = {} }) {
  if (stopHookActive) return { block: false }
  if (env.MAESTRO_MEMORY_STOP_NUDGE === '0') return { block: false }
  const needEdits = threshold(env)
  let edits = 0
  let shipped = false
  // A result always follows its call, so walking newest first meets the error
  // before the call it belongs to. A call that failed (a denied Write, a memory
  // write to a server that never connected) neither counts as work nor
  // discharges the duty.
  const failed = new Set()
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line) continue
    // The session already answered this stretch of work, by writing or by saying
    // nothing is worth keeping; only work after our last ask counts.
    if (line.includes('Stop hook feedback') && isOwnFeedback(line)) return verdict(edits, shipped, needEdits)
    if (line.includes('"tool_result"')) for (const id of failedIds(line)) failed.add(id)
    if (!line.includes('"tool_use"')) continue
    const uses = toolUses(line)
    // Within one message, a write after the progress discharges it; a write
    // before it does not. Walk the blocks newest first as well.
    for (let j = uses.length - 1; j >= 0; j--) {
      const use = uses[j]
      if (typeof use.id === 'string' && failed.has(use.id)) continue
      if (MEMORY_WRITE.test(use.name)) return verdict(edits, shipped, needEdits)
      if (FILE_TOOLS.has(use.name)) edits++
      else if (use.name === 'Bash' && isShipCommand(use.input?.command)) shipped = true
    }
  }
  return verdict(edits, shipped, needEdits)
}

function verdict(edits, shipped, needEdits) {
  return shipped || edits >= needEdits ? { block: true, reason: STOP_REASON } : { block: false }
}

/** The whole lines among the last `maxBytes` of a file; the cut first line is dropped. */
export function readTail(path, maxBytes = TAIL_BYTES) {
  const fd = openSync(path, 'r')
  try {
    const size = fstatSync(fd).size
    const start = Math.max(0, size - maxBytes)
    const buffer = Buffer.alloc(size - start)
    let read = 0
    while (read < buffer.length) {
      const n = readSync(fd, buffer, read, buffer.length - read, start + read)
      if (n === 0) break
      read += n
    }
    const lines = buffer.subarray(0, read).toString('utf8').split('\n')
    if (start > 0) lines.shift()
    return lines.filter((line) => line.length > 0)
  } finally {
    closeSync(fd)
  }
}

function readStdin() {
  const chunks = []
  const buffer = Buffer.alloc(65536)
  for (;;) {
    let n
    try {
      n = readSync(0, buffer, 0, buffer.length, null)
    } catch (error) {
      if (error && error.code === 'EAGAIN') continue
      if (error && error.code === 'EOF') break
      throw error
    }
    if (n === 0) break
    chunks.push(Buffer.from(buffer.subarray(0, n)))
  }
  return Buffer.concat(chunks).toString('utf8')
}

export function main() {
  try {
    const payload = JSON.parse(readStdin())
    const path = payload?.transcript_path
    if (typeof path !== 'string' || path.length === 0) return
    const decision = decideStop(readTail(path), {
      stopHookActive: payload.stop_hook_active === true,
      env: process.env,
    })
    if (decision.block) process.stdout.write(JSON.stringify({ decision: 'block', reason: decision.reason }))
  } catch (error) {
    debug(`skipped: ${error?.message ?? error}`)
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) main()
