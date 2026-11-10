#!/usr/bin/env node
/**
 * hook/main.ts — the bin the plugin's hooks call.
 *
 * Claude Code runs this on session start and session end. Two rules shape the
 * whole file: it always exits 0, and it stays quiet unless it has something to
 * say. A hook cannot be allowed to fail a session it was meant to improve.
 *
 * stdin is read here, not in the sync core: the payload arrives on a pipe that
 * closes, so the wait is bounded, and a terminal or a closed pipe resolves at
 * once instead of hanging the session.
 */

import { realpathSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { debug, parseHookArgs, runHook } from './modes.ts'

/** A payload that never closes must not hold a session start hostage. */
const STDIN_TIMEOUT_MS = 500

function readPayload(timeoutMs = STDIN_TIMEOUT_MS): Promise<string> {
  if (process.stdin.isTTY) return Promise.resolve('')
  return new Promise((resolve) => {
    let text = ''
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try {
        process.stdin.pause()
      } catch {
        // already closed
      }
      resolve(text)
    }
    const timer = setTimeout(finish, timeoutMs)
    timer.unref?.()
    process.stdin.setEncoding('utf8')
    process.stdin.on('data', (chunk: string) => {
      text += chunk
    })
    process.stdin.on('end', finish)
    process.stdin.on('error', finish)
    process.stdin.resume()
  })
}

/**
 * Run one hook invocation and print its text, or nothing.
 *
 * Exported so the bin is testable through its real entry point rather than a
 * copy of its logic: the guard below is the only untested line.
 */
export async function runHookCli(argv: string[] = process.argv.slice(2)): Promise<void> {
  const { mode } = parseHookArgs(argv)
  if (!mode) {
    debug(`ignoring invocation with no known mode: ${JSON.stringify(argv)}`)
    return
  }
  const text = await readPayload()
  const { payload } = parseHookArgs(argv, () => text)
  const out = runHook(mode, payload)
  if (!out) return
  process.stdout.write(out.endsWith('\n') ? out : `${out}\n`)
}

/**
 * Only start when executed, never when imported by a test. Both sides are
 * resolved, so a symlinked bin (how npm installs one) and a path with a space
 * both still count as direct invocation.
 */
function invokedDirectly(): boolean {
  const entry = process.argv[1]
  if (!entry) return false
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href
  } catch {
    return false
  }
}

if (invokedDirectly()) {
  runHookCli().catch((error) => {
    debug(`hook invocation failed: ${error?.message ?? error}`)
  })
}
