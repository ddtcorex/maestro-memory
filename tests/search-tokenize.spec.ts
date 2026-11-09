import { describe, it, expect } from 'vitest'
import { tokenize, normalizeToken } from '../src/host/memory/search/tokenize.ts'

describe('search tokenizer', () => {
  it('splits on non-alphanumerics and lowercases', () => {
    expect(tokenize('Govard public-api LINT gate')).toEqual([
      'govard',
      'public',
      'api',
      'lint',
      'gate',
    ])
  })

  it('indexes both the diacritic and the stripped form of a Vietnamese word', () => {
    const tokens = tokenize('Danh sách')
    expect(tokens).toContain('sách') // raw
    expect(tokens).toContain('sach') // stripped twin, so "danh sach" matches
    expect(tokens).toContain('danh') // already ASCII, once
    expect(tokens.filter((t) => t === 'danh')).toHaveLength(1)
  })

  it('keeps unicode word runs together instead of trimming marks off the split', () => {
    const tokens = tokenize('cà-phê sữa đá')
    expect(tokens).toContain('cà')
    expect(tokens).toContain('ca')
    expect(tokens).toContain('phê')
    expect(tokens).toContain('phe')
    expect(tokens).toContain('đá')
  })

  it('deduplicates while preserving first-seen order', () => {
    expect(tokenize('key key KEY project')).toEqual(['key', 'project'])
  })

  it('returns nothing for blank and punctuation-only input', () => {
    expect(tokenize('')).toEqual([])
    expect(tokenize('   ')).toEqual([])
    expect(tokenize('--- ... !!!')).toEqual([])
  })

  it('normalizeToken strips marks and lowercases', () => {
    expect(normalizeToken('ĐƯỜNG')).toBe('duong')
    expect(normalizeToken('plain')).toBe('plain')
  })
})
