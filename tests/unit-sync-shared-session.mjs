/**
 * Regression tests for syncSharedSession's session reuse decisions.
 */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createSession, deleteSession, openSession } from "../src/cc-session/index.js";

const { getSharedSession, setSharedSession, syncSharedSession } = await import("../src/session.js");
const { setUI } = await import("../src/ui.js");

describe("syncSharedSession", () => {
  afterEach(() => {
    setSharedSession(null);
    setUI(null);
  });

  // The branch this exercises is the guard that stops a reentrant subagent from
  // resuming — and then overwriting — the parent's session: a subagent's context
  // is shorter than the parent's cursor, so it starts fresh and the parent's
  // session is preserved. It was previously described here as the compact-summary
  // path, which cannot reach syncSharedSession at all, so the branch read as
  // covered for a case that never happens.
  it("starts a fresh session for a shorter context and preserves the parent's", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
    try {
      const mainSession = {
        sessionId: "11111111-1111-4111-8111-111111111111",
        cursor: 42,
        cwd,
      };
      setSharedSession(mainSession);

      const result = syncSharedSession(
        [
          {
            role: "user",
            content: "Summarize this conversation.",
            timestamp: Date.now(),
          },
        ],
        cwd,
        undefined,
        undefined,
        true,
      );

      assert.equal(
        result.sessionId,
        null,
        "a context shorter than the cursor — a subagent — must start a fresh Claude Code session instead of resuming the parent's",
      );
      assert.equal(
        result.preserveSharedSession,
        true,
        "the fresh session must not replace the parent's when it completes",
      );
      assert.deepEqual(getSharedSession(), mainSession);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // Issue #30. pi-context-prune shrinks pi's history below our cursor; that is
  // NOT a subagent. The old shorter-context branch clean-started here, so Claude
  // answered with no prior conversation at all. A non-reentrant shrink must
  // REBUILD from the (pruned) priors under the same UUID instead.
  it("rebuilds from pruned priors when a non-reentrant context shrinks below the cursor", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
    const sessionId = randomUUID();
    try {
      const seeded = createSession({ sessionId, projectPath: cwd });
      seeded.importMessages([
        { role: "user", content: "first turn", timestamp: Date.now() },
        { role: "assistant", content: [{ type: "text", text: "first reply" }], timestamp: Date.now() },
      ]);
      seeded.save();
      setSharedSession({ sessionId, cursor: 42, cwd });

      const result = syncSharedSession(
        [
          { role: "user", content: "compressed summary of everything so far", timestamp: Date.now() },
          { role: "assistant", content: [{ type: "text", text: "acknowledged" }], timestamp: Date.now() },
          { role: "user", content: "continue", timestamp: Date.now() },
        ],
        cwd,
      );

      assert.equal(result.sessionId, sessionId, "a pruned context must rebuild under the same UUID, not clean-start");
      assert.equal(result.preserveSharedSession, undefined);
      const rebuilt = openSession({ sessionId, projectPath: cwd });
      assert.equal(rebuilt.messages.length, 2, "the rebuilt session holds exactly the pruned priors");
      assert.deepEqual(getSharedSession()?.cursor, 2, "the cursor moves to the pruned length");
    } finally {
      deleteSession(sessionId, cwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  // The rebuilt file holds one line per record, and a carried `@file` expansion
  // is an `attachment` record — which `session.messages` filters out. Counting
  // messages told every user who at-mentioned a file before switching providers
  // that their session was corrupt, and asked them to open an issue about it.
  it("does not report a count mismatch when a rebuild carries an attachment", () => {
    const cwd = mkdtempSync(join(tmpdir(), "sync-shared-session-"));
    const sessionId = randomUUID();
    const prompt = "Review @fixture.txt and remember it.";
    const notices = [];
    try {
      const seeded = createSession({ sessionId, projectPath: cwd });
      seeded.importMessages(
        [
          { role: "user", content: prompt },
          { role: "assistant", content: [{ type: "text", text: "Noted." }] },
        ],
        {
          attachments: [
            {
              afterIndex: 0,
              attachment: {
                type: "file",
                filename: join(cwd, "fixture.txt"),
                content: { type: "text", file: { filePath: join(cwd, "fixture.txt"), content: "token" } },
              },
            },
          ],
        },
      );
      seeded.save();

      setSharedSession({ sessionId, cursor: 0, cwd });
      setUI({ notify: (message) => notices.push(message) });
      syncSharedSession(
        [
          { role: "user", content: prompt, timestamp: Date.now() },
          { role: "assistant", content: [{ type: "text", text: "Noted." }], timestamp: Date.now() },
          { role: "user", content: "Now what did it say?", timestamp: Date.now() },
        ],
        cwd,
      );

      assert.equal(
        openSession({ sessionId, projectPath: cwd }).attachments.length,
        1,
        "the rebuild did not carry the attachment, so this proves nothing about the count",
      );
      assert.deepEqual(notices, []);
    } finally {
      deleteSession(sessionId, cwd);
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});
