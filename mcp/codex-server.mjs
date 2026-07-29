#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";
import { resolveMusterCli, startMusterMcpServer } from "./server.mjs";

const protocol = [
  "Running Muster in Codex: use the bundled $muster-* skills for orchestration and these MCP tools for deterministic routing, gates, scoring, and wave computation.",
  "Core loop: muster_detect and muster_capabilities; assess and route; validate the manifest; compute waves; gate each wave with muster_fuse or muster_tally; use muster_advise for bounded escalation; state routing evidence.",
  "Plan stops for approval. Go branches first, commits green waves, and presents the merge decision. Batch modes use muster_sprint_protocol. Audit covers all six review dimensions. Diagnose reproduces before fixing.",
  "Legacy aliases still work: run -> plan, autopilot -> go, sprint -> go-backlog.",
  "CLI-only operations: use the CLI for muster_match_skills --stack and codex-conformance.",
].join("\n");
let sprintProtocol;
for (const relative of ["./sprint-protocol.md", "../cowork/sprint-protocol.md"]) {
  try { sprintProtocol = readFileSync(new URL(relative, import.meta.url), "utf8").trim(); break; } catch { /* try source layout */ }
}

startMusterMcpServer({
  protocol: protocol,
  runtimeIdentity: "codex",
  cliPath: resolveMusterCli(),
  environment: process.env,
  cwd: process.cwd(),
  io: process,
  maxInflight: 4,
  maxQueue: 16,
  staticTools: { muster_sprint_protocol: sprintProtocol || { error: "muster_sprint_protocol: bundled playbook unavailable" } },
  mapArgv: (name, argv) => name === "muster_capabilities"
    ? ["capabilities", "--codex"]
    : name === "muster_capabilities_roles"
      ? ["capabilities", "--codex", "--roles-only"]
      : name === "muster_assess" ? ["assess", "--codex"] : argv,
  authorizeTools: (catalog) => {
    catalog.muster_capabilities.description = "Resolve every Muster role against enabled Codex plugins, skills, MCP servers, and custom-agent profiles.";
    catalog.muster_capabilities_roles.description = "Resolve every Muster role against Codex and return only the compact {roles} map.";
    return { tools: catalog };
  },
});
