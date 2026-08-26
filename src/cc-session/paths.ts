/**
 * CC session path resolution — maps project paths to ~/.claude/projects/ layout.
 *
 * Vendored from cc-session-io@0.4.0 (MIT). CC stores sessions under
 * `~/.claude/projects/<sanitized-realpath>/<sessionId>.jsonl`. Path
 * normalization (realpath + NFC) must match CC's bootstrap or writes land
 * in a different directory than CC reads from.
 */

import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Maximum length for path component before hash suffix is added. */
export const MAX_SANITIZED_LENGTH = 200;

export function getClaudeDir(claudeDir?: string): string {
  return claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? join(homedir(), ".claude");
}

/**
 * Normalize a project path the same way Claude Code does at startup:
 * resolve symlinks via `realpathSync`, then NFC-normalize. This is critical
 * because CC stores sessions under `~/.claude/projects/<sanitized-realpath>/`,
 * so any caller that passes an unresolved path (e.g. `process.cwd()` from a
 * shell that entered via a symlink) writes to a different directory than CC
 * reads from. On macOS this hits often: `/tmp` → `/private/tmp`, `/var` →
 * `/private/var`, plus user-level symlinked project dirs.
 *
 * Falls back to NFC-normalizing the raw path if `realpathSync` throws (e.g.
 * the path doesn't exist yet, or EPERM on CloudStorage mounts) — matches CC's
 * own try/catch behavior in src/bootstrap/state.ts.
 */
export function normalizeProjectPath(projectPath: string): string {
  try {
    return realpathSync(projectPath).normalize("NFC");
  } catch {
    return projectPath.normalize("NFC");
  }
}

/**
 * Convert an absolute project path to the hash CC uses for directory names.
 * Matches the CLI's sanitization: replace all non-alphanumeric chars with dashes,
 * and truncate long paths with a hash suffix.
 */
export function projectPathToHash(projectPath: string): string {
  const sanitized = projectPath.replace(/[^a-zA-Z0-9]/g, "-");
  if (sanitized.length <= MAX_SANITIZED_LENGTH) return sanitized;
  // djb2 hash algorithm (matches Claude Code's Node.js implementation)
  let h = 0;
  for (let i = 0; i < projectPath.length; i++) h = ((h << 5) - h + projectPath.charCodeAt(i)) | 0;
  return `${sanitized.slice(0, MAX_SANITIZED_LENGTH)}-${Math.abs(h).toString(36)}`;
}

/** Get the project-specific directory under ~/.claude/projects/ */
export function getProjectDir(projectPath: string, claudeDir?: string): string {
  return join(getClaudeDir(claudeDir), "projects", projectPathToHash(normalizeProjectPath(projectPath)));
}

/** Get the JSONL file path for a session. */
export function getSessionPath(sessionId: string, projectPath: string, claudeDir?: string): string {
  return join(getProjectDir(projectPath, claudeDir), `${sessionId}.jsonl`);
}
