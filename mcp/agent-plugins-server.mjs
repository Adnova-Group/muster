#!/usr/bin/env node
import { readFileSync } from "node:fs";
import process from "node:process";
import { resolveMusterCli, startMusterMcpServer } from "./server.mjs";

const protocol = [
  "Running Muster in an Agent Plugins client: use the portable skills for workflows and these MCP tools for deterministic routing, validation, scoring, and wave computation.",
  "Detect the project, assess and route the outcome, validate the crew manifest, execute dependency-ordered waves, and apply the review or tournament gate at every barrier.",
  "Keep routing decisions and verification receipts visible. Write-capable work requires an isolated git worktree.",
].join("\n");

let sprintProtocol;
try {
  sprintProtocol = readFileSync(new URL("../cowork/sprint-protocol.md", import.meta.url), "utf8").trim();
} catch (error) {
  sprintProtocol = {
    error: `muster_sprint_protocol: missing or unreadable sprint-protocol.md (${error.code || error.message})`,
  };
}

startMusterMcpServer({
  protocol,
  runtimeIdentity: "agent-plugins",
  cliPath: resolveMusterCli(),
  environment: process.env,
  cwd: process.cwd(),
  io: process,
  maxInflight: 4,
  maxQueue: 16,
  staticTools: { muster_sprint_protocol: sprintProtocol },
  mapArgv: (name, argv) => name === "muster_capabilities"
    ? ["capabilities", "--agent-plugins"]
    : name === "muster_capabilities_roles"
      ? ["capabilities", "--agent-plugins", "--roles-only"]
      : argv,
  authorizeTools: catalog => ({ tools: catalog }),
});
