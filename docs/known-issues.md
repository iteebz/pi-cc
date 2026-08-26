# Known issues

## Prompt cache miss rate is ~25% (CC/Anthropic baseline)

The ~25% miss rate is not bridge damage — it is the CC baseline. Measured:
plain resume (no rebuild) misses **26%**, rebuild misses **22%**. Rebuilds
are not measurably worse than native resumes.

The bridge's conversion is lossy (thinking blocks dropped from other
providers, tool IDs sanitized, aborted turns dropped), but this does not
cause the misses. Anthropic's prompt cache has its own TTL, eviction, and
routing behavior that dominate.

The lever for better cache hits is fewer rebuilds, not better conversion.
The code already optimizes: same UUID across rebuilds, cursor tracking,
REUSE path whenever possible. See `diag/AUDIT.md` for the full
investigation.

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
