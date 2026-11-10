# maestro-memory

Durable memory and todos, stored as plain markdown under `~/.maestro-memory`, shipped as a
DeepSeek Harness (DSH) plugin. The store itself is harness-neutral; the DSH binding is one adapter.

> Give the AI cross-session durable memory and todos — the more you use it, the more it understands you.

- **Package:** `@ddtcorex/maestro-memory` (`cordis.patch.yml` id `maestro-memory`)
- **Version:** see `package.json` · **Changelog:** `CHANGELOG.md`

## Requirements

- Node.js `^22.19.0 || >=24.0.0`, pnpm 11+ (`packageManager` in `package.json`)
- A DSH release inside the `@deepseek-ai/dsh-client-*` peer range declared in `package.json`

## Install

```sh
pnpm install
pnpm run build   # -> lib/
pnpm test        # vitest run
```

**DSH profile (operator):**

```sh
dsh plugin --profile web add link:<path-to>/maestro-memory
# production: dsh plugin --profile web add github:ddtcorex/maestro-memory#<tag-or-sha>
```

`cordis.patch.yml` is shipped with the package, including a `connection` entry that declares `webServer` (DSH 0.2.x needs it before `rpc.handle` can register a channel). Do not duplicate it in the profile. Pin a release with `@ddtcorex/maestro-memory@<version>` when installing from npm, and run `pnpm install && pnpm build` after every `git pull` of a `link:` checkout.

```yaml
- insert:
    - id: maestro-memory
      name: '@ddtcorex/maestro-memory'
      config:
        memoryDir: null      # -> ~/.maestro-memory
        snapshotOrder: 500
        autoMemory: { enabled: false, userMessage: true, desensitize: true } # opt-in
        writeGuard: { enabled: false, threshold: 2 }  # per-turn write watchdog, opt-in
```

`writeGuard` is read once at `apply()` time — changing it needs a profile edit and a
host restart. `threshold` counts consecutive *working* human turns with no
`daily`/`project` write; any value below 1 is read as 1.

## Tools

| Tool | Purpose |
|------|---------|
| `memory` | Five tracks `memory`/`user`/`project`/`key`/`daily` + archive/expand. `key` is gated via `memory_suggest`. |
| `maestro_todo` | Durable cross-session todo store (four tracks `life`/`work`/`project`/`daily` with ids, smart view max 8). Named apart from the harness's own in-session task list `todo_write`. |
| `memory_search` | Word search across the store (BM25, diacritics-insensitive). Compact hits by default; pass `id` to open one entry in full. |
| `memory_suggest` | Gated proposals to `SUGGESTIONS.jsonl` — requires human approve. |

`memory` sanitizes sensitive fragments (`[Filtered:API key/password/token/ID/phone]`, pure credential → `content filtered`).

## Other agents (MCP)

The store is harness-neutral; DSH is one binding, MCP is the other. Any client that speaks MCP reads
and appends the same files, with the same ranking and the same bounded context.

```sh
node <checkout>/lib/mcp/main.js          # or: maestro-memory-mcp, once installed
```

Wire it once per client:

```json
// Claude Code: ~/.claude.json (or the project's .mcp.json)
{ "mcpServers": { "maestro-memory": { "command": "node", "args": ["<checkout>/lib/mcp/main.js"] } } }
```

```toml
# Codex: ~/.codex/config.toml
[mcp_servers.maestro-memory]
command = "node"
args = ["<checkout>/lib/mcp/main.js"]
```

```json
// Cursor: ~/.cursor/mcp.json
{ "mcpServers": { "maestro-memory": { "command": "node", "args": ["<checkout>/lib/mcp/main.js"] } } }
```

Five tools: `memory_search`, `memory_context`, `memory_list`, `memory_add`, `memory_suggest`. The
`key` track stays gated: `memory_add` refuses it and `memory_suggest` queues it for human approval,
exactly as in DSH.

**Start a session with `memory_context`.** The Claude Code plugin does this for the session it starts
(see below); every other client calls it as its first tool use and gets the same bounded context DSH
injects.
The store lives at `~/.maestro-memory`. Resolution order: `config.memoryDir`, then
`MAESTRO_MEMORY_DIR`, then an isolated `DSH_HOME` (a path other than `<home>/.dsh`, which is what a
dry-boot or a test uses), then the neutral root. A store still at an older root moves itself on the
next boot and writes `migrated-v5.json`; two store roots present is a refusal, never a merge.

**After upgrading, restart every client that had the store open** (Claude Code, Codex, Cursor, and
`dsh web` itself). A process started before the move keeps the resolved root it computed at startup;
an old one recreates `~/.dsh/maestro-memory` on its next write. The Memory view reports that stray
root as `staleLegacyRoot` instead of hiding it.

## Claude Code plugin

This repository is also a Claude Code plugin: one MCP server, one skill, one slash command, and two
hooks.

```sh
claude plugin marketplace add ddtcorex/maestro-memory
claude plugin install maestro-memory --marketplace ddtcorex/maestro-memory
```

| Hook | Command | What it does |
|---|---|---|
| `SessionStart` | `maestro-memory-hook session-start` | prints the same bounded snapshot `memory_context` returns for the payload's `cwd`, so the first turn already knows the project |
| `SessionEnd` | `maestro-memory-hook session-end` | appends one line to `daily/<date>.md` |

`maestro-memory-hook` is a second bin of the same package, called through `npx` at the pinned version
because the installed plugin is a git clone with no build output, while the server and the hook code
ship in the npm package.

**Why every shipped command uses `-p`.** npm cannot choose between two differently named bins: with
more than one, `npx <pkg>@<version> <bin>` fails with `could not determine executable to run` before it
looks at the name you asked for, because its resolver reads the package manifest and only accepts a
single shared path or a bin named exactly like the unscoped package. `npx -y -p <pkg>@<version> <bin>`
installs the package first and then resolves the bin, which works with any number of them. 5.1.0
shipped the other shape and its own MCP server stopped starting; 5.1.1 fixes the form and pins it with
a test.

How a session end reads, measured on Claude Code 2.1.322:

```
[07:15] session ended · project · - · 0 tools [session:3e4bd521-87ec-4e37-89dd-0b5a3366b8a6]
```

- The stamp and the file date come from the same local calendar the rest of the store uses, so a line
  and the file it lands in can never disagree, and `memory_list date=today` finds it.
- `-` means the payload carried no branch, and `0 tools` means it carried no tool count. 2.1.322 sends
  `session_id`, `transcript_path`, `cwd` and `hook_event_name`, plus `source` on start and `reason` on
  end. The line reports what it was told and invents nothing.
- The `[session:…]` marker is what deduplicates: a second `SessionEnd` for one session writes nothing,
  including one re-fired just after local midnight, while two sessions ending in the same minute get a
  line each.
- No line is written while a pre-5.0 store under `DSH_HOME` has not moved yet. The hook is the only
  writer that runs without the boot migration, and creating the new root ahead of it makes the
  migration find two roots and refuse.

**What it costs.** The hook process itself is 36-77 ms, but the shipped command reaches it through
`npx`: measured 704-795 ms per hook with a warm cache, so roughly 1.5 s added to a session start, and
about 1.4 s for one resolution against the registry. No model call is involved anywhere in the path.
What it injects is the bounded snapshot, and how much of it arrives depends on a limit measured on
2.1.322: hook output up to 10,000 bytes is injected as text, and above that the harness writes it to a
file and injects only a preview of about 2 KB. A full store renders more than that, so the hook keeps
itself under 9,000 bytes: it renders with tighter caps first, then cuts with a visible marker, and a
store that already fits renders byte for byte what `memory_context` returns.

**Failure behaviour.** Both modes exit 0 and print nothing when the store is unreadable, when the
payload is not JSON, or when no store root can be resolved. The `npx` wrapper around them is not
silent: with the registry unreachable it exits 1 and prints npm errors on stderr, which the harness
shows to the human, so the shipped command discards stderr with `2>/dev/null`. Run the command by hand
with `MAESTRO_MEMORY_DEBUG=1` to see what it would have said. A hook that stops a session is worse than
one that says nothing.

**A custom store path needs one more variable.** The hook process cannot see the DSH profile, so
`config.memoryDir` alone does not reach it. If you set `memoryDir` in the profile, set
`MAESTRO_MEMORY_DIR` to the same path for the hooks, or Claude Code will read a different (empty)
store and write its diary lines there.

**`/remember <text>`** writes one durable fact through the same MCP tools, and `key` still goes through
the suggestion queue for human approval. Claude Code lists plugin commands namespaced, so it may appear
as `/maestro-memory:remember`.

**Release order matters.** The hooks call the published package, so publish the npm version first and
push the plugin tag after. A plugin installed ahead of its package runs a command `npx` cannot resolve;
the hook then says nothing, but the wrapper's failure is what the human sees, which is why the wrapper
stderr is discarded.

## System Prompt Snapshot

`memory:snapshot` (order 500) injects bounded deterministic context:

`USER + MEMORY + KEY (branch-filtered) + Project Context (auto-recall top-4, 600 chars each, cap 1024) + Recent Daily (last 2 days, 512) + header + discipline note`

Caps: `memory 2048 / user 4096 / key 6144 / recentDaily 512 / autoRecall 1024`, plus
per-section entry budgets `memory 8 / user 8 / key 12 / recentDaily 2 / autoRecall 4`.

A cap is hard in **both** dimensions. The newest entry is always kept — compacted
to `head + [summary:…]` when it carries a summary tag. An untagged entry larger
than twice its byte cap is truncated with an explicit `…[truncated]` marker
instead of being kept whole: before that rule, a single 2,293-byte global entry
owned the 2,048-byte section and pushed every other entry out of the prompt.

**Cost reporting.** `renderSnapshotWithStats` (the renderer behind
`memory:snapshot`) reports the bytes, entry count and excluded-entry count of
every section. The host keeps the last 50 renders in memory and returns them as
`cost` on `/maestro-memory-health`: `samples`, `last`, `medianTotalBytes`,
`maxTotalBytes`, `medianBySection`. Entry text is never retained — byte counts
only.

**Write watchdog.** With `writeGuard.enabled`, the host counts consecutive human
turns in which work happened but no `daily`/`project` entry was written
(`agent/turn-stopping`). Three things must hold for a turn to count:

1. it was opened by a direct human prompt — goal-continuation rounds
   (`source.kind === 'goal'`) and injected context (`'plugin'`, e.g. wake
   notices) carry no per-turn duty;
2. it is not a subagent session;
3. it **dispatched at least one tool call**. A turn that only answered a
   question is conversation, not work, so no debt accrues — otherwise the
   watchdog would push the model to write filler entries, exactly what the
   discipline note forbids.

Once the gap reaches `threshold`, the snapshot gains a
`# ⚠️ Memory Write Backlog` section immediately before the discipline note, and
it stays until a write succeeds.
Only a write that actually recorded something counts — a deduplicated add does
not. The alert text is static (threshold only, never the live count), so one
open gap costs at most two tail snapshots: appear, then disappear.

**Subagent sessions** (`session.header.origin === 'subagent'`) get a restrained
per-achievement cadence instead of the per-turn duty, and never see the backlog
alert. The shared memory context (MEMORY / USER / KEY / Project Context) is
still injected for them.

The rendered snapshot collapses brace runs of two or more to a single brace: DSH interpolates each prompt context and fails the whole turn on a `{{name}}` group with a malformed or unregistered name, so free-form memory prose never reaches it as template syntax.

## UI & RPC

One `conversation.view` slot (`maestro-memory`, order 40) with tabs **Memory / Queue / Todo / Skills / Health**. Health shows `coverage`, `daily last 7d`, `longest` + 5-dim score `S/R/J/C/Safety` (composite `min*0.4+mean*0.6`).

The **Memory** tab lists each track read-only and carries a manual add composer:
pick a track, type an entry, press Add. It posts `memory.mutate` with
`action: 'add'`, so it needs no model round-trip; drafts are kept per track and
the button stays disabled while the entry is empty or while `key`/`project` has
no cwd. The model's `key` gate is `exec.agent`-scoped on the host, so it stays in
force — a human writing `key` here is equivalent to approving a queued
suggestion.

RPC: `/maestro-memory` + loopback `/maestro-memory-health` + `/maestro-memory-propose`.

Maintenance endpoints on `/maestro-memory` (both **preview-first**: `dryRun`
defaults to `true` and an actual write needs `confirm: true`):

| Endpoint | What it does |
| --- | --- |
| `memory.repair` | Splits entries glued without the `§` delimiter, drops exact duplicates and moves a trailing `[summary:…]` to its canonical header position, across every store file. Reports `files / changed / split / deduped / relocated`. |
| `memory.maintenance` | Plans (and optionally applies) the archive of the oldest entries of `memory`/`user`/`key`/`project` beyond `DEFAULT_ARCHIVE_POLICY` (keep-bytes + max-age). Overgrown entries move to the track's `*-archive.md`; they are never dropped. |

**Archive vs. the two-machine sync.** `sync/` merges `MEMORY.md`, `KEY.md` and `KEY-archive.md`
as a **union** — it never drops a version, and project/global entries carry no `[id:…]`, so a
*deletion* on one machine is indistinguishable from "the other machine has not seen it yet".
Consequences worth knowing before archiving:

- Archiving on ONE machine only is not stable: the next union merge pulls the archived entries
  back into the live file, because the peer still carries them there. Archive on every machine
  (same policy) so both sides agree and the union is a no-op, or archive with sync disabled.
- `MEMORY-archive.md` is **not** in the merge set (only `KEY-archive.md` is), so a project-track
  archive stays local. That is safe for the live file but means the two machines' archive files
  can legitimately differ.
- The archive does not change what the prompt shows: `# Project Key Memory` is capped at 6,144 B
  and `# Project Context` at the newest 4 entries, both far below the archive policy's keep
  budget. Verified on the live store: rendering was byte-identical before and after the run.

One repair pass runs once at boot, gated by a flag file under
`<root>/.maestro-memory/` (`maestroMetaDir`): `delimiter-repaired-v3` covers
every store file and writes its run report into the flag. (v1 was a KEY-only pass
that had been a silent no-op — it was called with a bogus cwd — and v2 covered
the store without the stray-delimiter split; the versioned flag is what lets an
existing machine pick up a new repair rule exactly once.)

## Maintenance

Maintenance runs through the `memory.repair` and `memory.maintenance` RPC endpoints
described under UI & RPC above (preview-first, `confirm: true` to write). There are
no standalone maintenance scripts; `scripts/` only holds the build helper.
