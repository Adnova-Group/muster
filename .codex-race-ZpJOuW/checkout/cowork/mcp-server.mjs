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
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { PRINCIPLES, VERBS, ROUTING_POLICY } from "../plugin/hooks/guidance.js";

const execFileP = promisify(execFile);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.join(HERE, "..", "src", "cli.js");
const PROTOCOL_VERSION = "2025-06-18"; // MCP spec version date-string (matches the MCP specification header)
// Single-source the version from package.json so serverInfo never drifts from the release.
const VERSION = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
const SERVER_INFO = { name: "muster", version: VERSION };
// Sprint's Cowork-adapted playbook — static content served verbatim (muster_sprint_protocol
// below), same trick as VERSION above: read once at module load, relative to this script so it
// survives being invoked from any cwd.
//
// Read failure (file missing/unreadable) must NOT crash the whole server at module load — every
// other tool would go down with it. Catch it here, keep SPRINT_PROTOCOL null, and record a named
// fallback error text; muster_sprint_protocol's tool handler (below) turns that into an isError
// response naming the missing file, instead of the process dying before it can even start.
const SPRINT_PROTOCOL_PATH = path.join(HERE, "sprint-protocol.md");
let SPRINT_PROTOCOL = null;
let SPRINT_PROTOCOL_ERROR = null;
try {
  SPRINT_PROTOCOL = readFileSync(SPRINT_PROTOCOL_PATH, "utf8").trim();
} catch (e) {
  SPRINT_PROTOCOL_ERROR = `muster_sprint_protocol: missing or unreadable file ${SPRINT_PROTOCOL_PATH} (${e.code || e.message})`;
}

// Cowork has no muster orchestrator skill / slash commands — only these MCP tools plus your own
// subagent dispatch (confirmed to support parallel fan-out and per-call model override). So the
// server teaches the glass-box loop and the per-mode lifecycle itself.
const COWORK_PROTOCOL = [
  "Running muster here: you have these MCP tools plus your own subagent dispatch (parallel fan-out and per-call model override both work). No skills or slash commands, so follow this protocol directly.",
  "",
  "Core loop (every mode):",
  "1. muster_detect + muster_capabilities: learn the project and which provider+model resolves each role. Dispatch each role on the model muster_capabilities assigns it.",
  "2. muster_assess a thin outcome; muster_route / muster_domain to pick the pipeline.",
  "3. Assemble a crew manifest, muster_manifest_validate it, fix until ok.",
  "4. muster_wave gives dependency-ordered waves. Dispatch each wave's members as PARALLEL subagents (fall back to muster_next, one task at a time, only if fan-out is unavailable). Cross-wave order is fixed; intra-wave order is free.",
  "5. The wave barrier is the gate. For a tournament -- a judge scores all candidates AND maps consensus/contradiction/partial-coverage/blind-spots into a debate map; call muster_fuse to decide fuse-vs-fallback (the agreement gate skips synthesis when candidates already agree; on mode fuse, a synthesizer grafts the top-K best; muster_pick is the fallback ranker when the gate declines fusion). For review -- dispatch adversarial reviewers and muster_tally their verdicts. Re-run the stated test signals before a wave counts as done. A failed gate re-scopes that wave, it does not stop the run.",
  "5a. Advisor escalate-up: a worker facing a hard decision returns a structured advice-request instead of guessing; call muster_advise to validate the request and resolve the advisor model (fable->opus); dispatch the advisor on it and feed the advice back so the worker keeps the decision (advises, does not command). The consult budget is bounded -- log each consult and stop escalating once the limit is reached.",
  "6. Glass-box: state each routing decision and its evidence as you go.",
  "",
  "By intent (the muster verbs, driven in prose since there are no slash commands):",
  "- plan (approve-first): do the core loop through the manifest and plan, then STOP for approval. Plan and show; do not execute.",
  "- go (hands-off): create a branch FIRST, run the core loop wave by wave, commit after each green wave, then STOP and present the merge decision. Only halt early for an escalation.",
  "- plan-backlog / go-backlog (batch): the backlog form of plan/go -- route every item up front (plan-backlog) or clear the whole backlog sequentially, one attended stop at the end (go-backlog); call muster_sprint_protocol for this session's Cowork-adapted batch playbook.",
  "- audit: fan out the six read-only review dimensions (architecture, tech-debt, coverage, simplification, readability, security) as parallel subagents, consolidate one ranked ledger, then fix with TDD and verify through the gate before presenting the merge.",
  "- diagnose (one bug): reproduce first, find the root cause, fix, add a regression test, verify. No symptom-patching.",
  "",
  "Legacy aliases still work: run -> plan, autopilot -> go, sprint -> go-backlog.",
].join("\n");

const INSTRUCTIONS = [PRINCIPLES, VERBS, ROUTING_POLICY, COWORK_PROTOCOL].join("\n\n");

// ── Tool catalog ──────────────────────────────────────────────────────────────
// Three factory shapes — every TOOLS entry is built from one of these:
//
//   S(desc, prop, required?)  — "str": receives a single string arg, passed directly as a CLI arg.
//   J2(desc, props, required) — "json2": one OR more payloads; each is written to its own temp file
//                               (JSON.stringify'd) and the paths are spread onto the CLI argv in order.
//                               `picks` (plural, returns an ARRAY) not `pick` (singular).
//   T(desc, prop, required?)  — "text": a single string payload written VERBATIM (no JSON.stringify)
//                               to one temp file, whose path is passed as the CLI arg — for verbs
//                               whose CLI takes a file path but whose content is plain text, not JSON.
const S = (description, prop, required = true) => ({
  kind: "str", description,
  inputSchema: { type: "object", properties: { [prop]: { type: "string" } }, required: required ? [prop] : [] },
  prop,
});
// J2: `picks` returns an ARRAY of payloads (use `picks`, not `pick`) — each element becomes one temp file.
const J2 = (description, props, required) => ({
  kind: "json2", description,
  inputSchema: { type: "object", properties: props, required },
});
const T = (description, prop, required = true) => ({
  kind: "text", description,
  inputSchema: { type: "object", properties: { [prop]: { type: "string" } }, required: required ? [prop] : [] },
  prop,
});

const TOOLS = {
  // analysis verbs — string or no arg
  muster_detect: { argv: ["detect"], ...S("Detect the project profile (languages, frameworks, VCS, test runner) for a directory. Always pass `dir` explicitly — omitting it analyzes the server's working directory, not the caller's project.", "dir", false) },
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
  muster_manifest_validate: { argv: ["manifest", "validate"], ...J2("Validate a crew manifest's shape and dependency graph.", { manifest: { type: "object" } }, ["manifest"]), picks: (a) => [a.manifest] },
  muster_wave: { argv: ["wave"], ...J2("Compute dependency-ordered execution waves from a manifest's plan.", { manifest: { type: "object" } }, ["manifest"]), picks: (a) => [a.manifest] },
  muster_sprint_waves: { argv: ["sprint-waves"], ...T("Computes dependency-ordered execution waves from a backlog file's {id}/{deps} annotations (returns waves JSON; annotated:false means the backlog is unannotated/sequential).", "backlog") },
  muster_sprint_protocol: {
    kind: "static", text: SPRINT_PROTOCOL, error: SPRINT_PROTOCOL_ERROR,
    description: "Returns the Cowork-adapted sprint orchestration playbook (cowork/sprint-protocol.md): backlog resolution, sprint-waves, sequential wave execution (the degradation path IS the path here — no isolated parallel item-runners), claim/receipt discipline, honest disposition defaults, and what Cowork lacks vs the Claude Code plugin.",
    inputSchema: { type: "object", properties: {} },
  },
  muster_next: { argv: ["next"], ...J2("Single-agent driver: given a manifest and the ids completed so far, return the next runnable task plus the full ready frontier. Run `next`, append its id to `completed`, call again until done.", { manifest: { type: "object" }, completed: { type: "array", items: { type: "string" } } }, ["manifest"]), picks: (a) => [a.manifest], flags: (a) => a.completed?.length ? ["--done", a.completed.join(",")] : [] },
  muster_score: { argv: ["score"], ...J2("Score an artifact's dimensions against a gate.", { scores: { type: "object" }, gate: { type: "object" } }, ["scores", "gate"]), picks: (a) => [{ scores: a.scores, gate: a.gate }] },
  muster_prioritize: { argv: ["prioritize"], ...J2("Rank backlog items by RICE/ICE/WSJF/weighted.", { items: { type: "array" }, model: { type: "string", enum: ["rice", "ice", "wsjf", "weighted"] } }, ["items"]), picks: (a) => [{ items: a.items, model: a.model || "rice" }], flags: (a) => a.model ? ["--model", a.model] : [] },
  muster_pick: { argv: ["pick"], ...J2("Pick the tournament winner from scored candidates.", { candidates: { type: "array" } }, ["candidates"]), picks: (a) => [a.candidates] },
  muster_tally: { argv: ["tally"], ...J2("Tally adversarial review verdicts into a gate decision.", { verdicts: { type: "array" } }, ["verdicts"]), picks: (a) => [a.verdicts] },
  muster_advise: { argv: ["advise"], ...J2("Validate an advice-request and resolve the advisor model (fable->opus). Deterministic, no LLM.", { request: { type: "object" } }, ["request"]), picks: (a) => [a.request] },
  muster_fuse: { argv: ["fuse"], ...J2("Fusion decision engine: validate the debate map, apply the agreement gate, select top-K for synthesis (mode fuse) or fall back to the single best (mode fallback). Deterministic, no LLM.", { candidates: { type: "array" }, fusionMap: { type: "object" } }, ["candidates", "fusionMap"]), picks: (a) => [a.candidates, a.fusionMap] },
};

// ── CLI invocation ──────────────────────────────────────────────────────────
async function runCli(argv) {
  try {
    // timeout: 60 s — generous for slow fuse/wave on large manifests; maxBuffer: 16 MB — large audit JSON
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
  // static: no CLI call at all — return pre-loaded file content verbatim (muster_sprint_protocol).
  // A load-time read failure (tool.error set) surfaces as isError instead of serving `null` text.
  if (tool.kind === "static") return tool.error ? { ok: false, text: tool.error } : { ok: true, text: tool.text };

  // text: write the single string payload verbatim (no JSON.stringify) to one temp file,
  // then invoke the CLI with that file's path — mirrors json2's temp-file handoff for
  // verbs whose CLI arg is a file path but whose content is plain text (e.g. a backlog).
  if (tool.kind === "text") {
    const dir = await mkdtemp(path.join(tmpdir(), "muster-mcp-"));
    try {
      const f = path.join(dir, "input.txt");
      await writeFile(f, args[tool.prop] ?? "");
      return await runCli([...tool.argv, f]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // json2: serialize each payload to its own temp file; pass all paths in order onto the CLI argv.
  // Single-payload tools use picks:(a)=>[payload] — one file, same effect.
  if (tool.kind === "json2") {
    const payloads = tool.picks(args);
    const dir = await mkdtemp(path.join(tmpdir(), "muster-mcp-"));
    try {
      const files = await Promise.all(
        payloads.map(async (p, i) => {
          const f = path.join(dir, `input-${i}.json`);
          await writeFile(f, JSON.stringify(p));
          return f;
        })
      );
      return await runCli([...tool.argv, ...files, ...(tool.flags ? tool.flags(args) : [])]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
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

// A-SEC6: cap the stdin accumulator to prevent heap exhaustion when a client
// sends data without a newline terminator (no-newline DoS). 4 MB is well above
// any legitimate JSON-RPC request muster sends. On overflow: emit a one-line
// diagnostic to stderr and exit cleanly (non-zero, not an uncaught exception).
const STDIN_MAX_BYTES = 4 * 1024 * 1024;

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > STDIN_MAX_BYTES) {
    process.stderr.write("mcp-server: stdin buffer exceeded 4 MB cap; shutting down\n");
    process.exit(1);
  }
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
