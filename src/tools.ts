// The pi ↔ Claude Code tool bridge: which names cross the boundary, how their
// arguments are spelled on each side, and how a result gets back to the MCP
// handler that is blocking on it.

import type { ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context, Tool } from "@earendil-works/pi-ai";
import { debug } from "./debug.js";
import type { ToolResult } from "./extract-tool-results.js";
import { createToolServer } from "./mcp-server.js";
import { type PromptStream, userMessage } from "./prompt-stream.js";
import type { QueryContext } from "./query-state.js";
import { steerMissedSession } from "./session.js";
import { MCP_SERVER_NAME, MCP_TOOL_PREFIX } from "./tool-names.js";
import { notify } from "./ui.js";

// Provider path: the query runs with `tools: []`, so the only tools CC can
// legitimately call are the pi tools we serve over MCP. Any other name is the
// model hallucinating a builtin (`bash`, `Bash`, `Edit`, an MCP server we don't
// serve). CC answers those itself with "No such tool available" and retries
// inside the same query, never dispatching them to our MCP server — so a tool
// call under such a name must not reach pi. Forwarding one ran a tool CC never
// dispatched (real side effects) and, because the retry carries a fresh
// tool_use id, left the handler for the retry with no result to release it:
// pi's result arrived keyed to the dead id, and both sides deadlocked.
export function piToolNameFor(name: string, wireNameToPi: Map<string, string>): string | undefined {
  return wireNameToPi.get(name) ?? wireNameToPi.get(name.toLowerCase());
}

// Renames for Claude Code SDK param names that differ from pi's native names.
// Keys not listed here pass through unchanged, so new pi params work automatically.
const SDK_KEY_RENAMES: Record<string, Record<string, string>> = {
  read: { file_path: "path" },
  write: { file_path: "path" },
  edit: { file_path: "path", old_string: "oldText", new_string: "newText", old_text: "oldText", new_text: "newText" },
};

// Maps SDK tool args to pi tool args via key renaming + pass-through.
// Pi's own prepareArguments hooks handle any structural transforms (e.g. edit oldText/newText → edits[]).
export function mapToolArgs(toolName: string, args: Record<string, unknown> | undefined): Record<string, unknown> {
  const input = args ?? {};
  const renames = SDK_KEY_RENAMES[toolName.toLowerCase()];
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    const piKey = renames?.[key] ?? key;
    if (!(piKey in result)) result[piKey] = value; // first alias wins
  }
  // Pi bash has no default timeout; add a safety default
  if (toolName.toLowerCase() === "bash" && result.timeout == null) {
    result.timeout = 120;
  }
  return result;
}

export function resolveMcpTools(context: Context): {
  mcpTools: Tool[];
  piNameToWire: Map<string, string>;
  wireNameToPi: Map<string, string>;
} {
  const mcpTools: Tool[] = [];
  const piNameToWire = new Map<string, string>();
  const wireNameToPi = new Map<string, string>();

  if (!context.tools) return { mcpTools, piNameToWire, wireNameToPi };

  for (const tool of context.tools) {
    const sdkName = `${MCP_TOOL_PREFIX}${tool.name}`;
    mcpTools.push(tool);
    piNameToWire.set(tool.name, sdkName);
    piNameToWire.set(tool.name.toLowerCase(), sdkName);
    wireNameToPi.set(sdkName, tool.name);
    wireNameToPi.set(sdkName.toLowerCase(), tool.name);
  }

  return { mcpTools, piNameToWire, wireNameToPi };
}

// Creates an MCP server that bridges pi tools to the SDK. Each tool handler
// blocks on a Promise until pi delivers the tool result via streamSimple.
// Handlers receive their toolCallId from Claude's tools/call _meta, so results
// are matched by ID end to end.
//
// The handler and pi's result can arrive in either order, hence the two maps:
// a result that lands first waits in `pendingResults` for the handler to claim
// it, and a handler that runs first parks its resolver in `pendingToolCalls`.
// Handlers close over the captured `queryCtx`, ensuring they operate on the
// correct query's state while multiple queries run concurrently.
export function buildMcpServers(
  tools: Tool[],
  queryCtx: QueryContext,
): Record<string, ReturnType<typeof createToolServer>> | undefined {
  if (!tools.length) return undefined;
  const mcpTools = tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    inputSchema: tool.parameters,
    handler: async (toolCallId: string) => {
      if (queryCtx.pendingResults.has(toolCallId)) {
        const result = queryCtx.pendingResults.get(toolCallId)!;
        queryCtx.pendingResults.delete(toolCallId);
        debug(
          `mcp handler: ${tool.name} [${toolCallId}] → resolved from queue (${queryCtx.pendingResults.size} remaining)`,
        );
        return result;
      }
      debug(`mcp handler: ${tool.name} [${toolCallId}] → waiting`);
      return new Promise<ToolResult>((resolve) => {
        queryCtx.pendingToolCalls.set(toolCallId, { toolName: tool.name, resolve });
      });
    },
  }));
  return { [MCP_SERVER_NAME]: createToolServer(MCP_SERVER_NAME, mcpTools) };
}

/** Releases this turn's tool results to their MCP handlers, after first pushing
 *  any steer to CC.
 *
 *  The ordering is mandatory, not an optimization. The steer and the MCP tool
 *  result travel back to CC over the same stdin FIFO. Awaiting the push ack
 *  (which resolves only once the SDK's write to stdin completed) before
 *  resolving any handler guarantees CC enqueues the steer *before* it reads the
 *  tool result, so its post-tool-call drain sees it and acts on it this turn.
 *  Resolve first and the steer misses the drain, silently degrading to
 *  follow-up semantics.
 *
 *  Both the post-tool-call drain and the FIFO ordering are CC CLI internals,
 *  not SDK contract — tests/int-tool-message.mjs is the tripwire if they move. */
export async function deliverToolResults(
  c: QueryContext,
  results: ToolResult[],
  steer: ContentBlockParam[] | null,
  contextLength: number,
): Promise<void> {
  if (steer) {
    const text = steer.map((b) => (b.type === "text" ? b.text : "[image]")).join("\n");
    if (!c.promptStream) {
      debug(`WARNING: steer with no prompt stream, dropping: ${text.slice(0, 60)}`);
      steerMissedSession(text);
    } else {
      try {
        await c.promptStream.push(userMessage(steer, "next"));
        debug(`provider: steer written to CC stdin before tool result: ${text.slice(0, 60)}`);
      } catch (error) {
        // The query is ending — pushing further input would wedge tool-result
        // delivery, so the steer doesn't reach this query. It is still in
        // pi's context, and the caller has already advanced the session
        // cursor past it, so force a rebuild or CC would never see it.
        debug(`provider: steer push rejected, delivering tool result anyway:`, error);
        steerMissedSession(text);
      }
    }
  }

  debug(
    `provider: tool results, ${results.length} results, ${c.pendingToolCalls.size} waiting handlers, ctx.msgs=${contextLength}`,
  );
  for (const result of results) {
    const id = result.toolCallId;
    if (id && c.pendingToolCalls.has(id)) {
      const pending = c.pendingToolCalls.get(id)!;
      c.pendingToolCalls.delete(id);
      debug(
        `provider: resolving ${pending.toolName} [${id}]${result.isError ? " (error)" : ""}`,
        JSON.stringify(result.content).slice(0, 200),
      );
      pending.resolve(result);
    } else if (id) {
      c.pendingResults.set(id, result);
      debug(`provider: queued result [${id}] (${c.pendingResults.size} pending)`);
    } else {
      debug(`WARNING: tool result without toolCallId, cannot match`);
    }
    if (c.pendingToolCalls.size > 0 && c.pendingResults.size > 0) {
      debug(`BUG: both maps non-empty! handlers=${c.pendingToolCalls.size} results=${c.pendingResults.size}`);
    }
  }
  if (c.pendingToolCalls.size > 0) {
    debug(`WARNING: ${c.pendingToolCalls.size} MCP handlers still waiting after delivering ${results.length} results`);
    notify(
      `Claude bridge: ${c.pendingToolCalls.size} tool handler(s) still waiting — provider may be stuck`,
      "warning",
    );
  }
}

/** Abort teardown for one query: settle everything that would otherwise be left
 *  awaiting a subprocess we are about to kill. The pump abandons iteration on
 *  abort, so an in-flight prompt-stream push would hang forever and take
 *  tool-result delivery with it. */
export function drainForAbort(c: QueryContext, promptStream: PromptStream): void {
  promptStream.fail(new Error("Operation aborted"));
  c.releasePendingToolCalls("Operation aborted");
}
