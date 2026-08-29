// Pi extension entry: registers the Claude Code provider and hooks pi's
// session lifecycle. The provider's query execution lives in provider.ts.

import { getModels } from "@earendil-works/pi-ai/compat";
import {
  type BuildSystemPromptOptions,
  compact,
  type ExtensionAPI,
  type ExtensionContext,
  generateBranchSummary,
} from "@earendil-works/pi-coding-agent";
import { loadConfig } from "./config.js";
import { PROVIDER_ID } from "./convert.js";
import { debug, errorMessage, moduleInstanceId } from "./debug.js";
import { buildModels } from "./models.js";
import { recordPromptCapture, setProviderSettings, streamClaudeAgentSdk } from "./provider.js";
import { reportLeaks } from "./query-state.js";
import { clearSharedSession, markNeedsRebuild } from "./session.js";
import { branchSummaryOutcome, isolatedStreamFn, reinjectPriorCompactionFileOps } from "./summary.js";
import { setUI } from "./ui.js";

// Pi binds getSystemPromptOptions onto every extension context at runtime, but
// its published types declare it only on command contexts. Narrow here rather
// than casting at each call site.
function systemPromptOptions(ctx: ExtensionContext): BuildSystemPromptOptions | undefined {
  const get = (ctx as { getSystemPromptOptions?: () => BuildSystemPromptOptions }).getSystemPromptOptions;
  return typeof get === "function" ? get.call(ctx) : undefined;
}

// Guards against re-registration across module reloads. Extensions like
// pi-subagents load this module again in the subagent; without the guard, that
// instance's registerProvider() overwrites the parent's streamSimple in the
// shared ModelRegistry, and the parent's next tool result runs against the
// subagent's empty state. Symbol.for is shared across module instances, so only
// the first registration takes effect. clearSession resets it on shutdown so
// /reload can register fresh.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("cc:activeStreamSimple");

const MODELS = buildModels(getModels("anthropic"));

export default function (pi: ExtensionAPI) {
  // Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

  const config = loadConfig(process.cwd());
  debug("loadConfig:", JSON.stringify(config));
  setProviderSettings(config.provider ?? {});

  const clearSession = (event: string) => {
    clearSharedSession(event);
    // Release the global streamSimple if this instance registered it, so
    // /reload can register fresh instead of wrapping stale state.
    const g = globalThis as Record<symbol, any>;
    if (g[ACTIVE_STREAM_SIMPLE_KEY] === streamClaudeAgentSdk) {
      g[ACTIVE_STREAM_SIMPLE_KEY] = undefined;
    }
  };

  pi.on("session_start", (event, ctx) => {
    setUI(ctx.ui);
    if (event.reason === "new" || event.reason === "resume" || event.reason === "fork") {
      clearSession(`session_start:${event.reason}`);
    }
  });

  // Set by before_agent_start, consumed by agent_start. Only a turn that never
  // fired before_agent_start needs the fallback capture below.
  let capturedThisTurn = false;

  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
    capturedThisTurn = true;
    recordPromptCapture(event.systemPrompt, {
      custom: options?.customPrompt,
      append: options?.appendSystemPrompt,
      contextFiles: options?.contextFiles ?? [],
      skills: hasRead ? (options?.skills ?? []) : [],
    });
  });

  // Pi emits before_agent_start only from the user-prompt path. A turn an
  // extension starts with sendMessage(triggerTurn) goes straight to the agent
  // loop, so nothing captured its prompt and the turn dies claiming the prompt
  // is unknown. That path also never offers extensions a chance to override the
  // system prompt, so the live one is pi's own assembly and safe to record.
  // Recording unconditionally here would be wrong: it would key a prompt some
  // extension rebuilt to base options and silently drop the user's real
  // instructions — exactly what the capture error exists to prevent.
  //
  // Pi binds getSystemPromptOptions onto command contexts only, so this path
  // often sees none. An options-less capture projects to nothing and the query
  // silently falls back to Claude Code's preset — the agent then answers as
  // Claude Code with no SYSTEM.md, AGENTS.md or skills. Forwarding the live
  // assembly as the custom prompt loses the structural split but keeps every
  // instruction pi loaded.
  pi.on("agent_start", (_event, ctx) => {
    const handled = capturedThisTurn;
    capturedThisTurn = false;
    if (handled) return;
    const assembled = ctx.getSystemPrompt();
    const options = systemPromptOptions(ctx);
    if (!options) {
      recordPromptCapture(assembled, { custom: assembled, contextFiles: [], skills: [] });
      return;
    }
    const hasRead = !options.selectedTools || options.selectedTools.includes("read");
    recordPromptCapture(assembled, {
      custom: options.customPrompt,
      append: options.appendSystemPrompt,
      contextFiles: options.contextFiles ?? [],
      skills: hasRead ? (options.skills ?? []) : [],
    });
  });

  pi.on("session_shutdown", () => {
    reportLeaks("session_shutdown");
    clearSession("session_shutdown");
    setUI(null);
  });

  pi.on("session_before_compact", async (event, ctx) => {
    if (ctx.model?.baseUrl !== "cc") return undefined;
    debug(
      `session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
        `isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
        `turnPrefix=${event.preparation.turnPrefixMessages.length}`,
    );
    try {
      reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
      const compaction = await compact(
        event.preparation,
        ctx.model,
        undefined,
        undefined,
        event.customInstructions,
        event.signal,
        undefined,
        isolatedStreamFn,
        undefined,
      );
      debug(`session_before_compact: takeover complete summaryLen=${compaction.summary.length}`);
      return { compaction };
    } catch (err) {
      debug("session_before_compact: takeover failed; cancelling to avoid native compact fallback", err);
      ctx.ui?.notify?.(
        `Claude bridge compact failed (${errorMessage(err)}); cancelled to avoid known hang. Retry, switch model, or reduce context.`,
        "error",
      );
      return { cancel: true };
    }
  });

  // /compact and session-tree navigation both mutate pi's messages array out
  // from under the bridge, so REUSE would keep --resume'ing a CC session that
  // no longer matches pi's history.
  pi.on("session_compact", (event) => markNeedsRebuild(`session_compact:${event.reason}:willRetry=${event.willRetry}`));
  pi.on("session_tree", () => markNeedsRebuild("session_tree"));

  // Branch summarization runs through the *agent's* stream function, so on a
  // bridge model it reaches this provider carrying pi's internal summarization
  // prompt — which no before_agent_start recorded, leaving the capture resolver
  // nothing to resolve. Taken over like compaction: its own CC subprocess,
  // never touching the live session.
  pi.on("session_before_tree", async (event, ctx) => {
    if (ctx.model?.baseUrl !== "cc") return undefined;
    const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = event.preparation;
    if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
    debug(
      `session_before_tree: takeover entries=${entriesToSummarize.length} target=${event.preparation.targetId.slice(0, 8)}`,
    );
    try {
      return branchSummaryOutcome(
        await generateBranchSummary(entriesToSummarize, {
          model: ctx.model,
          signal: event.signal,
          customInstructions,
          replaceInstructions,
          streamFn: isolatedStreamFn,
        }),
      );
    } catch (err) {
      debug("session_before_tree: takeover failed; cancelling navigation", err);
      ctx.ui?.notify?.(`Claude bridge branch summary failed (${errorMessage(err)}); navigation cancelled.`, "error");
      return { cancel: true };
    }
  });

  const g = globalThis as Record<symbol, any>;
  if (!g[ACTIVE_STREAM_SIMPLE_KEY]) {
    g[ACTIVE_STREAM_SIMPLE_KEY] = streamClaudeAgentSdk;
    pi.registerProvider(PROVIDER_ID, {
      baseUrl: "cc",
      apiKey: "not-used",
      api: "cc",
      models: MODELS,
      // Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
      streamSimple: streamClaudeAgentSdk as any,
    });
  } else {
    // Subagent session: the parent's registration already exposes cc
    // models via the shared ModelRegistry, and calls route through the parent's
    // streamSimple as reentrant QueryContexts.
    debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
  }
}
