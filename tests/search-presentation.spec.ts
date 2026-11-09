import { describe, it, expect } from 'vitest'
import {
  formatHit,
  formatHits,
  resolveTracks,
  REFUSAL_CWD_REQUIRED,
  DEFAULT_TRACKS_WITH_CWD,
} from '../src/host/memory/search/presentation.ts'

describe('search presentation', () => {
  it('formats a hit as id, track, date, score and preview', () => {
    const line = formatHit({ id: 'aaaaaaaa', track: 'key', date: '2026-09-01', score: 12.345, preview: 'body' })
    expect(line).toBe('aaaaaaaa  key  2026-09-01  12.35  body')
  })

  it('renders a missing date as a dash', () => {
    const line = formatHit({ id: 'aaaaaaaa', track: 'key', date: null, score: 1, preview: 'x' })
    expect(line).toBe('aaaaaaaa  key  -  1.00  x')
  })

  it('joins hits with newlines', () => {
    const a = { id: 'aaaaaaaa', track: 'key' as const, date: null, score: 1, preview: 'a' }
    const b = { id: 'bbbbbbbb', track: 'key' as const, date: null, score: 2, preview: 'b' }
    expect(formatHits([a, b]).split('\n')).toHaveLength(2)
  })

  it('refuses an unknown track name instead of silently searching everything', () => {
    expect(resolveTracks('keyx', true)).toEqual({ error: expect.stringMatching(/unknown track/i) })
  })

  it('defaults to the curated tracks and refuses an explicit cwd-scoped request without cwd', () => {
    expect(resolveTracks(undefined, true)).toEqual(DEFAULT_TRACKS_WITH_CWD)
    expect(resolveTracks('key,project', false)).toEqual({ error: REFUSAL_CWD_REQUIRED })
    expect(resolveTracks('memory', false)).toEqual(['memory'])
  })
})
