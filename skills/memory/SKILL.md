---
name: memory
description: Use at the start of a session and before writing anything durable. Reads and appends the shared maestro-memory store through its MCP tools, so the same facts follow you across Claude Code, Codex, Cursor and DSH.
---

# Shared memory

One store on this machine: `~/.maestro-memory`. DSH injects parts of it into its own prompt; every
other agent, including this one, reaches it only through these tools.

## Start of a session

The plugin's `SessionStart` hook already delivered this project's bounded context: user memory, global
memory, the project's key entries, recent daily notes and an index of older key entries. Do not fetch it
again.

Call `memory_context` only when that context is missing: a host without the hook (Codex, Cursor, a bare
MCP client), or a session that was compacted and lost it.

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
| `key` | Long-lived rules. **Ask the human first, then write with `approved:true`** |

Write the durable fact, not the story of finding it. One entry, one idea. If it will be stale in a
week, it does not belong in memory.

If the person says "remember this", `/remember <text>` performs this same write in one step: it
picks the track, writes it, and answers with the id.

`key` needs the human in the loop, because key entries are what a future session reads first and an
unreviewed one crowds out a reviewed one. The flow:

1. Show the exact entry you intend to write, in one line.
2. Ask with `AskUserQuestion`, offering write it, edit it, or skip.
3. Only after an explicit yes, call `memory_add` with `target:key`, the project as `cwd`, and
   `approved:true`. Without that flag the tool refuses and says so.

When nobody is there to answer, `memory_suggest` with `target:key` queues the entry for approval in the
DSH Memory view instead. The session-start context prints how many suggestions are waiting, so the
queue cannot fill up unnoticed.

## What this is not

Claude Code has its own memory in `~/.claude/projects/<slug>/memory/` and `CLAUDE.md`, and this plugin
does not touch it. Keep repository conventions there; keep facts worth sharing with other agents here.
Do not mirror one into the other, or the two copies will disagree and nothing decides which wins.
