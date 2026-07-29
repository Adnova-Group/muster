#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";
import { resolveMusterCli, startMusterMcpServer } from "../mcp/server.mjs";

const protocol = [
  "Running muster here: you have these MCP tools. No skills or slash commands, so follow this protocol directly. The verified default is sequential dispatch through muster_next. Use parallel fan-out or a per-call model override only after a phase-3 probe receipt from this active Cowork build proves those capabilities.",
  "",
  "Core loop (every mode):",
  "1. muster_detect + muster_capabilities: learn the project and which provider+model resolves each role. Cowork capabilities advertise only registered MCP providers or inline execution; dispatch each role on the model muster_capabilities assigns it.",
  "2. muster_assess a thin outcome; muster_route / muster_domain to pick the pipeline.",
  "3. Assemble a crew manifest, muster_manifest_validate it, fix until ok.",
  "4. muster_wave gives dependency-ordered waves. By default, drive each wave through muster_next one task at a time. If this active Cowork build has a successful phase-3 probe receipt, dependency-free members within a wave may dispatch as parallel subagents. Cross-wave order is fixed; intra-wave order is free.",
  "5. The wave barrier is the gate. For a tournament, call muster_fuse; for review, call muster_tally. Re-run the stated test signals before a wave counts as done.",
  "5a. Advisor escalate-up: call muster_advise for bounded hard-decision consultation.",
  "6. Glass-box: state each routing decision and its evidence as you go.",
  "",
  "By intent (the muster verbs, driven in prose since there are no slash commands):",
  "- plan (approve-first): do the core loop through the manifest and plan, then STOP for approval.",
  "- go (hands-off): create a branch FIRST, run wave by wave, commit after each green wave, then present the merge decision.",
  "- plan-backlog / go-backlog (batch): call muster_sprint_protocol for the batch playbook.",
  "- audit: cover architecture, tech-debt, coverage, simplification, readability, and security.",
  "- diagnose: reproduce, root-cause, fix, regression-test, and verify.",
  "",
  "Legacy aliases still work: run -> plan, autopilot -> go, sprint -> go-backlog.",
  "CLI-only operations: use the CLI for muster_match_skills --stack and codex-conformance.",
].join("\n");

const bounded = (name, fallback, ceiling) => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= ceiling ? value : fallback;
};
let sprintProtocol;
try {
  sprintProtocol = readFileSync(new URL("./sprint-protocol.md", import.meta.url), "utf8").trim();
} catch (error) {
  sprintProtocol = { error: `muster_sprint_protocol: missing or unreadable sprint-protocol.md (${error.code || error.message})` };
}

startMusterMcpServer({
  protocol: protocol,
  runtimeIdentity: "cowork",
  cliPath: resolveMusterCli(process.env.NODE_ENV === "test" ? process.env.MUSTER_COWORK_TEST_CLI : undefined),
  environment: process.env,
  cwd: process.cwd(),
  io: process,
  maxInflight: bounded("MUSTER_COWORK_MAX_INFLIGHT", 4, 64),
  maxQueue: bounded("MUSTER_COWORK_MAX_QUEUE", 16, 1024),
  staticTools: { muster_sprint_protocol: sprintProtocol },
  mapArgv: (name, argv) => name === "muster_capabilities"
    ? ["capabilities", "--cowork"]
    : name === "muster_capabilities_roles"
      ? ["capabilities", "--cowork", "--roles-only"]
      : argv,
  authorizeTools: (catalog) => ({ tools: catalog }),
});
