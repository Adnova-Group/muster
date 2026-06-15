#!/usr/bin/env node
// muster MCP server — exposes muster's deterministic CLI brain as MCP tools for Claude Cowork.
//
// Cowork extends only through MCP (local MCP servers + MCPB desktop extensions); it has no
// plugin/skill/slash/hook primitives. So the port is: wrap the portable CLI (src/cli.js, plain
// Node, no model calls) as a local MCP server. The CLI runs in Cowork's Linux VM; its verbs
// become tools here. muster's principles + routing policy ride in via the server `instructions`
// field — that replaces the SessionStart/UserPromptSubmit hooks.
//
// This wrapper is the deterministic HALF of muster: routing, scoring, detection, gate math. The
// orchestration half (parallel waves + tournaments) is gated on Cowork supporting subagent
// dispatch + per-call model override, which its docs do not disclose — run scripts/cowork-probe.mjs
// phase 3 inside Cowork to settle that before relying on it.
//
// SELF-CONTAINED: node: builtins only, plus guidance.js (also node:-only). stdio JSON-RPC 2.0,
// newline-delimited. No SDK dependency.

import { execFile } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PRINCIPLES, VERBS, ROUTING_POLICY } from "../plugin/hooks/guidance.js";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "src", "cli.js");
const PROTOCOL_VERSION = "2025-06-18";
const SERVER_INFO = { name: "muster", version: "0.2.7" };

// Cowork has no muster orchestrator skill / subagents / slash commands — only these MCP tools.
// So the server teaches the glass-box loop itself. Critically, it spells out the sequential
// fallback: Cowork's docs describe a single agent loop, so when the runtime cannot fan out
// parallel subagents, wave members run one at a time (cross-wave order is fixed, intra-wave is free).
const COWORK_PROTOCOL = [
  "Running muster here (no skills, agents, or slash commands — only these MCP tools):",
  "1. muster_detect + muster_capabilities: learn the project and which provider+model resolves each role. Dispatch each role on its model when you can.",
  "2. muster_assess the outcome if it is thin; muster_route / muster_domain to pick the pipeline.",
  "3. Assemble a crew manifest, then muster_manifest_validate it and fix until ok.",
  "4. muster_wave gives dependency-ordered waves. Run each wave in parallel IF this runtime can fan out subagents; otherwise run its members SEQUENTIALLY: call muster_next with the manifest and the ids completed so far, run the returned task, append its id, repeat until done. Cross-wave order is fixed; intra-wave order is free.",
  "5. Gate between waves: muster_tally the review verdicts before proceeding; muster_pick for tournaments. Re-run the stated test signals before claiming a wave done.",
  "6. Glass-box: state each routing decision and its evidence as you go.",
].join("\n");

const INSTRUCTIONS = [PRINCIPLES, VERBS, ROUTING_POLICY, COWORK_PROTOCOL].join("\n\n");

// ── Tool catalog ──────────────────────────────────────────────────────────────
// Two argument shapes: `str` verbs take a string and pass it as one CLI arg; `json` verbs take
// an object/string, get written to a temp file, and the path is passed to the file-based verb.
const S = (description, prop, required = true) => ({
  kind: "str", description,
  inputSchema: { type: "object", properties: { [prop]: { type: "string" } }, required: required ? [prop] : [] },
  prop,
});
const J = (description, props, required) => ({
  kind: "json", description,
  inputSchema: { type: "object", properties: props, required },
});

const TOOLS = {
  // analysis verbs — string or no arg
  muster_detect: { argv: ["detect"], ...S("Detect the project profile (languages, frameworks, VCS, test runner) for a directory.", "dir", false) },
  muster_capabilities: { argv: ["capabilities", "--cowork"], ...S("Resolve every muster role to its best-available provider, fallback chain, and model tier, against Cowork's MCP registry (local servers + extensions; declare remote connectors via MUSTER_COWORK_CONNECTORS).", "home", false) },
  muster_match: { argv: ["match"], ...S("Rank catalog providers against a free-text task by token overlap (no model call).", "task") },
  muster_domain: { argv: ["domain"], ...S("Classify an outcome into a work domain (software, product, content, ...).", "outcome") },
  muster_route: { argv: ["route"], ...S("Route an outcome to its domain + pipeline id.", "outcome") },
  muster_pipeline: { argv: ["pipeline"], ...S("Load a pipeline definition by domain or pipeline id.", "ref") },
  muster_assess: { argv: ["assess"], ...S("Deterministic gap-check on an outcome (too short, no success criteria, vague).", "outcome") },
  muster_steer: { argv: ["steer"], ...S("Classify a mid-run steer message (scope change, abort, refine, ...).", "message") },
  muster_diagnose: { argv: ["diagnose"], ...S("Classify a failure symptom and build a diagnose manifest.", "symptom") },
  muster_audit: { argv: ["audit"], kind: "none", description: "Build the whole-codebase audit manifest (six parallel review dimensions).", inputSchema: { type: "object", properties: {} } },

  // gate/math verbs — JSON in, written to a temp file
  muster_manifest_validate: { argv: ["manifest", "validate"], ...J("Validate a crew manifest's shape and dependency graph.", { manifest: { type: "object" } }, ["manifest"]), pick: (a) => a.manifest },
  muster_wave: { argv: ["wave"], ...J("Compute dependency-ordered execution waves from a manifest's plan.", { manifest: { type: "object" } }, ["manifest"]), pick: (a) => a.manifest },
  muster_next: { argv: ["next"], ...J("Single-agent driver: given a manifest and the ids completed so far, return the next runnable task plus the full ready frontier. Run `next`, append its id to `completed`, call again until done.", { manifest: { type: "object" }, completed: { type: "array", items: { type: "string" } } }, ["manifest"]), pick: (a) => a.manifest, flags: (a) => a.completed?.length ? ["--done", a.completed.join(",")] : [] },
  muster_score: { argv: ["score"], ...J("Score an artifact's dimensions against a gate.", { scores: { type: "object" }, gate: { type: "object" } }, ["scores", "gate"]), pick: (a) => ({ scores: a.scores, gate: a.gate }) },
  muster_prioritize: { argv: ["prioritize"], ...J("Rank backlog items by RICE/ICE/WSJF/weighted.", { items: { type: "array" }, model: { type: "string", enum: ["rice", "ice", "wsjf", "weighted"] } }, ["items"]), pick: (a) => ({ items: a.items, model: a.model || "rice" }), flags: (a) => a.model ? ["--model", a.model] : [] },
  muster_pick: { argv: ["pick"], ...J("Pick the tournament winner from scored candidates.", { candidates: { type: "array" } }, ["candidates"]), pick: (a) => a.candidates },
  muster_tally: { argv: ["tally"], ...J("Tally adversarial review verdicts into a gate decision.", { verdicts: { type: "array" } }, ["verdicts"]), pick: (a) => a.verdicts },
};

// ── CLI invocation ──────────────────────────────────────────────────────────
async function runCli(argv) {
  try {
    const { stdout } = await execFileP("node", [CLI, ...argv], { cwd: process.cwd(), timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
    return { ok: true, text: stdout.trim() };
  } catch (e) {
    const text = (e.stderr || e.stdout || e.message || "").toString().trim();
    return { ok: false, text: text || "muster CLI failed with no output" };
  }
}

async function callTool(name, args = {}) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, text: `unknown tool: ${name}` };

  if (tool.kind === "str") {
    const v = args[tool.prop];
    return runCli(v != null && v !== "" ? [...tool.argv, String(v)] : tool.argv);
  }
  if (tool.kind === "none") return runCli(tool.argv);

  // json: serialize the picked payload to a temp file, pass its path
  const payload = tool.pick(args);
  const dir = mkdtempSync(path.join(tmpdir(), "muster-mcp-"));
  const file = path.join(dir, "input.json");
  try {
    writeFileSync(file, JSON.stringify(payload));
    return await runCli([...tool.argv, file, ...(tool.flags ? tool.flags(args) : [])]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ── JSON-RPC 2.0 over stdio (newline-delimited) ───────────────────────────────
function send(msg) {
  process.stdout.write(JSON.stringify(msg) + "\n");
}
const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === undefined || id === null;

  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    case "notifications/initialized":
    case "notifications/cancelled":
      return; // no response to notifications
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema })),
      });
    case "tools/call": {
      const r = await callTool(params?.name, params?.arguments || {});
      return ok(id, { content: [{ type: "text", text: r.text }], isError: !r.ok });
    }
    default:
      if (!isNotification) err(id, -32601, `method not found: ${method}`);
  }
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg?.id != null) err(msg.id, -32603, `internal error: ${e.message}`);
    });
  }
});
process.stdin.on("end", () => process.exit(0));
