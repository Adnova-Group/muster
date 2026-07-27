#!/usr/bin/env node
// Reviewer-tier experiment harness (rerunnable): does the execution lane
// (kimi-code/kimi-for-coding) review as well as the judgment lane
// (kimi-code/k3)? Two pinned probes x two lanes, each cell one headless
// `kimi -p --agent-file` process via kimiProcessDispatch (src/kimi-dispatch.js).
//
//   PROBE 1 (review-gate pass): the diff of commit 9027136 (parent of the
//     env-merge fix 3cf6084), reviewed with a review-gate-style brief. The
//     KNOWN-BLOCKER list is pinned verbatim below as the human-judgment rubric.
//   PROBE 2 (spec-gate pass): a small synthetic Crew Manifest (pinned below)
//     whose outcome claims the stamped model_preference on a --agent-file agent
//     engages the -p process's own model lanes. Expected: FAIL naming the
//     misattribution (model_preference binds only SPAWNED SUBAGENTS; the -p
//     main agent's model comes ONLY from -m).
//
// RUBRIC: caught/missed is HUMAN JUDGMENT applied later by the orchestrator.
// This harness does NOT keyword-score; it records each run's raw verdict text
// verbatim into the results JSON for that step.
//
// Modes:
//   node eval/kimi-reviewer-tier-probe.mjs --dry-run   build all descriptors and
//                                                      print them as JSON; spawn NOTHING
//   node eval/kimi-reviewer-tier-probe.mjs [--out <path>] [--results-dir <dir>]
//                                                      live mode: spawn every cell
//                                                      (wave 2 runs this)
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";
import { kimiProcessDispatch, KIMI_PROCESS_MAX_BRIEF } from "../src/kimi-dispatch.js";
import { captureSessionId, resolveSessionForCwd, readSessionUsage } from "../src/kimi-receipts.js";

const pexecFile = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = join(HERE, "..");

// ───────────────────────────────────────────────────────────────────────────
// Pinned constants (spec-gate-pinned; every element load-bearing)
// ───────────────────────────────────────────────────────────────────────────

// Probe 1's subject commit -- parent of the env-merge fix 3cf6084.
export const PROBE1_COMMIT = "9027136";

// KNOWN-BLOCKER list, pinned verbatim: the rubric the orchestrator's HUMAN
// JUDGMENT step checks probe-1 verdicts against. Never shown to the reviewer.
export const KNOWN_BLOCKERS = Object.freeze([
  "env merge semantics unstated: kimiLaneEnv() returns exactly two keys, and prose instructing spawn straight from the descriptor env replaces the child environment wholesale, losing HOME/PATH"
]);

// Probe 2's subject: a small synthetic Crew Manifest whose outcome carries the
// misattribution the spec gate is expected to catch.
export const PROBE2_MANIFEST = Object.freeze({
  schema: "muster-crew-manifest/v1",
  item: "synthetic-reviewer-tier-probe",
  outcome: "Dispatch muster-reviewer as a headless kimi -p --agent-file leg: the stamped model_preference on the --agent-file agent engages the -p process's own model lanes, so the dispatch needs no -m flag.",
  crew: [
    { role: "reviewer", agent: "muster-reviewer", dispatch: "kimi -p --agent-file muster-reviewer.md" }
  ],
  waves: [["reviewer"]]
});

// Briefs, pinned and IDENTICAL across lanes. Each states the return contract:
// verdict first, then itemized findings.
export const PROBE1_BRIEF = `You are the review gate for a muster wave. Review the diff below for correctness and completeness.
Return contract: your FIRST word must be the verdict, PASS or FAIL, alone on the first line. Then itemized findings, one per line, each classified BLOCKER or MINOR with the file and the reason. The verdict is FAIL iff any BLOCKER finding exists.
Diff (git show ${PROBE1_COMMIT}, parent of the follow-up fix):
`;

export const PROBE2_BRIEF = `You are the spec gate for a muster run. Apply a lazy/malicious probe to the Crew Manifest below: hunt for every way a lazy or malicious reading of this spec breaks the run, contradicts the harness's actual behavior, or misattributes a mechanism.
Return contract: your FIRST word must be the verdict, PASS or FAIL, alone on the first line. Then itemized findings, one per line, each classified BLOCKER or MINOR, naming the misattributed or broken claim and the correct mechanism. The verdict is FAIL iff any BLOCKER finding exists.
Crew Manifest:
`;

export const PROBES = Object.freeze([
  { id: "review-gate-diff", gate: "review-gate" },
  { id: "spec-gate-manifest", gate: "spec-gate" }
]);
export const LANES = Object.freeze(["primary", "secondary"]);

// The installed agent both probes dispatch as (bare name -> the installed
// agents dir, per kimiProcessDispatch's resolution rule).
export const AGENT_FILE = "muster-reviewer.md";

// n=1-per-cell caveat, recorded verbatim into every results file.
export const CAVEAT = "n=1 per cell: each probe x lane cell ran exactly once (plus at most one retry on failure). No statistical power -- caught/missed and token deltas are directional signals for the orchestrator's human-judgment step, not measurements of a distribution.";

// ───────────────────────────────────────────────────────────────────────────
// Descriptor construction
// ───────────────────────────────────────────────────────────────────────────

// Probe 1's diff, retrieved live from the repo (never hardcoded).
export function probe1Diff(repoRoot = REPO_ROOT) {
  return execFileSync("git", ["show", PROBE1_COMMIT], { cwd: repoRoot, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
}

// Briefs ride argv as the -p prompt, capped at KIMI_PROCESS_MAX_BRIEF
// (src/kimi-dispatch.js). The full `git show` output can exceed that budget;
// when it does, cut the artifact at the last newline that fits and say so in
// the brief -- deterministic, and the truncation is disclosed to the reviewer.
export function fitBrief(prefix, artifact) {
  if (prefix.length + artifact.length <= KIMI_PROCESS_MAX_BRIEF) return prefix + artifact;
  const note = "\n[artifact truncated to fit the -p brief budget]\n";
  const room = KIMI_PROCESS_MAX_BRIEF - prefix.length - note.length;
  const cut = artifact.lastIndexOf("\n", room);
  return prefix + artifact.slice(0, cut > 0 ? cut : room) + note;
}

export function buildBriefs(repoRoot = REPO_ROOT) {
  return {
    "review-gate-diff": fitBrief(PROBE1_BRIEF, probe1Diff(repoRoot)),
    "spec-gate-manifest": fitBrief(PROBE2_BRIEF, JSON.stringify(PROBE2_MANIFEST, null, 2) + "\n")
  };
}

// Build all probe x lane cells with their kimiProcessDispatch descriptors.
// Pure construction -- spawns nothing (this is what --dry-run prints).
export function buildCells({ repoRoot = REPO_ROOT, agentFile = AGENT_FILE } = {}) {
  const briefs = buildBriefs(repoRoot);
  const cells = [];
  for (const probe of PROBES) {
    for (const lane of LANES) {
      cells.push({
        probe: probe.id,
        gate: probe.gate,
        lane,
        brief: briefs[probe.id],
        descriptor: kimiProcessDispatch({ brief: briefs[probe.id], agentFile, cwd: repoRoot, lane })
      });
    }
  }
  return cells;
}

// ───────────────────────────────────────────────────────────────────────────
// Execution (live mode)
// ───────────────────────────────────────────────────────────────────────────

// THE MERGE RULE from the pinned blocker: the descriptor's env is an OVERRIDE
// pair merged over the ambient env -- never passed as the whole env (a
// wholesale replacement loses HOME/PATH and the child breaks). Do not regress.
export function spawnEnv(descriptorEnv, baseEnv = process.env) {
  return { ...baseEnv, ...descriptorEnv };
}

// Retry trigger: nonzero exit, or truncated stdout (empty, or missing the
// session.resume_hint a complete stream-json run always ends with).
export function cellNeedsRetry({ exitCode, stdout }) {
  if (exitCode !== 0) return true;
  if (typeof stdout !== "string" || !stdout.trim()) return true;
  return captureSessionId(stdout) === null;
}

// The raw verdict text, verbatim: the concatenated assistant messages from the
// stream-json stdout (first line is the verdict, per the brief's return
// contract). Falls back to the whole raw stdout when nothing parses -- the
// human-judgment step still gets exactly what the run emitted.
export function extractVerdictText(stdout) {
  if (typeof stdout !== "string") return "";
  const parts = [];
  for (const line of stdout.split("\n")) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj?.role === "assistant" && typeof obj.content === "string" && obj.content.trim()) {
      parts.push(obj.content);
    }
  }
  return parts.length ? parts.join("\n") : stdout;
}

// One spawn attempt: the descriptor's argv with the env merge rule, stdout
// captured to the results dir. Never throws on a nonzero exit -- the exit code
// is data (the retry policy and the results file both need it).
async function spawnAttempt(cell, { resultsDir, attempt }) {
  const { descriptor } = cell;
  const stdoutFile = join(resultsDir, `${cell.probe}.${cell.lane}.attempt-${attempt}.stdout.jsonl`);
  let exitCode = 0;
  let stdout = "";
  try {
    ({ stdout } = await pexecFile("kimi", descriptor.argv, {
      cwd: descriptor.cwd,
      env: spawnEnv(descriptor.env),
      timeout: 600_000,
      maxBuffer: 64 * 1024 * 1024
    }));
  } catch (err) {
    exitCode = typeof err.code === "number" ? err.code : 1;
    stdout = err.stdout ?? "";
  }
  await writeFile(stdoutFile, stdout, "utf8");
  return { exitCode, stdout, stdoutFile };
}

// Run one cell: spawn, retry ONCE on nonzero exit/truncated output, then
// attribute tokens via captureSessionId -> resolveSessionForCwd ->
// readSessionUsage. Retried cells are marked so their token totals are
// EXCLUDED from the cost comparison (quality is still recorded).
export async function runCell(cell, { resultsDir }) {
  await mkdir(resultsDir, { recursive: true });
  let attempt = await spawnAttempt(cell, { resultsDir, attempt: 1 });
  let retried = false;
  if (cellNeedsRetry(attempt)) {
    retried = true;
    attempt = await spawnAttempt(cell, { resultsDir, attempt: 2 });
  }
  const sessionId = captureSessionId(attempt.stdout);
  let tokens = null;
  let tokensNote = null;
  if (sessionId) {
    try {
      const resolution = await resolveSessionForCwd({ cwd: cell.descriptor.cwd, capturedSessionId: sessionId });
      if (resolution.resolved) {
        tokens = (await readSessionUsage(resolution.sessionDir)).total;
      } else {
        tokensNote = `session unresolved: ${resolution.reason}`;
      }
    } catch (err) {
      tokensNote = `session attribution failed: ${err.message}`;
    }
  } else {
    tokensNote = "no session.resume_hint in stdout";
  }
  return {
    probe: cell.probe,
    gate: cell.gate,
    lane: cell.lane,
    exitCode: attempt.exitCode,
    verdictText: extractVerdictText(attempt.stdout),
    sessionId,
    tokens,
    ...(tokensNote ? { tokensNote } : {}),
    retried,
    attempts: retried ? 2 : 1,
    stdoutFile: attempt.stdoutFile
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Results assembly
// ───────────────────────────────────────────────────────────────────────────

// Cost comparison per lane. RETRIED CELLS ARE EXCLUDED from the token sums --
// a retried cell paid for two runs, so folding it in would compare unequal
// work. Their verdicts still count for quality (they sit in cells[] verbatim).
export function buildCostComparison(cells) {
  const byLane = {};
  for (const lane of LANES) {
    const counted = cells.filter(c => c.lane === lane && !c.retried && c.tokens);
    const excluded = cells.filter(c => c.lane === lane && (c.retried || !c.tokens));
    const sum = { input: 0, output: 0, total: 0 };
    for (const c of counted) {
      sum.input += c.tokens.input;
      sum.output += c.tokens.output;
      sum.total += c.tokens.total;
    }
    byLane[lane] = {
      cellsCounted: counted.map(c => c.probe),
      cellsExcluded: excluded.map(c => `${c.probe} (${c.retried ? "retried" : "no tokens"})`),
      tokens: sum
    };
  }
  return {
    rule: "retried cells (and cells without token attribution) are EXCLUDED from per-lane token sums; their verdicts remain in cells[] for the quality judgment",
    byLane
  };
}

export function assembleResults({ cells, outFile }) {
  return {
    harness: "eval/kimi-reviewer-tier-probe.mjs",
    generatedAt: new Date().toISOString(),
    caveat: CAVEAT,
    rubric: {
      scoring: "human-judgment",
      note: "caught/missed is HUMAN JUDGMENT applied by the orchestrator against each cell's verbatim verdictText -- this harness deliberately does NOT keyword-score.",
      knownBlockers: [...KNOWN_BLOCKERS],
      expected: {
        "review-gate-diff": "FAIL with a BLOCKER finding matching the pinned known-blocker list",
        "spec-gate-manifest": "FAIL with a finding naming the misattribution: model_preference applies only to spawned subagents; the -p main agent's model comes only from -m"
      }
    },
    constants: {
      probe1Commit: PROBE1_COMMIT,
      probe2Manifest: PROBE2_MANIFEST,
      agentFile: AGENT_FILE,
      lanes: [...LANES]
    },
    cells,
    costComparison: buildCostComparison(cells),
    ...(outFile ? { outFile } : {})
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CLI
// ───────────────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { dryRun: false, out: null, resultsDir: null };
  for (const [i, arg] of argv.entries()) {
    if (arg === "--dry-run") opts.dryRun = true;
    else if (arg === "--out") opts.out = argv[i + 1];
    else if (arg === "--results-dir") opts.resultsDir = argv[i + 1];
    else throw new Error(`unknown argument: ${arg}`);
  }
  return opts;
}

async function main(argv) {
  const opts = parseArgs(argv);
  const cells = buildCells({});
  if (opts.dryRun) {
    // Build every descriptor and print WITHOUT spawning -- tests and review
    // inspect exactly this.
    const view = cells.map(c => ({
      probe: c.probe,
      gate: c.gate,
      lane: c.lane,
      brief: c.brief,
      argv: c.descriptor.argv,
      env: c.descriptor.env,
      cwd: c.descriptor.cwd
    }));
    process.stdout.write(JSON.stringify({ mode: "dry-run", cells: view }, null, 2) + "\n");
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outFile = resolve(opts.out ?? join(REPO_ROOT, "eval", "results", `kimi-reviewer-tier-probe-${stamp}.json`));
  const resultsDir = resolve(opts.resultsDir ?? join(dirname(outFile), `kimi-reviewer-tier-probe-${stamp}.stdout`));
  const records = [];
  for (const cell of cells) {
    process.stderr.write(`running ${cell.probe} x ${cell.lane}...\n`);
    records.push(await runCell(cell, { resultsDir }));
  }
  const results = assembleResults({ cells: records, outFile });
  await mkdir(dirname(outFile), { recursive: true });
  await writeFile(outFile, JSON.stringify(results, null, 2) + "\n", "utf8");
  process.stdout.write(`${outFile}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch(err => {
    process.stderr.write(`kimi-reviewer-tier-probe: ${err.message}\n`);
    process.exit(1);
  });
}
