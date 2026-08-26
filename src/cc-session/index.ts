/**
 * Claude Code JSONL session I/O — vendored from cc-session-io@0.4.0 (MIT).
 *
 * Reads and writes the on-disk session format that CC's `--resume` consumes.
 * Stripped to what the bridge uses: session lifecycle, tool-pairing repair,
 * path resolution, and the Anthropic-format types that flow through both.
 */

export { getClaudeDir, getProjectDir, getSessionPath } from "./paths.js";
export { repairToolPairing } from "./repair.js";
export { createSession, deleteSession, openSession, Session } from "./session.js";
export type {
  AssistantMessagePayload,
  AssistantRecord,
  AttachmentRecord,
  BaseRecordFields,
  ContentBlock,
  CreateSessionOptions,
  ImageBlock,
  ImportAttachment,
  JsonlRecord,
  Message,
  OpenSessionOptions,
  TextBlock,
  ThinkingBlock,
  ToolCallSpec,
  ToolResultBlock,
  ToolUseBlock,
  UnknownRecord,
  UserContentBlock,
  UserMessagePayload,
  UserRecord,
} from "./types.js";
