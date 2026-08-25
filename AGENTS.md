# Agent Guidelines

## Ownership

This is **our** fork, maintained purely for the distil builder harness. It exists
to solve one problem: Claude integration into pi (provider + AskClaude tool),
better than maintaining our own adapter. It works. It is ours.

- Upstream (elidickinson) is dead to us — no pulling, no PRs, no issue tracking.
- Not published to npm. No changelog, no release process, no version bumps.
  `CHANGELOG.md` and `TODO.md` are historical record only; do not maintain them.
- Change freely. The only constraint is that the distil builder harness keeps
  working: verify with the tests before committing.

## Restricted Actions

Do **not** interact with the public without explicit permission — no PRs,
no GitHub comments, no publishing.

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
