#!/usr/bin/env node

// cowork/mcp-server.codex.mjs
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process2 from "node:process";
import { fileURLToPath } from "node:url";

// plugin/hooks/guidance.js
var PRINCIPLES = [
  "muster principles:",
  "- Think before coding; state your assumptions before you act.",
  "- TDD: write the failing test first, then make it pass.",
  "- Surgical changes: touch only what the task needs.",
  "- Glass-box reasoning: show the crew and the decisions, never hide them.",
  "- Prefer code over the model for deterministic work (routing, retries, transforms).",
  "- Fail loud: verify before claiming done."
].join("\n");
var VERBS = "Verbs: /muster:plan (approve-first; a backlog scope confirms, then plans), /muster:go (hands-off lifecycle; same scope confirm), /muster:plan-backlog (approve-first batch planner), /muster:diagnose (failure-first fix), /muster:audit (whole-codebase review-and-fix), /muster:go-backlog (batch backlog clear), /muster:runner (unattended one-cycle work-picker). Legacy aliases still work: /muster:run -> /muster:plan, /muster:autopilot -> /muster:go, /muster:sprint -> /muster:go-backlog.";
var VOICE_NUDGE = "Voice: terse and decision-first \u2014 done = verified with evidence inline; no recaps, no process narration.";
var ROUTING_POLICY = [
  "Default routing: in this muster repo, drive actionable prompts through muster --",
  "route directives and substantive questions to the verbs (/muster:plan \xB7 :go \xB7",
  ":plan-backlog \xB7 :diagnose \xB7 :audit \xB7 :go-backlog \xB7 :runner) where applicable, and",
  "content/copy work through the muster content pipeline (humanizer). Let conversational",
  "or trivial turns fall through. Honor explicit /muster commands as given.",
  "Legacy aliases still work: run -> plan, autopilot -> go, sprint -> go-backlog."
].join(" ") + " " + VOICE_NUDGE;
var SHORT_NUDGE = "muster mode -- drive directives through the muster verbs (don't default to plain inline work), route copy/content through the humanizer, keep reasoning glass-box. Conversational turns fall through. Verbs: /muster:plan \xB7 /muster:go \xB7 /muster:plan-backlog \xB7 /muster:diagnose \xB7 /muster:audit \xB7 /muster:go-backlog \xB7 /muster:runner. Legacy aliases still work: /muster:run -> plan, /muster:autopilot -> go, /muster:sprint -> go-backlog. " + VOICE_NUDGE;
var DIRECTIVE_PREFIXES = [
  "please",
  "can you",
  "could you",
  "let's",
  "lets",
  "now",
  "go",
  "ok",
  "okay"
];
var DIRECTIVE_VERBS = [
  "fix",
  "build",
  "implement",
  "add",
  "create",
  "write",
  "refactor",
  "migrate",
  "update",
  "remove",
  "rename",
  "convert",
  "make"
];
function escapeForRegex(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
var PREFIX_ALT = DIRECTIVE_PREFIXES.map(escapeForRegex).join("|");
var VERB_ALT = DIRECTIVE_VERBS.join("|");
var DIRECTIVE_RE = new RegExp(`^(?:(?:${PREFIX_ALT})\\s+)*(?:${VERB_ALT})\\b`, "i");

// cowork/mcp-server.codex.mjs
var HERE = path.dirname(fileURLToPath(import.meta.url));
var CLI = process2.env.NODE_ENV === "test" && process2.env.MUSTER_COWORK_TEST_CLI ? path.resolve(process2.env.MUSTER_COWORK_TEST_CLI) : path.join(HERE, "..", "src", "cli.js");
var PROTOCOL_VERSION = "2025-06-18";
var VERSION = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
var SERVER_INFO = { name: "muster", version: VERSION };
var SPRINT_PROTOCOL_PATH = path.join(HERE, "sprint-protocol.md");
var SPRINT_PROTOCOL = null;
var SPRINT_PROTOCOL_ERROR = null;
try {
  SPRINT_PROTOCOL = readFileSync(SPRINT_PROTOCOL_PATH, "utf8").trim();
} catch (e) {
  SPRINT_PROTOCOL_ERROR = `muster_sprint_protocol: missing or unreadable file ${SPRINT_PROTOCOL_PATH} (${e.code || e.message})`;
}
var COWORK_PROTOCOL = [
  "Running Muster in Codex: use the bundled $muster-* skills for orchestration and these MCP tools for deterministic routing, gates, scoring, and wave computation.",
  "",
  "Core loop (every mode):",
  "1. muster_detect + muster_capabilities: learn the project and which provider+model resolves each role. Cowork capabilities advertise only registered MCP providers or inline execution; dispatch each role on the model muster_capabilities assigns it.",
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
  "- audit: pass the connected project directory explicitly to muster_audit, fan out the six read-only review dimensions (architecture, tech-debt, coverage, simplification, readability, security) as parallel subagents, consolidate one ranked ledger, then fix with TDD and verify through the gate before presenting the merge.",
  "- diagnose (one bug): reproduce first, find the root cause, fix, add a regression test, verify. No symptom-patching.",
  "",
  "Legacy aliases still work: run -> plan, autopilot -> go, sprint -> go-backlog."
].join("\n");
var INSTRUCTIONS = [PRINCIPLES, VERBS, ROUTING_POLICY, COWORK_PROTOCOL].join("\n\n");
var S = (description, prop, required = true) => ({
  kind: "str",
  description,
  inputSchema: { type: "object", properties: { [prop]: { type: "string" } }, required: required ? [prop] : [] },
  prop
});
var J2 = (description, props, required) => ({
  kind: "json2",
  description,
  inputSchema: { type: "object", properties: props, required }
});
var T = (description, prop, required = true) => ({
  kind: "text",
  description,
  inputSchema: { type: "object", properties: { [prop]: { type: "string" } }, required: required ? [prop] : [] },
  prop
});
var TOOLS = {
  // analysis verbs — string or no arg
  muster_detect: { argv: ["detect"], ...S("Detect the project profile (languages, frameworks, VCS, test runner) for a directory. Always pass `dir` explicitly \u2014 omitting it analyzes the server's working directory, not the caller's project.", "dir", false) },
  muster_capabilities: { argv: ["capabilities", "--codex"], ...S("Resolve every Muster role against enabled Codex plugins, skills, MCP servers, and custom-agent profiles.", "home", false) },
  muster_match: { argv: ["match"], ...S("Rank catalog providers against a free-text task by token overlap (no model call).", "task") },
  muster_domain: { argv: ["domain"], ...S("Classify an outcome into a work domain (software, product, content, ...).", "outcome") },
  muster_route: { argv: ["route"], ...S("Route an outcome to its domain + pipeline id.", "outcome") },
  muster_pipeline: { argv: ["pipeline"], ...S("Load a pipeline definition by domain or pipeline id.", "ref") },
  muster_assess: { argv: ["assess", "--codex"], ...S("Deterministic gap-check on an outcome (too short, no success criteria, vague).", "outcome") },
  muster_steer: { argv: ["steer"], ...S("Classify a mid-run steer message (scope change, abort, refine, ...).", "message") },
  muster_diagnose: { argv: ["diagnose"], ...S("Classify a failure symptom and build a diagnose manifest.", "symptom") },
  muster_audit: {
    argv: ["audit"],
    kind: "target",
    description: "Build the whole-codebase audit manifest for an explicit connected project directory (six parallel review dimensions).",
    inputSchema: { type: "object", properties: { dir: { type: "string" } }, required: ["dir"] }
  },
  // gate/math verbs — JSON in, written to a temp file
  muster_manifest_validate: { argv: ["manifest", "validate"], ...J2("Validate a crew manifest's shape and dependency graph.", { manifest: { type: "object" } }, ["manifest"]), picks: (a) => [a.manifest] },
  muster_wave: { argv: ["wave"], ...J2("Compute dependency-ordered execution waves from a manifest's plan.", { manifest: { type: "object" } }, ["manifest"]), picks: (a) => [a.manifest] },
  muster_sprint_waves: { argv: ["sprint-waves"], ...T("Computes dependency-ordered execution waves from a backlog file's {id}/{deps} annotations (returns waves JSON; annotated:false means the backlog is unannotated/sequential).", "backlog") },
  muster_sprint_protocol: {
    kind: "static",
    text: SPRINT_PROTOCOL,
    error: SPRINT_PROTOCOL_ERROR,
    description: "Returns the Cowork-adapted sprint orchestration playbook (cowork/sprint-protocol.md): backlog resolution, sprint-waves, sequential wave execution (the degradation path IS the path here \u2014 no isolated parallel item-runners), claim/receipt discipline, honest disposition defaults, and what Cowork lacks vs the Claude Code plugin.",
    inputSchema: { type: "object", properties: {} }
  },
  muster_next: { argv: ["next"], ...J2("Single-agent driver: given a manifest and the ids completed so far, return the next runnable task plus the full ready frontier. Run `next`, append its id to `completed`, call again until done.", { manifest: { type: "object" }, completed: { type: "array", items: { type: "string" } } }, ["manifest"]), picks: (a) => [a.manifest], flags: (a) => a.completed?.length ? ["--done", a.completed.join(",")] : [] },
  muster_score: { argv: ["score"], ...J2("Score an artifact's dimensions against a gate.", { scores: { type: "object" }, gate: { type: "object" } }, ["scores", "gate"]), picks: (a) => [{ scores: a.scores, gate: a.gate }] },
  muster_prioritize: { argv: ["prioritize"], ...J2("Rank backlog items by RICE/ICE/WSJF/weighted.", { items: { type: "array" }, model: { type: "string", enum: ["rice", "ice", "wsjf", "weighted"] } }, ["items"]), picks: (a) => [{ items: a.items, model: a.model || "rice" }], flags: (a) => a.model ? ["--model", a.model] : [] },
  muster_pick: { argv: ["pick"], ...J2("Pick the tournament winner from scored candidates.", { candidates: { type: "array" } }, ["candidates"]), picks: (a) => [a.candidates] },
  muster_tally: { argv: ["tally"], ...J2("Tally adversarial review verdicts into a gate decision.", { verdicts: { type: "array" } }, ["verdicts"]), picks: (a) => [a.verdicts] },
  muster_advise: { argv: ["advise"], ...J2("Validate an advice-request and resolve the advisor model (fable->opus). Deterministic, no LLM.", { request: { type: "object" } }, ["request"]), picks: (a) => [a.request] },
  muster_fuse: { argv: ["fuse"], ...J2("Fusion decision engine: validate the debate map, apply the agreement gate, select top-K for synthesis (mode fuse) or fall back to the single best (mode fallback). Deterministic, no LLM.", { candidates: { type: "array" }, fusionMap: { type: "object" } }, ["candidates", "fusionMap"]), picks: (a) => [a.candidates, a.fusionMap] }
};
async function runCli(argv, { cwd = process2.cwd(), signal } = {}) {
  try {
    const { stdout } = await new Promise((resolve, reject) => {
      execFile("node", [CLI, ...argv], {
        cwd,
        signal,
        timeout: 6e4,
        maxBuffer: 16 * 1024 * 1024,
        env: { ...process2.env, MUSTER_RUNTIME: "cowork" }
      }, (error, childStdout, stderr) => {
        if (error) {
          error.stdout = childStdout;
          error.stderr = stderr;
          reject(error);
        } else resolve({ stdout: childStdout });
      });
    });
    return { ok: true, text: stdout.trim() };
  } catch (e) {
    if (signal?.aborted) return { ok: false, text: "muster MCP request cancelled" };
    const text = (e.stderr || e.stdout || e.message || "").toString().trim();
    return { ok: false, text: text || "muster CLI failed with no output" };
  }
}
async function callTool(name, args = {}, signal) {
  const tool = TOOLS[name];
  if (!tool) return { ok: false, text: `unknown tool: ${name}` };
  if (tool.kind === "str") {
    const v = args[tool.prop];
    return runCli(v != null && v !== "" ? [...tool.argv, String(v)] : tool.argv, { signal });
  }
  if (tool.kind === "none") return runCli(tool.argv, { signal });
  if (tool.kind === "target") {
    if (typeof args.dir !== "string" || !args.dir.trim()) {
      return { ok: false, text: "muster_audit: explicit target directory is required" };
    }
    return runCli(tool.argv, { cwd: path.resolve(args.dir), signal });
  }
  if (tool.kind === "static") return tool.error ? { ok: false, text: tool.error } : { ok: true, text: tool.text };
  if (tool.kind === "text") {
    const dir = await mkdtemp(path.join(tmpdir(), "muster-mcp-"));
    try {
      const f = path.join(dir, "input.txt");
      await writeFile(f, args[tool.prop] ?? "");
      return await runCli([...tool.argv, f], { signal });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
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
      return await runCli([...tool.argv, ...files, ...tool.flags ? tool.flags(args) : []], { signal });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}
var boundedEnvInt = (name, fallback, ceiling) => {
  const value = Number(process2.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= ceiling ? value : fallback;
};
var MAX_INFLIGHT = boundedEnvInt("MUSTER_COWORK_MAX_INFLIGHT", 4, 64);
var MAX_QUEUE = boundedEnvInt("MUSTER_COWORK_MAX_QUEUE", 16, 1024);
var cancelled = () => ({ ok: false, text: "muster MCP request cancelled" });
var WorkLimiter = class {
  constructor(maxInflight, maxQueue) {
    this.maxInflight = maxInflight;
    this.maxQueue = maxQueue;
    this.active = /* @__PURE__ */ new Map();
    this.queue = [];
    this.idleWaiters = [];
  }
  run(id, task) {
    if (this.active.has(id) || this.queue.some((item) => item.id === id)) {
      return Promise.resolve({ ok: false, text: `duplicate in-flight request id: ${id}` });
    }
    return new Promise((resolve) => {
      const item = { id, task, resolve, controller: new AbortController() };
      if (this.active.size < this.maxInflight) this.start(item);
      else if (this.queue.length < this.maxQueue) this.queue.push(item);
      else resolve({ ok: false, text: `muster MCP overloaded: queue limit ${this.maxQueue} reached` });
    });
  }
  start(item) {
    this.active.set(item.id, item);
    Promise.resolve().then(() => item.task(item.controller.signal)).then(item.resolve, (error) => item.resolve({ ok: false, text: `internal error: ${error.message}` })).finally(() => {
      this.active.delete(item.id);
      this.pump();
    });
  }
  pump() {
    while (this.active.size < this.maxInflight && this.queue.length) this.start(this.queue.shift());
    if (this.active.size === 0 && this.queue.length === 0) this.idleWaiters.splice(0).forEach((resolve) => resolve());
  }
  cancel(id) {
    const queuedIndex = this.queue.findIndex((item) => item.id === id);
    if (queuedIndex >= 0) {
      const [item] = this.queue.splice(queuedIndex, 1);
      item.resolve(cancelled());
      this.pump();
      return true;
    }
    const active = this.active.get(id);
    if (!active) return false;
    active.controller.abort();
    return true;
  }
  cancelAll() {
    for (const item of this.queue.splice(0)) item.resolve(cancelled());
    for (const item of this.active.values()) item.controller.abort();
    this.pump();
  }
  whenIdle() {
    if (this.active.size === 0 && this.queue.length === 0) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.push(resolve));
  }
};
var limiter = new WorkLimiter(MAX_INFLIGHT, MAX_QUEUE);
function send(msg) {
  process2.stdout.write(JSON.stringify(msg) + "\n");
}
var ok = (id, result) => send({ jsonrpc: "2.0", id, result });
var err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });
async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = id === void 0 || id === null;
  switch (method) {
    case "initialize":
      return ok(id, {
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS
      });
    case "notifications/initialized":
      return;
    // no response to notifications
    case "notifications/cancelled":
      limiter.cancel(params?.requestId);
      return;
    // no response to notifications
    case "ping":
      return ok(id, {});
    case "tools/list":
      return ok(id, {
        tools: Object.entries(TOOLS).map(([name, t]) => ({ name, description: t.description, inputSchema: t.inputSchema }))
      });
    case "tools/call": {
      const r = await limiter.run(id, (signal) => callTool(params?.name, params?.arguments || {}, signal));
      return ok(id, { content: [{ type: "text", text: r.text }], isError: !r.ok });
    }
    default:
      if (!isNotification) err(id, -32601, `method not found: ${method}`);
  }
}
var STDIN_MAX_BYTES = 4 * 1024 * 1024;
var buffer = "";
process2.stdin.setEncoding("utf8");
process2.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > STDIN_MAX_BYTES) {
    process2.stderr.write("mcp-server: stdin buffer exceeded 4 MB cap; shutting down\n");
    process2.exit(1);
  }
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      continue;
    }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg?.id != null) err(msg.id, -32603, `internal error: ${e.message}`);
    });
  }
});
process2.stdin.on("end", async () => {
  limiter.cancelAll();
  await limiter.whenIdle();
  process2.exit(0);
});
for (const signal of ["SIGINT", "SIGTERM"]) {
  process2.on(signal, async () => {
    limiter.cancelAll();
    await limiter.whenIdle();
    process2.exit(0);
  });
}
