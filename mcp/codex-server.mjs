#!/usr/bin/env node
process.env.MUSTER_MCP_HOST = "codex";
await import("./server.mjs");
