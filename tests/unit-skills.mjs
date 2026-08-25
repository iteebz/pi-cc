import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderSkillsBlock } from "../src/skills.js";

function skill(name, { disabled = false } = {}) {
  return {
    name,
    description: `${name} description`,
    filePath: `/skills/${name}/SKILL.md`,
    baseDir: `/skills/${name}`,
    sourceInfo: { source: "test", scope: "temporary", origin: "top-level" },
    disableModelInvocation: disabled,
  };
}

describe("skills block rendering", () => {
  it("formats skills and names the MCP read tool for provider queries", () => {
    const result = renderSkillsBlock([skill("browser")]);
    assert.ok(result?.startsWith("The following skills"));
    assert.match(result, /Use the read tool \(mcp__custom-tools__read\)/);
    assert.match(result, /<location>\/skills\/browser\/SKILL\.md<\/location>/);
  });

  it("emits nothing without visible skills", () => {
    assert.equal(renderSkillsBlock([]), undefined);
    assert.equal(renderSkillsBlock([skill("hidden", { disabled: true })]), undefined);
  });

  it("uses Pi's XML escaping", () => {
    const escaped = skill("browser");
    escaped.description = "read <this> & that";
    assert.match(renderSkillsBlock([escaped]), /read &lt;this&gt; &amp; that/);
  });
});
