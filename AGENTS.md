# Agent Guidelines

The single agent-facing doc for this repo. Pull `docs/` for reference:
`docs/config.md` (settings), `docs/debugging.md` (logs), `docs/known-issues.md`
(gotchas + CC behavior forensics).

## Ownership

Our fork, maintained purely for the distil builder harness. Upstream
(elidickinson) is dead to us — no pulling, no PRs.

- Not published to npm. No changelog, no version bumps — git history is the
  changelog.
- Change freely and commit autonomously. Verify with `just check` before
  committing.

## What it is

A pi extension registering Claude Code as a model provider. The Agent SDK
spawns the real `claude` binary as a subprocess — this is not a cloud API, it's
a local process wrapper. Every tool call flows through pi's TUI over MCP; the
one exception is the hosted web tools (`webTools`, on by default; `false` disables).

Install the canonical checkout directly: `pi install ~/dev/fork/pi-cc`.
A `git:github.com/...` source creates a separate managed clone and is not used.
Ship: `just ship` (check + smoke → push) → fresh-process live probe.

After a fresh clone or repo rename, reload into pi:
```
pi uninstall git:github.com/iteebz/pi-cc   # if a managed clone was installed
pi install ~/dev/fork/pi-cc
```

Tracked hooks enforce scoped conventional commits and recheck pushed history.
Enable them per checkout with `git config core.hooksPath hooks`.

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

## Commands

```
just check      # pre-commit gate: lint + typecheck + unit suite
just test       # full suite including live integration tests
just fmt        # auto-format
just verify     # pre-ship probe: check + bridge smoke test
just ship       # verify → push (local-path install is already live)
```

`tests/int-cache.sh` — prompt-caching prefix stability canary. Treat as
required for any change touching prompt assembly or session sync.

Suite must run outside a sandbox (writes to `~/.claude` for session state).

Toolchain: npm. `package-lock.json` is the single dependency graph used by
local checks and Pi's installed copy.

## Architecture

`src/index.ts` is the entry: registers the provider and hooks pi's session
lifecycle. `src/provider.ts` is the provider's `streamSimple` — dispatches to
three paths: `handleToolResults`, `handleOrphanedResult`, `startFreshQuery`.

```
debug → ui → query-state → turn → session → tools → stream → summary → provider → index
```

Leaves: `convert · attachments · config · models · skills · mcp-server ·
tool-names · extract-tool-results · session-verify · prompt-capture ·
prompt-stream`.

`cc-session/` — vendored CC JSONL session I/O (types, parse, write, repair,
path resolution). Self-contained; nothing in it imports from the bridge.

## Invariants

- Provider query starts CC with the hosted pair by default (`tools: []` when
  `webTools: false`). Every other tool arrives over MCP. Any other tool_use is a
  hallucinated builtin — must not reach pi.
- Model `contextWindow` in `src/models.ts` must match what the bridge serves
  (200K). Mismatch desynchronizes pi's auto-compaction.
- Prefix stability across turns keeps prompt caching alive. Haiku's 2048-token
  minimum means it caches nothing with our small system prompt.

## State ownership

Six module-level state slots. Every mutation is a named verb in its owning
module.

| slot | file | lifecycle | what |
|------|------|-----------|------|
| `sharedSession` | `session.ts` | session-scoped | CC session UUID + cursor; cleared on session_shutdown |
| `_ctx` | `query-state.ts` | session-scoped | top-level QueryContext (singleton); reentrant queries get fresh instances |
| `activeQueryContexts` | `query-state.ts` | query-scoped | set of all in-flight QueryContexts; empty between turns |
| `providerSettings` | `provider.ts` | extension-scoped | config loaded once at registration |
| `promptCaptures` | `provider.ts` | extension-scoped, bounded | keyed by assembled system prompt; see prompt-capture.ts LIABILITY warning |
| `ui` | `ui.ts` | session-scoped | pi's UI handle for notifications |

## Prompt cache

The ~25% cache miss rate is **CC/Anthropic baseline**, not bridge damage.
Audit data: plain resume (no rebuild) misses 26%, rebuild misses 22%. The
bridge's conversion is lossy (thinking blocks dropped, tool IDs sanitized),
but rebuilds are not measurably worse than native resumes.

The lever for better cache hits is **fewer rebuilds**, not better conversion.
The code already optimizes for this: same UUID across rebuilds, cursor
advanced past trailing assistant messages, REUSE path whenever possible.

## Comments

Density reference: `src/session.ts` and `src/stream.ts`. Keep only what the
code cannot say: reverse-engineered CC/SDK behavior, why a branch exists,
failure modes that were silent. Never cut a comment with a commit hash, issue
number, or pinned CC behavior — it cost a session to learn.
