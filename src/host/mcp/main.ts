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

import { realpathSync } from 'node:fs'
import { createRequire } from 'node:module'

import { pathToFileURL } from 'node:url'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { createToolHandlers, type ToolHandlers } from './tools.ts'
import { TOOL_DEFINITIONS, definitionFor } from './definitions.ts'
import { migrateMemoryRoot } from '../storage/migrate.ts'
import { resolveDshHome, resolveStoreRoot } from '../storage/layout.ts'

export interface ServerOptions {
  dshHome?: string
  memoryDir?: string | null
}

/** The root this server serves. Migrating one store and serving another is the
 * exact shape of the incident that made the store DSH_HOME-aware. */
export function resolveServerRoot(opts: ServerOptions = {}): string {
  // `dshHome` is the test seam: it stands in for DSH_HOME so a caller can point the
  // whole resolution at a scratch home without touching the real environment.
  const env = opts.dshHome ? { ...process.env, DSH_HOME: opts.dshHome } : process.env
  return resolveStoreRoot({ memoryDir: opts.memoryDir ?? null, env }).root
}

function packageVersion(): string {
  // Read the manifest instead of hardcoding: a literal rots at the next bump and
  // MCP clients show it. The file sits three levels up from src/host/mcp and two
  // from lib/mcp, so both candidates are tried.
  try {
    const require = createRequire(import.meta.url)
    for (const candidate of ['../../../package.json', '../../package.json']) {
      try {
        return String(require(candidate).version ?? '0.0.0')
      } catch {}
    }
  } catch {}
  return '0.0.0'
}

/** Build the server without starting a transport, so tests can drive it directly. */
export function createServer(opts: ServerOptions = {}): Server {
  const dshHome = opts.dshHome ?? resolveDshHome()
  const resolved = resolveStoreRoot({
    memoryDir: opts.memoryDir ?? null,
    env: opts.dshHome ? { ...process.env, DSH_HOME: opts.dshHome } : process.env,
  })
  // A store still on the pre-4.0 root must move BEFORE this process writes to it;
  // otherwise the first append creates the new root and the later DSH boot
  // migration finds both directories and refuses.
  const migration = migrateMemoryRoot({ root: resolved.root, mode: resolved.mode, dshHome })
  if (migration.status === 'refused' || migration.status === 'failed') {
    // stderr is the diagnostics channel for a stdio server. Silence here is how a
    // split store becomes "my old memory vanished in this client".
    console.error(
      `[maestro-memory] store migration ${migration.status}: ${migration.reason} (from ${migration.from} to ${migration.to})`,
    )
  }
  const root = resolved.root
  const handlers = createToolHandlers({ root })

  const server = new Server(
    { name: 'maestro-memory', version: packageVersion() },
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
      const handler = HANDLER_BY_TOOL[name]
      if (!handler) {
        return { content: [{ type: 'text', text: `no handler for ${name}` }], isError: true }
      }
      const result = handlers[handler](args)
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

/** Tool name to handler name, declared rather than derived by string surgery. */
const HANDLER_BY_TOOL: Record<string, keyof ToolHandlers> = {
  memory_search: 'search',
  memory_context: 'context',
  memory_list: 'list',
  memory_add: 'add',
  memory_suggest: 'suggest',
}

/**
 * Only start when executed, never when imported by a test.
 *
 * Comparing against `file://${process.argv[1]}` looked right and was not: an
 * installed `bin` is a POSIX symlink and a home directory may contain a space, and
 * both made the server exit 0 without serving anything, with no diagnostic.
 * Resolving both sides removes the whole class.
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
  main().catch((error) => {
    console.error(`[maestro-memory] mcp server failed: ${error?.message ?? error}`)
    process.exit(1)
  })
}
