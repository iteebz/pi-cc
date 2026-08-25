# Agent Guidelines

The single agent-facing doc for this repo. There is no README — this is it.

## Ownership

This is **our** fork, maintained purely for the distil builder harness. It exists
to solve one problem: Claude integration into pi (provider + session sync),
better than maintaining our own adapter. It works. It is ours.

- Upstream (elidickinson) is dead to us — no pulling, no PRs, no issue tracking.
- Not published to npm. No changelog, no release process, no version bumps — git
  history is the changelog.
- Change freely and commit autonomously. Verify with the tests before committing.

## What it is

A pi extension registering the Claude Code provider: Opus/Sonnet/Haiku as models
in pi. It is a minimal adapter, not a port of Claude Code — the job is to spend
the Claude subscription inside pi's harness, nothing more. Every tool call flows
through pi's TUI over MCP; the one deliberate exception is the hosted web tools
(`webTools`, off by default), which run server-side because pi ships no native
web search. Streaming, MCP tool bridging, session resume/persistence via
`cc-session-io`, thinking support, skills forwarding, mid-turn steering.

Install locally from this repo with `pi install /path/to/pi-claude-bridge`. The
copy pi actually runs lives at `~/.pi/agent/git/github.com/iteebz/pi-claude-bridge`;
after pushing, refresh it with `pi update git:github.com/iteebz/pi-claude-bridge`.
Ship protocol: verify → commit → push → `pi update` → live probe.

Select a model with `/model` (`claude-bridge/claude-opus-5`,
`claude-bridge/claude-sonnet-5`, `claude-bridge/claude-haiku-4-5`, …). All models
serve the bare id at a 200K context window — the `[1m]` variants are never
requested (see `src/models.ts`). Bash commands get a 120s default timeout
(matching CC's default; pi's bash has none). Skills are copied into CC's system
prompt. Steering works mid-turn: a message sent while a tool runs reaches CC at
that tool boundary, not after the turn finishes.

## Configuration

`~/.pi/agent/claude-bridge.json` (global) or `.pi/claude-bridge.json` (project,
merged over global). Reload with `/reload` after edits.

```json
{ "provider": { "webTools": true } }
```

- `strictMcpConfig` — block MCP servers from `~/.claude.json` / `.mcp.json`
  (default `true`). Cloud MCP (Gmail/Drive via claude.ai OAuth) is always blocked.
- `webTools` — enable hosted WebSearch/WebFetch (default `false`). They run
  server-side (Anthropic executes, billed against subscription quota); results
  stay inside CC's context and the stream renders `[web search]` markers.
- `autoMemoryEnabled` — enable CC's auto-memory system (default `false`).
- `pathToClaudeCodeExecutable` — path to the `claude` binary. Useful when the
  SDK's bundled musl/glibc binaries can't run (e.g. Nix:
  `"/home/you/.nix-profile/bin/claude"`).

The forwarded context (AGENTS.md files, pi's skills block, `.pi/SYSTEM.md`)
**replaces** CC's system prompt entirely; the `claude_code` preset survives only
as fallback when there is nothing to forward. Tool-use style and permission
framing therefore come from your own context files. There is no config flag for
this — it is the behavior.

pi's `modelOverrides` in `~/.pi/agent/models.json` do not apply to
extension-registered providers; override `contextWindow` etc. by editing
`src/models.ts`.

## Tests

From this dev checkout (it has `node_modules`; the installed copy does not):

- `npx tsc --noEmit` — typecheck.
- `npm run lint` — biome lint + format check (`src`, `tests`, `diag`). `npm run
  format` applies fixes. Config in `biome.json`: 2-space, 120 columns, double
  quotes, organized imports — standardized with distil (agents emit spaces by
  default; the formatter matches rather than fights them). Run lint plus the typecheck before committing.
- `npm run test:unit` — offline tests (`tests/unit-*.mjs`: queue, import, skills,
  sync). Always run this plus the typecheck before committing.
- `npm test` — full suite; adds integration tests that spawn real `pi` + Claude
  Code subprocesses (`tests/int-*.{sh,mjs}`: smoke, multi-turn, cache,
  session-resume/-rebuild, tool-message). Run at least `tests/int-smoke.sh`
  before shipping. Set `CLAUDE_BRIDGE_TESTING_ALT_MODEL` in `.env.test` for the
  alt-provider smoke test. The suite needs to run outside a sandbox: it writes to
  `~/.claude` for CC's session state, and a sandbox that blocks it makes the next
  turn's `--resume` fail with "No conversation found with session ID". The RPC
  harness probes for this at startup and fails fast.

`tests/int-cache.sh` is the canary for prompt-caching prefix stability — treat it
as required for any change touching prompt assembly or session sync.

## Debugging

`CLAUDE_BRIDGE_DEBUG=1` enables:

- **Bridge log** at `~/.pi/agent/claude-bridge.log` — every provider call,
  session-sync decision, tool-result delivery, and CC's stderr. Override with
  `CLAUDE_BRIDGE_DEBUG_PATH`.
- **Per-query CC CLI logs** at
  `~/.pi/agent/cc-cli-logs/<timestamp>-<tag>-<seq>.log` — the CC subprocess's own
  debug stream, one file per `query()`. Useful when a resume fails or CC
  misbehaves internally.

For a session-resume failure, the useful artifacts are the `syncResult:` lines
from the bridge log plus the matching `cc-cli-logs/` file for the failing query.

## Claims about how Claude Code behaves

`~/.claude/projects/**` is **not** evidence of what CC does. The bridge writes into
the same files and CC re-serializes imported records under synthetic ids, so a scan
of that directory largely reflects our own output handed back to us — 352 of 1,810
files hold both shapes. Before asserting "CC does X" from disk, split by provenance
(CC-live records carry a real `requestId`/`promptId`; ours carry
`msg_syn_*`/`req_syn_*`) and regroup by `message.id`, since CC stores one content
block per record while cc-session-io stores one record per message.
`diag/audit-transcripts.mjs` does both.

Better still, prove it with a live probe. `tests/int-cc-contracts.mjs` pins each
undocumented behavior we depend on against the installed CC/SDK and is the right
home for a new assumption; `diag/capture-proxy.mjs` captures the actual request
bodies when the question is what CC sends. And before reverse-engineering an SDK
option at all, grep `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — it
documents every settings field, several of which solve problems the CC source
makes look intractable.

The same skepticism applies to any *rate* computed from the debug log. Before
believing one, check the metric against a case whose answer you know: the
cache-break scanner counted a request's uncached `input` as if the next request
should read it back, which turned every tool-heavy turn into a false break and
manufactured a dose-response that looked like a real finding.

Bin by era before comparing groups. A correlation computed over a window that
straddles the onset of the phenomenon will credit whatever else changed.

Five wrong conclusions across two sessions came from skipping the above.

## Architecture

`src/index.ts` is the pi extension entry: it registers the provider, hooks pi's
session lifecycle events, and owns `streamSimple` plus the shared-session sync.
Everything else lives one layer down, each module importing only from below it:

```
debug → ui → query-state → turn → session → tools → stream → summary → index
```

with `convert · attachments · config · models · skills · mcp-server ·
tool-names · extract-tool-results · session-verify · prompt-capture ·
prompt-stream` as leaves the above pull from.

- `convert.ts` — pi messages → Anthropic API shape; the single place that decides
  what a rebuilt transcript calls each tool.
- `query-state.ts` — `QueryContext` (per-query and per-turn mutable state) and the
  registry that routes a delivered tool result to the query waiting for it.
- `turn.ts` — reads the current user turn out of pi's context; `turnStart` is the
  single history/prompt split.
- `session.ts` — sole owner of the shared CC session. `syncSharedSession` writes
  the same JSONL CC reads, so resume is a real CC resume, not a replayed prompt.
  Read its doc comment before touching rebuild/reentrancy branches.
- `tools.ts` — the pi↔CC tool-name bridge and MCP result routing.
- `stream.ts` — CC's SDK stream → pi's event stream.
- `summary.ts` — compaction and branch-summary takeover, each in its own CC
  subprocess that never touches the live session.
- `prompt-capture.ts` — projects pi's assembled system prompt (context files,
  skills) into what CC's child receives; keeps `--no-context-files` honest.
- `prompt-stream.ts` — feeds prompts and mid-turn steers into the running query.
- `skills.ts` / `mcp-server.ts` — skills-block rendering; serving pi's tools to CC
  over MCP (`mcp__custom-tools__*`).
- `tool-names.ts` — the MCP server name and `mcp__custom-tools__` prefix, in a
  dependency-free leaf so `convert.ts`/`skills.ts`/`tools.ts` read the string
  without importing the MCP SDK server.

Session persistence goes through `cc-session-io`: we write the same JSONL Claude
Code reads, so resume is a real CC resume.

## Invariants worth knowing before refactoring

- The provider query always starts CC with `tools: []` (or the hosted WebFetch/
  WebSearch pair when `webTools` is on); every other tool CC can call arrives over
  MCP with an `mcp__custom-tools__` prefix. Anything else in a tool_use block is a
  hallucinated builtin and must not reach pi.
- The registered model `contextWindow` must match what the bridge actually serves
  (200K everywhere — see `src/models.ts`); a mismatch desynchronizes pi's
  auto-compaction.
- Prefix stability across turns is what keeps Anthropic prompt caching alive:
  system prompt, tools, and message prefix must not change retroactively. With the
  replaced (small) system prompt the cacheable prefix is ~1–2K tokens: fine for
  Sonnet/Opus (1024 min) but **under Haiku's 2048 minimum — Haiku caches nothing**.
  `tests/int-cache.sh` runs Sonnet for exactly this reason and fails loudly when
  the prefix breaks — treat it as the canary for any change to prompt assembly or
  session sync.

## Known issues

- **Sessions get rebuilt more often than they need to be, and a rebuild is
  expensive.** The bridge rewrites CC's session from pi's history whenever pi's
  messages move underneath it — after an abort, `/compact`, tree navigation, or an
  API error. Over this repo's own bridge log a rebuild boundary lost the prompt
  cache ~58% of the time versus ~26% for a plain resume; aborts alone are 46% of
  rebuilds. See `TODO.md` #1.
- **Files CC edits are not carried across a rebuild.** CC records post-edit
  contents as an `edited_text_file` attachment; those aren't carried, because they
  hang off a tool-result record rather than a prompt and so have no stable position
  to restore them to. The edit itself survives in history as a tool call and its
  result — this costs the file snapshot, not the knowledge of the change. `@file`
  expansions *are* carried (`src/attachments.ts`).

## Comments

The density reference is `src/session.ts` and `src/stream.ts`. Match them.

Keep only what the code cannot say: reverse-engineered CC/SDK behavior, why a
branch exists, and failure modes that were silent. Cut restatement, step
narration, historical drama, and section banners — self-evident code is
self-evident. Never cut a comment you cannot re-derive: a commit hash, an issue
number, or a "CC does X" pinned by a contract test is knowledge that cost a
session to learn and is the entire reason the comment exists.
