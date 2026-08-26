/**
 * JSONL serialization for Claude Code session files.
 *
 * Vendored from cc-session-io@0.4.0 (MIT). One record per line,
 * JSON.parse/stringify — no framing beyond newlines.
 */

import type { AssistantRecord, JsonlRecord, UnknownRecord, UserRecord } from "./types.js";

/** Parse a JSONL string into an array of records. */
export function parseJsonl(content: string): JsonlRecord[] {
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map(parseRecord);
}

function parseRecord(line: string): JsonlRecord {
  const raw = JSON.parse(line);
  if (raw.type === "user") return raw as UserRecord;
  if (raw.type === "assistant") return raw as AssistantRecord;
  return raw as UnknownRecord;
}

/** Serialize a single record to a JSON line (no trailing newline). */
export function serializeRecord(record: JsonlRecord): string {
  return JSON.stringify(record);
}
