#!/usr/bin/env node
// Compatibility entrypoint for existing Cowork manifests.
process.env.MUSTER_MCP_HOST = "cowork";
await import("../mcp/server.mjs");
