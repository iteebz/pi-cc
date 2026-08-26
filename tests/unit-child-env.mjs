/**
 * Every Claude Code subprocess the bridge spawns has to be told to keep its hands
 * off state pi owns and to suppress outbound telemetry. These are silent when
 * missing: CC compacts or writes memory on its own, nothing throws, and the
 * damage shows up in the user's ~/.claude rather than in a test.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";

const { CC_CHILD_ENV } = await import("../src/config.js");

describe("Claude Code child environment", () => {
  it("disables auto-compaction and claude.ai MCP servers", () => {
    assert.equal(CC_CHILD_ENV.ENABLE_CLAUDEAI_MCP_SERVERS, "0");
    assert.equal(CC_CHILD_ENV.DISABLE_AUTO_COMPACT, "1");
  });

  it("suppresses all telemetry and nonessential traffic", () => {
    assert.equal(CC_CHILD_ENV.DISABLE_TELEMETRY, "1");
    assert.equal(CC_CHILD_ENV.DISABLE_ERROR_REPORTING, "1");
    assert.equal(CC_CHILD_ENV.DISABLE_AUTOUPDATER, "1");
    assert.equal(CC_CHILD_ENV.DISABLE_INSTALLATION_CHECKS, "1");
    assert.equal(CC_CHILD_ENV.DISABLE_UPGRADE_COMMAND, "1");
    assert.equal(CC_CHILD_ENV.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, "1");
    assert.equal(CC_CHILD_ENV.CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY, "1");
  });

  // Deliberately not asserted here: that every `query()` call site spreads the
  // constant. The only way to check that from a unit test is to grep src/index.ts,
  // which fails on innocent indirection (`env: childEnv`) and would have to be
  // taught about it — a brittle test that reads as coverage. The three sites
  // referencing CC_CHILD_ENV are the guard, and a fourth is a review question.
});
