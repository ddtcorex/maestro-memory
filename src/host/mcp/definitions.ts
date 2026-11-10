/**
 * mcp/definitions.ts — the tool surface, declared once.
 *
 * The server and the tests read the same list, so a tool cannot exist in one and
 * not the other. `readOnly` drives the MCP `readOnlyHint` annotation: a client that
 * shows the difference between a lookup and a write gets it from here.
 */

export interface ToolDefinition {
  name: string
  description: string
  inputSchema: Record<string, unknown>
  readOnly: boolean
}

const CWD = {
  type: 'string',
  description: 'Project directory. Reads default to the process working directory; writes require it for the project track.',
}

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'memory_search',
    readOnly: true,
    description:
      'Search durable memory by words across the key, project, memory and user tracks. Use it when the answer may live in an older entry the prompt does not show. Returns compact hits (id, track, date, score, preview); pass `id` to open one entry in full.',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Plain words. No regex and no query language; diacritics are optional.' },
        tracks: {
          type: 'string',
          description: 'Comma-separated: key, project, daily, memory, user. Default key,project,memory,user (daily is opt-in).',
        },
        cwd: CWD,
        limit: { type: 'integer', description: 'Max hits, default 8, capped at 25.' },
        id: { type: 'string', description: 'Open one entry in full by its 8-hex id instead of searching.' },
        full: { type: 'boolean', description: 'Return the full text of every hit, not just the preview.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_context',
    readOnly: true,
    description:
      'Return the bounded memory context for a project: user memory, global memory, project key memory, a project context slice, recent daily entries and an index of older key entries. Call it once at session start to start where the last session left off.',
    inputSchema: {
      type: 'object',
      properties: {
        cwd: CWD,
        branch: { type: 'string', description: 'Branch scope for the key track; omitted means every branch.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'memory_list',
    readOnly: true,
    description:
      'List the entries of one track. Use it to browse rather than to find: for a question, memory_search ranks and keeps the answer short.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['memory', 'user', 'project', 'key', 'daily'] },
        cwd: CWD,
        filter: { type: 'string', description: 'Content substring filter.' },
        limit: { type: 'integer' },
        recent: { type: 'boolean', description: 'Newest first.' },
        date: { type: 'string', description: 'Daily track date, YYYY-MM-DD.' },
      },
      required: ['target'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_add',
    readOnly: false,
    description:
      'Append one durable entry. Search first: if a similar entry already exists, extend it rather than adding a near-duplicate. The key track needs the human in the loop: show the exact entry, ask with AskUserQuestion, and only after an explicit yes send approved:true. Use memory_suggest instead when nobody is there to answer. The reply lists the closest existing entries so a duplicate is visible immediately.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['memory', 'user', 'project', 'daily', 'key'] },
        content: { type: 'string', description: 'The entry body. Write the durable fact, not the story of finding it.' },
        cwd: CWD,
        date: { type: 'string', description: 'Daily track date, YYYY-MM-DD.' },
        summary: { type: 'string', description: 'One-line summary, used by the prompt index lane.' },
        branches: { type: 'string', description: 'Branch scope for a project entry, comma-separated.' },
        approved: {
          type: 'boolean',
          description:
            'Set true only for the key track, and only after the human answered yes in this session. Other tracks ignore it.',
        },
      },
      required: ['target', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'memory_suggest',
    readOnly: false,
    description:
      'Propose an entry for human approval instead of writing it: the queue is reviewed in the DSH Memory view. Use it for the key track and for anything you are not sure belongs in memory.',
    inputSchema: {
      type: 'object',
      properties: {
        target: { type: 'string', enum: ['memory', 'user', 'key', 'todo-life', 'todo-work', 'todo-project', 'todo-daily'] },
        content: { type: 'string' },
        reason: { type: 'string', description: 'Why this belongs in memory; the reviewer sees it.' },
        cwd: CWD,
      },
      required: ['target', 'content', 'reason'],
      additionalProperties: false,
    },
  },
]

export function definitionFor(name: string): ToolDefinition | undefined {
  return TOOL_DEFINITIONS.find((tool) => tool.name === name)
}
