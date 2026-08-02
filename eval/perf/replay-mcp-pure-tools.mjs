#!/usr/bin/env node
// Replays the twelve deterministic MCP calls promoted to the in-process lane.
// "before" reproduces the removed transport for every call: create temp input
// files, fork src/cli.js, collect stdout, and remove the temp directory.
// "after" invokes the production in-process dispatcher with the same arguments.

import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

import { invokeInProcessTool } from "../../mcp/in-process-tools.mjs";
import { computeSprintWaves } from "../../src/sprint-waves.js";

const execFileP = promisify(execFile);
const rootDir = fileURLToPath(new URL("../../", import.meta.url));
const cliPath = join(rootDir, "src", "cli.js");
const roundsArg = process.argv.find((arg) => arg.startsWith("--rounds="));
const rounds = roundsArg ? Number(roundsArg.slice("--rounds=".length)) : 5;
if (!Number.isSafeInteger(rounds) || rounds < 1 || rounds > 100) throw new Error("--rounds must be an integer from 1 to 100");

const manifest = {
  plan: [
    { id: "a", task: "Build", mode: "single", deps: [] },
    { id: "b", task: "Review", mode: "single", deps: ["a"] },
  ],
};
const sprint = computeSprintWaves("- [ ] Build {id: a} {deps: none} {disposition: pr}");
const candidates = [{ id: "a", total: 9, passing: true }, { id: "b", total: 8, passing: true }];
const fusionMap = { consensus: [], contradictions: ["x"], partialCoverage: [], uniqueInsights: [], blindSpots: [] };
const cases = [
  ["muster_wave", { manifest }, [manifest], (files) => ["wave", files[0]]],
  ["muster_next", { manifest, completed: ["a"] }, [manifest], (files) => ["next", files[0], "--done", "a"]],
  ["muster_gate_cadence", { manifest, changedLines: 12 }, [manifest], (files) => ["gate-cadence", files[0], "--changed-lines", "12"]],
  ["muster_sprint_reconcile", { plan: sprint, receipts: [], inFlight: [] }, [{ plan: sprint, receipts: [], inFlight: [] }], (files) => ["sprint-reconcile", files[0]]],
  ["muster_score", { scores: { correctness: 3, clarity: 2 }, gate: { floor: 2, pass_total: 5 } }, [{ scores: { correctness: 3, clarity: 2 }, gate: { floor: 2, pass_total: 5 } }], (files) => ["score", files[0]]],
  ["muster_prioritize", { items: [{ name: "A", reach: 10, impact: 2, confidence: 0.8, effort: 2 }], model: "rice" }, [[{ name: "A", reach: 10, impact: 2, confidence: 0.8, effort: 2 }]], (files) => ["prioritize", files[0], "--model", "rice"]],
  ["muster_pick", { candidates }, [candidates], (files) => ["pick", files[0]]],
  ["muster_tally", { verdicts: [{ reviewer: "code", findings: [] }] }, [[{ reviewer: "code", findings: [] }]], (files) => ["tally", files[0]]],
  ["muster_advise", { request: { question: "Choose?", context: "A bounded choice", decisionType: "architecture", options: ["A", "B"] } }, [{ question: "Choose?", context: "A bounded choice", decisionType: "architecture", options: ["A", "B"] }], (files) => ["advise", files[0]]],
  ["muster_fuse", { candidates, fusionMap }, [candidates, fusionMap], (files) => ["fuse", ...files]],
  ["muster_fast_path", { outcome: "fix typo" }, [], () => ["fast-path", "fix typo"]],
  ["muster_plan_checklist", { manifest, done: ["a"] }, [manifest], (files) => ["plan-checklist", files[0], "--done", "a"]],
];

async function legacyCall(entry) {
  const [, , payloads, argv] = entry;
  const dir = await mkdtemp(join(tmpdir(), "muster-mcp-replay-"));
  try {
    const files = await Promise.all(payloads.map(async (payload, index) => {
      const file = join(dir, `input-${index}.json`);
      await writeFile(file, JSON.stringify(payload));
      return file;
    }));
    const { stdout } = await execFileP(process.execPath, [cliPath, ...argv(files)], { cwd: rootDir });
    return stdout.trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function inProcessCall([name, args]) {
  const result = await invokeInProcessTool(name, args, { environment: process.env });
  if (!result.handled || !result.result.ok) throw new Error(`${name}: ${result.result?.text || "not handled"}`);
  return result.result.text;
}

const before = [];
const after = [];
let byteEquivalent = true;
for (let round = 0; round < rounds; round += 1) {
  for (const entry of cases) {
    let started = performance.now();
    const expected = await legacyCall(entry);
    before.push(performance.now() - started);
    started = performance.now();
    const actual = await inProcessCall(entry);
    after.push(performance.now() - started);
    byteEquivalent &&= actual === expected;
  }
}

const percentile = (values, fraction) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * fraction) - 1)];
};
const beforeP95 = percentile(before, 0.95);
const afterP95 = percentile(after, 0.95);
const improvementPct = ((beforeP95 - afterP95) / beforeP95) * 100;
const report = {
  replay: "deterministic read-only MCP tools",
  callsPerReplay: cases.length,
  rounds,
  samplesPerLane: cases.length * rounds,
  before: { transport: "temp files + CLI child process", p95Ms: Number(beforeP95.toFixed(3)) },
  after: { transport: "in-process dispatcher", p95Ms: Number(afterP95.toFixed(3)) },
  improvementPct: Number(improvementPct.toFixed(1)),
  targetPct: 50,
  targetMet: improvementPct >= 50,
  byteEquivalent,
};
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.targetMet || !byteEquivalent || cases.length !== 12) process.exitCode = 1;
