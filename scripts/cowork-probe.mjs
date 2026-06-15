#!/usr/bin/env node
// cowork-probe — does a target runtime (e.g. Claude Cowork) support what muster needs?
//
// Muster has two layers (see docs/architecture.md): a portable Node CLI (src/*.js, no model
// calls) and a model-facing plugin layer bound to Claude Code primitives. Porting muster to a
// new runtime turns on two questions this probe answers:
//
//   1. CLI portability  — can the runtime shell out to `node src/cli.js <verb>` and read JSON?
//   2. Subagent dispatch — can it fan out parallel subagents with a per-call model override?
//
// Phase 1 + 2 run here in plain Node and self-verify. Phase 3 (dispatch) cannot: a Node script
// can't spawn Claude subagents. So the probe EMITS a self-test spec the host runtime executes,
// then GRADES the runtime's results when you feed them back with --dispatch-results.
//
// SELF-CONTAINED: node: builtins only. Copy this file into the target runtime and run it there.
//
// Usage:
//   node scripts/cowork-probe.mjs                         # phases 1+2, emit phase-3 spec
//   node scripts/cowork-probe.mjs --muster-root <dir>     # point at the muster checkout
//   node scripts/cowork-probe.mjs --dispatch-results <f>  # grade a phase-3 run
//   node scripts/cowork-probe.mjs --json                  # machine-readable report

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { parseArgs } from "node:util";

const VALID_KINDS = ["agent", "skill", "mcp", "inline"];

const { values: opts } = parseArgs({
  options: {
    "muster-root": { type: "string" },
    "dispatch-results": { type: "string" },
    "spec-out": { type: "string", default: "cowork-dispatch-spec.json" },
    json: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

const root = path.resolve(opts["muster-root"] ?? process.cwd());
const cli = path.join(root, "src", "cli.js");
const results = []; // { phase, name, status: pass|fail|manual, detail }
const record = (phase, name, status, detail) => results.push({ phase, name, status, detail });

// Run a CLI verb, return { ok, json, raw, error }. Never throws.
function runCli(args) {
  try {
    const raw = execFileSync("node", [cli, ...args], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 30_000,
    });
    try {
      return { ok: true, json: JSON.parse(raw), raw };
    } catch {
      return { ok: false, raw, error: "stdout was not valid JSON" };
    }
  } catch (e) {
    return { ok: false, raw: e.stdout?.toString?.() ?? "", error: e.shortMessage ?? e.message };
  }
}

// ── Phase 1: CLI portability ────────────────────────────────────────────────
// Each probe: a verb, plus a predicate proving the JSON has the shape muster relies on.
function phase1() {
  if (!existsSync(cli)) {
    record("cli", "locate src/cli.js", "fail", `not found at ${cli} — pass --muster-root`);
    return null;
  }
  const battery = [
    { args: ["detect"], check: (j) => "greenfield" in j && Array.isArray(j.languages) && j.vcs },
    { args: ["capabilities"], check: (j) => j.roles && typeof j.roles === "object" },
    { args: ["match", "review this code"], check: (j) => Array.isArray(j) && j.every((r) => r.id && "score" in r) },
    { args: ["route", "fix a failing test"], check: (j) => "domain" in j },
  ];
  let caps = null;
  for (const { args, check } of battery) {
    const r = runCli(args);
    const label = `muster ${args.join(" ")}`;
    if (!r.ok) record("cli", label, "fail", r.error);
    else if (!check(r.json)) record("cli", label, "fail", "exit 0 but JSON shape unexpected");
    else record("cli", label, "pass", "exit 0, JSON valid, shape OK");
    if (args[0] === "capabilities" && r.ok) caps = r.json;
  }
  // The Cowork MCP server spawns the CLI as a child process. On Windows MSIX installs the
  // virtualized bundle path can block that (anthropics/claude-code#47977). These CLI probes
  // running here prove child-process spawn works in THIS runtime; flag the platform caveat.
  const onWin = process.platform === "win32";
  record("cli", "child-process spawn works in this runtime (MSIX risk on win32)",
    caps ? (onWin ? "manual" : "pass") : "fail",
    caps ? (onWin ? "spawn worked here; re-verify from the packaged MSIX-virtualized path" : "spawn confirmed in this runtime")
         : "CLI never produced output — spawn or path is broken here");
  return caps;
}

// ── Phase 2: dispatch-contract extraction ────────────────────────────────────
// The CLI must hand the runtime a complete, dispatchable plan: every role resolves to a
// {kind, id, model} and the fallback chain always terminates at inline. Prove those invariants
// and report the distinct dispatch mechanisms the runtime must implement.
function phase2(caps) {
  if (!caps?.roles) {
    record("contract", "extract dispatch table", "fail", "no capabilities output from phase 1");
    return null;
  }
  const roles = Object.entries(caps.roles);
  const table = roles.map(([role, r]) => ({
    role,
    id: r.chosen?.id,
    kind: r.chosen?.kind,
    model: r.model,
  }));

  const badKind = table.filter((t) => !VALID_KINDS.includes(t.kind));
  const noModel = table.filter((t) => !t.model);
  const noTerminal = roles.filter(([, r]) => r.chain?.at(-1)?.kind !== "inline");

  record("contract", "every role has a valid chosen.kind", badKind.length ? "fail" : "pass",
    badKind.length ? `bad: ${badKind.map((t) => `${t.role}=${t.kind}`).join(", ")}` : `${table.length} roles`);
  record("contract", "every role carries a model override", noModel.length ? "fail" : "pass",
    noModel.length ? `missing: ${noModel.map((t) => t.role).join(", ")}` : "all roles");
  record("contract", "every fallback chain ends in inline", noTerminal.length ? "fail" : "pass",
    noTerminal.length ? `not terminal: ${noTerminal.map(([r]) => r).join(", ")}` : "resolution always terminates");

  const kinds = [...new Set(table.map((t) => t.kind))].sort();
  const models = [...new Set(table.map((t) => t.model))].sort();
  record("contract", "dispatch mechanisms required", "manual",
    `kinds=${kinds.join("/")} → agent:subagent_type, skill/mcp:generic+inject, inline:direct`);
  record("contract", "model tiers the runtime must override to", "manual", models.join(", "));
  return { table, kinds, models };
}

// ── Phase 3: live dispatch self-test ─────────────────────────────────────────
// Node can't spawn Claude subagents, so emit a spec the host runtime executes. It proves the two
// things autopilot/audit depend on: parallel fan-out (barrier) and a honored per-call model override.
function emitDispatchSpec(contract) {
  const overrideModel = contract?.models?.includes("haiku") ? "haiku" : (contract?.models?.[0] ?? "haiku");
  const spec = {
    purpose: "Prove the runtime can fan out parallel subagents and honor a per-call model override.",
    instructions: [
      "Execute all three tasks below as SEPARATE subagents, dispatched in a single parallel batch (a barrier).",
      "For the task with `modelOverride` set, dispatch that subagent on that model, not the default.",
      "Each subagent must return ONLY its `expect` token as its final message.",
      "Write the collected results to a JSON file, then grade with: node scripts/cowork-probe.mjs --dispatch-results <file>",
    ],
    tasks: [
      { id: "a", prompt: "Reply with exactly: ALPHA", expect: "ALPHA", modelOverride: null },
      { id: "b", prompt: "Reply with exactly: BETA", expect: "BETA", modelOverride: null },
      { id: "c", prompt: `Reply with exactly: GAMMA. (Report the model you are running as.)`, expect: "GAMMA", modelOverride: overrideModel },
    ],
    resultsSchema: {
      parallel: "boolean — were a,b,c dispatched in one concurrent batch (not sequentially)?",
      results: "array of { id, output, modelReported }",
    },
    passCriteria: [
      "all three `output` values match their `expect` token",
      "`parallel` is true (fan-out, not a loop)",
      `task c's modelReported reflects the override (${overrideModel}), not the default`,
    ],
  };
  writeFileSync(opts["spec-out"], JSON.stringify(spec, null, 2));
  record("dispatch", "fan-out + model-override self-test", "manual",
    `spec written to ${opts["spec-out"]} — runtime must execute it, then re-run with --dispatch-results`);
  return overrideModel;
}

// Grade a runtime's execution of the emitted spec.
function gradeDispatch(file, overrideModel) {
  let data;
  try {
    data = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    record("dispatch", "grade results", "fail", `cannot read/parse ${file}: ${e.message}`);
    return;
  }
  const expect = { a: "ALPHA", b: "BETA", c: "GAMMA" };
  const byId = Object.fromEntries((data.results ?? []).map((r) => [r.id, r]));
  const tokenMiss = Object.entries(expect).filter(([id, t]) => (byId[id]?.output ?? "").trim() !== t);

  record("dispatch", "all subagents returned correct token", tokenMiss.length ? "fail" : "pass",
    tokenMiss.length ? `wrong: ${tokenMiss.map(([id]) => id).join(", ")}` : "a/b/c all matched");
  record("dispatch", "dispatched in parallel (fan-out)", data.parallel === true ? "pass" : "fail",
    data.parallel === true ? "barrier batch confirmed" : "runtime reported sequential or unknown");
  const cModel = (byId.c?.modelReported ?? "").toLowerCase();
  const overrideOk = cModel.includes(overrideModel);
  record("dispatch", "per-call model override honored", overrideOk ? "pass" : "fail",
    overrideOk ? `task c ran on ${overrideModel}` : `expected ${overrideModel}, got "${byId.c?.modelReported ?? "?"}"`);
}

// ── Report ───────────────────────────────────────────────────────────────────
function report() {
  if (opts.json) {
    process.stdout.write(JSON.stringify({ root, results }, null, 2) + "\n");
  } else {
    const mark = { pass: "PASS", fail: "FAIL", manual: "RUNTIME" };
    let phase = "";
    for (const r of results) {
      if (r.phase !== phase) {
        phase = r.phase;
        const title = { cli: "Phase 1 — CLI portability", contract: "Phase 2 — dispatch contract", dispatch: "Phase 3 — live dispatch" }[phase];
        process.stdout.write(`\n${title}\n`);
      }
      process.stdout.write(`  [${mark[r.status].padEnd(7)}] ${r.name} — ${r.detail}\n`);
    }
    const fails = results.filter((r) => r.status === "fail").length;
    const manual = results.filter((r) => r.status === "manual").length;
    process.stdout.write(`\n${fails ? `${fails} FAIL` : "no failures"}${manual ? `, ${manual} need a runtime check` : ""}.\n`);
  }
  return results.some((r) => r.status === "fail") ? 1 : 0;
}

const caps = phase1();
const contract = phase2(caps);
if (opts["dispatch-results"]) {
  const overrideModel = contract?.models?.includes("haiku") ? "haiku" : (contract?.models?.[0] ?? "haiku");
  gradeDispatch(opts["dispatch-results"], overrideModel);
} else {
  emitDispatchSpec(contract);
}
process.exit(report());
