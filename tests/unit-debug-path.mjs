/**
 * Guards the guard: if tests/lib/setup.mjs stops being preloaded, unit tests
 * would silently start writing to the developer's real debug log instead of a
 * temp dir. That regression is otherwise invisible unless CC_BRIDGE_DEBUG=1.
 */

import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";

describe("test harness", () => {
  it("redirects the bridge debug log away from the real one", () => {
    const path = process.env.CC_BRIDGE_DEBUG_PATH;
    assert.ok(path, "CC_BRIDGE_DEBUG_PATH must be set — is tests/lib/setup.mjs still preloaded via --import?");
    // Compare against the production default specifically; a blanket "not under
    // $HOME" check would misfire for anyone whose TMPDIR lives inside their home.
    assert.notEqual(path, join(homedir(), ".pi", "agent", "cc.log"), "debug log must not resolve to the real one");
  });
});
