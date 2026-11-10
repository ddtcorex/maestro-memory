/**
 * The hook bin is called by Claude Code on every session, so its argument and
 * payload handling is a failure surface that must never throw: a hook that
 * errors blocks the session it was supposed to help.
 */
import { describe, it, expect } from 'vitest'
import { parseHookArgs, runHook } from '../src/host/hook/modes.ts'

describe('hook arguments', () => {
  it('reads the mode and tolerates a missing payload', () => {
    expect(parseHookArgs(['session-start'])).toEqual({ mode: 'session-start', payload: {} })
  })

  it('rejects an unknown mode without throwing', () => {
    expect(parseHookArgs(['nonsense']).mode).toBeNull()
    expect(parseHookArgs([]).mode).toBeNull()
  })

  it('parses the json payload a reader supplies', () => {
    const read = () => '{"cwd":"/work/acme-shop","session_id":"s-1"}'
    expect(parseHookArgs(['session-end'], read)).toEqual({
      mode: 'session-end',
      payload: { cwd: '/work/acme-shop', session_id: 's-1' },
    })
  })

  it('treats a malformed or non-object payload as empty', () => {
    expect(parseHookArgs(['session-end'], () => 'not json').payload).toEqual({})
    expect(parseHookArgs(['session-end'], () => '[1,2]').payload).toEqual({})
    expect(parseHookArgs(['session-end'], () => '   ').payload).toEqual({})
  })
})

describe('hook dispatch', () => {
  it('returns empty text instead of throwing when the store root cannot be resolved', () => {
    const out = runHook('session-start', {}, {
      resolveRoot: () => {
        throw new Error('no store')
      },
    })
    expect(out).toBe('')
  })
})
