// User-facing extension config. Loaded once at extension registration from
// the global agent dir (getAgentDir(), e.g. ~/.pi/agent/claude-bridge.json)
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
// - ENABLE_CLAUDEAI_MCP_SERVERS=0: keep the user's claude.ai-connected MCP servers
//   out of a pi session, which serves its own tools. Cloud MCP is a separate code
//   path from filesystem MCP and is NOT blocked by --strict-mcp-config or
//   settingSources; the native CC binary gates it on this env var alone.
// - DISABLE_AUTO_COMPACT=1: pi owns compaction; CC compacting its own copy would
//   diverge from pi's history, which is the source of truth for every rebuild,
//   double-flush the prompt cache, and race CC's anti-thrashing guard (issue #8).
//   Manual /compact inside CC still works (we never invoke it).
export const CC_CHILD_ENV = {
	ENABLE_CLAUDEAI_MCP_SERVERS: "0",
	DISABLE_AUTO_COMPACT: "1",
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
		/** Enable Claude Code's hosted WebSearch and WebFetch tools in provider sessions.
		 *  Server-side (Anthropic runs the search); bills against your subscription quota. */
		webTools?: boolean;
	};
}

export function tryParseJson(path: string): Partial<Config> {
	if (!existsSync(path)) return {};
	try {
		return JSON.parse(readFileSync(path, "utf-8"));
	} catch (e) {
		console.error(`claude-bridge: failed to parse ${path}: ${e}`);
		return {};
	}
}

export function claudeCodeSettings(provider: Config["provider"] = {}): { autoMemoryEnabled: boolean } {
	return { autoMemoryEnabled: provider.autoMemoryEnabled ?? false };
}

// The one place the hosted-web-tools policy lives. Claude Code's WebSearch/WebFetch
// are the deliberate exception to "every tool flows through pi's TUI": pi ships no
// native web search, and Anthropic's hosted pair is deep-research-optimized, so the
// bridge is the sole web-capable provider in the harness. They run server-side and
// bill against the subscription quota, hence opt-in. Off returns an empty list so
// the provider query starts CC with no built-in tools at all.
export function hostedTools(provider: Config["provider"] = {}): string[] {
	return provider.webTools ? ["WebFetch", "WebSearch"] : [];
}

export function globalConfigPath(): string {
	return join(getAgentDir(), "claude-bridge.json");
}

export function loadConfig(cwd: string): Config {
	const global = tryParseJson(globalConfigPath());
	const project = tryParseJson(join(cwd, CONFIG_DIR_NAME, "claude-bridge.json"));
	return { provider: { ...global.provider, ...project.provider } };
}
