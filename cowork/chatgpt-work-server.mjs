#!/usr/bin/env node
const profile = process.env.MUSTER_CHATGPT_WORK_PROFILE;
if (!["pro-safe", "full"].includes(profile)) {
  process.stderr.write("chatgpt-work-server: MUSTER_CHATGPT_WORK_PROFILE must be pro-safe or full\n");
  process.exit(1);
}
if (profile === "full" && (
  process.env.MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS !== "1"
  || process.env.MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS !== "1"
)) {
  process.stderr.write("chatgpt-work-server: full requires installer and server allow-full-actions opt-ins\n");
  process.exit(1);
}
process.env.MUSTER_MCP_TOOL_PROFILE = `chatgpt-work-${profile}`;
await import("./mcp-server.mjs");
