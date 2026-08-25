# TODO

Live work only. Git history and `diag/AUDIT.md` hold the rest.

1. **#30: pruning costs Claude the turn's context.** When `pi-context-prune`
   shrinks pi's history below our cursor, `syncSharedSession` clean-starts, so
   Claude answers that turn with no prior conversation. Rebuilding from the pruned
   messages keeps the (compressed) context and still bounds the JSONL, which is
   what the issue asks for.

   The discriminator must be **reentrancy, not message count.** The
   shorter-context branch in `syncSharedSession` is also the guard that stops a
   subagent resuming and overwriting the parent's session, and a subagent's priors
   are not empty. `isReentrant` is already computed in `src/index.ts` immediately
   before the `syncSharedSession` call and just isn't passed in — thread it
   through and branch on it. The stale `fix/issue-30-pruned-history` branch
   discriminates on `priorMessages.length === 0` and would break subagent
   isolation — do not merge it. Guarded by `unit-sync-shared-session.mjs` plus
   `int-subagent-rpiv-codebase-locator.mjs`.

2. **Make the dropped-thinking-signature rate visible.** ~26 of ~2,363
   `claude-bridge` thinking blocks carry an empty `thinkingSignature`, so
   `convert.ts` correctly refuses to replay them (Anthropic rejects unverifiable
   signatures) — but the empty-signature case is silent.

   Partly covered now: `convertPiMessages` returns a `dropped` summary and
   `convertAndImportMessages` logs `dropped N thinking (<providers>)`, so the loss
   is countable at conversion time. That is the aggregate, not the source — the
   empty-signature case still needs a WARNING at the drop site to tell "we minted
   nothing" apart from "another provider minted it". A 1.1% invisible loss becomes
   a number, which is the prerequisite for ever explaining it.
