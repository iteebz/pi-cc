// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/cc.json)
// and the project Pi config directory, project overriding global. Missing or
// unparseable files are ignored (error to console.error, empty object
// returned) so the extension always starts.

import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { existsSync, readFileSync } from "fs";
import { join } from "path";

// Applied to every Claude Code subprocess the bridge spawns — the provider
// and the compact summary. One place, so a guard is added once rather than
// twice, and so a missing one is visible.
//
// These are silent when missing: CC compacts or writes memory on its own,
// nothing throws, and the damage shows up in the user's ~/.claude rather than
// in a test.
//
// Session isolation:
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools. Cloud MCP is a separate code
//   path from filesystem MCP and is NOT blocked by --strict-mcp-config or
//   settingSources; the native CC binary gates it on this env var alone.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild,
//   double-flush the prompt cache, and race CC's anti-thrashing guard (issue #8).
//   Manual /compact inside CC still works (we never invoke it).
//
// Telemetry suppression — minimize outbound traffic from the CC subprocess:
// - DISABLE_TELEMETRY=1: no usage telemetry
// - DISABLE_ERROR_REPORTING=1: no crash/error reporting (sentry etc.)
// - DISABLE_AUTOUPDATER=1: no update checks; pi manages its own deps
// - DISABLE_INSTALLATION_CHECKS=1: no post-install phone-home
// - DISABLE_UPGRADE_COMMAND=1: suppress the /upgrade slash command
// - CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1: catch-all for ancillary requests
// - CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY=1: no survey prompts

export const CC_CHILD_ENV = {
  ENABLE_CLAUDEAI_MCP_SERVERS: "0",
  DISABLE_AUTO_COMPACT: "1",
  DISABLE_TELEMETRY: "1",
  DISABLE_ERROR_REPORTING: "1",
  DISABLE_AUTOUPDATER: "1",
  DISABLE_INSTALLATION_CHECKS: "1",
  DISABLE_UPGRADE_COMMAND: "1",
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
  CLAUDE_CODE_DISABLE_FEEDBACK_SURVEY: "1",
} as const;

// Pi owns context files on the provider path, so Claude Code must not load its
// own on top: otherwise a project CLAUDE.md arrives twice, and the user's
// ~/.claude/CLAUDE.md — a persona written for a harness that is not the one
// running — arrives at all, stamped "These instructions OVERRIDE any default
// behavior" and outranking Pi's own AGENTS.md.
//
// Excludes rather than settingSources: the source gate that suppresses CLAUDE.md
// is the same one that reads settings.json, where Bedrock/Vertex users keep
// `env` and `apiKeyHelper`. Patterns are matched with picomatch against absolute
// paths; "**/CLAUDE.md" covers the user, ancestor, project and .claude/ copies,
// while rules need their own. Managed/policy memory is not excludable by design.
export const CLAUDE_MD_EXCLUDES = ["**/CLAUDE.md", "**/.claude/rules/**"];

export interface Config {
  /** Low-level Claude Agent SDK plumbing. Most users won't need these. */
  provider?: {
    strictMcpConfig?: boolean;
    autoMemoryEnabled?: boolean;
    pathToClaudeCodeExecutable?: string;
    /** Claude Code's hosted WebSearch and WebFetch tools in provider sessions.
     *  On by default; false disables both; an explicit list enables exactly
     *  those. Server-side (Anthropic runs the search); bills against your
     *  subscription quota. */
    webTools?: boolean | string[];
  };
}

function tryParseJson(path: string): Partial<Config> {
  if (!existsSync(path)) return {};
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch (e) {
    console.error(`cc: failed to parse ${path}: ${e}`);
    return {};
  }
}

// Settings-layer suppression — complements the env-layer flags in CC_CHILD_ENV.
// Some behaviors are only controllable here (co-authored-by, git instructions),
// others are belt-and-suspenders with their env counterpart.
export function claudeCodeSettings(provider: Config["provider"] = {}) {
  return {
    autoMemoryEnabled: provider.autoMemoryEnabled ?? false,
    includeCoAuthoredBy: false,
    includeGitInstructions: false,
    promptSuggestionEnabled: false,
    feedbackSurveyRate: 0,
    spinnerTipsEnabled: false,
  };
}

// The one place the hosted-web-tools policy lives. Claude Code's WebSearch/WebFetch
// are the deliberate exception to "every tool flows through pi's TUI": pi ships no
// native web search, and Anthropic's hosted pair is deep-research-optimized, so the
// bridge is the sole web-capable provider in the harness. They run server-side and
// bill against the subscription quota. On by default; `webTools: false` returns an
// empty list so the provider query starts CC with no built-in tools at all.
//
// The pair is separable because the two tools have different context costs:
// WebSearch returns snippets, WebFetch returns whole pages that stay in the
// agent's prefix for the rest of the session. `webTools: ["WebSearch"]` keeps
// lookup and pushes deep research into a subagent.
export const HOSTED_WEB_TOOLS = ["WebFetch", "WebSearch"];

export function hostedTools(provider: Config["provider"] = {}): string[] {
  const setting = provider.webTools;
  if (setting === false) return [];
  if (!Array.isArray(setting)) return [...HOSTED_WEB_TOOLS];
  const unknown = setting.filter((t) => !HOSTED_WEB_TOOLS.includes(t));
  if (unknown.length) console.error(`cc: unknown webTools entries ignored: ${unknown.join(", ")}`);
  return setting.filter((t) => HOSTED_WEB_TOOLS.includes(t));
}

function globalConfigPath(): string {
  return join(getAgentDir(), "cc.json");
}

export function loadConfig(cwd: string): Config {
  const global = tryParseJson(globalConfigPath());
  const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "cc.json"));
  return { provider: { ...global.provider, ...project.provider } };
}
