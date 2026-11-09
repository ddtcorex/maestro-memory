import { describe, it, expect } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { readHealth } from '../src/host/storage/health.ts'

describe('health markers', () => {
  it('reports both markers and the resolved root', () => {
    const root = mkdtempSync(join(tmpdir(), 'health-'))
    mkdirSync(join(root, '.maestro-memory'), { recursive: true })
    writeFileSync(join(root, '.maestro-memory', 'migrated-v4'), '{}')
    writeFileSync(join(root, '.maestro-memory', 'migrated-v5.json'), '{}')
    expect(readHealth({ root })).toEqual({ storeRoot: root, markerV4: true, markerV5: true })
  })

  it('reports a v5-only store without claiming the v4 rename is missing', () => {
    const root = mkdtempSync(join(tmpdir(), 'health2-'))
    mkdirSync(join(root, '.maestro-memory'), { recursive: true })
    writeFileSync(join(root, '.maestro-memory', 'migrated-v5.json'), '{}')
    expect(readHealth({ root })).toEqual({ storeRoot: root, markerV4: false, markerV5: true })
  })
})
