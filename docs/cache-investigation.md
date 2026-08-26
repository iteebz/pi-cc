# Prompt cache investigation

Status: **open investigation** — findings documented, interventions identified, none shipped yet.

## The problem

~25% of `--resume` boundaries miss the prompt cache entirely, re-sending the
whole conversation. Measured across 7,543 requests (April–July 2026). The miss
rate is bimodal: either full hit (~95%+) or near-total miss (<13%).

28.5% of resumes within 5 minutes of the previous request re-send everything,
against a 0.6% in-query control — roughly 40× the floor.

The cost is latency and wasted cache-write tokens on the subscription.

## Root cause analysis

The bridge writes a JSONL session file. CC reads it via `--resume`, runs it
through a normalization pipeline, and sends the result to Anthropic's API.
The cache is keyed on exact bytes. Any difference in the normalized output
between turns breaks the cache.

The normalization pipeline (`normalizeMessagesForAPI` in CC's
`src/utils/messages.ts`) applies 13+ transformations between the JSONL and
the API request. Several are non-deterministic or environment-dependent.

### Confirmed causes (from CC source at `~/dev/fork/claude-code/src`)

**1. Nondeterministic tool result sort** (`messages.ts:2187`)
```
orphanedTRs.sort((a, b) => a.timestamp.localeCompare(b.timestamp))
```
Same-millisecond tool results sort nondeterministically. CC's bug, not ours.
Reproduces at ~80% with 10 parallel tool calls. Bridge-written records cannot
tie (one timestamp per record), so this only affects CC's own live-appended
records — which means it hits on REUSE, not REBUILD.

**2. `[id:xxxx]` tag mutation** (`messages.ts:1620`)
CC appends `\n[id:xxxx]` to every non-`isMeta` user message before sending to
the API. The `xxxx` is derived from the message's UUID via
`deriveShortMessageId`. The bridge generates new UUIDs on every REBUILD
(`randomUUID()` in `cc-session/session.ts:baseFields()`). New UUIDs → new tags
→ different bytes → cache miss.

**Status: needs testing.** If `[id:]` tags land in the cached prefix (before the
`cache_control` marker on the last message), stabilizing UUIDs would directly
improve rebuild cache hits. The `cache_control` marker goes on the last message
only (`addCacheBreakpoints`, `claude.ts:3091`), so tags on earlier messages ARE
in the prefix.

**3. Feature flag flips** (`messages.ts`, `claude.ts`)
CC's normalization is gated on GrowthBook feature flags:
- `tengu_toolref_defer_j8m` — controls tool reference sibling relocation
- `tengu_chair_sermon` — controls system reminder wrapping of attachments
- Various others in `claude.ts`

These read from `checkStatsigFeatureGate_CACHED_MAY_BE_STALE()`, which can
update mid-session when GrowthBook's disk cache refreshes. A flip changes the
normalization output → cache miss. Cannot be controlled from the bridge.

**4. Server-side eviction**
Anthropic's cache has TTL behavior. >1h gaps miss at 96.7% (expected).
15-60min gaps miss at 78.3% (higher than the 1h TTL CC requests should
allow). Likely server-side routing or eviction.

### What the bridge controls vs. doesn't

| Factor | Bridge can fix? | Status |
|--------|----------------|--------|
| UUID stability across rebuilds | **Yes** | Not yet done |
| `isMeta` flag on bridge records | **Yes** | Not yet done |
| Tool result timestamp ties | No — CC's sort | CC bug |
| Feature flag flips | No — CC's GrowthBook | CC infra |
| Server-side cache eviction | No — Anthropic | Anthropic infra |
| `normalizeMessagesForAPI` transforms | No — CC binary | CC code |

### Interventions the bridge CAN make

**A. Stabilize UUIDs across rebuilds.**
Currently: `randomUUID()` on every rebuild → new `[id:]` tags → cache miss.
Proposed: derive UUIDs deterministically from message content + position, or
preserve the UUIDs CC wrote in the previous session. The session file from the
prior run has the UUIDs CC last saw — reusing them means the `[id:]` tags match
what was cached.

Implementation: `cc-session/session.ts:baseFields()` generates UUIDs. Either:
- Read the old session's UUIDs before deleting it and replay them
- Or derive UUIDs as `uuidv5(sessionId + messageIndex)` for determinism

**B. Set `isMeta` on bridge-written user records.**
CC skips `[id:]` tag injection for `isMeta` messages (`messages.ts:1623`).
If bridge-written user records are marked `isMeta`, their content stays
stable across rebuilds regardless of UUID changes. Risk: unknown — `isMeta`
may affect other CC behaviors (display, compaction, filtering).

**C. Skip rebuild on clean aborts.**
Currently: every abort marks `needsRebuild`. Could instead validate the JSONL
after abort — if all lines parse and tool pairing is sound, REUSE instead.
This avoids the rebuild entirely, keeping UUIDs and everything else identical.

## Code references

### Bridge code (`~/dev/fork/pi-claude-bridge/src`)
- `cc-session/session.ts:baseFields()` — UUID generation (line ~144)
- `session.ts:markAborted()` — sets `needsRebuild` on abort
- `session.ts:syncSharedSession()` — REUSE vs REBUILD decision
- `convert.ts:convertPiMessages()` — pi→Anthropic message conversion
- `provider.ts:startFreshQuery()` — where syncSharedSession is called

### CC source (`~/dev/fork/claude-code/src`)
- `utils/messages.ts:1620` — `appendMessageTagToUserMessage` (`[id:]` injection)
- `utils/messages.ts:2187` — `recoverOrphanedParallelToolResults` (nondeterministic sort)
- `utils/messages.ts:1990` — `normalizeMessagesForAPI` (13+ transforms)
- `utils/messages.ts:1481` — `reorderAttachmentsForAPI` (attachment reorder)
- `utils/sessionStorage.ts:2069` — `buildConversationChain` (JSONL → message chain)
- `utils/sessionStorage.ts:3472` — `loadTranscriptFile` (JSONL reader)
- `services/api/claude.ts:3070` — `addCacheBreakpoints` (cache_control placement)
- `services/api/claude.ts:3213` — `buildSystemPromptBlocks` (system prompt caching)
- `services/api/claude.ts:358` — `getCacheControl` (TTL: 1h for subscribers)
- `services/api/promptCacheBreakDetection.ts` — CC's own cache break detector

### Diagnostic tooling (`~/dev/fork/pi-claude-bridge/diag`)
- `audit-cache.mjs` — cache hit/miss rate from bridge debug log
- `capture-proxy.mjs` — capture actual API request bodies
- `diff-captures.mjs` — diff captured request bodies

## Testing approach

Model: any (cache behavior is model-independent per the audit). Sonnet 4.6
is cheapest for iteration.

Enable debug logging: `CLAUDE_BRIDGE_DEBUG=1`

The cache hit rate is visible in the bridge debug log:
```
usage: in=X out=Y cacheRead=Z cacheWrite=W total=T cachePct=P% model=M
```

A cache hit: `cachePct` ≥ 90% on turn 2+.
A cache miss: `cachePct` < 50% when `cacheWrite` was >0 on the previous turn.

Integration test: `tests/int-cache.sh` — 5 turns, verifies cache reuse across
`--resume` boundaries. Currently passes consistently.

To test UUID stabilization: modify `cc-session/session.ts:baseFields()`, run a
multi-turn session, abort mid-turn, verify `cachePct` on the next turn.

## Audit baseline

From `diag/AUDIT.md` (2026-07-29, 7,543 requests):
```
in-query   40 / 6466 pairs   0.6%   <- control (bridge can't mutate prefix)
boundary  136 /  549 pairs  24.8%   <- --resume boundaries
```

Resume cache hit distribution (n=782):
```
>=95%: 57.2%    50-94%: 1.3%    <50%: 41.6%
```

Gap analysis (sub-5-minute resumes):
```
28.5% miss rate — 40× the in-query control
43% of misses read back only the system+tools preamble (6,599 tokens)
39% of misses cache nothing at all (cacheRead=0)
```
