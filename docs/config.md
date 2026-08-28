# Configuration

`~/.pi/agent/cc.json` (global) or `.pi/cc.json` (project,
merged over global). Reload with `/reload` after edits.

```json
{ "provider": { "webTools": false } }
```

| key | default | what |
|-----|---------|------|
| `strictMcpConfig` | `true` | block MCP servers from `~/.claude.json` / `.mcp.json` |
| `webTools` | `true` | hosted WebSearch/WebFetch (server-side, billed against subscription); set `false` to disable |
| `autoMemoryEnabled` | `false` | CC's auto-memory system (MEMORY.md reads/writes) |
| `pathToClaudeCodeExecutable` | auto | path to `claude` binary (useful for Nix etc.) |

The forwarded context (AGENTS.md, skills, `.pi/SYSTEM.md`) **replaces** CC's
system prompt entirely — the `claude_code` preset survives only as fallback
when nothing is forwarded.

Select a model with `/model` (`cc/claude-opus-5`,
`cc/claude-sonnet-5`, `cc/claude-haiku-4-5`, …). All
models serve 200K context. Bash commands get 120s default timeout. Skills are
forwarded into CC's system prompt. Steering works mid-turn.
