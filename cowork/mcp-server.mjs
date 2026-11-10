#!/usr/bin/env node
import process from "node:process";
import { readFileSync } from "node:fs";
import { resolveMusterCli, startMusterMcpServer } from "../mcp/server.mjs";

const protocol = [
  "muster's deterministic backend for Claude Desktop. First check whether this session has muster's plugin skills: /muster:plan, /muster:go, /muster:audit, /muster:diagnose (type / to list them). If it does, use them; the plugin is the primary route and these tools are its deterministic backend, so call a tool only when a skill asks for it. If it does not (a plugin-less install), follow the fallback protocol below.",
  "",
  "Fallback protocol, core loop (every mode):",
  "1. muster_detect + muster_capabilities: learn the project and which provider resolves each role. Its dispatch block says whether muster's plugin rides in (dispatch.pluginLoad) and what Cowork dispatch is proven.",
  "2. muster_assess a thin outcome; muster_route / muster_domain to pick the pipeline.",
  "3. Assemble a crew manifest, muster_manifest_validate it, fix until ok.",
  "4. muster_wave gives dependency-ordered waves. Cowork documents sub-agent coordination with parallel workstreams, so dependency-free members within a wave may dispatch as parallel subagents. muster_next stays the sequential default driver when no subagent tool is available. Cross-wave order is fixed; intra-wave order is free.",
  "4a. A per-call model override is documented nowhere for Cowork. Treat each role's claudeModel as advisory, and rely on it only after a phase-3 probe receipt from this active Cowork build proves the override.",
  "5. The wave barrier is the gate. For a tournament, call muster_fuse; for review, call muster_tally. Re-run the stated test signals before a wave counts as done.",
  "5a. Advisor escalate-up: call muster_advise for bounded hard-decision consultation.",
  "6. Glass-box: state each routing decision and its evidence as you go.",
  "",
  "By intent (the muster verbs, driven in prose when the slash commands are absent):",
  "- plan (approve-first): do the core loop through the manifest and plan, then STOP and ask for approval with AskUserQuestion (Approve & run / Adjust the plan / Cancel).",
  "- go (hands-off): create a branch FIRST, run wave by wave, commit after each green wave, then present the merge decision.",
  "- plan-backlog / go-backlog (batch): call muster_sprint_protocol for the batch playbook.",
  "- audit: cover architecture, tech-debt, coverage, simplification, readability, and security.",
  "- diagnose: reproduce, root-cause, fix, regression-test, and verify.",
  "- design: use muster_design to resolve canonical DESIGN.md context, hold attended initialization, gate human-facing writes, and run one of the 23 pinned workflows. Non-design outcomes skip this tool entirely.",
  "",
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
