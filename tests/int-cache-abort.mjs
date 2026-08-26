#!/usr/bin/env node
/**
 * Prompt cache test for the abort→resume path.
 *
 * Validates that aborting a turn and sending a new message preserves the
 * prompt cache. Exercises two interventions:
 *   1. Clean abort detection (markAborted skips rebuild when JSONL is intact)
 *   2. Deterministic UUIDs (if rebuild IS needed, tags are stable)
 *
 * Flow:
 *   Turn 1: normal (establishes cache, cacheWrite > 0)
 *   Turn 2: aborted after 2s
 *   Turn 3: normal (should cache-hit: cachePct >= 70%)
 */

console.log("=== cache-abort-test.mjs ===");

import { readFileSync } from "node:fs";
import { createRpcHarness } from "./lib/rpc-harness.mjs";

const TIMEOUT = 120_000;
const MODEL = "cc/claude-sonnet-4-6";

const harness = createRpcHarness({
  name: "cache-abort",
  args: ["--model", MODEL],
  defaultTimeout: TIMEOUT,
});

const { startAndWait, stop, send, addListener, collectText, DEBUG_LOG } = harness;

function waitForIdle(timeout = TIMEOUT) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timeout waiting for idle")), timeout);
    const remove = addListener((msg) => {
      if (msg.type === "agent_end") {
        clearTimeout(timer);
        remove();
        resolve(msg);
      }
    });
  });
}

// Collect usage from turn_end events
const usages = [];
function startUsageCollection() {
  return addListener((msg) => {
    if (msg.type === "turn_end" && msg.message?.usage) {
      usages.push(msg.message.usage);
    }
  });
}

await startAndWait();
const removeUsage = startUsageCollection();

try {
  // --- Turn 1: establish cache ---
  console.log("Turn 1: establishing cache...");
  const collector1 = collectText();
  await send({
    type: "prompt",
    message: "The secret code is FOXTROT-9. Acknowledge with exactly: 'Code FOXTROT-9 received.'",
  });
  await waitForIdle();
  const text1 = collector1.stop();
  console.log(`  Response: ${text1.slice(0, 80)}`);

  const u1 = usages[usages.length - 1];
  if (u1) {
    console.log(`  cacheWrite=${u1.cacheWrite ?? 0} cacheRead=${u1.cacheRead ?? 0} input=${u1.input ?? 0}`);
  }

  // --- Turn 2: abort mid-stream ---
  console.log("\nTurn 2: sending long prompt, aborting after 2s...");
  const collector2 = collectText();
  await send({
    type: "prompt",
    message:
      "Write a comprehensive 3000-word essay covering the complete history of cryptography from ancient Egypt through quantum computing. Include specific dates, names, and technical details for each era.",
  });

  // Wait 2 seconds then abort
  await new Promise((r) => setTimeout(r, 2000));
  const idle2 = waitForIdle();
  await send({ type: "abort" });
  await idle2;
  const text2 = collector2.stop();
  console.log(`  Got ${text2.length} chars before abort`);

  // --- Turn 3: post-abort turn (the critical measurement) ---
  console.log("\nTurn 3: post-abort message (should cache-hit)...");
  const collector3 = collectText();
  await send({
    type: "prompt",
    message: "What was the secret code? Reply with just the code, nothing else.",
  });
  await waitForIdle();
  const text3 = collector3.stop();
  console.log(`  Response: ${text3.slice(0, 80)}`);

  // --- Analyze results ---
  console.log("\n=== Cache metrics ===");
  console.log("Turn  Input     CacheRd   CacheWr   Output    CachePct");
  console.log("----  --------  --------  --------  --------  --------");

  let postAbortPct = -1;

  for (let i = 0; i < usages.length; i++) {
    const u = usages[i];
    const input = u.input ?? 0;
    const cacheRead = u.cacheRead ?? 0;
    const cacheWrite = u.cacheWrite ?? 0;
    const output = u.output ?? 0;
    const total = input + cacheRead + cacheWrite;
    const pct = total > 0 ? Math.round((cacheRead / total) * 100) : 0;
    console.log(
      `${String(i + 1).padStart(4)}  ${String(input).padStart(8)}  ${String(cacheRead).padStart(8)}  ${String(cacheWrite).padStart(8)}  ${String(output).padStart(8)}  ${pct}%`,
    );

    // The last usage entry is turn 3 (post-abort)
    if (i === usages.length - 1) postAbortPct = pct;
  }

  // --- Debug log analysis ---
  console.log("\n=== Session sync decisions ===");
  const debugLog = readFileSync(DEBUG_LOG, "utf8");

  for (const match of debugLog.matchAll(/syncResult: path=(\S+) sessionId=([a-f0-9-]+)/g)) {
    console.log(`  ${match[1]}  session=${match[2].slice(0, 8)}`);
  }

  // Show abort handling
  const abortLines = debugLog.split("\n").filter((l) => /abort detected/.test(l));
  console.log("\nAbort handling:");
  for (const line of abortLines) {
    // Extract just the relevant part
    const match = line.match(/abort detected.*/);
    if (match) console.log(`  ${match[0]}`);
  }

  // --- Assertions ---
  console.log("\n=== Assertions ===");
  let fail = 0;

  // Check that abort skipped rebuild (clean JSONL)
  const skippedRebuild = abortLines.some((l) => l.includes("skipping rebuild"));
  const markedRebuild = abortLines.some((l) => l.includes("marked needsRebuild"));
  if (skippedRebuild) {
    console.log("  ✓ Abort skipped rebuild (clean JSONL detected)");
  } else if (markedRebuild) {
    console.log("  ✗ Abort triggered rebuild (JSONL was damaged or not found)");
    fail++;
  } else {
    console.log("  ? No abort handling found in debug log");
  }

  // Check post-abort cache hit rate
  if (postAbortPct >= 70) {
    console.log(`  ✓ Post-abort cache hit: ${postAbortPct}% (≥70%)`);
  } else if (postAbortPct >= 0) {
    console.log(`  ✗ Post-abort cache hit: ${postAbortPct}% (<70% — cache miss)`);
    fail++;
  } else {
    console.log("  ? No usage data for post-abort turn");
  }

  // Check content correctness
  const lower3 = text3.toLowerCase();
  if (lower3.includes("foxtrot") || lower3.includes("9")) {
    console.log("  ✓ Post-abort response has correct content");
  } else {
    console.log(`  ✗ Post-abort response missing secret code: ${text3}`);
    fail++;
  }

  // Session ID stability
  const sessionIds = new Set();
  for (const match of debugLog.matchAll(/syncResult: path=(?:reuse|rebuild) sessionId=([a-f0-9-]+)/g)) {
    sessionIds.add(match[1]);
  }
  if (sessionIds.size <= 1) {
    console.log(`  ✓ Session ID stable (${sessionIds.size} unique)`);
  } else {
    console.log(`  ✗ Session ID changed across abort: ${[...sessionIds].map((s) => s.slice(0, 8)).join(", ")}`);
    fail++;
  }

  if (fail === 0) {
    console.log("\nPASS");
  } else {
    console.log(`\nFAIL: ${fail} assertion(s) failed`);
    process.exitCode = 1;
  }
} catch (e) {
  process.exitCode = 1;
  console.log(`FAIL: ${e.message}\n${e.stack}`);
  console.log(`  Debug log: ${DEBUG_LOG}`);
} finally {
  removeUsage();
  await stop();
}
