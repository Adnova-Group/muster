// Reviewer-tier probe harness (eval/kimi-reviewer-tier-probe.mjs): pinned
// constants, descriptor construction via --dry-run (both probes x both lanes),
// quarantine-dir construction, the contamination scanner (positive/negative
// canned cases), the quality-exclusion logic, the env merge rule, and the
// results-JSON shape on canned fixtures. NO live model calls -- the only
// spawns are the harness's own --dry-run mode, which builds descriptors
// without spawning kimi.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";
import {
  KNOWN_BLOCKERS, PROBE1_COMMIT, PROBE2_MANIFEST, PROBE1_BRIEF, PROBE2_BRIEF,
  PROBES, LANES, AGENT_FILE, CAVEAT, PROTOCOL_VERSION, PROBE_MATERIAL_FILES,
  EFFORTS, EFFORT_ENV_VAR, PROBE_MODES,
  buildCells, buildBriefs, buildQuarantineDir, probeMaterial, fitBrief,
  spawnEnv, cellNeedsRetry, extractVerdictText, scanContamination,
  effortCellVerdict, buildCostComparison, buildQualityComparison,
  buildEffortComparison, assembleResults
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

async function dryRun(extraArgs = []) {
  const home = fakeKimiHome();
  const { stdout } = await pexecFile(process.execPath, [SCRIPT, "--dry-run", ...extraArgs], {
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
  assert.equal(PROBE1_COMMIT, "d5ae59d");
});

test("briefs are pinned constants stating the return contract, the quarantine file, and the quarantine instruction", () => {
  assert.equal(PROTOCOL_VERSION, 2);
  for (const brief of [PROBE1_BRIEF, PROBE2_BRIEF]) {
    assert.match(brief, /FIRST word must be the verdict, PASS or FAIL/);
    assert.match(brief, /itemized findings/);
    assert.match(brief, /BLOCKER or MINOR/);
    // the v2 quarantine instruction, verbatim in both briefs
    assert.match(brief, /Review ONLY that file's material: do not read any other file, do not run git commands/);
  }
  // probe 1 = review-gate style over probe.patch; probe 2 = spec-gate style
  // (lazy/malicious probe) over probe-manifest.json
  assert.match(PROBE1_BRIEF, /review gate/);
  assert.match(PROBE1_BRIEF, /probe\.patch/);
  assert.match(PROBE2_BRIEF, /spec gate/);
  assert.match(PROBE2_BRIEF, /lazy\/malicious probe/);
  assert.match(PROBE2_BRIEF, /probe-manifest\.json/);
  assert.match(CAVEAT, /n=1 per cell/);
});

// --- Descriptor construction (both probes x both lanes, via --dry-run) -------

test("--dry-run builds 2 probes x 2 lanes of descriptors and spawns nothing", async () => {
  const out = await dryRun();
  assert.equal(out.mode, "dry-run");
  assert.equal(out.protocolVersion, 2);
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
    // QUARANTINE: cwd is the cell's own fresh temp dir, never the repo
    assert.equal(cell.cwd, cell.quarantineDir);
    assert.notEqual(cell.cwd, REPO_ROOT);
    assert.ok(cell.cwd.startsWith(tmpdir()), "quarantine dir lives under the temp dir");
    // the env is the OVERRIDE PAIR ONLY -- never the whole environment
    assert.deepEqual(cell.env, kimiLaneEnv());
    assert.deepEqual(Object.keys(cell.env).sort(), ["KIMI_CODE_EXPERIMENTAL_FLAG", "KIMI_SECONDARY_MODEL"]);
  }
});

test("quarantine dirs are fresh per cell and contain ONLY the probe material file", async () => {
  const out = await dryRun();
  const dirs = out.cells.map(c => c.quarantineDir);
  assert.equal(new Set(dirs).size, dirs.length, "every cell gets its own quarantine dir");
  for (const cell of out.cells) {
    assert.equal(cell.materialFile, PROBE_MATERIAL_FILES[cell.probe]);
    assert.deepEqual(readdirSync(cell.quarantineDir), [cell.materialFile], "the material file is the ONLY file in the dir");
    const content = readFileSync(join(cell.quarantineDir, cell.materialFile), "utf8");
    assert.equal(content, probeMaterial(cell.probe, REPO_ROOT));
  }
  // probe 1's material is the real, reachable d5ae59d diff, with the prose the known
  // blocker lives in; probe 2's is the pinned synthetic manifest
  const p1 = out.cells.find(c => c.probe === "review-gate-diff");
  const p1Material = readFileSync(join(p1.quarantineDir, p1.materialFile), "utf8");
  assert.match(p1Material, /Attended sessions dispatch lane-sensitive legs as headless `kimi -p` processes/);
  const p2 = out.cells.find(c => c.probe === "spec-gate-manifest");
  const p2Material = readFileSync(join(p2.quarantineDir, p2.materialFile), "utf8");
  assert.deepEqual(JSON.parse(p2Material), PROBE2_MANIFEST);
  // the known-blocker list is the rubric, NEVER shown to the reviewer -- not
  // in the brief and not in the quarantine material
  assert.ok(!p1.brief.includes(KNOWN_BLOCKERS[0]), "the known-blocker list must not leak into the probe-1 brief");
  assert.ok(!p1Material.includes(KNOWN_BLOCKERS[0]), "the known-blocker list must not leak into the probe-1 material");
});

test("buildQuarantineDir honors an injected baseDir", () => {
  const base = mkdtempSync(join(tmpdir(), "kimi-probe-base-"));
  const q = buildQuarantineDir({ probeId: "spec-gate-manifest", repoRoot: REPO_ROOT, baseDir: base });
  assert.ok(q.dir.startsWith(base), "quarantine dir is built under the injected baseDir");
  assert.equal(q.file, "probe-manifest.json");
  assert.deepEqual(readdirSync(q.dir), ["probe-manifest.json"]);
});

test("--dry-run binds primary to k3 and secondary to kimi-for-coding", async () => {
  const out = await dryRun();
  const byLane = Object.fromEntries(LANES.map(l => [l, out.cells.filter(c => c.lane === l)]));
  assert.equal(byLane.primary.length, 2);
  assert.equal(byLane.secondary.length, 2);
  for (const cell of byLane.primary) assert.equal(cell.argv[7], "kimi-code/k3");
  for (const cell of byLane.secondary) assert.equal(cell.argv[7], "kimi-code/kimi-for-coding");
});

test("--dry-run briefs are identical across lanes and reference each probe's quarantine file", async () => {
  const out = await dryRun();
  for (const probe of ["review-gate-diff", "spec-gate-manifest"]) {
    const briefs = out.cells.filter(c => c.probe === probe).map(c => c.brief);
    assert.equal(briefs.length, 2);
    assert.equal(briefs[0], briefs[1], "briefs must be identical across lanes");
    assert.ok(briefs[0].length <= KIMI_PROCESS_MAX_BRIEF, "brief must fit the -p budget");
    // briefs name the quarantine file by RELATIVE name only -- an absolute
    // temp path would differ per cell and break lane-identity
    assert.ok(!briefs[0].includes(tmpdir()), "brief must not embed the absolute quarantine path");
  }
  assert.match(out.cells.find(c => c.probe === "review-gate-diff").brief, /probe\.patch/);
  assert.match(out.cells.find(c => c.probe === "spec-gate-manifest").brief, /probe-manifest\.json/);
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

test("cellNeedsRetry: a quota/balance fault is NEVER retried (kimi 0.30.0 fail-fast)", () => {
  // The binary marks the quota fault retryable: false -- retrying a billing
  // fault burns wall-clock time, not just quota. The cell keeps its recorded
  // exitCode/verdict for the human-judgment step either way.
  const quotaStream = '{"role":"meta","type":"system.version","version":"0.30.0"}\n' +
    '{"type":"error","code":"api_error","name":"APIProviderQuotaExhaustedError","message":"Exceeded your current quota, please check your account balance","retryable":false}\n';
  assert.equal(cellNeedsRetry({ exitCode: 1, stdout: quotaStream }), false, "quota fault: no retry despite nonzero exit");
  assert.equal(cellNeedsRetry({ exitCode: 0, stdout: quotaStream }), false, "quota fault: no retry despite truncated stream");
  // An ordinary rate-limit 429 is NOT a billing fault and still retries.
  const rateLimited = '{"type":"error","code":"rate_limit","message":"429 too many requests"}\n';
  assert.equal(cellNeedsRetry({ exitCode: 1, stdout: rateLimited }), true, "rate limit stays retryable");
});

test("cellNeedsRetry: quota wording in ASSISTANT text does not suppress the retry (scoped match)", () => {
  // Review-gate minor: the quota match is scoped to error-surface lines, so a
  // run whose model output merely TALKS about billing still retries on a
  // nonzero exit.
  const billingTalk = '{"role":"assistant","content":"You should check your account balance regularly."}\n';
  assert.equal(cellNeedsRetry({ exitCode: 1, stdout: billingTalk }), true);
});

// --- Verdict extraction (raw, verbatim; NO keyword scoring) ------------------

test("extractVerdictText returns the assistant text verbatim from canned stream-json stdout", () => {
  const stdout = readFileSync(FIXTURE_STDOUT, "utf8");
  assert.equal(extractVerdictText(stdout), "ok");
  // unparseable stdout falls back to the raw text -- the human-judgment step
  // still gets exactly what the run emitted
  assert.equal(extractVerdictText("not json at all"), "not json at all");
});

// --- Contamination scanner (positive/negative canned cases) ------------------

const QUAR = "/tmp/kimi-tier-probe-canned";
const toolCallLine = (name, args) =>
  JSON.stringify({ role: "assistant", tool_calls: [{ type: "function", id: "t1", function: { name, arguments: JSON.stringify(args) } }] });

test("scanContamination: a clean quarantined run yields no indicators", () => {
  const stdout = [
    JSON.stringify({ role: "meta", type: "system.version", version: "0.29.1" }),
    toolCallLine("Read", { path: `${QUAR}/probe.patch` }),                       // inside quarantine: fine
    toolCallLine("Read", { path: "probe.patch" }),                               // relative: resolves inside cwd
    toolCallLine("Bash", { command: "cat probe.patch | head -50" }),             // no git, no outside path
    toolCallLine("Grep", { pattern: "kimiLaneEnv", path: QUAR }),                // the quarantine dir itself
    JSON.stringify({ role: "assistant", content: "FAIL\nBLOCKER: ..." })
  ].join("\n");
  const scan = scanContamination(stdout, { quarantineDir: QUAR });
  assert.equal(scan.contaminated, false);
  assert.deepEqual(scan.indicators, []);
});

test("scanContamination: git show/log/diff in a Bash tool call is flagged", () => {
  for (const cmd of ["git show 9027136", "git log --oneline -5", "git diff HEAD~1", "cd /tmp && git show abc | head"]) {
    const scan = scanContamination(toolCallLine("Bash", { command: cmd }), { quarantineDir: QUAR });
    assert.equal(scan.contaminated, true, cmd);
    assert.equal(scan.indicators[0].kind, "git-command");
  }
  // a non-git Bash command is not flagged
  assert.equal(scanContamination(toolCallLine("Bash", { command: "ls -la" }), { quarantineDir: QUAR }).contaminated, false);
});

test("scanContamination: file reads outside the quarantine dir are flagged", () => {
  const scan = scanContamination(toolCallLine("Read", { path: "/home/ryan/dev/muster/src/kimi-dispatch.js" }), { quarantineDir: QUAR });
  const kinds = scan.indicators.map(i => i.kind);
  assert.ok(kinds.includes("read-outside-quarantine"));
  assert.ok(kinds.includes("forbidden-path"), "the same line also trips the repo-name path rule");
  assert.equal(scan.contaminated, true);
  // Grep/Glob with an outside path are reads too
  assert.ok(scanContamination(toolCallLine("Grep", { pattern: "x", path: "/etc" }), { quarantineDir: QUAR }).indicators
    .some(i => i.kind === "read-outside-quarantine"));
});

test("scanContamination: paths containing the repo name or eval/results are flagged anywhere in the line", () => {
  for (const line of [
    JSON.stringify({ role: "tool", content: "/home/ryan/dev/muster/src/kimi.js" }),
    JSON.stringify({ role: "tool", content: "see eval/results/kimi-reviewer-tier-probe-x.json" }),
    toolCallLine("Bash", { command: "cat /home/ryan/dev/muster/eval/results/x.json" })
  ]) {
    const scan = scanContamination(line, { quarantineDir: QUAR });
    assert.ok(scan.contaminated, line.slice(0, 60));
    assert.ok(scan.indicators.some(i => i.kind === "forbidden-path"));
  }
  // lookalikes are NOT the repo: muster-reviewer.md, "the muster wave" prose
  const benign = [
    JSON.stringify({ role: "assistant", content: "FAIL\nBLOCKER: muster-reviewer.md misattributes model_preference" }),
    JSON.stringify({ role: "tool", content: "/home/ryan/.kimi-code/agents/muster-reviewer.md" })
  ].join("\n");
  assert.equal(scanContamination(benign, { quarantineDir: QUAR }).contaminated, false);
});

// --- Quality exclusion (contaminated cells out of the judgment, never hidden)

test("buildQualityComparison excludes contaminated cells from the judgment but keeps them recorded", async () => {
  const cells = await cannedCells();
  cells[1].contaminated = true;
  cells[1].contaminationIndicators = [{ line: 3, kind: "git-command", detail: "git show 9027136" }];
  for (const c of cells) { c.contaminated ??= false; c.contaminationIndicators ??= []; }
  const qc = buildQualityComparison(cells);
  assert.match(qc.rule, /EXCLUDED/);
  assert.equal(qc.cellsIncluded.length, 3);
  assert.deepEqual(qc.cellsExcluded, ["review-gate-diff x secondary (git-command)"]);
  // the contaminated cell itself is still in cells[] with its verdict text
  const flagged = cells[1];
  assert.equal(flagged.contaminated, true);
  assert.ok("verdictText" in flagged);
});

// --- Results JSON shape (canned fixtures) ------------------------------------

async function cannedCells() {
  const tokens = (await readSessionUsage(FIXTURE_SESSION)).total;
  const stdout = readFileSync(FIXTURE_STDOUT, "utf8");
  const base = { contaminated: false, contaminationIndicators: [], materialFile: "probe.patch", quarantineDir: "/tmp/kimi-tier-probe-canned" };
  return [
    { ...base, probe: "review-gate-diff", gate: "review-gate", lane: "primary", exitCode: 0, verdictText: extractVerdictText(stdout), sessionId: "session_a", tokens, retried: false, attempts: 1, stdoutFile: "x" },
    { ...base, probe: "review-gate-diff", gate: "review-gate", lane: "secondary", exitCode: 0, verdictText: "FAIL\nBLOCKER: ...", sessionId: "session_b", tokens, retried: false, attempts: 1, stdoutFile: "x" },
    { ...base, probe: "spec-gate-manifest", gate: "spec-gate", lane: "primary", exitCode: 0, verdictText: "FAIL\nBLOCKER: ...", sessionId: "session_c", tokens, retried: false, attempts: 1, stdoutFile: "x" },
    { ...base, probe: "spec-gate-manifest", gate: "spec-gate", lane: "secondary", exitCode: 1, verdictText: "", sessionId: null, tokens, retried: true, attempts: 2, stdoutFile: "x" }
  ];
}

test("assembleResults emits the full v2 results shape with the caveat, rubric, and both comparisons", async () => {
  const results = assembleResults({ cells: await cannedCells(), outFile: "/tmp/out.json" });
  assert.equal(results.harness, "eval/kimi-reviewer-tier-probe.mjs");
  assert.equal(results.protocolVersion, 2);
  assert.match(results.caveat, /n=1 per cell/);
  assert.equal(results.rubric.scoring, "human-judgment");
  assert.match(results.rubric.note, /does NOT keyword-score/);
  assert.deepEqual(results.rubric.knownBlockers, [...KNOWN_BLOCKERS]);
  assert.deepEqual(results.constants.probe2Manifest, PROBE2_MANIFEST);
  assert.equal(results.constants.probe1Commit, "d5ae59d");
  assert.deepEqual(results.constants.probeMaterialFiles, { "review-gate-diff": "probe.patch", "spec-gate-manifest": "probe-manifest.json" });
  assert.equal(results.cells.length, 4);
  for (const cell of results.cells) {
    for (const key of ["probe", "lane", "exitCode", "verdictText", "sessionId", "tokens", "retried", "contaminated", "contaminationIndicators"]) {
      assert.ok(key in cell, `cell must record ${key}`);
    }
  }
  // no canned cell is contaminated: all four included in the quality comparison
  assert.equal(results.qualityComparison.cellsIncluded.length, 4);
  assert.deepEqual(results.qualityComparison.cellsExcluded, []);
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

// --- Effort mode (--mode effort): K3 effort dimension over the pinned probes -

test("PROBE_MODES and EFFORTS are pinned: tier|effort, low|high, env var name", () => {
  assert.deepEqual([...PROBE_MODES], ["tier", "effort"]);
  assert.deepEqual([...EFFORTS], ["low", "high"]);
  assert.equal(EFFORT_ENV_VAR, "KIMI_MODEL_THINKING_EFFORT");
});

test("--mode effort --dry-run builds 2 probes x 2 efforts on lane=primary ONLY, effort riding the env", async () => {
  const out = await dryRun(["--mode", "effort"]);
  assert.equal(out.probeMode, "effort");
  assert.equal(out.cells.length, PROBES.length * EFFORTS.length);
  for (const cell of out.cells) {
    assert.equal(cell.lane, "primary", "effort mode runs the primary (k3) lane only");
    assert.equal(cell.argv[7], "kimi-code/k3");
    assert.ok(EFFORTS.includes(cell.effort), `cell effort must be a pinned rung, got ${cell.effort}`);
    // the effort rides the descriptor env as an OVERRIDE key alongside the
    // lane pair -- the spawnEnv merge rule applies it over the ambient env
    assert.equal(cell.env[EFFORT_ENV_VAR], cell.effort);
    assert.deepEqual(Object.keys(cell.env).sort(),
      [EFFORT_ENV_VAR, "KIMI_CODE_EXPERIMENTAL_FLAG", "KIMI_SECONDARY_MODEL"].sort());
    // quarantine protocol unchanged: own fresh dir with only the material file
    assert.equal(cell.cwd, cell.quarantineDir);
    assert.notEqual(cell.cwd, REPO_ROOT);
    assert.deepEqual(readdirSync(cell.quarantineDir), [cell.materialFile]);
  }
  // both effort rungs present per probe, and briefs byte-identical across
  // efforts (the SAME pinned briefs as tier mode -- effort rides ONLY the env)
  for (const probe of ["review-gate-diff", "spec-gate-manifest"]) {
    const group = out.cells.filter(c => c.probe === probe);
    assert.deepEqual(group.map(c => c.effort).sort(), [...EFFORTS].sort());
    assert.equal(group[0].brief, group[1].brief, "briefs must be identical across efforts");
  }
  const dirs = out.cells.map(c => c.quarantineDir);
  assert.equal(new Set(dirs).size, dirs.length, "every effort cell gets its own quarantine dir");
});

test("tier-mode cells carry effort: null and the lane-pair env only (no effort var)", async () => {
  const out = await dryRun();
  for (const cell of out.cells) {
    assert.equal(cell.effort, null);
    assert.ok(!(EFFORT_ENV_VAR in cell.env), "tier mode must not set the effort override");
  }
});

test("spawnEnv applies the effort override over the ambient env (never wholesale)", () => {
  const base = { HOME: "/home/x", PATH: "/usr/bin" };
  const merged = spawnEnv({ ...kimiLaneEnv(), [EFFORT_ENV_VAR]: "low" }, base);
  assert.equal(merged.HOME, "/home/x");
  assert.equal(merged.PATH, "/usr/bin");
  assert.equal(merged[EFFORT_ENV_VAR], "low");
});

test("effortCellVerdict: valid only when every observed step ran the intended effort", () => {
  assert.deepEqual(effortCellVerdict({ expected: "low", observed: ["low", "low"] }), { effortValid: true, effortNote: null });
  assert.deepEqual(effortCellVerdict({ expected: "high", observed: ["high"] }), { effortValid: true, effortNote: null });
  // any other effort (the override was silently ignored) invalidates the cell
  const mixed = effortCellVerdict({ expected: "low", observed: ["low", "high"] });
  assert.equal(mixed.effortValid, false);
  assert.match(mixed.effortNote, /1\/2 llm\.request step/);
  // a step with the field absent is unverifiable, never a pass
  assert.equal(effortCellVerdict({ expected: "low", observed: ["low", null] }).effortValid, false);
  // no receipts at all (unresolved session, empty wire) is unproven -> invalid
  assert.equal(effortCellVerdict({ expected: "low", observed: null }).effortValid, false);
  assert.equal(effortCellVerdict({ expected: "low", observed: [] }).effortValid, false);
  assert.throws(() => effortCellVerdict({ expected: "", observed: ["low"] }), /expected effort is required/);
});

// --- Effort-invalid cell exclusion (exactly like a retried cell) ------------

async function cannedEffortCells() {
  const tokens = (await readSessionUsage(FIXTURE_SESSION)).total;
  const stdout = readFileSync(FIXTURE_STDOUT, "utf8");
  const base = {
    lane: "primary", exitCode: 0, sessionId: "session_e", tokens,
    retried: false, attempts: 1, stdoutFile: "x",
    contaminated: false, contaminationIndicators: [],
    materialFile: "probe.patch", quarantineDir: "/tmp/kimi-tier-probe-canned"
  };
  return [
    { ...base, probe: "review-gate-diff", gate: "review-gate", effort: "low", effortValid: true, observedEfforts: ["low", "low"], verdictText: extractVerdictText(stdout) },
    { ...base, probe: "review-gate-diff", gate: "review-gate", effort: "high", effortValid: true, observedEfforts: ["high"], verdictText: "FAIL\nBLOCKER: ..." },
    // the override was silently ignored: receipts show high on a low cell
    { ...base, probe: "spec-gate-manifest", gate: "spec-gate", effort: "low", effortValid: false, observedEfforts: ["high"], effortNote: "1/1 llm.request step(s) ran thinkingEffort \"high\" instead of \"low\"", verdictText: "FAIL\nBLOCKER: ..." },
    { ...base, probe: "spec-gate-manifest", gate: "spec-gate", effort: "high", effortValid: true, observedEfforts: ["high"], verdictText: "FAIL\nBLOCKER: ..." }
  ];
}

test("cost comparison EXCLUDES effort-invalid cells exactly like retried cells, recorded never hidden", async () => {
  const cells = await cannedEffortCells();
  const { byLane, rule } = buildCostComparison(cells);
  assert.match(rule, /effort-invalid cells/);
  // primary only in effort mode: 3 valid cells counted, the ignored-override
  // cell excluded with an "invalid effort" label
  assert.equal(byLane.primary.cellsCounted.length, 3);
  assert.deepEqual(byLane.primary.cellsExcluded, ["spec-gate-manifest @ low (invalid effort)"]);
  assert.deepEqual(byLane.secondary.cellsCounted, []);
  const perCell = cells[0].tokens.total;
  assert.equal(byLane.primary.tokens.total, perCell * 3, "the invalid cell's tokens stay out of the sum");
  // the invalid cell itself is still recorded verbatim in cells[]
  const invalid = cells.find(c => c.effortValid === false);
  assert.deepEqual(invalid.observedEfforts, ["high"]);
  assert.ok("verdictText" in invalid);
});

test("assembleResults in effort mode emits probeMode, the effort constants, and the per-effort valid/invalid split", async () => {
  const results = assembleResults({ cells: await cannedEffortCells(), mode: "effort" });
  assert.equal(results.probeMode, "effort");
  assert.deepEqual(results.constants.efforts, ["low", "high"]);
  assert.equal(results.constants.effortEnvVar, EFFORT_ENV_VAR);
  const ec = results.effortComparison;
  assert.match(ec.rule, /every llm\.request receipt/);
  assert.equal(ec.envVar, EFFORT_ENV_VAR);
  assert.deepEqual(ec.byEffort.low.cellsValid, ["review-gate-diff"]);
  assert.equal(ec.byEffort.low.cellsInvalid.length, 1);
  assert.match(ec.byEffort.low.cellsInvalid[0], /^spec-gate-manifest \(/);
  assert.deepEqual(ec.byEffort.high.cellsValid.sort(), ["review-gate-diff", "spec-gate-manifest"]);
  assert.deepEqual(ec.byEffort.high.cellsInvalid, []);
  // quality comparison labels carry the effort so same-probe cells stay distinct
  assert.ok(results.qualityComparison.cellsIncluded.includes("spec-gate-manifest x primary @ low"));
  // every effort cell record carries the receipt-proof fields
  for (const cell of results.cells) {
    for (const key of ["effort", "effortValid", "observedEfforts"]) {
      assert.ok(key in cell, `effort-mode cell must record ${key}`);
    }
  }
});
