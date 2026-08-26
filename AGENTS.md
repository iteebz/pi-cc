# Agent Guidelines

The single agent-facing doc for this repo. Pull `docs/` for reference:
`docs/config.md` (settings), `docs/debugging.md` (logs), `docs/known-issues.md`
(gotchas + CC behavior forensics).

## Ownership

Our fork, maintained purely for the distil builder harness. Upstream
(elidickinson) is dead to us — no pulling, no PRs.

- Not published to npm. No changelog, no version bumps — git history is the
  changelog.
- Change freely and commit autonomously. Verify with `npm run check` before
  committing.

## What it is

A pi extension registering Claude Code as a model provider. The Agent SDK
spawns the real `claude` binary as a subprocess — this is not a cloud API, it's
a local process wrapper. Every tool call flows through pi's TUI over MCP; the
one exception is the hosted web tools (`webTools`, off by default).

Install: `pi install /path/to/pi-claude-bridge`. Installed copy lives at
`~/.pi/agent/git/github.com/iteebz/pi-claude-bridge`.
Ship: verify → commit → push → `pi update git:github.com/iteebz/pi-claude-bridge` → live probe.

## Hardening — CC subprocess stripped to bare minimum

Two layers suppress all ancillary behavior from the spawned CC binary:

**env vars** (`CC_CHILD_ENV` in `src/config.ts`):
`DISABLE_TELEMETRY=1`, `DISABLE_ERROR_REPORTING=1`, `DISABLE_AUTOUPDATER=1`,
`DISABLE_INSTALLATION_CHECKS=1`, `DISABLE_UPGRADE_COMMAND=1`,
`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`,
`CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1`,
`ENABLE_CLAUDEAI_MCP_SERVERS=0`, `DISABLE_AUTO_COMPACT=1`.

**settings** (`claudeCodeSettings()` in `src/config.ts`):
`autoMemoryEnabled: false`, `includeCoAuthoredBy: false`,
`includeGitInstructions: false`, `promptSuggestionEnabled: false`,
`feedbackSurveyRate: 0`, `spinnerTipsEnabled: false`.

CLAUDE.md files excluded. Pi's context replaces CC's system prompt entirely.

## Tests

- `npm run check` — **pre-commit gate**: lint + typecheck + unit suite.
- `npm test` — full suite including live integration tests.
- `tests/int-cache.sh` — prompt-caching prefix stability canary. Treat as
  required for any change touching prompt assembly or session sync.

Suite must run outside a sandbox (writes to `~/.claude` for session state).

## Architecture

`src/index.ts` is the entry: registers the provider, hooks pi's session
lifecycle, owns `streamSimple`. Everything else one layer down:

```
debug → ui → query-state → turn → session → tools → stream → summary → index
```

Leaves: `convert · attachments · config · models · skills · mcp-server ·
tool-names · extract-tool-results · session-verify · prompt-capture ·
prompt-stream`.

## Invariants

- Provider query starts CC with `tools: []` (or hosted pair when `webTools`
  on). Every other tool arrives over MCP. Any other tool_use is a hallucinated
  builtin — must not reach pi.
- Model `contextWindow` in `src/models.ts` must match what the bridge serves
  (200K). Mismatch desynchronizes pi's auto-compaction.
- Prefix stability across turns keeps prompt caching alive. Haiku's 2048-token
  minimum means it caches nothing with our small system prompt.

## Comments

Density reference: `src/session.ts` and `src/stream.ts`. Keep only what the
code cannot say: reverse-engineered CC/SDK behavior, why a branch exists,
failure modes that were silent. Never cut a comment with a commit hash, issue
number, or pinned CC behavior — it cost a session to learn.
