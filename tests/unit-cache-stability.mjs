/**
 * Cache stability interventions:
 *   - Deterministic UUIDs: same sessionId + same record order = same UUIDs
 *     across rebuilds, stabilizing CC's [id:] tags for prompt cache reuse.
 *   - Clean abort detection: skip rebuild when the JSONL is valid after abort,
 *     keeping the file (and cache) identical.
 */

import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSession } from "../src/cc-session/index.js";

// --- Deterministic UUIDs ---

describe("deterministic UUIDs", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("produces identical UUIDs for the same sessionId and record order", () => {
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    dir = mkdtempSync(join(tmpdir(), "det-uuid-"));

    // Build 1
    const s1 = createSession({ projectPath: dir, sessionId, deterministicUuids: true });
    const u1a = s1.addUserMessage("Hello");
    const u1b = s1.addAssistantMessage([{ type: "text", text: "Hi" }]);
    const u1c = s1.addUserMessage("How are you?");

    // Build 2 — same sessionId, same messages
    const s2 = createSession({ projectPath: dir, sessionId: `${sessionId}`, deterministicUuids: true });
    const u2a = s2.addUserMessage("Hello");
    const u2b = s2.addAssistantMessage([{ type: "text", text: "Hi" }]);
    const u2c = s2.addUserMessage("How are you?");

    assert.equal(u1a, u2a, "first user message UUID should match");
    assert.equal(u1b, u2b, "assistant message UUID should match");
    assert.equal(u1c, u2c, "second user message UUID should match");
  });

  it("produces different UUIDs for different sessionIds", () => {
    dir = mkdtempSync(join(tmpdir(), "det-uuid-diff-"));
    const s1 = createSession({
      projectPath: dir,
      sessionId: "11111111-1111-4111-8111-111111111111",
      deterministicUuids: true,
    });
    const s2 = createSession({
      projectPath: dir,
      sessionId: "22222222-2222-4222-8222-222222222222",
      deterministicUuids: true,
    });
    const u1 = s1.addUserMessage("Hello");
    const u2 = s2.addUserMessage("Hello");
    assert.notEqual(u1, u2);
  });

  it("generates valid UUID v4 format", () => {
    dir = mkdtempSync(join(tmpdir(), "det-uuid-fmt-"));
    const s = createSession({
      projectPath: dir,
      sessionId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
      deterministicUuids: true,
    });
    const uuid = s.addUserMessage("test");
    // UUID v4 format: 8-4-4-4-12 hex chars with version nibble = 4
    assert.match(uuid, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it("random UUIDs are used when deterministicUuids is not set", () => {
    dir = mkdtempSync(join(tmpdir(), "det-uuid-off-"));
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const s1 = createSession({ projectPath: dir, sessionId });
    const s2 = createSession({ projectPath: dir, sessionId });
    const u1 = s1.addUserMessage("Hello");
    const u2 = s2.addUserMessage("Hello");
    // Random UUIDs should differ (astronomically unlikely to collide)
    assert.notEqual(u1, u2);
  });

  it("attachment UUIDs are also deterministic", () => {
    dir = mkdtempSync(join(tmpdir(), "det-uuid-attach-"));
    const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
    const s1 = createSession({ projectPath: dir, sessionId, deterministicUuids: true });
    s1.addUserMessage("Hello");
    const a1 = s1.addAttachment({ type: "file", path: "/tmp/test.txt" });

    const s2 = createSession({ projectPath: dir, sessionId, deterministicUuids: true });
    s2.addUserMessage("Hello");
    const a2 = s2.addAttachment({ type: "file", path: "/tmp/test.txt" });

    assert.equal(a1, a2, "attachment UUID should be deterministic");
  });
});

// --- Clean abort detection ---

describe("markAborted skips rebuild on clean JSONL", () => {
  let dir;
  afterEach(() => {
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("does not set needsRebuild when the session file is clean", async () => {
    dir = mkdtempSync(join(tmpdir(), "clean-abort-"));
    const { setSharedSession, getSharedSession, markAborted } = await import("../src/session.js");

    // Create a valid session file
    const session = createSession({ projectPath: dir, claudeDir: dir });
    session.addUserMessage("Hello");
    session.addAssistantMessage([{ type: "text", text: "Hi" }]);
    session.save();

    setSharedSession({
      sessionId: session.sessionId,
      cursor: 2,
      cwd: dir,
    });

    // Override CLAUDE_CONFIG_DIR so isSessionFileClean finds the file
    const origDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      markAborted();
      const state = getSharedSession();
      assert.ok(state, "session should still exist");
      assert.equal(state.needsRebuild, undefined, "should NOT set needsRebuild on clean JSONL");
    } finally {
      process.env.CLAUDE_CONFIG_DIR = origDir;
      setSharedSession(null);
    }
  });

  it("sets needsRebuild when the session file has truncated JSON", async () => {
    dir = mkdtempSync(join(tmpdir(), "damaged-abort-"));
    const { setSharedSession, getSharedSession, markAborted } = await import("../src/session.js");

    // Create a session file with a truncated last line
    const session = createSession({ projectPath: dir, claudeDir: dir });
    session.addUserMessage("Hello");
    session.save();

    // Corrupt the file by appending a truncated line
    const content = readFileSync(session.jsonlPath, "utf-8");
    writeFileSync(session.jsonlPath, `${content}{"type":"assistant","message":{"role":"assis`);

    setSharedSession({
      sessionId: session.sessionId,
      cursor: 1,
      cwd: dir,
    });

    const origDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      markAborted();
      const state = getSharedSession();
      assert.ok(state, "session should still exist");
      assert.equal(state.needsRebuild, true, "should set needsRebuild on damaged JSONL");
    } finally {
      process.env.CLAUDE_CONFIG_DIR = origDir;
      setSharedSession(null);
    }
  });

  it("sets needsRebuild when the session file is missing", async () => {
    dir = mkdtempSync(join(tmpdir(), "missing-abort-"));
    const { setSharedSession, getSharedSession, markAborted } = await import("../src/session.js");

    setSharedSession({
      sessionId: "nonexistent-session-id",
      cursor: 1,
      cwd: dir,
    });

    const origDir = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = dir;
    try {
      markAborted();
      const state = getSharedSession();
      assert.ok(state, "session should still exist");
      assert.equal(state.needsRebuild, true, "should set needsRebuild when file is missing");
    } finally {
      process.env.CLAUDE_CONFIG_DIR = origDir;
      setSharedSession(null);
    }
  });
});
