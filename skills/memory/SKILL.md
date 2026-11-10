---
name: memory
description: Use at the start of a session and before writing anything durable. Reads and appends the shared maestro-memory store through its MCP tools, so the same facts follow you across Claude Code, Codex, Cursor and DSH.
---

# Shared memory

One store on this machine: `~/.maestro-memory`. DSH injects parts of it into its own prompt; every
other agent, including this one, reaches it only through these tools.

## Start of a session

Call `memory_context` once, with the project directory as `cwd`. It returns the same bounded context
DSH would have injected: user memory, global memory, the project's key entries, recent daily notes and
an index of older key entries. Without this call, a project with months of memory looks brand new.

## Before you write

Call `memory_search` first. Durable memory accumulates variants of the same rule when nobody looks:
one entry says phpcs runs before merge, another says the same thing about a different command. If a
near-identical entry exists, extend it rather than adding a second one.

`memory_add` answers with the closest existing entries for exactly this reason; read that list before
deciding the write is new.

## Writing

| Track | Put here |
|---|---|
| `memory` | Durable facts and lessons that do not belong to one project |
| `user` | Standing instructions about how to work with this person |
| `project` | Facts tied to one repository, with `cwd` |
| `daily` | What happened today, with a date |
| `key` | Long-lived rules. **Gated: not writable directly** |

Write the durable fact, not the story of finding it. One entry, one idea. If it will be stale in a
week, it does not belong in memory.

`key` cannot be written directly. `memory_add` refuses it and points at `memory_suggest`, which queues
the entry for a human to approve in the DSH Memory view. That gate exists because key entries are what
a future session reads first, and an unreviewed one crowds out a reviewed one.

## What this is not

Claude Code has its own memory in `~/.claude/projects/<slug>/memory/` and `CLAUDE.md`, and this plugin
does not touch it. Keep repository conventions there; keep facts worth sharing with other agents here.
Do not mirror one into the other, or the two copies will disagree and nothing decides which wins.
