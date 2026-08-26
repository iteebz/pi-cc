// The shared Claude Code session: the JSONL on disk that `--resume` reads.
//
// We write the same JSONL Claude Code reads, so resume is a real CC resume, not
// a replayed prompt. Sole owner of `sharedSession` — every mutation is a named
// verb here, so "who moved the cursor" is a grep.

import type { Context } from "@earendil-works/pi-ai";
import { createSession, deleteSession, openSession, repairToolPairing } from "cc-session-io";
import { type CarriedAttachment, collectCarriedAttachments, placeCarriedAttachments } from "./attachments.js";
import { convertPiMessages } from "./convert.js";
import { DEBUG, DEBUG_LOG_PATH, debug, debugSessionPaths, diagDump, safeRealpath } from "./debug.js";
import { verifyWrittenSession as _verifyWrittenSession } from "./session-verify.js";
import { turnStart } from "./turn.js";
import { notify } from "./ui.js";

export interface SessionState {
  sessionId: string;
  cursor: number;
  cwd: string;
  /** Force the next sync down REBUILD: pi mutated its messages out from under
   *  us, or an abort left the JSONL indeterminate. */
  needsRebuild?: boolean;
}

export interface SyncResult {
  sessionId: string | null;
  preserveSharedSession?: boolean;
}

let sharedSession: SessionState | null = null;

export function getSharedSession(): SessionState | null {
  return sharedSession;
}

export function setSharedSession(state: SessionState | null): void {
  sharedSession = state;
}

export function clearSharedSession(reason: string): void {
  debug(`${reason}: clearing session ${sharedSession?.sessionId?.slice(0, 8) ?? "none"}`);
  sharedSession = null;
}

/** pi rewrote its own history (/compact, session_tree), or a message never reached CC. */
export function markNeedsRebuild(reason: string): void {
  if (!sharedSession) return;
  debug(`${reason}: marking needsRebuild on session ${sharedSession.sessionId.slice(0, 8)}`);
  sharedSession = { ...sharedSession, needsRebuild: true };
}

/** REBUILD under the same UUID. The subprocess is already dead by the time
 *  this runs — close() killed it, and the for-await loop confirmed no more
 *  messages. Keeping the UUID preserves the prompt cache prefix across aborts.
 *  (forceRotate was removed: it guaranteed a cold cache on every abort, and
 *  the race it guarded against — a late orphan write — cannot happen after
 *  close() + loop exit.) */
export function markAborted(): void {
  if (!sharedSession) return;
  sharedSession = { ...sharedSession, needsRebuild: true };
  debug(`provider: abort detected, marked sharedSession needsRebuild`);
}

export function setCursor(cursor: number): void {
  if (sharedSession) sharedSession.cursor = cursor;
}

/** A steer that never reached CC. The cursor already counted it, so count-based
 *  sync would skip it forever — rebuild re-imports it from pi's context. */
export function steerMissedSession(text: string): void {
  if (!sharedSession) return;
  sharedSession = { ...sharedSession, needsRebuild: true };
  debug(`provider: steer never reached CC, marked session for rebuild: ${text.slice(0, 60)}`);
}

/** CC's `@file` expansions from the session about to be replaced. Must run
 *  before `deleteSession` wipes the file they live in — after it, this yields
 *  nothing and nothing errors. */
function readCarriedAttachments(sessionId: string, cwd: string): CarriedAttachment[] {
  try {
    const previous = openSession({ sessionId, projectPath: cwd, claudeDir: process.env.CLAUDE_CONFIG_DIR });
    return collectCarriedAttachments(previous.records);
  } catch (error) {
    // A post-abort rebuild can read a half-written file, and cc-session-io
    // JSON.parses each line bare. Losing an attachment beats failing the turn.
    debug(`WARNING: could not read attachments from session ${sessionId.slice(0, 8)}:`, error);
    return [];
  }
}

// Lossy: only text, thinking and toolCall blocks survive, and thinking only when
// CC itself minted the signature. An assistant message whose blocks all filter out
// keeps its slot with a placeholder — dropping it can leave a tool_result with no
// preceding tool_use. A turn aborted before anything streamed is dropped instead;
// inventing content would diverge from the prefix CC cached.
function convertAndImportMessages(
  session: ReturnType<typeof createSession>,
  messages: Context["messages"],
  customToolNameToSdk?: Map<string, string>,
  carried?: readonly CarriedAttachment[],
): void {
  const { anthropicMessages, sanitizedIds, dropped } = convertPiMessages(messages, customToolNameToSdk);

  debug(`convertAndImportMessages: ${messages.length} pi msgs → ${anthropicMessages.length} anthropic msgs`);
  debug(
    `convertAndImportMessages: imported roles:`,
    anthropicMessages
      .map((m, i) => {
        const c = m.content;
        if (typeof c === "string") return `[${i}]${m.role}:text`;
        if (Array.isArray(c)) return `[${i}]${m.role}:${c.map((b) => b.type).join("+")}`;
        return `[${i}]${m.role}:?`;
      })
      .join(" "),
  );
  // The roles line shows only survivors, where a stripped block looks like one
  // that never existed. Name the losses.
  const droppedParts = [
    dropped.thinking ? `${dropped.thinking} thinking (${[...dropped.providers].sort().join(", ")})` : "",
    dropped.emptySignatures ? `${dropped.emptySignatures} empty-signature (own provider, no signature to replay)` : "",
    dropped.abortedTurns ? `${dropped.abortedTurns} aborted turn(s)` : "",
    ...[...dropped.other].map(([type, n]) => `${n} ${type}`),
  ].filter(Boolean);
  if (droppedParts.length > 0) {
    debug(`convertAndImportMessages: dropped ${droppedParts.join(", ")}`);
  }
  if (sanitizedIds.size > 0) {
    debug(
      `convertAndImportMessages: sanitized ${sanitizedIds.size} tool IDs:`,
      [...sanitizedIds.entries()].map(([orig, clean]) => (orig === clean ? orig : `${orig}→${clean}`)).join(", "),
    );
  }
  // Pre-repair for debug logging; importMessages also repairs internally (idempotent).
  const repaired = repairToolPairing(anthropicMessages);
  if (repaired.length !== anthropicMessages.length) {
    debug(`convertAndImportMessages: repairToolPairing ${anthropicMessages.length} → ${repaired.length} msgs`);
  }
  // Against the repaired array: that is the index space importMessages reads.
  // Attachments are links in CC's uuid chain — written in order, not appended.
  const placed = carried?.length
    ? placeCarriedAttachments(carried, repaired as unknown as { role: string; content: unknown }[])
    : undefined;
  if (placed?.skipped.length) {
    debug(
      `convertAndImportMessages: dropped ${placed.skipped.length} carried attachment(s): ${placed.skipped.join("; ")}`,
    );
  }
  if (placed?.attachments.length) {
    debug(`convertAndImportMessages: carrying ${placed.attachments.length} attachment(s) across the rebuild`);
  }
  if (repaired.length) {
    session.importMessages(repaired, placed?.attachments.length ? { attachments: placed.attachments } : undefined);
  }
}

// Warns instead of throwing: CC may be more tolerant than our checks, and a false
// positive shouldn't block the user. Pure logic in session-verify.js; this fans
// each warning out to debug log + pi notify + diagDump.
function verifyWrittenSession(
  jsonlPath: string,
  expectedSessionId: string,
  expectedRecordCount: number,
  cwd: string,
): void {
  const warnings = _verifyWrittenSession(jsonlPath, expectedSessionId, expectedRecordCount);
  for (const msg of warnings) {
    debug(`WARNING session verify: ${msg}`);
    notify(
      `Session file issue: ${msg}\n` +
        `cwd=${cwd} realpath=${safeRealpath(cwd)} CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"}\n` +
        (DEBUG ? `Debug log: ${DEBUG_LOG_PATH}` : `Rerun with CLAUDE_BRIDGE_DEBUG=1 to capture a debug log.`),
      "warning",
    );
    diagDump("session_verify_fail", {
      msg,
      jsonlPath,
      cwd,
      realpath: safeRealpath(cwd),
      claudeConfigDir: process.env.CLAUDE_CONFIG_DIR ?? null,
    });
  }
}

/**
 * Give CC every message before the current user turn. Returns the session id to
 * resume from, or null for a clean start.
 *
 *   REUSE   — pi's history matches the cached session (or drifted only by the
 *             trailing assistant message pi appends after streamSimple returns,
 *             which CC already persisted). Keeps the prompt cache warm.
 *   REBUILD — no session, or pi's history diverged. Wipes the file and rewrites
 *             it from pi's history under the same UUID.
 *
 * Rebuild rather than patch: injecting deltas creates a branch CC's --resume
 * doesn't follow. Same UUID across rebuilds: CC re-reads the JSONL every resume
 * (no in-process caching), so preserving it costs nothing and keeps log
 * correlation stable across provider switches.
 *
 * The "Case 1/2/3/4" log strings are grep anchors for int-cache.sh and
 * int-session-resume.mjs. Don't rename them.
 */
export function syncSharedSession(
  messages: Context["messages"],
  cwd: string,
  customToolNameToSdk?: Map<string, string>,
  modelId?: string,
  isReentrant = false,
): SyncResult {
  const priorMessages = messages.slice(0, turnStart(messages)); // everything before the current user turn

  // priorMessages.length >= cursor: a shorter context cannot continue the cached
  // session. Without it, missed = [].slice(cursor) falsely hits REUSE and resumes
  // an unrelated longer CC session (issue #25).
  if (sharedSession && !sharedSession.needsRebuild && priorMessages.length >= sharedSession.cursor) {
    const missed = priorMessages.slice(sharedSession.cursor);
    const trailingAssistantOnly = missed.length === 1 && (missed[0] as { role?: string }).role === "assistant";
    if (missed.length === 0 || trailingAssistantOnly) {
      if (trailingAssistantOnly) {
        sharedSession = { ...sharedSession, cursor: priorMessages.length, cwd };
      }
      debug(
        `Case 3: ${trailingAssistantOnly ? "advanced cursor past trailing assistant, " : ""}resuming session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`,
      );
      debug(`syncResult: path=reuse sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`);
      return { sessionId: sharedSession.sessionId };
    }
  }
  // Subagent isolation. A reentrant subagent's own priors are shorter than the
  // parent's cursor, so it lands here, gets a fresh session, and that ephemeral
  // session is deleted when its query completes. Remove this branch and a
  // subagent resumes, then overwrites, the parent's session.
  //
  // A NON-reentrant shorter context is a different situation entirely (issue #30):
  // pi pruned or compacted its history, so the context shrank under us. Clean-
  // starting there would answer with no prior conversation at all. Fall through
  // to REBUILD instead — the (compressed) priors are re-written under the same
  // UUID, which keeps the context and bounds the JSONL.
  if (isReentrant && sharedSession && !sharedSession.needsRebuild && priorMessages.length < sharedSession.cursor) {
    debug(
      `Case 1 synthetic: clean start for shorter context, preserving shared session ${sharedSession.sessionId.slice(0, 8)}, cursor=${sharedSession.cursor}`,
    );
    debug(
      `syncResult: path=clean-start preserve-shared sessionId=${sharedSession.sessionId} cursor=${sharedSession.cursor}`,
    );
    return { sessionId: null, preserveSharedSession: true };
  }

  // REBUILD path
  if (priorMessages.length === 0) {
    debug(`Case 1: clean start, ${messages.length} total messages`);
    debug(`syncResult: path=clean-start`);
    return { sessionId: null };
  }
  const previousSessionId = sharedSession?.sessionId;
  const previousCursor = sharedSession?.cursor ?? 0;
  // Before deleteSession — it wipes the file these live in.
  const carried = previousSessionId !== undefined ? readCarriedAttachments(previousSessionId, cwd) : [];
  if (previousSessionId !== undefined) {
    // Wipe prior jsonl + companion dir (no-op if nothing to wipe).
    deleteSession(previousSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
  }
  // Reuse the UUID across rebuilds so the prompt cache prefix survives.
  const session = createSession({
    projectPath: cwd,
    claudeDir: process.env.CLAUDE_CONFIG_DIR,
    ...(previousSessionId ? { sessionId: previousSessionId } : {}),
    ...(modelId ? { model: modelId } : {}),
  });
  convertAndImportMessages(session, priorMessages, customToolNameToSdk, carried);
  session.save();
  // records, not messages: `messages` filters out attachment records.
  verifyWrittenSession(session.jsonlPath, session.sessionId, session.records.length, cwd);
  sharedSession = { sessionId: session.sessionId, cursor: priorMessages.length, cwd };
  if (previousSessionId === undefined) {
    debug(
      `Case 2: first turn with ${priorMessages.length} prior messages → session ${session.sessionId.slice(0, 8)}, ${session.records.length} records`,
    );
  } else {
    const missedCount = priorMessages.length - previousCursor;
    debug(
      `Case 4: ${missedCount} missed messages, ${priorMessages.length} total → rewrote session ${session.sessionId.slice(0, 8)} (same id), ${session.records.length} records`,
    );
  }
  debugSessionPaths(`${session.sessionId.slice(0, 8)}`, cwd, session.jsonlPath);
  debug(
    `syncResult: path=rebuild sessionId=${session.sessionId} priors=${priorMessages.length} ${previousSessionId === undefined ? "first" : "preserved"}`,
  );
  return { sessionId: session.sessionId };
}

/** Drop the session a reentrant subagent captured, so the parent's survives. */
export function discardEphemeralSession(capturedSessionId: string | undefined, cwd: string): void {
  if (capturedSessionId && capturedSessionId !== sharedSession?.sessionId) {
    deleteSession(capturedSessionId, cwd, process.env.CLAUDE_CONFIG_DIR);
    debug(
      `provider: query done, deleted ephemeral session ${capturedSessionId.slice(0, 8)} to preserve shared session`,
    );
  }
  debug(
    `provider: query done, ignoring captured session ${capturedSessionId?.slice(0, 8) ?? "none"} to preserve shared session`,
  );
}
