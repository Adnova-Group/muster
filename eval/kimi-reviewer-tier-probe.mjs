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
// PROTOCOL v2 -- BLINDED QUARANTINE. The v1 run (protocolVersion absent/1)
// was CONTAMINATED: cells ran with cwd = the repo worktree, so the answer key
// was tool-reachable (git history held the fix commit, eval/results held prior
// cells' verdicts, the repo held the harness's pinned constants) -- and the
// verdict texts show agents reading them. v2 closes that:
//   1. QUARANTINE MODE: each cell runs with cwd = a fresh temp dir containing
//      ONLY the probe material as a file (probe 1: probe.patch; probe 2:
//      probe-manifest.json). The brief references that file by relative name
//      and explicitly instructs: review ONLY this material, do not read other
//      files, do not run git commands. Briefs stay pinned constants, extended
//      with the quarantine instruction, identical across lanes.
//   2. CONTAMINATION SCAN: after each cell its stream-json stdout is
//      mechanically scanned for contamination indicators (file reads outside
//      the quarantine dir, any git show/log/diff command, any path containing
//      the repo name or eval/results). Contaminated cells are flagged in the
//      results JSON (contaminated: true) and EXCLUDED from the quality
//      comparison -- recorded, never hidden. Token totals are still recorded
//      per the cost policy.
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
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
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

// Protocol version: 2 = blinded quarantine (v1 results are contaminated and
// were discarded -- see the header comment and docs/fast-path-token-gap.md).
export const PROTOCOL_VERSION = 2;

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

// Briefs, pinned and IDENTICAL across lanes. v2 quarantine: the brief no
// longer inlines the artifact -- it names the quarantine file (relative, so
// every cell's brief is byte-identical) and carries the quarantine
// instruction verbatim. Each states the return contract: verdict first, then
// itemized findings.
const QUARANTINE_INSTRUCTION = "Review ONLY that file's material: do not read any other file, do not run git commands, and do not go looking for the repository -- the quarantine file is the complete review subject.";

export const PROBE1_BRIEF = `You are the review gate for a muster wave. The diff under review is the file probe.patch in your current working directory (the full diff of commit ${PROBE1_COMMIT}, parent of the follow-up fix). ${QUARANTINE_INSTRUCTION} Review the diff for correctness and completeness.
Return contract: your FIRST word must be the verdict, PASS or FAIL, alone on the first line. Then itemized findings, one per line, each classified BLOCKER or MINOR with the file and the reason. The verdict is FAIL iff any BLOCKER finding exists.`;

export const PROBE2_BRIEF = `You are the spec gate for a muster run. The Crew Manifest under review is the file probe-manifest.json in your current working directory. ${QUARANTINE_INSTRUCTION} Apply a lazy/malicious probe to the manifest: hunt for every way a lazy or malicious reading of this spec breaks the run, contradicts the harness's actual behavior, or misattributes a mechanism.
Return contract: your FIRST word must be the verdict, PASS or FAIL, alone on the first line. Then itemized findings, one per line, each classified BLOCKER or MINOR, naming the misattributed or broken claim and the correct mechanism. The verdict is FAIL iff any BLOCKER finding exists.`;

export const PROBES = Object.freeze([
  { id: "review-gate-diff", gate: "review-gate" },
  { id: "spec-gate-manifest", gate: "spec-gate" }
]);
export const LANES = Object.freeze(["primary", "secondary"]);

// The quarantine material file per probe -- the ONLY file in each cell's
// temp working dir.
export const PROBE_MATERIAL_FILES = Object.freeze({
  "review-gate-diff": "probe.patch",
  "spec-gate-manifest": "probe-manifest.json"
});

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
// (src/kimi-dispatch.js). v2 briefs are small constants that REFERENCE the
// quarantine file rather than inlining it, so they sit far under the budget;
// fitBrief remains for any caller that still inlines an artifact: when the
// budget is exceeded, cut the artifact at the last newline that fits and say
// so in the brief -- deterministic, and the truncation is disclosed.
export function fitBrief(prefix, artifact) {
  if (prefix.length + artifact.length <= KIMI_PROCESS_MAX_BRIEF) return prefix + artifact;
  const note = "\n[artifact truncated to fit the -p brief budget]\n";
  const room = KIMI_PROCESS_MAX_BRIEF - prefix.length - note.length;
  const cut = artifact.lastIndexOf("\n", room);
  return prefix + artifact.slice(0, cut > 0 ? cut : room) + note;
}

export function buildBriefs() {
  return {
    "review-gate-diff": PROBE1_BRIEF,
    "spec-gate-manifest": PROBE2_BRIEF
  };
}

// The quarantine material for one probe: probe 1's diff retrieved live from
// the repo (never hardcoded), probe 2's pinned synthetic manifest.
export function probeMaterial(probeId, repoRoot = REPO_ROOT) {
  const file = PROBE_MATERIAL_FILES[probeId];
  if (!file) throw new Error(`probeMaterial: unknown probe ${JSON.stringify(probeId)}`);
  if (probeId === "review-gate-diff") return probe1Diff(repoRoot);
  return JSON.stringify(PROBE2_MANIFEST, null, 2) + "\n";
}

// QUARANTINE MODE (protocol v2): a fresh temp dir containing ONLY the probe
// material file. The cell's cwd is this dir, so nothing else is in reach by
// default -- no repo, no git history, no prior cells' results. (Dry-run
// builds these too: descriptor construction IS the quarantine construction.)
export function buildQuarantineDir({ probeId, repoRoot = REPO_ROOT, baseDir } = {}) {
  const file = PROBE_MATERIAL_FILES[probeId];
  if (!file) throw new Error(`buildQuarantineDir: unknown probe ${JSON.stringify(probeId)}`);
  const dir = mkdtempSync(join(baseDir ?? tmpdir(), `kimi-tier-probe-${probeId}-`));
  writeFileSync(join(dir, file), probeMaterial(probeId, repoRoot));
  return { dir, file };
}

// Build all probe x lane cells with their kimiProcessDispatch descriptors,
// each in its own quarantine dir. Pure construction -- spawns nothing (this
// is what --dry-run prints).
export function buildCells({ repoRoot = REPO_ROOT, agentFile = AGENT_FILE, baseDir } = {}) {
  const briefs = buildBriefs();
  const cells = [];
  for (const probe of PROBES) {
    const brief = briefs[probe.id];
    for (const lane of LANES) {
      const quarantine = buildQuarantineDir({ probeId: probe.id, repoRoot, baseDir });
      cells.push({
        probe: probe.id,
        gate: probe.gate,
        lane,
        brief,
        quarantineDir: quarantine.dir,
        materialFile: quarantine.file,
        descriptor: kimiProcessDispatch({ brief, agentFile, cwd: quarantine.dir, lane })
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

// ───────────────────────────────────────────────────────────────────────────
// Contamination scan (protocol v2): mechanical, over the cell's stream-json
// stdout. Three indicator classes, each recorded with its line number:
//   git-command            a Bash tool call running `git show|log|diff`
//   read-outside-quarantine  a Read/ReadMediaFile/Grep/Glob tool call whose
//                          path argument is absolute and outside the cell's
//                          quarantine dir
//   forbidden-path         any line containing a path with the repo name
//                          ("/muster/" or the repo root itself) or
//                          "eval/results" -- the answer-key locations
// The scan is deliberately mechanical (no judgment): a flagged cell is
// EXCLUDED from the quality comparison, recorded, never hidden.
// ───────────────────────────────────────────────────────────────────────────

const GIT_FORBIDDEN_RE = /\bgit\s+(show|log|diff)\b/;
const READ_PATH_TOOLS = new Set(["Read", "ReadMediaFile", "Grep", "Glob"]);
const PATH_ARG_KEYS = ["path", "file_path", "filePath"];
const REPO_NAME_PATH_RE = /\/muster(?:\/|$|["'\s)])/;

export function scanContamination(stdout, { quarantineDir, repoRoot = REPO_ROOT } = {}) {
  if (typeof stdout !== "string") throw new Error("scanContamination: stdout must be a string");
  if (typeof quarantineDir !== "string" || !quarantineDir) throw new Error("scanContamination: quarantineDir is required");
  const indicators = [];
  for (const [index, line] of stdout.split("\n").entries()) {
    if (!line.trim()) continue;
    const lineNo = index + 1;
    if (line.includes("eval/results")) {
      indicators.push({ line: lineNo, kind: "forbidden-path", detail: "path containing eval/results" });
    }
    if (REPO_NAME_PATH_RE.test(line)) {
      indicators.push({ line: lineNo, kind: "forbidden-path", detail: "path containing the repo name (muster)" });
    } else if (repoRoot && line.includes(repoRoot)) {
      indicators.push({ line: lineNo, kind: "forbidden-path", detail: `path containing the repo root ${repoRoot}` });
    }
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const calls = obj?.tool_calls;
    if (!Array.isArray(calls)) continue;
    for (const call of calls) {
      const name = call?.function?.name;
      let args = {};
      try { args = JSON.parse(call?.function?.arguments ?? "{}"); } catch { args = {}; }
      if (name === "Bash") {
        const command = typeof args.command === "string" ? args.command : String(call?.function?.arguments ?? "");
        if (GIT_FORBIDDEN_RE.test(command)) {
          indicators.push({ line: lineNo, kind: "git-command", detail: command.slice(0, 160) });
        }
      }
      if (READ_PATH_TOOLS.has(name)) {
        for (const key of PATH_ARG_KEYS) {
          const p = args[key];
          if (typeof p === "string" && p.startsWith("/") && p !== quarantineDir && !p.startsWith(quarantineDir + "/")) {
            indicators.push({ line: lineNo, kind: "read-outside-quarantine", detail: `${name} ${p}` });
          }
        }
      }
    }
  }
  return { contaminated: indicators.length > 0, indicators };
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
// readSessionUsage, then contamination-scan the final attempt's stdout.
// Retried cells are marked so their token totals are EXCLUDED from the cost
// comparison; contaminated cells are marked so their verdicts are EXCLUDED
// from the quality comparison. Both stay recorded in cells[] -- never hidden.
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
  const scan = scanContamination(attempt.stdout, { quarantineDir: cell.descriptor.cwd });
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
    quarantineDir: cell.descriptor.cwd,
    materialFile: cell.materialFile,
    contaminated: scan.contaminated,
    contaminationIndicators: scan.indicators,
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

// Quality exclusion (protocol v2): contaminated cells are EXCLUDED from the
// caught/missed quality comparison. Their records (verdict text, indicators,
// tokens) stay in cells[] and their tokens still count in costComparison --
// excluded from the judgment, never hidden.
export function buildQualityComparison(cells) {
  const included = cells.filter(c => !c.contaminated);
  const excluded = cells.filter(c => c.contaminated);
  return {
    rule: "contaminated cells (contamination indicators found in the cell's stream-json stdout) are EXCLUDED from the quality comparison; they remain recorded in cells[] with their indicators, and their tokens still count in costComparison",
    cellsIncluded: included.map(c => `${c.probe} x ${c.lane}`),
    cellsExcluded: excluded.map(c => `${c.probe} x ${c.lane} (${c.contaminationIndicators.map(i => i.kind).join(", ")})`)
  };
}

export function assembleResults({ cells, outFile }) {
  return {
    harness: "eval/kimi-reviewer-tier-probe.mjs",
    protocolVersion: PROTOCOL_VERSION,
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
      probeMaterialFiles: { ...PROBE_MATERIAL_FILES },
      agentFile: AGENT_FILE,
      lanes: [...LANES]
    },
    cells,
    costComparison: buildCostComparison(cells),
    qualityComparison: buildQualityComparison(cells),
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
      cwd: c.descriptor.cwd,
      quarantineDir: c.quarantineDir,
      materialFile: c.materialFile
    }));
    process.stdout.write(JSON.stringify({ mode: "dry-run", protocolVersion: PROTOCOL_VERSION, cells: view }, null, 2) + "\n");
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
