import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { claudeCodeSettings, hostedTools, loadConfig } from "../src/config.js";

function withTempHome(fn) {
  const oldHome = process.env.HOME;
  const home = mkdtempSync(join(tmpdir(), "cc-home-"));
  try {
    process.env.HOME = home;
    return fn(home);
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true });
  }
}

describe("hostedTools", () => {
  // The web-tools policy is the one deliberate exception to "every tool flows
  // through pi's TUI". On by default so the harness has web reach; the pair
  // becomes the query's `tools` list verbatim (see index.ts).
  it("serves the hosted WebFetch/WebSearch pair by default", () => {
    assert.deepEqual(hostedTools(), ["WebFetch", "WebSearch"]);
    assert.deepEqual(hostedTools({}), ["WebFetch", "WebSearch"]);
    assert.deepEqual(hostedTools({ webTools: true }), ["WebFetch", "WebSearch"]);
  });

  it("serves no hosted tools when explicitly disabled", () => {
    assert.deepEqual(hostedTools({ webTools: false }), []);
  });
});

describe("claudeCodeSettings", () => {
  const base = {
    autoMemoryEnabled: false,
    includeCoAuthoredBy: false,
    includeGitInstructions: false,
    promptSuggestionEnabled: false,
    feedbackSurveyRate: 0,
    spinnerTipsEnabled: false,
  };

  it("disables auto-memory and all ancillary features by default", () => {
    assert.deepEqual(claudeCodeSettings(), base);
  });

  it("allows auto-memory to be enabled", () => {
    assert.deepEqual(claudeCodeSettings({ autoMemoryEnabled: true }), { ...base, autoMemoryEnabled: true });
  });
});

describe("loadConfig", () => {
  it("loads project config from Pi's configured project directory", () =>
    withTempHome(() => {
      const cwd = mkdtempSync(join(tmpdir(), "cc-project-"));
      try {
        const configDir = join(cwd, CONFIG_DIR_NAME);
        mkdirSync(configDir, { recursive: true });
        writeFileSync(
          join(configDir, "cc.json"),
          JSON.stringify({
            provider: { plan: "max" },
          }),
        );

        assert.deepEqual(loadConfig(cwd), {
          provider: { plan: "max" },
        });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));

  it("merges project config over global config", () =>
    withTempHome((_home) => {
      const cwd = mkdtempSync(join(tmpdir(), "cc-project-"));
      try {
        const globalDir = getAgentDir();
        const projectDir = join(cwd, CONFIG_DIR_NAME);
        mkdirSync(globalDir, { recursive: true });
        mkdirSync(projectDir, { recursive: true });
        writeFileSync(
          join(globalDir, "cc.json"),
          JSON.stringify({
            provider: { plan: "pro", strictMcpConfig: true },
          }),
        );
        writeFileSync(
          join(projectDir, "cc.json"),
          JSON.stringify({
            provider: { plan: "max", autoMemoryEnabled: true },
          }),
        );

        assert.deepEqual(loadConfig(cwd), {
          provider: { plan: "max", strictMcpConfig: true, autoMemoryEnabled: true },
        });
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    }));

  it("resolves global config via PI_CODING_AGENT_DIR override, not hardcoded ~/.pi/agent", () =>
    withTempHome(() => {
      const agentDir = mkdtempSync(join(tmpdir(), "cc-agent-"));
      const cwd = mkdtempSync(join(tmpdir(), "cc-project-"));
      const oldEnv = process.env.PI_CODING_AGENT_DIR;
      try {
        process.env.PI_CODING_AGENT_DIR = agentDir;
        writeFileSync(
          join(agentDir, "cc.json"),
          JSON.stringify({
            provider: { plan: "max" },
          }),
        );

        assert.deepEqual(loadConfig(cwd), {
          provider: { plan: "max" },
        });
      } finally {
        if (oldEnv === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = oldEnv;
        rmSync(agentDir, { recursive: true, force: true });
        rmSync(cwd, { recursive: true, force: true });
      }
    }));
});
