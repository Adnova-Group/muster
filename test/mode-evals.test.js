import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  gradeCase,
  CHECKS,
  ARTIFACT_KIND,
  planFencesOk,
  resolveMergeDisposition,
  WAVE_COMMIT_RE,
} from "../eval/modes/grade-lib.mjs";

// CI regression guard for the mode-prompt eval (eval/modes/). Two jobs, mirroring
// test/router-eval.test.js's split: (1) unit-test grade-lib's graders directly — a pass
// case and a fail case per check type, so a grader that silently stops catching a real
// defect would itself fail here; (2) grade every checked-in fixture + pure-function case
// in dataset.json and assert the whole code-graded set is green. No model calls anywhere
// in this file (grading: "model" cases are read for shape only, never graded).

const root = new URL("../", import.meta.url);
const read = (rel) => readFile(new URL(rel, root), "utf8");

async function loadArtifacts(testCase) {
  const kind = ARTIFACT_KIND[testCase.check];
  if (!kind || kind === "none") return undefined;
  const raw = testCase.artifact ? await read(`eval/modes/${testCase.artifact}`) : testCase.input;
  return kind === "json" ? JSON.parse(raw) : raw;
}

// --- grade-lib unit tests: one pass + one fail per check type --------------------------

test("diagnose-classify: mode match passes, mismatch fails, empty input throws as expected", () => {
  assert.equal(gradeCase({ check: "diagnose-classify", outcome: "Login button does nothing", expect: { mode: "bug" } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "diagnose-classify", outcome: "Login button does nothing", expect: { mode: "ci" } }, undefined).pass, false);
  assert.equal(gradeCase({ check: "diagnose-classify", outcome: "", expect: { throws: true } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "diagnose-classify", outcome: "", expect: { throws: false, mode: "bug" } }, undefined).pass, false);
});

test("diagnose-manifest: matching plan/crew shape passes, wrong shape fails", () => {
  const good = gradeCase({ check: "diagnose-manifest", outcome: "checkout total is wrong", expect: { validates: true, planIds: ["repro", "root-cause", "fix", "regression", "verify"], crewRoles: ["debug", "implement", "test-author", "code-review"] } }, undefined);
  assert.equal(good.pass, true);
  const bad = gradeCase({ check: "diagnose-manifest", outcome: "checkout total is wrong", expect: { planIds: ["fix", "verify"] } }, undefined);
  assert.equal(bad.pass, false);
});

test("audit-manifest: expected dimensions/roles pass, wrong ones fail", () => {
  const good = gradeCase({ check: "audit-manifest", outcome: "audit the repo", expect: { givenPromptingSignal: false, validates: true, planIdsInclude: ["audit-security", "fix", "verify"], planIdsExclude: ["audit-prompt-quality"] } }, undefined);
  assert.equal(good.pass, true);
  const bad = gradeCase({ check: "audit-manifest", outcome: "audit the repo", expect: { givenPromptingSignal: false, crewCoversRoles: ["docs-research"] } }, undefined);
  assert.equal(bad.pass, false);
});

test("audit-ledger: well-formed ranked ledger passes, malformed/unranked ledger fails", () => {
  const good = "- P0 `src/a.js:1` — bad thing — Fix: fix it.\n- P1 `src/b.js:2` — another — Fix: fix that.";
  assert.equal(gradeCase({ check: "audit-ledger", expect: { minFindings: 2, sortedBySeverity: true } }, good).pass, true);
  const malformed = "- P0 src/a.js:1 bad thing, no fix noted";
  assert.equal(gradeCase({ check: "audit-ledger", expect: { minFindings: 1 } }, malformed).pass, false);
  const unranked = "- P1 `src/a.js:1` — bad thing — Fix: fix it.\n- P0 `src/b.js:2` — another — Fix: fix that.";
  assert.equal(gradeCase({ check: "audit-ledger", expect: { sortedBySeverity: true } }, unranked).pass, false);
});

test("sprint-waves: correct wave shape passes, wrong expectation fails", () => {
  const backlog = "- [ ] a {id: a} {deps: none}\n- [ ] b depends on a {id: b} {deps: a}\n";
  assert.equal(gradeCase({ check: "sprint-waves", expect: { ok: true, annotated: true, waves: [["a"], ["b"]] } }, backlog).pass, true);
  assert.equal(gradeCase({ check: "sprint-waves", expect: { ok: true, waves: [["b"], ["a"]] } }, backlog).pass, false);
  const cycle = "- [ ] a {id: a} {deps: b}\n- [ ] b {id: b} {deps: a}\n";
  assert.equal(gradeCase({ check: "sprint-waves", expect: { ok: false, errorsNonEmpty: true } }, cycle).pass, true);
});

test("sprint-one-attended-stop: exactly one marker/prompt passes, more than one fails", () => {
  const once = "## Sprint\nitem a done\n\n## Batch report\n| a | pr |\nAskUserQuestion: Done";
  assert.equal(gradeCase({ check: "sprint-one-attended-stop", expect: { marker: "## Batch report", promptCount: 1 } }, once).pass, true);
  const twice = once + "\n\n## Batch report\nagain\nAskUserQuestion: Done";
  assert.equal(gradeCase({ check: "sprint-one-attended-stop", expect: { marker: "## Batch report", promptCount: 1 } }, twice).pass, false);
});

test("assess: clear/signals match passes, mismatch fails", () => {
  assert.equal(gradeCase({ check: "assess", outcome: "Add JWT auth with tests, targeting 100% coverage.", expect: { clear: true } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "assess", outcome: "make it better", expect: { clear: true } }, undefined).pass, false);
  assert.equal(gradeCase({ check: "assess", outcome: "make it better", expect: { clear: false, signalsInclude: ["vague-only"] } }, undefined).pass, true);
});

test("issue-ref: issue-shaped input passes, plain text fails an isIssueRef:true expectation", () => {
  assert.equal(gradeCase({ check: "issue-ref", outcome: "#7", expect: { isIssueRef: true, number: 7 } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "issue-ref", outcome: "Add a feature", expect: { isIssueRef: true } }, undefined).pass, false);
  assert.equal(gradeCase({ check: "issue-ref", outcome: "Add a feature", expect: { isIssueRef: false } }, undefined).pass, true);
});

test("manifest: valid + fenced + covered manifest passes; invalid, unfenced, all-inline each fail", () => {
  const validParallel = { outcome: "o", successCriteria: ["c"], crew: [{ stage: "implement", provider: "p", source: "builtin", model: "sonnet", rationale: "r", evidence: "e", fallback: "inline" }], recommendations: [], degradations: [], plan: [{ id: "a", task: "t1", mode: "single", deps: [], owns: ["src/**"] }, { id: "b", task: "t2", mode: "single", deps: [], owns: ["docs/**"] }] };
  assert.equal(gradeCase({ check: "manifest", expect: { validates: true, requireFences: true, expectRoles: ["implement"], nonInline: true } }, validParallel).pass, true);

  const invalid = { outcome: "o" }; // missing everything
  assert.equal(gradeCase({ check: "manifest", expect: { validates: true } }, invalid).pass, false);

  const unfenced = { outcome: "o", successCriteria: ["c"], crew: [{ stage: "implement", provider: "p", source: "builtin", model: "sonnet", rationale: "r", evidence: "e", fallback: "inline" }], recommendations: [], degradations: [], plan: [{ id: "a", task: "t1", mode: "single", deps: [] }, { id: "b", task: "t2", mode: "single", deps: [] }] };
  assert.equal(gradeCase({ check: "manifest", expect: { validates: true, requireFences: true } }, unfenced).pass, false);
  assert.equal(planFencesOk(unfenced), false);

  const allInline = { ...validParallel, crew: [{ stage: "implement", provider: "inline", source: "inline", rationale: "r", evidence: "e", fallback: "inline" }] };
  assert.equal(gradeCase({ check: "manifest", expect: { validates: true, nonInline: true } }, allInline).pass, false);
});

test("disposition: resolveMergeDisposition downgrades only merge-* when unattended", () => {
  assert.equal(resolveMergeDisposition("merge-push", { attended: false }), "pr");
  assert.equal(resolveMergeDisposition("merge-local", { attended: false }), "pr");
  assert.equal(resolveMergeDisposition("merge-push", { attended: true }), "merge-push");
  assert.equal(resolveMergeDisposition("pr", { attended: false }), "pr");
  assert.equal(gradeCase({ check: "disposition", expect: { declared: "merge-push", attended: false, expected: "pr" } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "disposition", expect: { declared: "merge-push", attended: false, expected: "merge-push" } }, undefined).pass, false);
});

test("commit-message: wave-convention commits pass, a non-conforming message fails", () => {
  assert.match("feat(wave 1): add auth endpoint", WAVE_COMMIT_RE);
  assert.equal(gradeCase({ check: "commit-message", expect: {} }, "feat(wave 1): a\nfeat(wave 2): b").pass, true);
  assert.equal(gradeCase({ check: "commit-message", expect: {} }, "feat(wave 1): a\nfixup!  oops").pass, false);
});

test("runner-receipts: a clean claim->done trail passes; unclaimed work, wrong disposition, and a duplicate ledger each fail", () => {
  const clean = "CLAIMED x r1 2026-01-01T00:00:00Z\nDONE x r1 2026-01-01T00:05:00Z pr\nLEDGER r1 last-seen=2026-01-01T00:05:00Z last-item=x result=done";
  assert.equal(gradeCase({ check: "runner-receipts", expect: { expectDisposition: "pr" } }, clean).pass, true);

  const noClaim = "DONE x r1 2026-01-01T00:05:00Z pr\nLEDGER r1 last-seen=2026-01-01T00:05:00Z last-item=x result=done";
  const noClaimResult = gradeCase({ check: "runner-receipts", expect: { expectDisposition: "pr" } }, noClaim);
  assert.equal(noClaimResult.pass, false);
  assert.equal(noClaimResult.checks.find((c) => c.name === "claimBeforeWork").ok, false);

  const wrongDisposition = "CLAIMED x r1 2026-01-01T00:00:00Z\nDONE x r1 2026-01-01T00:05:00Z merge-push\nLEDGER r1 last-seen=2026-01-01T00:05:00Z last-item=x result=done";
  assert.equal(gradeCase({ check: "runner-receipts", expect: { expectDisposition: "pr" } }, wrongDisposition).pass, false);

  const duplicateLedger = clean + "\nLEDGER r1 last-seen=2026-01-01T01:00:00Z last-item=x result=done";
  const dupResult = gradeCase({ check: "runner-receipts", expect: {} }, duplicateLedger);
  assert.equal(dupResult.pass, false);
  assert.equal(dupResult.checks.find((c) => c.name === "oneLedgerHeartbeatPerRunner").ok, false);

  const badGrammar = clean + "\nSOME RANDOM LINE";
  assert.equal(gradeCase({ check: "runner-receipts", expect: {} }, badGrammar).pass, false);
});

test("gradeCase: unknown check name fails loudly instead of silently passing", () => {
  const g = gradeCase({ check: "not-a-real-check", expect: {} }, undefined);
  assert.equal(g.pass, false);
  assert.match(g.checks[0].detail, /unknown check/);
});

test("every check in CHECKS has a matching ARTIFACT_KIND entry", () => {
  for (const name of Object.keys(CHECKS)) assert.ok(name in ARTIFACT_KIND, `CHECKS.${name} has no ARTIFACT_KIND entry`);
});

// --- dataset + fixtures: the checked-in material grades green ---------------------------

const dataset = JSON.parse(await read("eval/modes/dataset.json"));
const MODES = ["run", "autopilot", "sprint", "runner", "audit", "diagnose"];

test("dataset covers all 6 mode prompts with at least 5 cases each, 30+ total", () => {
  assert.ok(dataset.cases.length >= 30, `expected 30+ total cases, got ${dataset.cases.length}`);
  const byMode = {};
  for (const c of dataset.cases) byMode[c.mode] = (byMode[c.mode] || 0) + 1;
  for (const mode of MODES) assert.ok((byMode[mode] || 0) >= 5, `mode "${mode}" has only ${byMode[mode] || 0} cases`);
  for (const mode of Object.keys(byMode)) assert.ok(MODES.includes(mode), `unknown mode "${mode}" in dataset`);
});

test("audit-manifest cases grade manifest construction from a GIVEN signal, not live detection (self-describing expect key)", () => {
  // buildAuditManifest's prompt-quality dimension is fed a signal computed upstream by
  // src/detect.js's hasPromptingSignal — filesystem-bound async I/O over a real
  // package.json, already exercised end-to-end with real fixtures in test/detect.test.js.
  // grade.mjs (the frozen CLI consumer) calls gradeCase(...) synchronously and un-awaited,
  // so this eval cannot also re-run that live async detection without forking the
  // consumer's contract. These 3 cases instead grade buildAuditManifest's reaction to a
  // signal value the case supplies directly, via the self-describing
  // `expect.givenPromptingSignal` — not the ambiguous `expect.prompting`, which read as
  // though the case graded detection itself.
  const auditManifestCases = dataset.cases.filter((c) => c.check === "audit-manifest");
  assert.ok(auditManifestCases.length >= 3, `expected the 3 audit-manifest cases, got ${auditManifestCases.length}`);
  for (const c of auditManifestCases) {
    assert.ok(!("prompting" in c.expect), `${c.id}: expect uses the ambiguous "prompting" key — rename to "givenPromptingSignal"`);
    assert.ok("givenPromptingSignal" in c.expect, `${c.id}: expect.givenPromptingSignal must be explicit — this is a construction input, not a live-detected value`);
  }
});

test("model-graded cases carry a rubric and no gradeable expect, and are excluded from CI grading", () => {
  const modelCases = dataset.cases.filter((c) => c.grading === "model");
  assert.ok(modelCases.length > 0, "expected at least one model-graded case to demonstrate the pattern");
  for (const c of modelCases) {
    assert.ok(typeof c.rubric === "string" && c.rubric.length > 0, `${c.id}: model-graded case needs a rubric`);
    assert.deepEqual(c.expect, {}, `${c.id}: model-graded case should carry an empty expect (nothing for code to grade)`);
  }
});

test("every code-graded dataset case grades as passing", async () => {
  const codeGraded = dataset.cases.filter((c) => c.grading !== "model");
  assert.ok(codeGraded.length >= 30, `expected 30+ code-graded cases, got ${codeGraded.length}`);
  for (const c of codeGraded) {
    const artifacts = await loadArtifacts(c);
    const g = gradeCase(c, artifacts);
    assert.ok(g.pass, `${c.id} should pass: ${JSON.stringify(g.checks.filter((x) => !x.ok))}`);
  }
});

test("the sprint waves fixture's pinned output matches the checked-in waves.json (drift guard)", async () => {
  const { computeSprintWaves } = await import("../src/sprint-waves.js");
  const backlog = await read("eval/modes/fixtures/sprint/backlog.md");
  const pinned = JSON.parse(await read("eval/modes/fixtures/sprint/waves.json"));
  assert.deepEqual(computeSprintWaves(backlog), pinned);
});

test("package.json wires eval:modes to eval/modes/grade.mjs", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.scripts["eval:modes"], "node eval/modes/grade.mjs");
});
