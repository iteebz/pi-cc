// The one MCP server the bridge runs, and the prefix every pi tool wears once
// Claude Code can see it.
//
// A leaf module with no imports on purpose: mcp-server.ts serves the tools,
// convert.ts names them in a rebuilt transcript, tools.ts recognizes a call as
// ours, and skills.ts points agents at the read tool by its wire name. None of
// those should pull in the MCP SDK server implementation just to read a string.
export const MCP_SERVER_NAME = "custom-tools";
export const MCP_TOOL_PREFIX = `mcp__${MCP_SERVER_NAME}__`;
