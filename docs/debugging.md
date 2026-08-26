# Debugging

`CLAUDE_BRIDGE_DEBUG=1` enables:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — provider calls,
  session-sync decisions, tool-result delivery, CC stderr. Override path with
  `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CC CLI logs** at `~/.pi/agent/cc-cli-logs/<timestamp>.log` —
  CC's own debug stream, one file per `query()`.

For a session-resume failure: check `syncResult:` lines in the bridge log plus
the matching `cc-cli-logs/` file.
