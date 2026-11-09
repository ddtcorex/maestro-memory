#!/usr/bin/env node
/**
 * mcp/main.ts — the stdio entry for foreign agents.
 *
 * DSH binds the store through Cordis in `src/host/index.ts`; this file binds the
 * same store through MCP. Nothing here decides behaviour: the handlers do, and
 * `definitions.ts` declares the surface, so the two transports cannot disagree
 * about what a tool is called or what it returns.
 *
 * Process model: one stdio server, no port, no daemon. stdin close ends it.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createToolHandlers } from './tools.ts'
import { TOOL_DEFINITIONS, definitionFor } from './definitions.ts'
import { migrateMemoryRoot } from '../storage/migrate.ts'
import { resolveDshHome, resolveMemoryRoot } from '../storage/layout.ts'

export interface ServerOptions {
  dshHome?: string
  memoryDir?: string | null
}

/** Build the server without starting a transport, so tests can drive it directly. */
export function createServer(opts: ServerOptions = {}): Server {
  const dshHome = opts.dshHome ?? resolveDshHome()
  // A store still on the pre-4.0 root must move BEFORE this process writes to it;
  // otherwise the first append creates the new root and the later DSH boot
  // migration finds both directories and refuses.
  migrateMemoryRoot({ dshHome, memoryDir: opts.memoryDir ?? null })
  const root = resolveMemoryRoot(opts.memoryDir ?? null)
  const handlers = createToolHandlers({ root })

  const server = new Server(
    { name: 'maestro-memory', version: '4.2.0' },
    { capabilities: { tools: {} } },
  )

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOL_DEFINITIONS.map((tool) => ({
      name: tool.name,
      description: tool.description,
      inputSchema: tool.inputSchema,
      annotations: tool.readOnly ? { readOnlyHint: true } : { readOnlyHint: false },
    })),
  }))

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params
    const definition = definitionFor(name)
    if (!definition) {
      return { content: [{ type: 'text', text: `unknown tool ${name}` }], isError: true }
    }
    const args = (rawArgs ?? {}) as Record<string, any>
    try {
      const handler = (handlers as any)[name.replace('memory_', '')]
      if (typeof handler !== 'function') {
        return { content: [{ type: 'text', text: `no handler for ${name}` }], isError: true }
      }
      const result = handler.call(handlers, args)
      return { content: [{ type: 'text', text: String(result.text ?? '') }] }
    } catch (error: any) {
      // A throwing handler must not take the server down: the client sees the
      // message and can retry or report it.
      return { content: [{ type: 'text', text: `error: ${error?.message ?? String(error)}` }], isError: true }
    }
  })

  return server
}

async function main(): Promise<void> {
  const server = createServer()
  const transport = new StdioServerTransport()
  await server.connect(transport)
}

// Only start when executed, never when imported by a test.
const invokedDirectly = (() => {
  try {
    return process.argv[1] !== undefined && import.meta.url === `file://${process.argv[1]}`
  } catch {
    return false
  }
})()

if (invokedDirectly) {
  main().catch((error) => {
    console.error(`[maestro-memory] mcp server failed: ${error?.message ?? error}`)
    process.exit(1)
  })
}
