# pi-claude-bridge

Claude Code as a model provider for [pi](https://github.com/anthropics/pi).
Our fork — see `AGENTS.md` for agent guidelines.

## Configuration

`~/.pi/agent/claude-bridge.json` (global) or `.pi/claude-bridge.json` (project,
merged over global). Reload with `/reload` after edits.

```json
{ "provider": { "webTools": true } }
```

| key | default | what |
|-----|---------|------|
| `strictMcpConfig` | `true` | block MCP servers from `~/.claude.json` / `.mcp.json` |
| `webTools` | `false` | enable hosted WebSearch/WebFetch (server-side, billed against subscription) |
| `autoMemoryEnabled` | `false` | CC's auto-memory system (MEMORY.md reads/writes) |
| `pathToClaudeCodeExecutable` | auto | path to `claude` binary (useful for Nix etc.) |

The forwarded context (AGENTS.md, skills, `.pi/SYSTEM.md`) **replaces** CC's
system prompt entirely — the `claude_code` preset survives only as fallback
when nothing is forwarded.

Select a model with `/model` (`claude-bridge/claude-opus-5`,
`claude-bridge/claude-sonnet-5`, `claude-bridge/claude-haiku-4-5`, …). All
models serve 200K context. Bash commands get 120s default timeout. Skills are
forwarded into CC's system prompt. Steering works mid-turn.

## Debugging

`CLAUDE_BRIDGE_DEBUG=1` enables:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — provider calls,
  session-sync decisions, tool-result delivery, CC stderr. Override path with
  `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CC CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>.log` —
  CC's own debug stream, one file per `query()`.

For a session-resume failure: check `syncResult:` lines in the bridge log plus
the matching `cc-cli-logs/` file.

## Known issues

- **Rebuilds are expensive.** The bridge rewrites CC's session from pi's
  history after aborts, `/compact`, tree navigation, or API errors. A rebuild
  loses the prompt cache ~58% of the time vs ~26% for a plain resume. See
  `TODO.md` #1.
- **Files CC edits aren't carried across rebuilds.** CC records post-edit
  contents as `edited_text_file` attachments; those aren't carried (they hang
  off tool-result records with no stable position). The edit itself survives as
  a tool call + result. `@file` expansions *are* carried (`src/attachments.ts`).

## Claims about CC behavior

`~/.claude/projects/**` is **not** evidence of what CC does — the bridge writes
the same files, and CC re-serializes imported records under synthetic ids. Before
asserting "CC does X" from disk, split by provenance (CC-live records have real
`requestId`/`promptId`; ours have `msg_syn_*`/`req_syn_*`).

Better: prove it with a live probe. `tests/int-cc-contracts.mjs` pins
undocumented behaviors against the installed SDK. `diag/capture-proxy.mjs`
captures actual request bodies. And before reverse-engineering an SDK option,
grep `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — it documents
every settings field.
