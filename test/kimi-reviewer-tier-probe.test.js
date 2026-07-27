// Reviewer-tier probe harness (eval/kimi-reviewer-tier-probe.mjs): pinned
// constants, descriptor construction via --dry-run (both probes x both lanes),
// the env merge rule, results-JSON shape on canned fixtures, and the
// retry-exclusion logic. NO live model calls -- the only spawns are the
// harness's own --dry-run mode, which builds descriptors without spawning kimi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  KNOWN_BLOCKERS, PROBE1_COMMIT, PROBE2_MANIFEST, PROBE1_BRIEF, PROBE2_BRIEF,
  PROBES, LANES, AGENT_FILE, CAVEAT,
  buildCells, fitBrief, spawnEnv, cellNeedsRetry, extractVerdictText,
  buildCostComparison, assembleResults
} from "../eval/kimi-reviewer-tier-probe.mjs";
import { KIMI_LANES, kimiLaneEnv } from "../src/kimi.js";
import { KIMI_PROCESS_MAX_BRIEF } from "../src/kimi-dispatch.js";
import { readSessionUsage } from "../src/kimi-receipts.js";

const pexecFile = promisify(execFile);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SCRIPT = join(REPO_ROOT, "eval", "kimi-reviewer-tier-probe.mjs");
const FIXTURE_STDOUT = join(REPO_ROOT, "test", "fixtures", "kimi-stream-stdout.jsonl");
const FIXTURE_SESSION = join(REPO_ROOT, "test", "fixtures", "kimi-session-usage");

// A throwaway KIMI_CODE_HOME carrying the agent file kimiProcessDispatch
// resolves bare names against -- keeps the dry-run hermetic.
function fakeKimiHome() {
  const home = mkdtempSync(join(tmpdir(), "kimi-probe-home-"));
  mkdirSync(join(home, "agents"), { recursive: true });
  writeFileSync(join(home, "agents", AGENT_FILE), "---\nname: muster-reviewer\n---\n");
  return home;
}

async function dryRun() {
  const home = fakeKimiHome();
  const { stdout } = await pexecFile(process.execPath, [SCRIPT, "--dry-run"], {
    cwd: REPO_ROOT,
    env: { ...process.env, KIMI_CODE_HOME: home },
    maxBuffer: 16 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

// --- Pinned constants --------------------------------------------------------

test("KNOWN_BLOCKERS is pinned verbatim (the human-judgment rubric for probe 1)", () => {
  assert.deepEqual([...KNOWN_BLOCKERS], [
    "env merge semantics unstated: kimiLaneEnv() returns exactly two keys, and prose instructing spawn straight from the descriptor env replaces the child environment wholesale, losing HOME/PATH"
  ]);
});

test("PROBE2_MANIFEST carries the model_preference misattribution the spec gate must catch", () => {
  assert.equal(PROBE2_MANIFEST.schema, "muster-crew-manifest/v1");
  assert.match(PROBE2_MANIFEST.outcome, /stamped model_preference on the --agent-file agent engages the -p process's own model lanes/);
  assert.equal(PROBE1_COMMIT, "9027136");
});

test("briefs are pinned constants stating the return contract (verdict first, itemized findings)", () => {
  for (const brief of [PROBE1_BRIEF, PROBE2_BRIEF]) {
    assert.match(brief, /FIRST word must be the verdict, PASS or FAIL/);
    assert.match(brief, /itemized findings/);
    assert.match(brief, /BLOCKER or MINOR/);
  }
  // probe 1 = review-gate style; probe 2 = spec-gate style (lazy/malicious probe)
  assert.match(PROBE1_BRIEF, /review gate/);
  assert.match(PROBE1_BRIEF, /Review the diff below/);
  assert.match(PROBE2_BRIEF, /spec gate/);
  assert.match(PROBE2_BRIEF, /lazy\/malicious probe/);
  assert.match(CAVEAT, /n=1 per cell/);
});

// --- Descriptor construction (both probes x both lanes, via --dry-run) -------

test("--dry-run builds 2 probes x 2 lanes of descriptors and spawns nothing", async () => {
  const out = await dryRun();
  assert.equal(out.mode, "dry-run");
  assert.equal(out.cells.length, PROBES.length * LANES.length);
  assert.deepEqual([...new Set(out.cells.map(c => c.probe))].sort(), ["review-gate-diff", "spec-gate-manifest"]);
  for (const cell of out.cells) {
    // the descriptor argv shape, with -m ALWAYS emitted and binding the lane
    assert.equal(cell.argv[0], "-p");
    assert.equal(cell.argv[1], cell.brief);
    assert.deepEqual(cell.argv.slice(2, 5), ["--agent-file", cell.argv[3], "--output-format"]);
    assert.equal(cell.argv[5], "stream-json");
    assert.equal(cell.argv[6], "-m");
    assert.equal(cell.argv[7], KIMI_LANES[cell.lane]);
    assert.ok(cell.argv[3].endsWith(AGENT_FILE), "agent file resolves under the installed agents dir");
    assert.equal(cell.cwd, REPO_ROOT);
    // the env is the OVERRIDE PAIR ONLY -- never the whole environment
    assert.deepEqual(cell.env, kimiLaneEnv());
    assert.deepEqual(Object.keys(cell.env).sort(), ["KIMI_CODE_EXPERIMENTAL_FLAG", "KIMI_SECONDARY_MODEL"]);
  }
});

test("--dry-run binds primary to k3 and secondary to kimi-for-coding", async () => {
  const out = await dryRun();
  const byLane = Object.fromEntries(LANES.map(l => [l, out.cells.filter(c => c.lane === l)]));
  assert.equal(byLane.primary.length, 2);
  assert.equal(byLane.secondary.length, 2);
  for (const cell of byLane.primary) assert.equal(cell.argv[7], "kimi-code/k3");
  for (const cell of byLane.secondary) assert.equal(cell.argv[7], "kimi-code/kimi-for-coding");
});

test("--dry-run briefs are identical across lanes and carry each probe's subject", async () => {
  const out = await dryRun();
  for (const probe of ["review-gate-diff", "spec-gate-manifest"]) {
    const briefs = out.cells.filter(c => c.probe === probe).map(c => c.brief);
    assert.equal(briefs.length, 2);
    assert.equal(briefs[0], briefs[1], "briefs must be identical across lanes");
    assert.ok(briefs[0].length <= KIMI_PROCESS_MAX_BRIEF, "brief must fit the -p budget");
  }
  const p1 = out.cells.find(c => c.probe === "review-gate-diff").brief;
  // the probe-1 subject is the real 9027136 diff, with the prose the known
  // blocker lives in
  assert.match(p1, /git show 9027136/);
  assert.match(p1, /Attended sessions dispatch lane-sensitive legs as headless `kimi -p` processes/);
  const p2 = out.cells.find(c => c.probe === "spec-gate-manifest").brief;
  assert.match(p2, /muster-crew-manifest\/v1/);
  assert.match(p2, /model_preference/);
  // the known-blocker list is the rubric, NEVER shown to the reviewer
  assert.ok(!p1.includes(KNOWN_BLOCKERS[0]), "the known-blocker list must not leak into the probe-1 brief");
});

// --- The env merge rule ------------------------------------------------------

test("spawnEnv merges the descriptor env OVER the ambient env -- never wholesale replacement", () => {
  const base = { HOME: "/home/x", PATH: "/usr/bin", KIMI_SECONDARY_MODEL: "stale" };
  const merged = spawnEnv({ KIMI_CODE_EXPERIMENTAL_FLAG: "1", KIMI_SECONDARY_MODEL: "kimi-code/kimi-for-coding" }, base);
  assert.equal(merged.HOME, "/home/x", "wholesale replacement loses HOME");
  assert.equal(merged.PATH, "/usr/bin", "wholesale replacement loses PATH");
  assert.equal(merged.KIMI_CODE_EXPERIMENTAL_FLAG, "1");
  assert.equal(merged.KIMI_SECONDARY_MODEL, "kimi-code/kimi-for-coding", "descriptor keys override ambient ones");
});

test("fitBrief truncates over-budget artifacts at a newline with a disclosed note", () => {
  const small = fitBrief("prefix:", "short artifact");
  assert.equal(small, "prefix:short artifact");
  const big = fitBrief("prefix:", ("x".repeat(100) + "\n").repeat(200));
  assert.ok(big.length <= KIMI_PROCESS_MAX_BRIEF);
  assert.match(big, /artifact truncated to fit the -p brief budget/);
});

// --- Retry policy ------------------------------------------------------------

test("cellNeedsRetry: nonzero exit or truncated stdout triggers the single retry", () => {
  const good = readFileSync(FIXTURE_STDOUT, "utf8");
  assert.equal(cellNeedsRetry({ exitCode: 0, stdout: good }), false);
  assert.equal(cellNeedsRetry({ exitCode: 1, stdout: good }), true, "nonzero exit retries");
  assert.equal(cellNeedsRetry({ exitCode: 0, stdout: "" }), true, "empty stdout is truncated");
  assert.equal(cellNeedsRetry({ exitCode: 0, stdout: "{\"role\":\"assistant\",\"content\":\"PASS\"}\n" }), true,
    "no session.resume_hint means the stream-json run was truncated");
});

// --- Verdict extraction (raw, verbatim; NO keyword scoring) ------------------

test("extractVerdictText returns the assistant text verbatim from canned stream-json stdout", () => {
  const stdout = readFileSync(FIXTURE_STDOUT, "utf8");
  assert.equal(extractVerdictText(stdout), "ok");
  // unparseable stdout falls back to the raw text -- the human-judgment step
  // still gets exactly what the run emitted
  assert.equal(extractVerdictText("not json at all"), "not json at all");
});

// --- Results JSON shape (canned fixtures) ------------------------------------

async function cannedCells() {
  const tokens = (await readSessionUsage(FIXTURE_SESSION)).total;
  const stdout = readFileSync(FIXTURE_STDOUT, "utf8");
  return [
    { probe: "review-gate-diff", gate: "review-gate", lane: "primary", exitCode: 0, verdictText: extractVerdictText(stdout), sessionId: "session_a", tokens, retried: false, attempts: 1, stdoutFile: "x" },
    { probe: "review-gate-diff", gate: "review-gate", lane: "secondary", exitCode: 0, verdictText: "FAIL\nBLOCKER: ...", sessionId: "session_b", tokens, retried: false, attempts: 1, stdoutFile: "x" },
    { probe: "spec-gate-manifest", gate: "spec-gate", lane: "primary", exitCode: 0, verdictText: "FAIL\nBLOCKER: ...", sessionId: "session_c", tokens, retried: false, attempts: 1, stdoutFile: "x" },
    { probe: "spec-gate-manifest", gate: "spec-gate", lane: "secondary", exitCode: 1, verdictText: "", sessionId: null, tokens, retried: true, attempts: 2, stdoutFile: "x" }
  ];
}

test("assembleResults emits the full results shape with the caveat and human-judgment rubric", async () => {
  const results = assembleResults({ cells: await cannedCells(), outFile: "/tmp/out.json" });
  assert.equal(results.harness, "eval/kimi-reviewer-tier-probe.mjs");
  assert.match(results.caveat, /n=1 per cell/);
  assert.equal(results.rubric.scoring, "human-judgment");
  assert.match(results.rubric.note, /does NOT keyword-score/);
  assert.deepEqual(results.rubric.knownBlockers, [...KNOWN_BLOCKERS]);
  assert.deepEqual(results.constants.probe2Manifest, PROBE2_MANIFEST);
  assert.equal(results.constants.probe1Commit, "9027136");
  assert.equal(results.cells.length, 4);
  for (const cell of results.cells) {
    for (const key of ["probe", "lane", "exitCode", "verdictText", "sessionId", "tokens", "retried"]) {
      assert.ok(key in cell, `cell must record ${key}`);
    }
  }
  assert.equal(results.outFile, "/tmp/out.json");
});

test("cost comparison EXCLUDES retried cells' tokens but keeps their quality record", async () => {
  const cells = await cannedCells();
  const results = assembleResults({ cells });
  const { byLane, rule } = results.costComparison;
  assert.match(rule, /EXCLUDED/);
  // secondary's only spec-gate cell was retried: excluded from the sums
  assert.deepEqual(byLane.secondary.cellsCounted, ["review-gate-diff"]);
  assert.deepEqual(byLane.secondary.cellsExcluded, ["spec-gate-manifest (retried)"]);
  // but the retried cell itself (verdict text, retry flag) is still in cells[]
  const retried = results.cells.find(c => c.probe === "spec-gate-manifest" && c.lane === "secondary");
  assert.equal(retried.retried, true);
  assert.equal(retried.attempts, 2);
  assert.ok("verdictText" in retried);
  // per-lane sums count only the non-retried cells: primary has 2, secondary 1
  const perCell = cells[0].tokens.total;
  assert.equal(byLane.primary.tokens.total, perCell * 2);
  assert.equal(byLane.secondary.tokens.total, perCell);
});
