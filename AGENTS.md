# Agent Guidelines

## Ownership

This is **our** fork, maintained purely for the distil builder harness. It exists
to solve one problem: Claude integration into pi (provider + AskClaude tool),
better than maintaining our own adapter. It works. It is ours.

- Upstream (elidickinson) is dead to us — no pulling, no PRs, no issue tracking.
- Not published to npm. No changelog, no release process, no version bumps.
  `CHANGELOG.md` and `TODO.md` are historical record only; do not maintain them.
- Change freely and commit autonomously. Agents maintain this as needed for
  integrated pi; verify with the tests before committing.

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

## Tests

Unit tests: `npm run test:unit`. Full suite (`npm test`) runs integration +
smoke tests and typically needs to run outside a sandbox because it accesses
local pi/Claude settings and auth state.

## Architecture map

`src/index.ts` is the pi extension entry: it registers the provider (models,
streaming fn), hooks pi session lifecycle events, and owns the shared-session
sync. The module seams:

- `convert.ts` — pi messages → Anthropic API shape; the single place that
  decides what a rebuilt transcript calls each tool.
- `query-state.ts` — per-query state (`QueryContext`) and pending tool-call
  routing between Claude Code's stream and pi's TUI.
- `prompt-stream.ts` — feeding prompts/steers into the running CC query.
- `prompt-capture.ts` — projects pi's assembled system prompt (context files,
  skills) into what CC's child receives; keeps `--no-context-files` honest.
- `skills.ts` — skills block rendering + MCP read-tool rewrite.
- `mcp-server.ts` — serves pi's tools to CC over MCP (`mcp__custom-tools__*`).
- `session-verify.ts`, `extract-tool-results.ts`, `attachments.ts` — session
  write verification, tool-result extraction, image carrying.

Session persistence goes through `cc-session-io`: we write the same JSONL
Claude Code reads, so resume is a real CC resume, not a replayed prompt. The
cursor logic in `syncSharedSession` is load-bearing — read its doc comment
before touching rebuild/reentrancy branches.

## Invariants worth knowing before refactoring

- The provider query always starts CC with `tools: []`; every tool CC can call
  arrives over MCP with an `mcp__custom-tools__` prefix. Anything else in a
  tool_use block is a hallucinated builtin and must not reach pi.
- The registered model `contextWindow` must match what the bridge actually
  serves (200K everywhere — see `src/models.ts`); mismatch desynchronizes pi's
  auto-compaction.
- Prefix stability across turns is what keeps Anthropic prompt caching alive:
  system prompt, tools, and message prefix must not change retroactively.
  `tests/int-cache.sh` fails loudly when you break this — treat it as the
  canary for any change that touches prompt assembly or session sync.
