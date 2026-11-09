import { describe, it, expect } from 'vitest'
import { TOOL_DEFINITIONS } from '../src/host/mcp/definitions.ts'

describe('mcp tool definitions', () => {
  it('declares exactly the five tools in order', () => {
    expect(TOOL_DEFINITIONS.map((t) => t.name)).toEqual([
      'memory_search',
      'memory_context',
      'memory_list',
      'memory_add',
      'memory_suggest',
    ])
  })

  it('marks the three read tools read-only and the two writes not', () => {
    expect(TOOL_DEFINITIONS.filter((t) => t.readOnly).map((t) => t.name)).toEqual([
      'memory_search',
      'memory_context',
      'memory_list',
    ])
  })

  it('gives every tool a description and an object schema', () => {
    for (const tool of TOOL_DEFINITIONS) {
      expect(tool.description.length).toBeGreaterThan(20)
      expect(tool.inputSchema).toMatchObject({ type: 'object' })
    }
  })

  it('tells the model to search before writing', () => {
    const add = TOOL_DEFINITIONS.find((t) => t.name === 'memory_add')!
    expect(add.description.toLowerCase()).toContain('search')
  })
})
