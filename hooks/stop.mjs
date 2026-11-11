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

/** One shell segment that records work: commit, push, tag creation or a merge. */
function isShipSegment(segment) {
  const s = segment.trim()
  if (/^gh\s+pr\s+merge\b/.test(s)) return true
  const git = /^git(?:\s+-C\s+\S+)?\s+(commit|push|merge|tag)\b(.*)$/.exec(s)
  if (!git) return false
  if (git[1] !== 'tag') return true
  // `git tag` alone or `git tag -l` lists tags; creating one names it.
  const rest = git[2].trim()
  return rest.length > 0 && !/^(?:-l\b|--list\b)/.test(rest)
}

function isShipCommand(command) {
  if (typeof command !== 'string') return false
  return command.split(/&&|\|\||;|\||\n/).some(isShipSegment)
}

function toolUses(line) {
  let entry
  try {
    entry = JSON.parse(line)
  } catch {
    return []
  }
  if (!entry || typeof entry !== 'object' || entry.type !== 'assistant' || entry.isSidechain === true) return []
  const content = entry.message?.content
  if (!Array.isArray(content)) return []
  return content.filter((block) => block && block.type === 'tool_use' && typeof block.name === 'string')
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
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]
    if (!line || !line.includes('"tool_use"')) continue
    const uses = toolUses(line)
    // Within one message, a write after the progress discharges it; a write
    // before it does not. Walk the blocks newest first as well.
    for (let j = uses.length - 1; j >= 0; j--) {
      const use = uses[j]
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
