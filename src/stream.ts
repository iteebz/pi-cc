// Claude Code's SDK stream → pi's event stream.
//
// The loop, which is not obvious from any one function: consumeQuery pumps the
// SDK generator into currentPiStream. On tool_use it ends that stream and nulls
// it, and the MCP handler blocks the generator — nothing arrives until pi runs
// the tool and calls streamSimple again, which swaps in a new stream and
// resolves the handler.
//
// That null is also why resetTurnState is safe to call while the generator still
// holds queued messages from the previous turn: they hit the `!c.currentPiStream`
// guard and are skipped.

import type { query, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import * as piAi from "@earendil-works/pi-ai";
import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  calculateCost,
  type Model,
} from "@earendil-works/pi-ai";
import { appendFileSync } from "fs";
import { debug, RECORD_STREAM_PATH } from "./debug.js";
import type { QueryContext } from "./query-state.js";
import { mapToolArgs, piToolNameFor } from "./tools.js";
import { notify } from "./ui.js";

// Factory on pi-ai ≥0.66, constructor before it (gsd-pi etc.).
const _piAi = piAi as any;
export const newAssistantMessageEventStream: () => AssistantMessageEventStream =
  typeof _piAi.createAssistantMessageEventStream === "function"
    ? _piAi.createAssistantMessageEventStream
    : () => new _piAi.AssistantMessageEventStream();

// --- Usage + result inspection ---

function updateUsage(output: AssistantMessage, usage: Record<string, number | undefined>, model: Model<any>): void {
  if (usage.input_tokens != null) output.usage.input = usage.input_tokens;
  if (usage.output_tokens != null) output.usage.output = usage.output_tokens;
  if (usage.cache_read_input_tokens != null) output.usage.cacheRead = usage.cache_read_input_tokens;
  if (usage.cache_creation_input_tokens != null) output.usage.cacheWrite = usage.cache_creation_input_tokens;
  // CC reports reasoning tokens separately; pi's Usage type has no such field.
  const reasoning = usage.reasoning_tokens ?? usage.thinking_tokens;
  if (reasoning != null) (output.usage as typeof output.usage & { reasoning?: number }).reasoning = reasoning;
  output.usage.totalTokens =
    output.usage.input + output.usage.output + output.usage.cacheRead + output.usage.cacheWrite;
  calculateCost(model, output.usage);
  const promptTokens = output.usage.input + output.usage.cacheRead + output.usage.cacheWrite;
  const cachePct = promptTokens > 0 ? Math.round((output.usage.cacheRead / promptTokens) * 100) : 0;
  const reasoningText = reasoning != null ? ` reasoning=${reasoning}` : "";
  debug(
    `usage: in=${output.usage.input} out=${output.usage.output} cacheRead=${output.usage.cacheRead} cacheWrite=${output.usage.cacheWrite} total=${output.usage.totalTokens}${reasoningText} cachePct=${cachePct}% model=${model.id}`,
  );
}

// The served window (modelUsage[id].contextWindow) can differ from the one pi
// registered when the runtime entitlement doesn't match the docs — bare Opus
// served 200K on Pro, [1m] not honored. Otherwise discarded; log makes it
// observable. See issue #18.
export function logServedContextWindow(label: string, message: SDKMessage, model: Model<any>): void {
  const modelUsage = (message as any).modelUsage as
    | Record<string, { contextWindow?: number; maxOutputTokens?: number }>
    | undefined;
  if (!modelUsage) return;
  for (const [k, v] of Object.entries(modelUsage)) {
    debug(
      `${label}: served contextWindow=${v.contextWindow ?? "?"} maxOutputTokens=${v.maxOutputTokens ?? "?"} servedModel=${k} registered=${model.contextWindow}`,
    );
  }
}

/** Failure text for an SDK result, or undefined when it succeeded. CC reports API
 *  failures (429, overload, prompt-too-long) with `is_error` on an otherwise
 *  success-shaped result; error subtypes carry `errors` instead. */
export function resultErrorText(message: SDKMessage): string | undefined {
  const result = message as SDKMessage & {
    subtype?: string;
    is_error?: boolean;
    result?: string;
    errors?: unknown;
    error?: unknown;
  };
  if (result.subtype === "success")
    return result.is_error ? result.result || "Claude Code reported an error" : undefined;
  if (Array.isArray(result.errors) && result.errors.length) return result.errors.map(String).join("\n");
  if (typeof result.error === "string") return result.error;
  return `Claude Code failed: ${result.subtype ?? "unknown result"}`;
}

function mapStopReason(reason: string | undefined): "stop" | "length" | "toolUse" {
  switch (reason) {
    case "tool_use":
      return "toolUse";
    case "max_tokens":
      return "length";
    case "end_turn":
    default:
      return "stop";
  }
}

function parsePartialJson(input: string, fallback: Record<string, unknown>): Record<string, unknown> {
  if (!input) return fallback;
  try {
    return JSON.parse(input);
  } catch {
    return fallback;
  }
}

// --- Pi stream lifecycle ---

const completedStreams = new WeakSet<object>();

export function markStreamComplete(stream: AssistantMessageEventStream | null): void {
  if (stream) completedStreams.add(stream as object);
}

export function claimCurrentPiStream(stream: AssistantMessageEventStream, label: string, c: QueryContext): void {
  if (c.currentPiStream && !completedStreams.has(c.currentPiStream as object)) {
    debug(
      `WARNING: currentPiStream overwritten before terminal event (${label}); activeQuery=${Boolean(c.activeQuery)} pendingHandlers=${c.pendingToolCalls.size}`,
    );
  }
  c.currentPiStream = stream;
}

function ensureTurnStarted(c: QueryContext): void {
  if (!c.turnStarted && c.currentPiStream && c.turnOutput) {
    c.currentPiStream!.push({ type: "start", partial: c.turnOutput });
    c.turnStarted = true;
  }
}

export function finalizeCurrentStream(c: QueryContext, stopReason?: string): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  debug(
    `provider: finalizeCurrentStream called, stopReason=${stopReason}, turnOutput=${JSON.stringify({ stopReason: c.turnOutput!.stopReason, error: c.turnOutput!.errorMessage })}`,
  );
  if (!c.turnStarted) ensureTurnStarted(c);
  const stream = c.currentPiStream;
  if (c.turnOutput.stopReason === "error") {
    stream!.push({ type: "error", reason: "error", error: c.turnOutput });
  } else {
    const reason = stopReason === "length" ? "length" : "stop";
    stream!.push({ type: "done", reason, message: c.turnOutput });
  }
  markStreamComplete(stream);
  stream!.end();
  c.currentPiStream = null;
}

/** End the pi stream on a tool call. The SDK still yields an assistant message
 *  for this turn; currentPiStream=null makes consumeQuery skip it. */
function endStreamForToolUse(c: QueryContext): void {
  c.turnOutput!.stopReason = "toolUse";
  const stream = c.currentPiStream;
  stream!.push({ type: "done", reason: "toolUse", message: c.turnOutput });
  markStreamComplete(stream);
  stream!.end();
  c.currentPiStream = null;
}

/** Text that arrived complete rather than as deltas. */
function pushWholeText(c: QueryContext, text: string): void {
  ensureTurnStarted(c);
  c.turnBlocks.push({ type: "text", text });
  const idx = c.turnBlocks.length - 1;
  c.currentPiStream?.push({ type: "text_start", contentIndex: idx, partial: c.turnOutput });
  c.currentPiStream?.push({ type: "text_delta", contentIndex: idx, delta: text, partial: c.turnOutput });
  c.currentPiStream?.push({ type: "text_end", contentIndex: idx, content: text, partial: c.turnOutput });
}

// --- Event mapping ---

/** Maps Anthropic stream events to pi stream events (text, thinking, toolcall).
 *  On message_stop with tool_use: ends currentPiStream so pi can execute the tool. */
function processStreamEvent(
  message: SDKMessage,
  customToolNameToPi: Map<string, string>,
  model: Model<any>,
  c: QueryContext,
): void {
  if (!c.currentPiStream || !c.turnOutput) return;
  c.turnSawStreamEvent = true;
  const event = (message as SDKMessage & { event: any }).event;

  if (event?.type === "message_start") {
    c.turnToolCallIds = [];
    if (event.message?.usage) updateUsage(c.turnOutput, event.message.usage, model);
    return;
  }

  if (event?.type === "content_block_start") {
    ensureTurnStarted(c);
    if (event.content_block?.type === "text") {
      c.turnBlocks.push({ type: "text", text: "", index: event.index });
      c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
    } else if (event.content_block?.type === "thinking") {
      c.turnBlocks.push({ type: "thinking", thinking: "", thinkingSignature: "", index: event.index });
      c.currentPiStream!.push({ type: "thinking_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
    } else if (event.content_block?.type === "tool_use") {
      const piName = piToolNameFor(event.content_block.name, customToolNameToPi);
      if (!piName) {
        debug(
          `processStreamEvent: skipping tool_use for unserved tool ${event.content_block.name} [${event.content_block.id}] — CC rejects it and retries`,
        );
        return;
      }
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(event.content_block.id);
      c.turnBlocks.push({
        type: "toolCall",
        id: event.content_block.id,
        name: piName,
        arguments: (event.content_block.input as Record<string, unknown>) ?? {},
        partialJson: "",
        index: event.index,
      });
      c.currentPiStream!.push({ type: "toolcall_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
    } else if (event.content_block?.type === "server_tool_use") {
      // Hosted tool: Anthropic runs it and streams a sibling *_tool_result
      // block. No roundtrip through pi is possible, so render a marker.
      c.turnBlocks.push({ type: "text", text: "", index: event.index });
      const name = event.content_block.name ?? "web_search";
      c.currentPiStream!.push({ type: "text_start", contentIndex: c.turnBlocks.length - 1, partial: c.turnOutput });
      const marker = `[web search${name !== "web_search" ? `: ${name}` : ""}]\n`;
      c.turnBlocks[c.turnBlocks.length - 1].text = marker;
      c.currentPiStream!.push({
        type: "text_delta",
        contentIndex: c.turnBlocks.length - 1,
        delta: marker,
        partial: c.turnOutput,
      });
    } else if (typeof event.content_block?.type === "string" && event.content_block.type.endsWith("_tool_result")) {
      // Stays inside CC's context; the model's answer cites it.
      debug("processStreamEvent: hosted tool result block (not rendered)", event.content_block?.type);
    } else {
      debug("processStreamEvent: unhandled content_block_start type", event.content_block?.type);
    }
    return;
  }

  if (event?.type === "content_block_delta") {
    const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
    const block = c.turnBlocks[index];
    if (!block) return;
    if (event.delta?.type === "text_delta" && block.type === "text") {
      block.text += event.delta.text;
      c.currentPiStream!.push({
        type: "text_delta",
        contentIndex: index,
        delta: event.delta.text,
        partial: c.turnOutput,
      });
    } else if (event.delta?.type === "thinking_delta" && block.type === "thinking") {
      block.thinking += event.delta.thinking;
      c.currentPiStream!.push({
        type: "thinking_delta",
        contentIndex: index,
        delta: event.delta.thinking,
        partial: c.turnOutput,
      });
    } else if (event.delta?.type === "input_json_delta" && block.type === "toolCall") {
      block.partialJson += event.delta.partial_json;
      block.arguments = parsePartialJson(block.partialJson, block.arguments);
      c.currentPiStream!.push({
        type: "toolcall_delta",
        contentIndex: index,
        delta: event.delta.partial_json,
        partial: c.turnOutput,
      });
    } else if (event.delta?.type === "input_json_delta" && block.type === "server_tool_use") {
      // Server-side execution: nothing to render per-delta.
    } else if (event.delta?.type === "signature_delta" && block.type === "thinking") {
      block.thinkingSignature = (block.thinkingSignature ?? "") + event.delta.signature;
    } else {
      debug("processStreamEvent: unhandled content_block_delta type", event.delta?.type);
    }
    return;
  }

  if (event?.type === "content_block_stop") {
    const index = c.turnBlocks.findIndex((b: any) => b.index === event.index);
    const block = c.turnBlocks[index];
    if (!block) return;
    delete block.index;
    if (block.type === "text") {
      c.currentPiStream!.push({ type: "text_end", contentIndex: index, content: block.text, partial: c.turnOutput });
    } else if (block.type === "thinking") {
      c.currentPiStream!.push({
        type: "thinking_end",
        contentIndex: index,
        content: block.thinking,
        partial: c.turnOutput,
      });
    } else if (block.type === "toolCall") {
      c.turnSawToolCall = true;
      block.arguments = mapToolArgs(block.name, parsePartialJson(block.partialJson, block.arguments));
      delete block.partialJson;
      c.currentPiStream!.push({ type: "toolcall_end", contentIndex: index, toolCall: block, partial: c.turnOutput });
    }
    return;
  }

  if (event?.type === "message_delta") {
    c.turnOutput.stopReason = mapStopReason(event.delta?.stop_reason);
    if (event.usage) updateUsage(c.turnOutput, event.usage, model);
    return;
  }

  if (event?.type === "message_stop" && c.turnSawToolCall) {
    endStreamForToolUse(c);
    return;
  }

  if (event?.type !== "message_stop" && event?.type !== "ping") {
    debug("processStreamEvent: unhandled event type", event?.type);
  }
}

// The SDK yields completed `assistant` messages after streaming — a no-op when
// stream_events already delivered the content. After resetTurnState, though, the
// next turn's assistant message can arrive before any stream_event, making this
// the primary content path. Same lifecycle obligations as processStreamEvent,
// including ending the stream on tool_use or the MCP handler deadlocks.
function processAssistantMessage(
  message: SDKMessage,
  model: Model<any>,
  customToolNameToPi: Map<string, string>,
  c: QueryContext,
): void {
  if (c.turnSawStreamEvent) return;
  const assistantMsg = (message as any).message;
  if (!assistantMsg?.content) return;
  c.turnToolCallIds = [];
  debug(
    `processAssistantMessage fallback: ${assistantMsg.content.length} blocks, types=${assistantMsg.content.map((b: any) => b.type).join(",")}`,
  );
  for (const block of assistantMsg.content) {
    if (block.type === "text" && block.text) {
      pushWholeText(c, block.text);
    } else if (block.type === "thinking") {
      ensureTurnStarted(c);
      c.turnBlocks.push({ type: "thinking", thinking: block.thinking ?? "", thinkingSignature: block.signature ?? "" });
      const idx = c.turnBlocks.length - 1;
      c.currentPiStream?.push({ type: "thinking_start", contentIndex: idx, partial: c.turnOutput });
      if (block.thinking)
        c.currentPiStream?.push({
          type: "thinking_delta",
          contentIndex: idx,
          delta: block.thinking,
          partial: c.turnOutput,
        });
      c.currentPiStream?.push({
        type: "thinking_end",
        contentIndex: idx,
        content: block.thinking ?? "",
        partial: c.turnOutput,
      });
    } else if (block.type === "tool_use") {
      const piName = piToolNameFor(block.name, customToolNameToPi);
      if (!piName) {
        debug(
          `processAssistantMessage: skipping tool_use for unserved tool ${block.name} [${block.id}] — CC rejects it and retries`,
        );
        continue;
      }
      ensureTurnStarted(c);
      c.turnSawToolCall = true;
      c.turnToolCallIds.push(block.id);
      c.turnBlocks.push({
        type: "toolCall",
        id: block.id,
        name: piName,
        arguments: mapToolArgs(piName, block.input),
      });
      const idx = c.turnBlocks.length - 1;
      const toolBlock = c.turnBlocks[idx];
      c.currentPiStream?.push({ type: "toolcall_start", contentIndex: idx, partial: c.turnOutput });
      c.currentPiStream?.push({
        type: "toolcall_end",
        contentIndex: idx,
        toolCall: toolBlock as any,
        partial: c.turnOutput,
      });
    } else {
      debug("processAssistantMessage: unhandled block type", block.type);
    }
  }
  if (assistantMsg.usage && c.turnOutput) updateUsage(c.turnOutput, assistantMsg.usage, model);

  if (c.turnSawToolCall && c.currentPiStream && c.turnOutput) endStreamForToolUse(c);
}

/** Pumps the SDK generator until the query ends. Per turn: stream_events
 *  (deltas), then an assistant message (completed blocks). On tool_use whichever
 *  path sees it first ends the stream. */
export async function consumeQuery(
  sdkQuery: ReturnType<typeof query>,
  customToolNameToPi: Map<string, string>,
  model: Model<any>,
  wasAborted: () => boolean,
  queryCtx: QueryContext,
): Promise<{ capturedSessionId?: string }> {
  let capturedSessionId: string | undefined;

  for await (const message of sdkQuery) {
    if (RECORD_STREAM_PATH) appendFileSync(RECORD_STREAM_PATH, `${JSON.stringify(message)}\n`);
    if (wasAborted()) break;
    // Below the currentPiStream guard is content, which has nowhere to go once a
    // turn ended on a tool call. These three are not content and must stay above it:
    //   stdin — nothing else closes the CLI's stdin (isSingleUserTurn=false), so
    //     skipping this hangs the query;
    //   a result's failure — the only record the turn failed at all; behind the
    //     guard a 429 at a tool boundary ended the turn silently empty;
    //   rate-limit events — most likely during exactly those long tool turns.
    let resultError: string | undefined;
    if (message.type === "result") {
      queryCtx.promptStream?.end();
      logServedContextWindow("result", message, model);
      resultError = resultErrorText(message);
      if (resultError !== undefined) {
        debug(`consumeQuery: error result, subtype=${message.subtype}, error=${resultError}`);
        if (queryCtx.turnOutput) {
          queryCtx.turnOutput.stopReason = "error";
          queryCtx.turnOutput.errorMessage = resultError;
        }
      }
    }
    if (message.type === "rate_limit_event") {
      const info = (message as any).rate_limit_info;
      debug("consumeQuery: rate_limit_event", JSON.stringify(info).slice(0, 300));
      // Only rejection is actionable — the turn was actually blocked. CC also
      // emits an allowed_warning on every turn once a weekly window is active,
      // with utilization numbers that do not track real usage; surfacing that
      // produced a constant "1% used" wallpaper (and it fired twice without
      // any usage change), so it is dropped.
      if (info?.status === "rejected") {
        const resetsAt = info.resetsAt ? new Date(info.resetsAt).toLocaleTimeString() : "unknown";
        notify(`Claude rate limited (${info.rateLimitType ?? "unknown"}) — resets at ${resetsAt}`, "warning");
      }
      continue;
    }
    if (!queryCtx.currentPiStream || !queryCtx.turnOutput) continue;

    switch (message.type) {
      case "stream_event":
        processStreamEvent(message, customToolNameToPi, model, queryCtx);
        break;
      case "assistant":
        processAssistantMessage(message, model, customToolNameToPi, queryCtx);
        break;
      case "result":
        // Failures were recorded above the guard; this is the success path,
        // used only when no assistant message already delivered the text.
        if (resultError === undefined && !queryCtx.turnSawStreamEvent && message.subtype === "success") {
          pushWholeText(queryCtx, message.result || "");
        }
        break;
      case "system":
        if ((message as any).subtype === "init" && (message as any).session_id) {
          capturedSessionId = (message as any).session_id;
        }
        break;
      case "user":
        // SDK echo of prompts and tool results only. A steer CC drained at a
        // tool boundary is recorded as a `queued_command` attachment and never
        // reaches this stream — hence the steering tripwire lives in int tests.
        break;
      default:
        debug("consumeQuery: unhandled SDK message type", message.type);
        break;
    }
  }

  debug(
    `consumeQuery: for-await loop exited, wasAborted=${wasAborted()}, capturedSessionId=${capturedSessionId?.slice(0, 8) ?? "none"}`,
  );

  return { capturedSessionId };
}
