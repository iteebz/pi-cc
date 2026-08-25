// Pi extension entry: registers the Claude Code provider, hooks pi's session
// lifecycle, and owns the provider's streamSimple.
//
// Everything else lives one layer down:
//   convert · session · turn · tools · stream · summary · prompt-capture
//   config · models · skills · mcp-server · query-state · ui · debug

import type { AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import { getModels } from "@earendil-works/pi-ai/compat";
import { compact, generateBranchSummary, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { query, type EffortLevel } from "@anthropic-ai/claude-agent-sdk";
import { CC_CHILD_ENV, CLAUDE_MD_EXCLUDES, claudeCodeSettings, loadConfig, type Config } from "./config.js";
import { PROVIDER_ID } from "./convert.js";
import { debug, diagDump, errorMessage, makeCliDebugOptions, moduleInstanceId } from "./debug.js";
import { buildModels } from "./models.js";
import { makePromptStream, userMessage } from "./prompt-stream.js";
import { projectPromptCapture, PromptCaptures } from "./prompt-capture.js";
import { activeQueryContexts, contextForToolResults, ctx, QueryContext, reportLeaks } from "./query-state.js";
import {
	clearSharedSession, discardEphemeralSession, getSharedSession, markAborted, markNeedsRebuild,
	setCursor, setSharedSession, syncSharedSession,
} from "./session.js";
import {
	claimCurrentPiStream, consumeQuery, finalizeCurrentStream, markStreamComplete,
	newAssistantMessageEventStream, resultErrorText,
} from "./stream.js";
import { branchSummaryOutcome, isolatedStreamFn, reinjectPriorCompactionFileOps } from "./summary.js";
import { buildMcpServers, deliverToolResults, drainForAbort, resolveMcpTools } from "./tools.js";
import { extractAllToolResults, extractUserPrompt, extractUserPromptBlocks, steerBlocks } from "./turn.js";
import { setUI } from "./ui.js";

// Guards against re-registration across module reloads. Extensions like
// pi-subagents load this module again in the subagent; without the guard, that
// instance's registerProvider() overwrites the parent's streamSimple in the
// shared ModelRegistry, and the parent's next tool result runs against the
// subagent's empty state. Symbol.for is shared across module instances, so only
// the first registration takes effect. clearSession resets it on shutdown so
// /reload can register fresh.
const ACTIVE_STREAM_SIMPLE_KEY = Symbol.for("claude-bridge:activeStreamSimple");

const MODELS = buildModels(getModels("anthropic"));
let providerSettings: NonNullable<Config["provider"]> = {};

// Captures of what pi assembled per agent; see prompt-capture.ts for why this
// is keyed rather than held in a single slot.
const promptCaptures = new PromptCaptures();

// Pi reasoning levels → CC SDK effort levels. Fallback for models pi-ai ships
// no thinkingLevelMap for.
const REASONING_TO_EFFORT: Record<string, EffortLevel> = {
	minimal: "low", low: "low", medium: "medium", high: "high", xhigh: "max",
};

/** Provider entry point. Pi calls this for each new prompt and each tool result.
 *  Two cases: tool result delivery (active query) or fresh query. */
function streamClaudeAgentSdk(model: Model<any>, context: Context, options?: SimpleStreamOptions): AssistantMessageEventStream {
	const stream = newAssistantMessageEventStream();

	const lastMsgRole = context.messages[context.messages.length - 1]?.role;
	debug(`provider: streamClaudeAgentSdk called, activeQuery=${!!ctx().activeQuery}, lastMsgRole=${lastMsgRole}, isReentrant=${ctx().activeQuery !== null}`);

	const activeQuery = ctx().activeQuery !== null;
	const allResults = activeQueryContexts.size > 0 ? extractAllToolResults(context) : [];
	const resultCtx = allResults.length > 0 ? contextForToolResults(allResults) : undefined;
	if (activeQuery && lastMsgRole === "user" && allResults.length === 0) {
		debug(`provider: active query user-only call treated as reentrant fresh query, waitingHandlers=${ctx().pendingToolCalls.size}, ctx.msgs=${context.messages.length}`);
	}

	// --- Tool result delivery ---
	// Pi appends tool results to context and calls back. Match this turn's results
	// against waiting MCP handlers; ones that arrive first get queued.
	if (resultCtx) {
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

	// --- Orphaned tool result (e.g. user aborted a tool call) ---
	const lastMsg = context.messages[context.messages.length - 1];
	if (lastMsg?.role === "toolResult") {
		debug(`provider: orphaned tool result after abort, emitting end_turn`);
		if (activeQueryContexts.size === 0) setCursor(context.messages.length);
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

	// --- Fresh query ---
	// Reentrant queries get their own QueryContext so background subagents can
	// run concurrently with the parent.
	const isReentrant = activeQuery;
	const queryCtx = isReentrant ? new QueryContext() : ctx();
	debug(`provider: fresh query setup, isReentrant=${isReentrant}, activeContexts=${activeQueryContexts.size}`);

	// Resolved before anything is claimed or reset: an unaccountable system
	// prompt throws, and doing that first leaves no half-built query behind —
	// in particular no stream claimed on the shared context that nobody ends.
	const { mcpTools, customToolNameToSdk, customToolNameToPi } = resolveMcpTools(context);
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
	const syncResult = syncSharedSession(context.messages, cwd, customToolNameToSdk, model.id);
	const resumeSessionId = syncResult.sessionId;
	const promptBlocks = extractUserPromptBlocks(context.messages);
	let promptText = extractUserPrompt(context.messages) ?? "";

	// Should never happen with per-query state: an empty prompt means the last
	// context message isn't a user message.
	if (!promptText && !promptBlocks) {
		diagDump("empty_prompt", {
			contextLength: context.messages.length,
			lastMsgRole: lastMsg?.role,
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
	void promptStream.push(userMessage(promptBlocks ?? [{ type: "text", text: promptText }]))
		.catch((error) => debug(`provider: initial prompt push rejected:`, error));
	queryCtx.promptStream = promptStream;
	const mcpServers = buildMcpServers(mcpTools, queryCtx);

	// --strict-mcp-config: CC otherwise reads MCP servers from ~/.claude.json and
	// .mcp.json, which are pure token overhead here since pi executes tools.
	// Applied unconditionally because settingSources is left at CC's default,
	// which loads all sources.
	const strictMcpConfigEnabled = providerSettings.strictMcpConfig !== false;

	// pi-ai 0.72+ ships per-model overrides (e.g. opus-4-7 wants xhigh→xhigh,
	// not xhigh→max); our table covers older pi-ai and unmapped levels.
	const effort = options?.reasoning
		? ((model as any).thinkingLevelMap?.[options.reasoning] as EffortLevel | undefined)
			?? REASONING_TO_EFFORT[options.reasoning]
		: undefined;

	const extraArgs: Record<string, string | null> = { model: model.id };
	if (strictMcpConfigEnabled) extraArgs["strict-mcp-config"] = null;
	// Opus 4.7 defaults thinking.display to "omitted" (empty thinking text in stream).
	// Force summarized so thinking_delta events arrive. See anthropics/claude-agent-sdk-python#830.
	if (effort) extraArgs["thinking-display"] = "summarized";

	const queryOptions: NonNullable<Parameters<typeof query>[0]["options"]> = {
		cwd,
		env: { ...process.env, ...CC_CHILD_ENV },
		// webTools opt-in: hosted WebSearch/WebFetch run server-side and bill
		// against the subscription quota, so they are off unless enabled. Every
		// other tool CC can call arrives over MCP.
		tools: providerSettings.webTools ? ["WebFetch", "WebSearch"] : [],
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
		...(providerSettings.pathToClaudeCodeExecutable ? { pathToClaudeCodeExecutable: providerSettings.pathToClaudeCodeExecutable } : {}),
		...makeCliDebugOptions("provider"),
	};

	debug("provider: fresh query",
		`model=${model.id} msgs=${context.messages.length} tools=${mcpTools.length}`,
		`resume=${resumeSessionId?.slice(0, 8) ?? "none"} effort=${effort ?? "default"}`,
		`ctxFiles=${promptCapture?.contextFiles.length ?? 0} strictMcp=${strictMcpConfigEnabled}`,
		`prompt=${promptText.slice(0, 60)}${promptBlocks ? " [+images]" : ""}`);

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
		try { sdkQuery.close(); } catch {}
	};
	if (options?.signal) {
		if (options.signal.aborted) onAbort();
		else options.signal.addEventListener("abort", onAbort, { once: true });
	}

	consumeQuery(sdkQuery, customToolNameToPi, model, () => wasAborted, queryCtx)
		.then(({ capturedSessionId }) => {
			debug(`provider: consumeQuery completed, stopReason=${queryCtx.turnOutput?.stopReason}, error=${queryCtx.turnOutput?.errorMessage}, aborted=${wasAborted}`);

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
		})
		.catch((error) => {
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
			stream?.push({ type: "error", reason: (queryCtx.turnOutput?.stopReason ?? "error") as "aborted" | "error", error: queryCtx.turnOutput! });
			markStreamComplete(stream);
			stream?.end();
			queryCtx.currentPiStream = null;
		})
		.finally(() => {
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
		});

	return stream;
}

export default function (pi: ExtensionAPI) {
	// Disable non-essential Claude Code traffic (update checks, MCP registry, telemetry)
	process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";

	const config = loadConfig(process.cwd());
	debug("loadConfig:", JSON.stringify(config));
	providerSettings = config.provider ?? {};

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

	pi.on("before_agent_start", (event) => {
		const options = event.systemPromptOptions;
		const hasRead = !options?.selectedTools || options.selectedTools.includes("read");
		promptCaptures.record(event.systemPrompt, {
			custom: options?.customPrompt,
			append: options?.appendSystemPrompt,
			contextFiles: options?.contextFiles ?? [],
			skills: hasRead ? options?.skills ?? [] : [],
		});
	});

	pi.on("session_shutdown", () => {
		reportLeaks("session_shutdown");
		clearSession("session_shutdown");
	});

	pi.on("session_before_compact", async (event, ctx) => {
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		debug(
			`session_before_compact: takeover reason=${event.reason} willRetry=${event.willRetry} ` +
			`isSplitTurn=${event.preparation.isSplitTurn} messages=${event.preparation.messagesToSummarize.length} ` +
			`turnPrefix=${event.preparation.turnPrefixMessages.length}`,
		);
		try {
			reinjectPriorCompactionFileOps(event.branchEntries, event.preparation);
			const compaction = await compact(
				event.preparation, ctx.model, undefined, undefined,
				event.customInstructions, event.signal, undefined, isolatedStreamFn, undefined,
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
		if (ctx.model?.baseUrl !== "claude-bridge") return undefined;
		const { entriesToSummarize, userWantsSummary, customInstructions, replaceInstructions } = event.preparation;
		if (!userWantsSummary || entriesToSummarize.length === 0) return undefined;
		debug(`session_before_tree: takeover entries=${entriesToSummarize.length} target=${event.preparation.targetId.slice(0, 8)}`);
		try {
			return branchSummaryOutcome(await generateBranchSummary(entriesToSummarize, {
				model: ctx.model,
				signal: event.signal,
				customInstructions,
				replaceInstructions,
				streamFn: isolatedStreamFn,
			}));
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
			baseUrl: "claude-bridge",
			apiKey: "not-used",
			api: "claude-bridge",
			models: MODELS,
			// Cast: pi-ai AssistantMessageEventStream diamond dep between pi-coding-agent and pi-agent-core
			streamSimple: streamClaudeAgentSdk as any,
		});
	} else {
		// Subagent session: the parent's registration already exposes claude-bridge
		// models via the shared ModelRegistry, and calls route through the parent's
		// streamSimple as reentrant QueryContexts.
		debug(`provider: skipping re-registration, parent instance active (module=${moduleInstanceId})`);
	}
}

// @internal — the seam unit tests drive. Each name's home is its module.
export const __test = {
	resetSharedSession: () => setSharedSession(null),
	setSharedSession,
	getSharedSession,
	setPiUI: setUI,
	syncSharedSession,
	extractUserPromptBlocks,
	consumeQuery,
	finalizeCurrentStream,
	resultErrorText,
	deliverToolResults,
	drainForAbort,
	CC_CHILD_ENV,
	buildMcpServers,
	branchSummaryOutcome,
};
