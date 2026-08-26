// Debug + diagnostic logging. Layer 0: imports nothing local, so every other
// module can log without creating a cycle.
//
// CC_BRIDGE_DEBUG=1 enables debug logging to ~/.pi/agent/cc.log

import { appendFileSync, mkdirSync, realpathSync, statSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";

export const DEBUG = process.env.CC_BRIDGE_DEBUG === "1";
export const DEBUG_LOG_PATH = process.env.CC_BRIDGE_DEBUG_PATH || join(homedir(), ".pi", "agent", "cc.log");
const DIAG_LOG_PATH = join(homedir(), ".pi", "agent", "cc-diag.log");

// CC_BRIDGE_RECORD_STREAM=<path> appends every SDK message consumeQuery sees,
// one JSON object per line. Used by tests/lib/record-sdk-streams.mjs to capture
// replay fixtures, so unit tests assert against message shapes Claude Code really
// emitted rather than ones we imagined.
export const RECORD_STREAM_PATH = process.env.CC_BRIDGE_RECORD_STREAM;

// Ensure log directories exist when debug is enabled
if (DEBUG) {
  try {
    mkdirSync(dirname(DEBUG_LOG_PATH), { recursive: true });
    mkdirSync(dirname(DIAG_LOG_PATH), { recursive: true });
  } catch {
    // If directory creation fails, debug functions will throw on first use
  }
}

// Unique per module evaluation — confirms whether subagents share module state
export const moduleInstanceId = Math.random().toString(36).slice(2, 8);

export function debug(...args: unknown[]) {
  if (!DEBUG) return;
  const ts = new Date().toISOString();
  const fmt = (a: unknown): string => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}${a.stack ? `\n${a.stack}` : ""}`;
    return JSON.stringify(a);
  };
  const msg = args.map(fmt).join(" ");
  appendFileSync(DEBUG_LOG_PATH, `[${ts}] [${moduleInstanceId}] ${msg}\n`);
}

// Per-query CLI debug capture. When CC_BRIDGE_DEBUG=1, ask the Claude Code
// CLI subprocess to write its own debug log to a file we choose, and also
// forward its stderr into our debug stream. Drops straight into the real SDK's
// Options — see @anthropic-ai/claude-agent-sdk sdk.d.ts:1245 (debug, debugFile,
// stderr). Without this, CC's internal view of the world is invisible to us
// and "No conversation found" / empty-error reports are unactionable.
let nextCliDebugSeq = 1;
export function makeCliDebugOptions(tag: string): {
  debug?: boolean;
  debugFile?: string;
  stderr?: (data: string) => void;
} {
  if (!DEBUG) return {};
  const seq = nextCliDebugSeq++;
  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const logDir = join(dirname(DEBUG_LOG_PATH), "cc-cli-logs");
  try {
    mkdirSync(logDir, { recursive: true });
  } catch {
    /* ignore */
  }
  const debugFile = join(logDir, `${ts}-${tag}-${seq}.log`);
  debug(`cli-debug: ${tag} #${seq} → ${debugFile}`);
  return {
    debug: true,
    debugFile,
    stderr: (data: string) => {
      for (const line of data.split(/\r?\n/)) {
        if (line) debug(`[cli-stderr ${tag}#${seq}] ${line}`);
      }
    },
  };
}

/** Unconditional diagnostic dump — for "should never happen" paths */
export function diagDump(label: string, data: Record<string, unknown>) {
  const ts = new Date().toISOString();
  const entry = { ts, moduleInstanceId, label, ...data };
  appendFileSync(DIAG_LOG_PATH, `${JSON.stringify(entry)}\n`);
  debug(`DIAG: ${label} (see ${DIAG_LOG_PATH})`);
}

export function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch (e) {
    return `<failed: ${(e as Error).message}>`;
  }
}

// Diagnostic snapshot of where a session file was just written. Catches the
// class of bugs where pi writes to ~/.claude/projects/<X> but CC SDK reads
// from ~/.claude/projects/<Y> (symlinks, CLAUDE_CONFIG_DIR, hash mismatch).
export function debugSessionPaths(label: string, cwd: string, jsonlPath: string): void {
  const realCwd = safeRealpath(cwd);
  let fileSize: number | null = null;
  let fileExists = false;
  try {
    const st = statSync(jsonlPath);
    fileExists = true;
    fileSize = st.size;
  } catch {
    /* file may not exist yet */
  }
  debug(`${label}: cwd=${cwd}`);
  if (realCwd !== cwd)
    debug(`${label}: realpath(cwd)=${realCwd} (DIFFERS — symlink-resolved path is what CC SDK uses)`);
  debug(`${label}: jsonlPath=${jsonlPath}`);
  debug(`${label}: fileExists=${fileExists}${fileSize != null ? ` size=${fileSize}` : ""}`);
  debug(
    `${label}: env.CLAUDE_CONFIG_DIR=${process.env.CLAUDE_CONFIG_DIR ?? "(unset)"} HOME=${process.env.HOME ?? "(unset)"}`,
  );
}

/** Message text for anything thrown, including the non-Error shapes the SDK
 *  and MCP layers surface. */
export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (err && typeof err === "object") {
    const obj = err as Record<string, unknown>;
    if (typeof obj.message === "string") return obj.message;
    if (typeof obj.error === "string") return obj.error;
    try {
      return JSON.stringify(err);
    } catch {}
  }
  return String(err);
}
