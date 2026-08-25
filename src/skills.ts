import { formatSkillsForPrompt, type Skill } from "@earendil-works/pi-coding-agent";
import { MCP_SERVER_NAME } from "./tool-names.js";

export function renderSkillsBlock(skills: Skill[]): string | undefined {
  const block = formatSkillsForPrompt(skills).trim();
  if (!block) return undefined;
  return rewriteSkillsBlock(block);
}

export function rewriteSkillsBlock(skillsBlock: string): string {
  return skillsBlock.replace(
    "Use the read tool to load a skill's file",
    `Use the read tool (mcp__${MCP_SERVER_NAME}__read) to load a skill's file`,
  );
}
