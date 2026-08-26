# pi-claude-bridge

Pi extension that registers Claude Code as a model provider. The Agent SDK
spawns the real `claude` binary as a subprocess — every tool call flows through
pi's TUI over MCP.

**Agents:** read [`AGENTS.md`](AGENTS.md) — that is the operational doc.
