# Known issues

## Rebuilds are expensive

The bridge rewrites CC's session from pi's history after aborts, `/compact`,
tree navigation, or API errors. A rebuild loses the prompt cache ~58% of the
time vs ~26% for a plain resume. Aborts alone are 46% of rebuilds. See
`diag/AUDIT.md` § `audit-cache.mjs` for the full investigation.

## Files CC edits aren't carried across rebuilds

CC records post-edit contents as `edited_text_file` attachments; those aren't
carried (they hang off tool-result records with no stable position). The edit
itself survives as a tool call + result. `@file` expansions *are* carried
(`src/attachments.ts`).

## Claims about CC behavior

`~/.claude/projects/**` is **not** evidence of what CC does — the bridge writes
the same files, and CC re-serializes imported records under synthetic ids.
Before asserting "CC does X" from disk, split by provenance (CC-live records
have real `requestId`/`promptId`; ours have `msg_syn_*`/`req_syn_*`).

Better: prove it with a live probe. `tests/int-cc-contracts.mjs` pins
undocumented behaviors against the installed SDK. `diag/capture-proxy.mjs`
captures actual request bodies. And before reverse-engineering an SDK option,
grep `node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` — it documents
every settings field.
