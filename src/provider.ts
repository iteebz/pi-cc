// The provider's streamSimple: dispatches each pi call to tool-result delivery,
// orphan cleanup, or a fresh CC subprocess query. Owns the query lifecycle —
// option assembly, SDK query, abort wiring, session bookkeeping, stream finalization.
//
// Extracted from index.ts so registration (what hooks into pi) is separate from
// execution (what happens when pi calls us).

import { type EffortLevel, query } from "@anthropic-ai/claude-agent-sdk";
import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { CC_CHILD_ENV, CLAUDE_MD_EXCLUDES, type Config, claudeCodeSettings, hostedTools } from "./config.js";
import { debug, diagDump, errorMessage, makeCliDebugOptions } from "./debug.js";
import { PromptCaptures, projectPromptCapture } from "./prompt-capture.js";
import { makePromptStream, userMessage } from "./prompt-stream.js";
import { activeQueryContexts, contextForToolResults, ctx, QueryContext } from "./query-state.js";
import {
  clearSharedSession,
  discardEphemeralSession,
  getSharedSession,
  markAborted,
  setCursor,
  setSharedSession,
  syncSharedSession,
} from "./session.js";
import {
  claimCurrentPiStream,
  consumeQuery,
  finalizeCurrentStream,
  markStreamComplete,
  newAssistantMessageEventStream,
} from "./stream.js";
import { buildMcpServers, deliverToolResults, drainForAbort, resolveMcpTools } from "./tools.js";
import { extractAllToolResults, extractUserPrompt, extractUserPromptBlocks, steerBlocks } from "./turn.js";

// -- Module-level state, written by index.ts via the setters below --

let providerSettings: NonNullable<Config["provider"]> = {};

// Captures of what pi assembled per agent; see prompt-capture.ts for why this
// is keyed rather than held in a single slot.
const promptCaptures = new PromptCaptures();

// Pi reasoning levels → CC SDK effort levels. Fallback for models pi-ai ships
// no thinkingLevelMap for.
const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
  minimal: "low",
  low: "low",
  medium: "medium",
  high: "high",
  xhigh: "max",
};

export function setProviderSettings(settings: NonNullable<Config["provider"]>): void {
  providerSettings = settings;
}

export function recordPromptCapture(systemPrompt: string, opts: Parameters<PromptCaptures["record"]>[1]): void {
  promptCaptures.record(systemPrompt, opts);
}

// ---------------------------------------------------------------------------
// Provider entry point — dispatcher
// ---------------------------------------------------------------------------

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Three paths: tool result delivery, orphaned tool result, or fresh query. */
export function streamClaudeAgentSdk(
  model: Model<any>,
  context: Context,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const stream = newAssistantMessageEventStream();

  const lastMsgRole = context.messages[context.messages.length - 1]?.role;
  debug(
    `provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`,
  );

  const activeQuery = ctx().activeQuery !== null;
  const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
  const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
  if (activeQuery && lastMsgRole === "user" && allResults.length === 0) {
    debug(
      `provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`,
    );
  }

  // --- Tool result delivery ---
  if (resultCtx) return handleToolResults(stream, resultCtx, allResults, model, context, lastMsgRole);

  // --- Orphaned tool result (e.g. user aborted a tool call) ---
  const lastMsg = context.messages[context.messages.length - 1];
  if (lastMsg?.role === "toolResult") return handleOrphanedResult(stream, model, context.messages.length);

  // --- Fresh query ---
  return startFreshQuery(stream, model, context, options, activeQuery);
}

// ---------------------------------------------------------------------------
// Path 1: tool result delivery
// ---------------------------------------------------------------------------

/** Pi appends tool results to context and calls back. Match this turn's results
 *  against waiting MCP handlers; ones that arrive first get queued. */
function handleToolResults(
  stream: AssistantMessageEventStream,
  resultCtx: QueryContext,
  allResults: ReturnType<typeof extractAllToolResults>,
  model: Model<any>,
  context: Context,
  lastMsgRole: string | undefined,
): AssistantMessageEventStream {
  claimCurrentPiStream(stream, "tool-result", resultCtx);
  resultCtx.resetTurnState(model);
  // A steer sent while a tool was executing: pi drains it at the turn
  // boundary and appends it alongside the tool result.
  const steer = lastMsgRole === "user" ? steerBlocks(context.messages) : null;
  // Async because the steer must reach CC's stdin before the tool result
  // does — see deliverToolResults. Detached so the provider still returns
  // its stream synchronously.
  void deliverToolResults(resultCtx, allResults, steer, context.messages.length);
  // The shared cursor tracks the top-level conversation. A reentrant subagent
  // delivering its own results would drag it to that subagent's message count
  // — observed pulling a parent from 5 back to 3, which cost the parent's next
  // turn a full rebuild and a flushed prompt cache.
  if (resultCtx === ctx()) setCursor(context.messages.length);
  resultCtx.latestCursor = Math.max(resultCtx.latestCursor, context.messages.length);
  return stream;
}

// ---------------------------------------------------------------------------
// Path 2: orphaned tool result
// ---------------------------------------------------------------------------

/** A tool result with no query waiting for it — the user aborted the call. */
function handleOrphanedResult(
  stream: AssistantMessageEventStream,
  model: Model<any>,
  contextLength: number,
): AssistantMessageEventStream {
  debug("provider: orphaned tool result after abort, emitting end_turn");
  if (activeQueryContexts.size === 0) setCursor(contextLength);
  // A throwaway context, because resetTurnState on the shared ctx() would
  // replace a live parent's turnOutput mid-stream and strand the blocks it
  // had already emitted.
  const c = new QueryContext();
  c.resetTurnState(model);
  queueMicrotask(() => {
    stream.push({ type: "done", reason: "stop", message: c.turnOutput });
    markStreamComplete(stream);
    stream.end();
  });
  return stream;
}

// ---------------------------------------------------------------------------
// Path 3: fresh query
// ---------------------------------------------------------------------------

/** Start a new CC subprocess query. Reentrant queries (subagents) get their own
 *  QueryContext so they can run concurrently with the parent. */
function startFreshQuery(
  stream: AssistantMessageEventStream,
  model: Model<any>,
  context: Context,
  options: SimpleStreamOptions | undefined,
  isReentrant: boolean,
): AssistantMessageEventStream {
  const queryCtx = isReentrant ? new QueryContext() : ctx();
  debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

  // Resolved before anything is claimed or reset: an unaccountable system
  // prompt throws, and doing that first leaves no half-built query behind —
  // in particular no stream claimed on the shared context that nobody ends.
  const { mcpTools, piNameToWire, wireNameToPi } = resolveMcpTools(context);
  // Built from what pi loaded for this run, so `--no-context-files` and
  // `--no-skills` reach Claude Code by leaving nothing to forward. A sub-agent's
  // custom override embeds its parent's assembled pi prompt; recursive projection
  // replaces that exact inherited prompt with its already-safe portable parts.
  const promptCapture = promptCaptures.resolveOrDerive(context.systemPrompt);
  const forwardedPrompt = promptCapture ? projectPromptCapture(promptCapture) : undefined;

  claimCurrentPiStream(stream, "fresh-query", queryCtx);
  queryCtx.pendingToolCalls.clear();
  queryCtx.pendingResults.clear();
  // Stale ids would let a late result from the previous query route here via
  // contextForToolResults — which means pushing its steer into this query's
  // stdin, not just mismatching a map.
  queryCtx.turnToolCallIds = [];
  queryCtx.resetTurnState(model);
  queryCtx.latestCursor = 0;

  const cwd = (options as { cwd?: string } | undefined)?.cwd ?? process.cwd();
  const syncResult = syncSharedSession(context.messages, cwd, piNameToWire, model.id, isReentrant);
  const resumeSessionId = syncResult.sessionId;
  const promptBlocks = extractUserPromptBlocks(context.messages);
  let promptText = extractUserPrompt(context.messages) ?? "";

  // Should never happen with per-query state: an empty prompt means the last
  // context message isn't a user message.
  if (!promptText && !promptBlocks) {
    diagDump("empty_prompt", {
      contextLength: context.messages.length,
      lastMsgRole: context.messages[context.messages.length - 1]?.role,
      isReentrant,
      activeQueryContexts: activeQueryContexts.size,
      activeQueryExists: queryCtx.activeQuery !== null,
      sharedSession: getSharedSession(),
      messageRoles: context.messages.map((m, i) => `[${i}]${m.role}`).join(" "),
    });
    promptText = "[continue]";
  }

  // Always stream the prompt rather than passing a string: a parked input
  // generator is what lets us write steers to CC's stdin mid-turn. The cost is
  // that `isSingleUserTurn` is false, so the SDK no longer closes stdin on the
  // first result — consumeQuery ends the stream explicitly instead, or the
  // query would never terminate.
  const promptStream = makePromptStream();
  void promptStream
    .push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
    .catch((error) => debug("provider: initial prompt push rejected:", error));
  queryCtx.promptStream = promptStream;

  const queryOptions = buildQueryOptions(model, cwd, mcpTools, queryCtx, forwardedPrompt, resumeSessionId, options);

  debug(
    "provider: fresh query",
    `model=${model.id} msgs=${context.messages.length} tools=${mcpTools.length}`,
    `resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${queryOptions.effort ?? "default"}`,
    `ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${providerSettings.strictMcpConfig !== false}`,
    `prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`,
  );

  let wasAborted = false;
  const sdkQuery = query({ prompt: promptStream.stream, options: queryOptions });
  queryCtx.activeQuery = sdkQuery;
  activeQueryContexts.add(queryCtx);

  const onAbort = () => {
    wasAborted = true;
    drainForAbort(queryCtx, promptStream);
    // interrupt() asks the CLI to stop gracefully; close() kills it immediately.
    // Both are needed — interrupt alone lets the current API call finish.
    void sdkQuery.interrupt().catch(() => {});
    try {
      sdkQuery.close();
    } catch {}
  };
  if (options?.signal) {
    if (options.signal.aborted) onAbort();
    else options.signal.addEventListener("abort", onAbort, { once: true });
  }

  consumeQuery(sdkQuery, wireNameToPi, model, () => wasAborted, queryCtx)
    .then(({ capturedSessionId }) =>
      onQueryComplete(
        queryCtx,
        sdkQuery,
        syncResult,
        capturedSessionId,
        context,
        cwd,
        isReentrant,
        wasAborted,
        options,
      ),
    )
    .catch((error) => onQueryError(queryCtx, sdkQuery, error, model, promptStream, isReentrant, wasAborted, options))
    .finally(() => onQueryFinally(queryCtx, sdkQuery, promptStream, options, onAbort));

  return stream;
}

// ---------------------------------------------------------------------------
// Query option assembly
// ---------------------------------------------------------------------------

function buildQueryOptions(
  model: Model<any>,
  cwd: string,
  mcpTools: ReturnType<typeof resolveMcpTools>["mcpTools"],
  queryCtx: QueryContext,
  forwardedPrompt: string | undefined,
  resumeSessionId: string | null,
  options: SimpleStreamOptions | undefined,
): NonNullable<Parameters<typeof query>[0]["options"]> {
  const mcpServers = buildMcpServers(mcpTools, queryCtx);

  // --strict-mcp-config: CC otherwise reads MCP servers from ~/.claude.json and
  // .mcp.json, which are pure token overhead here since pi executes tools.
  const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;

  // pi-ai 0.72+ ships per-model overrides (e.g. opus-4-7 wants xhigh→xhigh,
  // not xhigh→max); our table covers older pi-ai and unmapped levels.
  const effort = options?.reasoning
    ? (((model as any).thinkingLevelMap?.[options.reasoning] as EffortLevel | undefined) ??
      REASONING_TO_EFFORT[options.reasoning])
    : undefined;

  const extraArgs: Record<string, string | null> = { model: model.id };
  if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
  // Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
  // Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
  if (effort) extraArgs["thinking-display"] = "summarized";

  return {
    cwd,
    env: { ...process.env, ...CC_CHILD_ENV },
    // hostedTools() owns the web-tools policy: the hosted pair when webTools is
    // on, otherwise []. Every other tool CC can call arrives over MCP.
    tools: hostedTools(providerSettings),
    permissionMode: "bypassPermissions",
    includePartialMessages: true,
    settings: { ...claudeCodeSettings(providerSettings), claudeMdExcludes: CLAUDE_MD_EXCLUDES },
    // The forwarded context (AGENTS.md, skills, .pi/SYSTEM.md) replaces Claude
    // Code's preset entirely — that is the point of forwarding it. Falls back
    // to the bare preset only when there is nothing to forward, since the child
    // then depends on the preset's tool and permission guidance.
    systemPrompt: forwardedPrompt ?? { type: "preset", preset: "claude_code" },
    extraArgs,
    ...(effort ? { effort } : {}),
    ...(mcpServers ? { mcpServers } : {}),
    ...(resumeSessionId ? { resume: resumeSessionId } : {}),
    ...(providerSettings.pathToClaudeCodeExecutable
      ? { pathToClaudeCodeExecutable: providerSettings.pathToClaudeCodeExecutable }
      : {}),
    ...makeCliDebugOptions("provider"),
  };
}

// ---------------------------------------------------------------------------
// Query lifecycle callbacks
// ---------------------------------------------------------------------------

function onQueryComplete(
  queryCtx: QueryContext,
  sdkQuery: ReturnType<typeof query>,
  syncResult: ReturnType<typeof syncSharedSession>,
  capturedSessionId: string | undefined,
  context: Context,
  cwd: string,
  isReentrant: boolean,
  wasAborted: boolean,
  options: SimpleStreamOptions | undefined,
): void {
  debug(
    `provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`,
  );

  if (wasAborted || options?.signal?.aborted) {
    markAborted();
    if (queryCtx.turnOutput) {
      queryCtx.turnOutput.stopReason = "aborted";
      queryCtx.turnOutput.errorMessage = "Operation aborted";
    }
    const stream = queryCtx.currentPiStream;
    stream?.push({ type: "error", reason: "aborted", error: queryCtx.turnOutput! });
    markStreamComplete(stream);
    stream?.end();
    queryCtx.currentPiStream = null;
    return;
  }

  const sessionId = capturedSessionId ?? getSharedSession()?.sessionId;
  if (syncResult.preserveSharedSession) {
    discardEphemeralSession(capturedSessionId, cwd);
  } else if (sessionId) {
    const cursor = Math.max(context.messages.length, queryCtx.latestCursor, getSharedSession()?.cursor ?? 0);
    debug(`provider: query done, session=${sessionId.slice(0, 8)}, cursor=${cursor}`);
    setSharedSession({ sessionId, cursor, cwd });
  }

  if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
    debug("provider: clearing activeQuery before final stream completion");
    queryCtx.activeQuery = null;
  }
  finalizeCurrentStream(queryCtx, queryCtx.turnOutput?.stopReason);
}

function onQueryError(
  queryCtx: QueryContext,
  sdkQuery: ReturnType<typeof query>,
  error: unknown,
  model: Model<any>,
  promptStream: ReturnType<typeof makePromptStream>,
  isReentrant: boolean,
  wasAborted: boolean,
  options: SimpleStreamOptions | undefined,
): void {
  debug(`provider: query error, model=${model.id}, aborted=${Boolean(options?.signal?.aborted)}, error=`, error);
  if (wasAborted || options?.signal?.aborted) markAborted();
  else clearSharedSession("provider: query error");
  promptStream.fail(error instanceof Error ? error : new Error(String(error)));
  if (queryCtx.turnOutput) {
    queryCtx.turnOutput.stopReason = options?.signal?.aborted ? "aborted" : "error";
    // The SDK drops its copy of the result text if any message follows the error
    // result, so prefer the cause consumeQuery recorded off the result itself.
    queryCtx.turnOutput.errorMessage ??= errorMessage(error);
  }
  if (!isReentrant && queryCtx.activeQuery === sdkQuery) {
    queryCtx.releasePendingToolCalls("Query ended");
    queryCtx.activeQuery = null;
  }
  const stream = queryCtx.currentPiStream;
  stream?.push({
    type: "error",
    reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error",
    error: queryCtx.turnOutput!,
  });
  markStreamComplete(stream);
  stream?.end();
  queryCtx.currentPiStream = null;
}

function onQueryFinally(
  queryCtx: QueryContext,
  sdkQuery: ReturnType<typeof query>,
  promptStream: ReturnType<typeof makePromptStream>,
  options: SimpleStreamOptions | undefined,
  onAbort: () => void,
): void {
  if (options?.signal) options.signal.removeEventListener("abort", onAbort);
  // Settle any ack still parked in the generator — the CLI is gone, so
  // nothing will resume it.
  promptStream.fail(new Error("query ended"));
  if (queryCtx.promptStream === promptStream) queryCtx.promptStream = null;
  // A later query claiming this context sets activeQuery to its own handle;
  // null means the handlers above cleared ours and nothing replaced it.
  // Testing only for `=== sdkQuery` would never fire on the non-reentrant
  // path, leaving the top-level context in the routing set forever — where a
  // later orphaned tool result matches its stale turnToolCallIds and takes
  // the delivery branch, returning a stream nothing ends.
  if (queryCtx.activeQuery === sdkQuery || queryCtx.activeQuery === null) {
    queryCtx.releasePendingToolCalls("Query ended");
    queryCtx.activeQuery = null;
    activeQueryContexts.delete(queryCtx);
  }
  sdkQuery.close();
}
