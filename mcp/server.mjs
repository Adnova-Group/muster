import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PRINCIPLES, VERBS, ROUTING_POLICY } from "../plugin/hooks/guidance.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// CLI resolution is layout-adaptive: source installs use ../src/cli.js while
// bundled installs place muster.mjs beside this module.
const REPO_CLI = path.join(HERE, "..", "src", "cli.js");
const BUNDLED_CLI = path.join(HERE, "muster.mjs");
export function resolveMusterCli(testCli) {
  return testCli
  ? path.resolve(testCli)
  : existsSync(REPO_CLI) ? REPO_CLI
  : existsSync(BUNDLED_CLI) ? BUNDLED_CLI
  : REPO_CLI;
}
const PROTOCOL_VERSION = "2025-06-18"; // MCP spec version date-string (matches the MCP specification header)
// Single-source the version from package.json so serverInfo never drifts from the release.
const VERSION = JSON.parse(readFileSync(path.join(HERE, "..", "package.json"), "utf8")).version;
const SERVER_INFO = { name: "muster", version: VERSION };
// ── Tool catalog ──────────────────────────────────────────────────────────────
// Factory shapes used by most TOOLS entries:
//
//   S(desc, prop, required?)  — "str": receives a single string arg, passed directly as a CLI arg.
//                               An entry may also carry its own `flags: (args) => [...]` (same
//                               convention as json2's `flags` below) to append extra plain CLI
//                               args/flags after the primary positional value — e.g.
//                               muster_receipt_verify's `--cwd <repo>` pair. Optional; only
//                               defined where a tool actually needs it, so every existing "str"
//                               tool's behavior is unchanged.
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
const SPRINT_RECEIPT_SCHEMA = {
  type: "object",
  properties: {
    id: { type: "string", minLength: 1, maxLength: 256 },
    itemId: { type: "string", minLength: 1, maxLength: 128 },
    phase: { type: "string", enum: ["implementation", "review", "integration"] },
    status: { type: "string", enum: ["completed", "failed", "cancelled"] },
    attempt: { type: "integer", minimum: 1, maximum: 1000000 },
  },
  required: ["id", "itemId", "phase", "status"],
  additionalProperties: false,
};
const SPRINT_IN_FLIGHT_SCHEMA = {
  type: "object",
  properties: {
    itemId: { type: "string", minLength: 1, maxLength: 128 },
    phase: { type: "string", enum: ["implementation", "review", "integration"] },
    attempt: { type: "integer", minimum: 1, maximum: 1000000 },
  },
  required: ["itemId", "phase", "attempt"],
  additionalProperties: false,
};

const TOOLS = {
  // analysis verbs — string or no arg
  muster_detect: { argv: ["detect"], ...S("Detect the project profile (languages, frameworks, VCS, test runner) for a directory. Always pass `dir` explicitly — omitting it analyzes the server's working directory, not the caller's project.", "dir", false) },
  muster_capabilities: { argv: ["capabilities"], ...S("Resolve every Muster role against the runtime capabilities declared by this adapter.", "home", false) },
  muster_match: { argv: ["match"], ...S("Rank catalog providers against a free-text task by token overlap (no model call).", "task") },
  muster_domain: { argv: ["domain"], ...S("Classify an outcome into a work domain (software, product, content, ...).", "outcome") },
  muster_route: { argv: ["route"], ...S("Route an outcome to its domain + pipeline id.", "outcome") },
  muster_pipeline: { argv: ["pipeline"], ...S("Load a pipeline definition by domain or pipeline id.", "ref") },
  muster_assess: { argv: ["assess"], ...S("Deterministic gap-check on an outcome (too short, no success criteria, vague).", "outcome") },
  muster_steer: { argv: ["steer"], ...S("Classify a mid-run steer message (scope change, abort, refine, ...).", "message") },
  muster_diagnose: { argv: ["diagnose"], ...S("Classify a failure symptom and build a diagnose manifest.", "symptom") },
  muster_audit: {
    argv: ["audit"], kind: "target",
    // audit-mcp-backlog-mode: two OPTIONAL params on the existing "target" kind, appended
    // onto the CLI argv by the "target" branch's `flags` below (mirrors "str"'s `flags`).
    // `backlog:true` exposes the $muster-audit skill's read-only backlog sweep (read-only
    // dimension sweep -> ranked capture, NO fix/verify stages); `paths` scopes the sweep.
    // Default (dir only) is unchanged: the whole-codebase fix+verify remediation manifest.
    description: "Build the audit manifest for an explicit connected project directory (six parallel review dimensions). Default: whole-codebase remediation (consolidate -> fix -> verify). `backlog: true`: read-only sweep -> ranked capture into a backlog, NO fix/verify stages. `paths`: scope the sweep to the given paths/subsystems.",
    inputSchema: { type: "object", properties: { dir: { type: "string" }, backlog: { type: "boolean" }, paths: { type: "array", items: { type: "string" } } }, required: ["dir"] },
    flags: (a) => [
      ...(a.backlog ? ["--backlog"] : []),
      ...(Array.isArray(a.paths) ? a.paths.filter((p) => typeof p === "string" && p.trim()) : []),
    ],
  },

  // gate/math verbs — JSON in, written to a temp file
  muster_manifest_validate: { argv: ["manifest", "validate"], ...J2("Validate a crew manifest's shape and dependency graph.", { manifest: { type: "object" } }, ["manifest"]), picks: (a) => [a.manifest] },
  muster_wave: { argv: ["wave"], ...J2("Compute dependency-ordered execution waves from a manifest's plan.", { manifest: { type: "object" } }, ["manifest"]), picks: (a) => [a.manifest] },
  muster_sprint_waves: { argv: ["sprint-waves"], ...T("Computes dependency-ordered execution waves from a backlog file's {id}/{deps} annotations. Returns waves/items plus an explicit schedule: cap-bounded isolated build/review batches, the barrier, ordered merge integration, and sequential-degradation metadata; annotated:false means the backlog is unannotated/sequential.", "backlog") },
  muster_sprint_reconcile: {
    argv: ["sprint-reconcile"],
    ...J2(
      "Reconciles all available sprint completion receipts with the emitted schedule. Returns canonical item states and newly eligible implementation/review/integration dispatch actions; call after every wake before waiting again.",
      {
        plan: { type: "object" },
        receipts: { type: "array", maxItems: 10000, items: SPRINT_RECEIPT_SCHEMA },
        inFlight: { type: "array", maxItems: 1000, items: SPRINT_IN_FLIGHT_SCHEMA },
      },
      ["plan", "receipts", "inFlight"],
    ),
    picks: (a) => [{ plan: a.plan, receipts: a.receipts, inFlight: a.inFlight }],
  },
  muster_sprint_protocol: {
    kind: "static", text: null, error: "muster_sprint_protocol: adapter did not supply static content",
    description: "Returns the bundled sprint orchestration playbook: backlog resolution, sprint-waves, sequential wave execution, claim/receipt discipline, and honest disposition defaults.",
    inputSchema: { type: "object", properties: {} },
  },
  muster_next: { argv: ["next"], ...J2("Single-agent driver: given a manifest and the ids completed so far, return the next runnable task plus the full ready frontier. Run `next`, append its id to `completed`, call again until done.", { manifest: { type: "object" }, completed: { type: "array", items: { type: "string" } } }, ["manifest"]), picks: (a) => [a.manifest], flags: (a) => a.completed?.length ? ["--done", a.completed.join(",")] : [] },
  muster_score: { argv: ["score"], ...J2("Score an artifact's dimensions against a gate.", { scores: { type: "object" }, gate: { type: "object" } }, ["scores", "gate"]), picks: (a) => [{ scores: a.scores, gate: a.gate }] },
  muster_prioritize: { argv: ["prioritize"], ...J2("Rank backlog items by RICE/ICE/WSJF/weighted.", { items: { type: "array" }, model: { type: "string", enum: ["rice", "ice", "wsjf", "weighted"] } }, ["items"]), picks: (a) => [{ items: a.items, model: a.model || "rice" }], flags: (a) => a.model ? ["--model", a.model] : [] },
  muster_pick: { argv: ["pick"], ...J2("Pick the tournament winner from scored candidates.", { candidates: { type: "array" } }, ["candidates"]), picks: (a) => [a.candidates] },
  muster_tally: { argv: ["tally"], ...J2("Tally adversarial review verdicts into a gate decision. A reviewer entry may carry status:\"exhausted\"|\"absent\" naming the WORKER's own failure to deliver a verdict (killed/ran out of budget, or never responded) instead of findings -- this always forces blocked:true with a named reason in blockedReasons, never a silent skip and never counted as a real PASS or FAIL.", { verdicts: { type: "array" } }, ["verdicts"]), picks: (a) => [a.verdicts] },
  muster_advise: { argv: ["advise"], ...J2("Validate an advice-request and resolve the advisor model (apex degrades to prime). Deterministic, no LLM.", { request: { type: "object" } }, ["request"]), picks: (a) => [a.request] },
  muster_fuse: { argv: ["fuse"], ...J2("Fusion decision engine: validate the debate map, apply the agreement gate, select top-K for synthesis (mode fuse) or fall back to the single best (mode fallback). Deterministic, no LLM.", { candidates: { type: "array" }, fusionMap: { type: "object" } }, ["candidates", "fusionMap"]), picks: (a) => [a.candidates, a.fusionMap] },

  // Additional deterministic operations exposed by every adapter.
  muster_capabilities_roles: { argv: ["capabilities", "--roles-only"], ...S("Resolve every Muster role the same way muster_capabilities does, but return only the compact {roles} map.", "home", false) },
  muster_match_skills: { argv: ["match", "--skills"], ...S("Rank the live skills inventory against a free-text task by token overlap, plus stack-derived suggested skills (matchSkills + suggestSkillsForStack; no model call). Stack signals are always derived from the task text itself (signalsFromTask); use the CLI for an explicit --stack override.", "task") },
  muster_gate_cadence: { argv: ["gate-cadence"], ...J2("Compute review-gate cadence (spec-gate rounds, batched review-gate passes, and -- when changedLines is given -- reviewer count + reasoning tier) from a manifest's dependency-ordered waves. Deterministic, no LLM.", { manifest: { type: "object" }, changedLines: { type: "number" } }, ["manifest"]), picks: (a) => [a.manifest], flags: (a) => a.changedLines !== undefined ? ["--changed-lines", String(a.changedLines)] : [] },
  muster_receipt_verify: {
    argv: ["receipt-verify"], kind: "str", prop: "sha",
    description: "Verify a base-SHA is a REAL, resolvable git commit object in an explicit repo -- proof a well-formed-but-fabricated SHA does not pass (makeGitShaVerifier's git-backed default verifier: `git rev-parse --verify --quiet <sha>^{commit}`, never a branch/tag/HEAD/relative ref). Returns {sha, cwd, verified, mechanism}. `cwd` is required and never defaults to this server's own cwd -- state which repository the SHA is being checked against explicitly.",
    inputSchema: { type: "object", properties: { sha: { type: "string" }, cwd: { type: "string" } }, required: ["sha", "cwd"] },
    flags: (a) => ["--cwd", String(a.cwd ?? "")],
  },

  // Operations with specialized argument shapes.
  muster_scope: { argv: ["scope"], ...S("Deterministic backlog-vs-item scope detection for the plan/go verb family (detectScope): does free text look like a backlog reference/file, or read as a single-item outcome? Returns {scope: \"backlog\"|\"item\"|\"ambiguous\", signals}. An empty/omitted `text` is a valid bare invocation -- checks the default .muster/backlog.md under the server's own working directory (this tool has no `dir` override, matching the CLI's own scope command).", "text", false) },
  muster_fast_path: {
    argv: ["fast-path"], kind: "fastPath", prop: "outcome",
    description: "Score an outcome for the pre-router fast path (scoreOutcomeForFastPath): a single-task/small outcome with no cross-cutting or multi-deliverable signal skips full crew assembly. Returns {eligible, wordCount, reason}. When `capabilities` is ALSO given -- the SAME {roles} shape muster_capabilities_roles returns -- and the outcome scores eligible, also emits the minimal builder+one-reviewer manifest (buildFastPathManifest; no LLM dispatch). Omit `capabilities` for eligibility scoring only.",
    inputSchema: {
      type: "object",
      properties: { outcome: { type: "string" }, capabilities: { type: "object" } },
      required: ["outcome"],
    },
  },
  muster_plan_checklist: { argv: ["plan-checklist"], ...J2("Render a crew manifest's `plan` array as a markdown checklist (renderPlanChecklist): `- [ ]`/`- [x]`, a tournament marker, and owns/frozen fence suffixes. Optional `done` (array of task ids) marks matching tasks complete.", { manifest: { type: "object" }, done: { type: "array", items: { type: "string" } } }, ["manifest"]), picks: (a) => [a.manifest], flags: (a) => a.done?.length ? ["--done", a.done.join(",")] : [] },
};

// ── CLI invocation ──────────────────────────────────────────────────────────
// The canonical apex opt-in rides MUSTER_ENABLE_APEX (MCPB user_config key
// enable_apex, declared with NO default: a false-by-default boolean substitutes
// "false" whether the user toggled it or not, which would make "unset"
// indistinguishable from an explicit disable and let a stale legacy value
// override it). Installs upgraded from the fable-era manifest may still carry
// a stored enable_fable=true, which the manifest keeps substituting into the
// legacy MUSTER_ENABLE_FABLE. Precedence is explicit: enable_apex SET TO
// EITHER VALUE always wins; the legacy key applies only when enable_apex is
// unset (absent or substituting empty) -- so an upgrade never silently
// revokes the old opt-in, and a stale legacy value never overrides an
// explicit enable_apex=false. Tier aliasing itself stays owned by src/model.js.
const withLegacyTierAlias = (source) => {
  const environment = { ...source };
  const on = (v) => !!v && v !== "0" && String(v).toLowerCase() !== "false";
  const apexUnset = environment.MUSTER_ENABLE_APEX === undefined
    || String(environment.MUSTER_ENABLE_APEX).trim() === "";
  if (apexUnset && on(environment.MUSTER_ENABLE_FABLE)) {
    environment.MUSTER_ENABLE_APEX = environment.MUSTER_ENABLE_FABLE;
  }
  return environment;
};

const cancelled = () => ({ ok: false, text: "muster MCP request cancelled" });

class WorkLimiter {
  constructor(maxInflight, maxQueue) {
    this.maxInflight = maxInflight;
    this.maxQueue = maxQueue;
    this.active = new Map();
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
    Promise.resolve()
      .then(() => item.task(item.controller.signal))
      .then(item.resolve, (error) => item.resolve({ ok: false, text: `internal error: ${error.message}` }))
      .finally(() => {
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
}

export function startMusterMcpServer(config) {
  for (const field of ["protocol", "runtimeIdentity", "cliPath"]) {
    if (typeof config?.[field] !== "string" || !config[field]) throw new TypeError(`startMusterMcpServer: ${field} is required`);
  }
  for (const field of ["mapArgv", "authorizeTools"]) {
    if (typeof config[field] !== "function") throw new TypeError(`startMusterMcpServer: ${field} callback is required`);
  }
  const io = config.io;
  if (!io?.stdin || !io?.stdout || !io?.stderr || typeof io.exit !== "function") {
    throw new TypeError("startMusterMcpServer: explicit io is required");
  }
  const environment = withLegacyTierAlias(config.environment || {});
  const catalog = Object.fromEntries(Object.entries(TOOLS).map(([name, tool]) => [
    name,
    {
      ...tool,
      ...(tool.argv ? { argv: config.mapArgv(name, [...tool.argv]) } : {}),
    },
  ]));
  for (const [name, content] of Object.entries(config.staticTools || {})) {
    if (catalog[name]?.kind === "static") {
      catalog[name] = typeof content === "string"
        ? { ...catalog[name], text: content, error: null }
        : { ...catalog[name], text: null, error: String(content?.error || "static content unavailable") };
    }
  }
  const authorized = config.authorizeTools(catalog);
  if (!authorized || typeof authorized.tools !== "object" || Array.isArray(authorized.tools)) {
    throw new TypeError("startMusterMcpServer: authorizeTools must return { tools }");
  }
  const exposedTools = authorized.tools;
  const instructions = authorized.instructions
    || [PRINCIPLES, VERBS, ROUTING_POLICY, config.protocol].join("\n\n");
  const profileName = authorized.profileName || "";
  const limiter = new WorkLimiter(config.maxInflight || 4, config.maxQueue || 16);

  async function runCli(argv, { cwd = config.cwd, signal } = {}) {
    try {
      const { stdout } = await new Promise((resolve, reject) => {
        execFile("node", [config.cliPath, ...argv], {
          cwd,
          signal,
          timeout: 60_000,
          maxBuffer: 16 * 1024 * 1024,
          env: { ...environment, MUSTER_RUNTIME: config.runtimeIdentity },
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
      if (signal?.aborted) return cancelled();
      const text = (e.stderr || e.stdout || e.message || "").toString().trim();
      return { ok: false, text: text || "muster CLI failed with no output" };
    }
  }

  async function callTool(name, args = {}, signal) {
    const tool = catalog[name];
    if (!tool) return { ok: false, text: `unknown tool: ${name}` };

  if (tool.kind === "str") {
    const v = args[tool.prop];
    const hasValue = v != null && v !== "";
    // `flags` only fires alongside a PRESENT primary value -- appending it when the
    // positional is missing would let it shift into the positional's own argv slot
    // (e.g. muster_receipt_verify omitting `sha` would otherwise send `["receipt-verify",
    // "--cwd", cwd]`, with the CLI reading "--cwd" itself as the sha and silently
    // "verifying" a nonsense ref instead of reporting the missing-sha usage error).
    // Suppressing flags too when the value is absent lets the bare argv reach the CLI's
    // own required-arg check for a clean, correct diagnostic.
    return runCli(hasValue ? [...tool.argv, String(v), ...(tool.flags ? tool.flags(args) : [])] : tool.argv, { signal });
  }
  if (tool.kind === "none") return runCli(tool.argv, { signal });
  if (tool.kind === "target") {
    if (typeof args.dir !== "string" || !args.dir.trim()) {
      return { ok: false, text: "muster_audit: explicit target directory is required" };
    }
    // `paths` entries are spread as positional argv, but flag scans read the whole argv,
    // so a "-"-leading path would masquerade as
    // a flag (paths:["-h"] prints USAGE not JSON; paths:["--backlog"] silently flips the
    // mode). Path scopes are filesystem paths/subsystems and never start with "-"; reject
    // such an entry at this trust boundary before it ever reaches argv.
    if (Array.isArray(args.paths)) {
      const badPath = args.paths.find((p) => typeof p === "string" && p.trim().startsWith("-"));
      if (badPath !== undefined) {
        return { ok: false, text: `muster_audit: path scope must not start with "-" (got ${JSON.stringify(badPath)}); it would masquerade as a CLI flag` };
      }
    }
    // Append any tool-declared flags (muster_audit's --backlog / path scopes) after the
    // verb; the target's own required `dir` stays the resolved cwd, never a positional.
    const extra = tool.flags ? tool.flags(args) : [];
    return runCli([...tool.argv, ...extra], { cwd: path.resolve(args.dir), signal });
  }
  // static: no CLI call at all — return pre-loaded file content verbatim (muster_sprint_protocol).
  // A load-time read failure (tool.error set) surfaces as isError instead of serving `null` text.
  if (tool.kind === "static") return tool.error ? { ok: false, text: tool.error } : { ok: true, text: tool.text };

  // fastPath: muster_fast_path's bespoke kind -- a required string positional (`outcome`)
  // PLUS an OPTIONAL JSON payload (`capabilities`) behind a flag. Neither "str" (single
  // positional, synchronous `flags`) nor "json2" (payload-only positionals) covers that
  // shape, so this writes its own temp file only when `capabilities` is actually present,
  // mirroring "json2"'s write/run/cleanup sequence below rather than reusing "str"'s
  // (synchronous, therefore file-write-incapable) `flags` callback.
  if (tool.kind === "fastPath") {
    const v = args[tool.prop];
    if (typeof v !== "string" || !v.trim()) {
      return { ok: false, text: "muster_fast_path: outcome is required" };
    }
    const capabilities = args.capabilities;
    if (capabilities == null) return runCli([...tool.argv, v], { signal });
    const dir = await mkdtemp(path.join(tmpdir(), "muster-mcp-"));
    try {
      const f = path.join(dir, "capabilities.json");
      await writeFile(f, JSON.stringify(capabilities));
      return await runCli([...tool.argv, v, "--capabilities", f], { signal });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }

  // text: write the single string payload verbatim (no JSON.stringify) to one temp file,
  // then invoke the CLI with that file's path — mirrors json2's temp-file handoff for
  // verbs whose CLI arg is a file path but whose content is plain text (e.g. a backlog).
  // The handoff runs with the temp dir AS the cwd: sprint-waves (audit 2 slice B)
  // canonically contains its backlog read under the run root (process.cwd()) and refuses
  // anything outside it, and this file is server-written into a fresh mkdtemp (the caller
  // controls its CONTENT, never its path), so scoping the run root to the temp dir keeps
  // the handoff inside containment by construction.
  if (tool.kind === "text") {
    const dir = await mkdtemp(path.join(tmpdir(), "muster-mcp-"));
    try {
      const f = path.join(dir, "input.txt");
      await writeFile(f, args[tool.prop] ?? "");
      return await runCli([...tool.argv, f], { cwd: dir, signal });
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
      return await runCli([...tool.argv, ...files, ...(tool.flags ? tool.flags(args) : [])], { signal });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  }

  const invoke = authorized.invoke
    ? (name, args, signal) => authorized.invoke({ name, args, signal, callTool })
    : (name, args, signal) => callTool(name, args, signal);
  const send = (msg) => io.stdout.write(JSON.stringify(msg) + "\n");
  const ok = (id, result) => send({ jsonrpc: "2.0", id, result });
  const err = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

  async function handle(msg) {
  const { id, method, params } = msg;
  const isNotification = !Object.hasOwn(msg, "id");
  const replyOk = (result) => {
    if (!isNotification) ok(id, result);
  };
  const replyErr = (code, message) => {
    if (!isNotification) err(id, code, message);
  };

  switch (method) {
    case "initialize":
      return replyOk({
        protocolVersion: params?.protocolVersion || PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO,
        instructions,
      });
    case "notifications/initialized":
      return; // no response to notifications
    case "notifications/cancelled":
      limiter.cancel(params?.requestId);
      return; // no response to notifications
    case "ping":
      return replyOk({});
    case "tools/list":
      return replyOk({
        tools: Object.entries(exposedTools).map(([name, t]) => ({
          name, ...(t.title ? { title: t.title } : {}),
          description: t.description, inputSchema: t.inputSchema,
          ...(t.annotations ? { annotations: t.annotations } : {}),
        })),
      });
    case "tools/call": {
      if (!Object.hasOwn(exposedTools, params?.name)) {
        return replyOk({
          content: [{
            type: "text",
            text: profileName
              ? `tool ${JSON.stringify(params?.name)} is not available in MCP tool profile ${JSON.stringify(profileName)}`
              : `unknown tool: ${params?.name}`,
          }],
          isError: true,
        });
      }
      const workId = isNotification ? Symbol("tools/call notification") : id;
      const r = await limiter.run(workId, (signal) => invoke(params?.name, params?.arguments || {}, signal));
      return replyOk({ content: [{ type: "text", text: r.text }], isError: !r.ok });
    }
    default:
      return replyErr(-32601, `method not found: ${method}`);
  }
  }

// A-SEC6: cap the stdin accumulator to prevent heap exhaustion when a client
// sends data without a newline terminator (no-newline DoS). 4 MB is well above
// any legitimate JSON-RPC request muster sends. On overflow: emit a one-line
// diagnostic to stderr and exit cleanly (non-zero, not an uncaught exception).
const STDIN_MAX_BYTES = 4 * 1024 * 1024;

  let buffer = "";
  io.stdin.setEncoding("utf8");
  io.stdin.on("data", (chunk) => {
  buffer += chunk;
  if (Buffer.byteLength(buffer) > STDIN_MAX_BYTES) {
    io.stderr.write("mcp-server: stdin buffer exceeded 4 MB cap; shutting down\n");
    io.exit(1);
  }
  let nl;
  while ((nl = buffer.indexOf("\n")) >= 0) {
    const line = buffer.slice(0, nl).trim();
    buffer = buffer.slice(nl + 1);
    if (!line) continue;
    let msg;
    try { msg = JSON.parse(line); } catch { continue; }
    Promise.resolve(handle(msg)).catch((e) => {
      if (msg !== null && typeof msg === "object" && Object.hasOwn(msg, "id")) {
        err(msg.id, -32603, `internal error: ${e.message}`);
      }
    });
  }
  });
  io.stdin.on("end", async () => {
  limiter.cancelAll();
  await limiter.whenIdle();
    io.exit(0);
  });
  for (const signal of ["SIGINT", "SIGTERM"]) {
    io.on(signal, async () => {
    limiter.cancelAll();
    await limiter.whenIdle();
      io.exit(0);
    });
  }
  return { handle, tools: exposedTools };
}
