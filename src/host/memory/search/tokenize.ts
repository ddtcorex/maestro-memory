/**
 * search/tokenize.ts — tokens for the entry index.
 *
 * Two jobs, both measured against the live store rather than guessed:
 * - split on `\p{L}\p{N}` runs so punctuation and markdown never become terms;
 * - index BOTH the original token and its diacritics-stripped twin, so a search
 *   for `danh sach` still finds `danh sách`. There is no stemmer: Vietnamese and
 *   English stemmers both cost more than they return at this corpus size.
 */

const WORD_RE = /[\p{L}\p{N}]+/gu
const MARKS_RE = /\p{M}+/gu

/** Lowercase and strip combining marks: `ĐƯỜNG` -> `duong`. */
export function normalizeToken(token: string): string {
  return token.normalize('NFD').replace(MARKS_RE, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
}

/**
 * Tokens for one entry, deduplicated in first-seen order.
 *
 * The stripped twin is appended right after its origin token so a caller that
 * truncates the list still keeps pairs together.
 */
export function tokenize(text: string): string[] {
  if (typeof text !== 'string' || text.length === 0) return []
  const seen = new Set<string>()
  const out: string[] = []
  const push = (t: string) => {
    if (!t || seen.has(t)) return
    seen.add(t)
    out.push(t)
  }
  for (const match of text.normalize('NFC').matchAll(WORD_RE)) {
    const raw = match[0].toLowerCase()
    push(raw)
    const stripped = normalizeToken(raw)
    if (stripped !== raw) push(stripped)
  }
  return out
}
