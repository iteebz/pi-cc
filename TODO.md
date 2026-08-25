# TODO

Live work only. Git history and `diag/AUDIT.md` hold the rest.

1. **Make the dropped-thinking-signature rate visible.** ~26 of ~2,363
   `claude-bridge` thinking blocks carry an empty `thinkingSignature`, so
   `convert.ts` correctly refuses to replay them (Anthropic rejects unverifiable
   signatures) — but the empty-signature case is silent.

   Partly covered now: `convertPiMessages` returns a `dropped` summary and
   `convertAndImportMessages` logs `dropped N thinking (<providers>)`, so the loss
   is countable at conversion time. That is the aggregate, not the source — the
   empty-signature case still needs a WARNING at the drop site to tell "we minted
   nothing" apart from "another provider minted it". A 1.1% invisible loss becomes
   a number, which is the prerequisite for ever explaining it.
