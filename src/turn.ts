// Reading the current turn out of pi's context.
//
// One question, asked several ways: where does the history end and the prompt
// begin? Everything here derives from `turnStart`, which is the single answer.

import type { Base64ImageSource, ContentBlockParam } from "@anthropic-ai/sdk/resources";
import type { Context, ImageContent, TextContent, UserMessage } from "@earendil-works/pi-ai";
import { messageContentToText } from "./convert.js";
import { debug } from "./debug.js";
import { extractAllToolResults as _extractAllToolResults, type ToolResult } from "./extract-tool-results.js";

/** Index of the first message of the current user turn — the trailing run of
 *  user messages that has not been written into the Claude Code session yet.
 *  Equals messages.length when the last message is not a user message.
 *
 *  Single source of truth for the history/prompt split: everything before this
 *  index is replayed as session history, everything from it onward becomes the
 *  prompt. Deriving both halves from one index is what keeps a message from
 *  landing in both — an extension appending a display-only user message after
 *  the real one (see issue #34) makes the turn longer than one message. */
export function turnStart(messages: Context["messages"]): number {
  let i = messages.length;
  while (i > 0 && messages[i - 1].role === "user") i--;
  return i;
}

/** Extract the current user turn as a prompt string. Returns null if the last message is not a user message. */
export function extractUserPrompt(messages: Context["messages"]): string | null {
  const turn = messages.slice(turnStart(messages)) as UserMessage[];
  if (turn.length === 0) return null;
  // Drop empties before joining so an all-empty turn still yields "" and trips
  // the caller's empty-prompt guard rather than sending bare newlines.
  return turn
    .map((m) => (typeof m.content === "string" ? m.content : messageContentToText(m.content)))
    .filter((text) => text)
    .join("\n");
}

/** Extract the current user turn as ContentBlockParam[] (preserving images).
 *  Returns null if no images — caller should fall back to string prompt. */
export function extractUserPromptBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
  const turn = messages.slice(turnStart(messages)) as UserMessage[];
  if (turn.length === 0) return null;

  let hasImage = false;
  const blocks: ContentBlockParam[] = [];
  for (const message of turn) {
    const content: (TextContent | ImageContent)[] =
      typeof message.content === "string" ? [{ type: "text", text: message.content }] : message.content;
    // Off-type content violates UserMessage's contract, so fail rather than
    // degrade — but name the shape, since the cause is almost always another
    // extension appending a malformed message, not this file.
    if (!Array.isArray(content)) {
      throw new Error(
        `extractUserPromptBlocks: user message content must be a string or block array, got ${typeof content} — likely a malformed message from another extension`,
      );
    }
    for (const block of content) {
      if (block.type === "text" && block.text) {
        blocks.push({ type: "text", text: block.text });
      } else if (block.type === "image") {
        // Guard before logging: data-less image blocks do occur, and reading
        // .length off the missing field in the debug template would throw
        // before this check ever runs (template args evaluate unconditionally).
        if (!block.data || !block.mimeType) {
          debug(`image block missing data or mimeType, skipping: keys=${Object.keys(block).join(",")}`);
          continue;
        }
        debug(`image block: mimeType=${block.mimeType}, data length=${block.data.length}`);
        hasImage = true;
        blocks.push({
          type: "image",
          source: {
            type: "base64",
            media_type: block.mimeType as Base64ImageSource["media_type"],
            data: block.data,
          },
        });
      }
    }
  }
  debug(
    `extractUserPromptBlocks: ${turn.length} msgs in turn, ${blocks.length} blocks, types=${blocks.map((b) => b.type).join(",")}`,
  );
  return hasImage ? blocks : null;
}

/** The trailing user turn as content blocks, or null if there isn't one.
 *  Blocks rather than text so image steers keep their images. */
export function steerBlocks(messages: Context["messages"]): ContentBlockParam[] | null {
  const blocks = extractUserPromptBlocks(messages);
  if (blocks) return blocks;
  const text = extractUserPrompt(messages);
  return text ? [{ type: "text", text }] : null;
}

// Pi doesn't pass tool results directly — it appends them to the context and calls
// the provider again. Thin wrapper over extract-tool-results.js that adds per-turn
// debug logging at the extraction boundary.
export function extractAllToolResults(context: Context): ToolResult[] {
  const { results, stopIdx } = _extractAllToolResults(
    context.messages as unknown as Array<{ role: string; [key: string]: unknown }>,
  );
  debug(
    `extractAllToolResults: ${results.length} results from ${context.messages.length} msgs, stopped at index ${stopIdx}`,
  );
  debug(`extractAllToolResults: all msg roles:`, context.messages.map((m, i) => `[${i}]${m.role}`).join(" "));
  for (let r = 0; r < results.length; r++) {
    debug(
      `extractAllToolResults: result[${r}] id=${results[r].toolCallId}${results[r].isError ? " ERROR" : ""} preview:`,
      JSON.stringify(results[r].content).slice(0, 150),
    );
  }
  return results;
}
