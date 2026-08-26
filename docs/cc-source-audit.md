# CC Source Audit — Bridge Assumptions vs Reality

Audited 2026-08-26 against CC source at `~/dev/fork/claude-code/src/` (leaked 2.0.89).

## Seam 1: JSONL → Normalized API Messages

### Data flow

Bridge writes JSONL → CC reads via `loadTranscriptFile` (sessionStorage.ts:3472) →
`isTranscriptMessage` filters to user/assistant/attachment/system (sessionStorage.ts:139) →
`buildConversationChain` walks parentUuid from leaf (sessionStorage.ts:2069) →
`normalizeMessages` splits multi-block messages (messages.ts:741) →
`normalizeMessagesForAPI` applies 13+ transforms (messages.ts:1989).

### Per-field analysis

| Field | Bridge writes | CC uses? | Verdict |
|-------|--------------|----------|---------|
| `uuid` | Deterministic SHA-256(sessionId + index) | **Yes — critical.** `buildConversationChain` walks via parentUuid→uuid. `deriveShortMessageId(uuid)` → `[id:xxxx]` tag appended to non-isMeta user messages (messages.ts:1620). Merged messages pick uuid based on isMeta (messages.ts:2429). | ✅ Correct. Deterministic UUIDs stabilize [id:] tags across rebuilds. |
| `parentUuid` | Chained from previous record | **Yes — critical.** The entire chain walk depends on this. Cycle → partial transcript. Missing → chain break. | ✅ Correct. Linear chain matches CC's walk. |
| `timestamp` | Monotonic `Date.now()++` | **Yes — used for sort.** `recoverOrphanedParallelToolResults` sorts by `a.timestamp.localeCompare(b.timestamp)` (sessionStorage.ts:2187). Bridge writes unique monotonic timestamps → no ties → sort is deterministic. | ✅ Correct. |
| `isSidechain` | Always `false` | **Yes — read path.** `loadTranscriptFile` uses it for leaf detection (sessionStorage.ts:3399), session listing filters sidechain sessions (sessionStorage.ts:5056-5058). `false` is correct for main conversation. | ✅ Correct. |
| `cwd` | `normalizeProjectPath(cwd)` | **Yes — metadata only.** Used for `projectPath` in LogOption (sessionStorage.ts:4680). Not used in normalization. | ✅ Correct. |
| `userType` | `"external"` | **No — never read.** Written by CC (sessionStorage.ts:1057) but never read back by any normalization or chain logic. Only exists in `SerializedMessage` type (logs.ts:10). | ✅ Inert — any value works. |
| `version` | `"2.1.83"` | **No — metadata only.** Read back for `LogOption` display but never affects normalization. | ⚠️ Fragile. Hardcoded version drifts from actual CC. No functional impact now but could gate logic in future CC versions. |
| `slug` | `bridge-{random8}` | **Write path only.** CC reads it from records only to re-populate its slug cache (sessionStorage.ts:1023). CC overwrites it on next write (bridge notes this already). Not used in normalization. | ✅ Inert. |
| `entrypoint` | `"cli"` | **Analytics only.** Recorded in analytics metadata (analytics/metadata.ts:906). Never affects normalization. | ✅ Correct — `cli` is accurate since the bridge runs through CC CLI. |
| `requestId` | `req_syn_{random}` on assistant records | **No — not read by normalization.** CC writes it (sessionStorage.ts), but `normalizeMessagesForAPI` never consults requestId. The normalized `AssistantMessage.requestId` comes from CC's own API response, not the JSONL record. | ✅ Inert. |
| `promptId` | Not written (optional field) | Read by CC for OTel correlation. Absence is fine. | ✅ Correct. |
| `permissionMode` | Not written (optional field) | Read by CC for permission rewind. Absence is fine. | ✅ Correct. |
| `isMeta` | Not written (defaults to undefined) | **Yes — affects normalization.** Non-isMeta user messages get `[id:xxxx]` tags (messages.ts:1621). Meta messages get merged differently (messages.ts:2428). Error stripping targets isMeta messages (messages.ts:2117). Bridge user messages are real user turns → correctly NOT isMeta. | ✅ Correct. |
| `sessionId` | Stable UUID across rebuilds | Used by CC to group records. Reuse preserves log correlation. | ✅ Correct. |
| `gitBranch` | `"HEAD"` | Metadata only. | ⚠️ Fragile — always "HEAD" instead of actual branch. No normalization impact. |
| `message.id` (assistant) | `msg_syn_{random}` | **Yes — critical.** `normalizeMessagesForAPI` merges assistant messages with the same `message.id` (messages.ts:2253). `recoverOrphanedParallelToolResults` groups siblings by `message.id` (sessionStorage.ts:2157). Bridge writes one message.id per assistant record → no merging needed → correct. | ✅ Correct. |

### Summary: ✅ All fields correct or inert. Two ⚠️ cosmetic fragilities (version, gitBranch) with no normalization impact.


## Seam 2: Tool Pairing

### Bridge repair (cc-session/repair.ts)

The bridge's `repairToolPairing` handles three cases:
1. **Orphan tool_use** (assistant has tool_use, no subsequent tool_result) → injects synthetic `{is_error: true, content: "[no tool result recorded]"}`
2. **Orphan tool_result** (tool_result with no preceding tool_use) → drops it
3. **Consecutive assistants** → flushes pending results between them

### CC repair (messages.ts:5120 `ensureToolResultPairing`)

CC's repair runs AFTER `normalizeMessagesForAPI` and handles:
1. **Missing tool_result** → injects `{is_error: true, content: "[Tool result missing due to internal error]"}`
2. **Orphan tool_result** → strips it
3. **Duplicate tool_use IDs** → strips duplicates
4. **Duplicate tool_result IDs** → strips duplicates
5. **Orphan server_tool_use/mcp_tool_use** → strips if no matching result in same message

### Double-repair analysis

The bridge repairs **before** writing JSONL. CC repairs **after** normalizing the loaded JSONL. Key question: can bridge repair create something CC repair then double-repairs?

**No — the repairs are compatible:**

- Bridge repair inserts synthetic tool_results with `is_error: true`. These are structurally valid tool_results paired with the tool_use. CC's repair sees them as matched → **skips them**.
- Bridge repair drops orphan tool_results. CC's repair would also drop them → **idempotent**.
- The bridge's synthetic content (`"[no tool result recorded]"`) is different from CC's (`"[Tool result missing due to internal error]"`), but this is cosmetic — the model sees the bridge's string, CC never overrides it because the pairing is valid.
- `importMessages` in session.ts also calls `repairWithOrigin` internally. The bridge calls it on the pre-import array, then `importMessages` calls it again. `repairToolPairing` is idempotent (comment in session.ts confirms this).

**One edge case:** CC's repair handles duplicate tool_use IDs across messages (`allSeenToolUseIds` set), which the bridge's repair does NOT handle. But the bridge writes one message.id per assistant, and CC's `normalizeMessagesForAPI` merges assistants with the same message.id. Since bridge message.ids are unique, no merging happens, and duplicate tool_use IDs can't occur in the bridge's output.

### Verdict: ✅ Correct. No double-repair possible. Repairs are compatible and idempotent.


## Seam 3: Attachment Lifecycle

### Bridge placement (src/attachments.ts)

The bridge carries `@file` attachments (`type: "file"`) across rebuilds by:
1. `collectCarriedAttachments`: reads old session, finds content-bearing attachments, tags each with its parent's ordinal among text-bearing user records.
2. `placeCarriedAttachments`: maps ordinal to position in the new message array, verifying the text matches. Mismatch → skipped (conservative).
3. `importMessages`: writes attachments as JSONL records chained into the uuid chain at the right position.

### CC's reorder (messages.ts:1481 `reorderAttachmentsForAPI`)

CC bubbles attachment records **upward** (toward the top of the array) until they hit either:
- An assistant message, OR
- A user message whose first content block is `tool_result`

Then they're placed **after** the stopping point.

### Match analysis

The bridge writes attachments immediately after the user record they belong to (via `afterIndex` in `importMessages`). CC's reorder then bubbles them upward. This means:

- **Normal case** (attachment after a user text message): reorder hits the user message itself and leaves the attachment in place → ✅ correct.
- **Attachment after a user message that's followed by a tool_result message**: reorder bubbles the attachment up past the tool_result messages until it hits the preceding assistant → places it after the assistant and before the tool_results → **different from bridge placement** but this is CC normalizing its own semantics, not a conflict.
- **Attachment between tool_result and user text**: the bridge never places here (ordinal scheme keys only to text-bearing user records, not tool_result records).

### Types the bridge drops

The bridge carries only `type: "file"`. It explicitly drops:
- `edited_text_file` — edit content already exists as tool call + result in pi history
- `skill_listing`, `task_reminder`, `agent_listing_delta`, `mcp_instructions_delta` — CC regenerates these every turn
- `directory` — CC regenerates these
- All swarm-related types

CC's `normalizeAttachmentForAPI` (messages.ts:3453) handles all of these. The bridge's filtering is correct: everything dropped is either already in the conversation or regenerated by CC.

### Verdict: ✅ Correct. Placement matches CC's expectations. Type filtering is sound.


## Seam 4: System Prompt Forwarding

### Bridge approach (prompt-capture.ts, provider.ts)

The bridge captures pi's assembled system prompt, extracts the portable parts (context files, skills, custom prompt, append text), and forwards them via the SDK's `systemPrompt` option:
```typescript
systemPrompt: forwardedPrompt ?? { type: "preset", preset: "claude_code" }
```

When `forwardedPrompt` is a string, it **replaces** CC's preset entirely.

### CC's system prompt caching (claude.ts:3213 `buildSystemPromptBlocks`)

CC splits the system prompt into blocks via `splitSysPromptPrefix` and applies `cache_control` markers:
```typescript
return splitSysPromptPrefix(systemPrompt, {...}).map(block => ({
  type: 'text',
  text: block.text,
  ...(enablePromptCaching && block.cacheScope !== null && {
    cache_control: getCacheControl({...})
  }),
}))
```

### Interaction analysis

1. **Cache compatibility**: CC applies cache_control to the system prompt blocks. The bridge's forwarded prompt is a different string than CC's preset → different cache key. This is **expected and correct** — the bridge wants its own prompt cached, not CC's preset.

2. **Additional system content CC injects**: CC injects additional system content beyond the main prompt:
   - Tool definitions (separate from system prompt, handled by the SDK)
   - Attachment expansion into `<system-reminder>` wrapped user messages (messages.ts:2273, gated on `tengu_chair_sermon`)
   - These are **message-level**, not system-prompt-level → no conflict

3. **Preset override semantics**: When the bridge passes a string, CC uses it as the entire system prompt. When it passes `{type: "preset", preset: "claude_code"}`, CC uses its own preset. The bridge never passes both simultaneously.

4. **Cache scope**: CC's `splitSysPromptPrefix` splits on `\n\n---\n\n` boundaries and assigns cache scopes. The bridge's forwarded prompt has no such delimiters → treated as a single block → one cache_control marker. This is **fine** — single-block system prompts cache correctly.

### Verdict: ✅ Correct. System prompt forwarding is clean. CC's caching operates on the forwarded content normally.


## Seam 5: Feature Flag Sensitivity

### Flags that affect normalization

| Flag | Effect | Bridge impact |
|------|--------|---------------|
| `tengu_toolref_defer_j8m` | Controls whether `TOOL_REFERENCE_TURN_BOUNDARY` text siblings are injected into user messages (messages.ts:2153) or relocated post-merge (messages.ts:2301). | ⚠️ **Fragile.** The bridge's records don't contain tool_reference blocks, so NEITHER path fires on bridge content. Safe by accident — if a pi tool produced tool_reference content, this flag would change normalization. |
| `tengu_chair_sermon` | Controls `ensureSystemReminderWrap` on attachment messages (messages.ts:2273) and `smooshSystemReminderSiblings` post-merge (messages.ts:2334). | ⚠️ **Fragile.** Carried `@file` attachments get normalized through `normalizeAttachmentForAPI` which applies `wrapMessagesInSystemReminder`. Whether the wrapper gets double-wrapped by `ensureSystemReminderWrap` depends on this flag. A flag flip changes the bytes → **cache miss.** |
| `HISTORY_SNIP` (compile-time feature) | Controls `[id:xxxx]` tag injection on user messages (messages.ts:2351). When off, no tags injected → different bytes than when on. | ⚠️ **Fragile but stable.** This is a compile-time feature flag, not a runtime GrowthBook gate. It doesn't flip mid-session. The bridge's deterministic UUIDs only matter when this feature is enabled. |
| `tengu_anti_distill_fake_tool_injection` | Injects fake tool uses into the conversation (claude.ts:307). | ❌ **Potential problem.** If enabled, CC injects synthetic tool_use/tool_result pairs into the message stream. These don't exist in the bridge's JSONL. On the next turn, CC normalizes the combined transcript (bridge JSONL + its own injected messages) and the presence/absence of these fake tools changes the normalized output → cache miss. The bridge can't control this. |

### Summary

The bridge cannot control GrowthBook flags. The main risk is **cache instability**, not correctness — all flag-gated transforms produce valid API messages either way. The bridge's content passes through normalization correctly regardless of flag state.

The one non-cache concern is `tengu_anti_distill_fake_tool_injection` (claude.ts:307), which could inject content the bridge doesn't expect. However, this likely only fires for suspected distillation (not normal usage), and the injected content would be in CC's own live messages, not in the bridge's JSONL.

### Verdict: ⚠️ Fragile but not fixable. Flag flips cause cache misses (~25% baseline is largely this). No correctness bugs.


## New Findings for known-issues.md

### 1. `version` field hardcoded to `"2.1.83"` — cosmetic drift

The bridge hardcodes `version: "2.1.83"` in `session.ts:80`. CC reads this for `LogOption` display but never gates normalization on it. No functional impact today, but a future CC version could gate behavior on the version field of resumed sessions (e.g., "apply legacy compat for pre-X.Y records"). Low risk, easy to fix: read the version from the installed CC binary.

### 2. CC's `isVirtual` / `isVisibleInTranscriptOnly` filtering

`normalizeMessagesForAPI` filters out messages with `isVirtual: true` (messages.ts:2002). The bridge never writes these fields, which is correct — but if CC ever wrote a virtual message to the JSONL during a live session and the bridge later read and re-imported it, the field would be lost. Currently safe because the bridge never opens a CC-written session for import — it only reads its own files.

### 3. `system` record type not written

CC's `isTranscriptMessage` accepts `type: "system"` records. The bridge only writes `user`, `assistant`, and `attachment` records. This is correct — system records are CC-internal (compact boundaries, turn durations, local commands). The bridge has no reason to write them.
