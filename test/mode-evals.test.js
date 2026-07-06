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
  MUSTER_RECEIPT_PATTERNS,
  computeClaimWindows,
  computeClaimWindowWinner,
  SCAFFOLD_SEED_FILES,
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

// --- skill-protocol grade-lib unit tests (eval/modes extended past the 6 verb prompts) -

test("orchestrator-brief: fences + return-contract caps present passes; a missing fence or cap each fail", () => {
  const withFences = "OWNS: src/auth/**\nFROZEN: docs/**\n\n## Return contract\nReturn raw data, <=2000 chars.";
  assert.equal(gradeCase({ check: "orchestrator-brief", expect: { requireOwns: true, requireFrozen: true, returnContractCaps: [2000] } }, withFences).pass, true);

  const missingFrozen = "OWNS: src/auth/**\n\n## Return contract\nReturn raw data, <=2000 chars.";
  assert.equal(gradeCase({ check: "orchestrator-brief", expect: { requireOwns: true, requireFrozen: true } }, missingFrozen).pass, false);

  const noReturnContract = "OWNS: src/auth/**\nFROZEN: docs/**\n\nJust go implement it.";
  assert.equal(gradeCase({ check: "orchestrator-brief", expect: { returnContractCaps: [2000] } }, noReturnContract).pass, false);
});

test("review-gate-verdict: a verdict-first PASS/ESCALATE matching the tallied findings passes; a verdict contradicting the findings fails", () => {
  const cleanPass = "VERDICT: PASS\n\n- NIT: minor naming nit.";
  assert.equal(gradeCase({ check: "review-gate-verdict", expect: { verdict: "PASS" } }, cleanPass).pass, true);

  const blockerEscalate = "VERDICT: ESCALATE\n\n- BLOCKER: auth bypass.";
  assert.equal(gradeCase({ check: "review-gate-verdict", expect: { verdict: "ESCALATE" } }, blockerEscalate).pass, true);

  const verdictContradictsFindings = "VERDICT: PASS\n\n- BLOCKER: auth bypass.";
  const bad = gradeCase({ check: "review-gate-verdict", expect: {} }, verdictContradictsFindings);
  assert.equal(bad.pass, false);
  assert.equal(bad.checks.find((c) => c.name === "findingsPrecedeVerdict").ok, false);

  const verdictNotFirst = "Some preamble.\nVERDICT: PASS";
  assert.equal(gradeCase({ check: "review-gate-verdict", expect: {} }, verdictNotFirst).checks.find((c) => c.name === "verdictFirst").ok, false);
});

test("coordination-claim-window: MUSTER_RECEIPT_PATTERNS classify every receipt type", () => {
  assert.match("MUSTER CLAIMED alice 2026-01-01T00:00:00Z", MUSTER_RECEIPT_PATTERNS.CLAIMED);
  assert.match("MUSTER DONE alice 2026-01-01T00:00:00Z", MUSTER_RECEIPT_PATTERNS.DONE);
  assert.match("MUSTER BLOCKED alice 2026-01-01T00:00:00Z the question", MUSTER_RECEIPT_PATTERNS.BLOCKED);
  assert.match("MUSTER FAILED alice 2026-01-01T00:00:00Z the reason", MUSTER_RECEIPT_PATTERNS.FAILED);
  assert.match("MUSTER YIELD alice 2026-01-01T00:00:00Z lost the race", MUSTER_RECEIPT_PATTERNS.YIELD);
});

test("coordination-claim-window: the earliest in-window claim wins and the loser's yield is required; an unyielded loser fails", () => {
  const race = "MUSTER CLAIMED bob 2026-01-01T00:00:05Z\nMUSTER CLAIMED alice 2026-01-01T00:00:00Z\nMUSTER YIELD bob 2026-01-01T00:00:10Z\nMUSTER DONE alice 2026-01-01T00:05:00Z";
  assert.equal(gradeCase({ check: "coordination-claim-window", expect: { winner: "alice", terminalType: "DONE" } }, race).pass, true);

  const unyielded = "MUSTER CLAIMED bob 2026-01-01T00:00:05Z\nMUSTER CLAIMED alice 2026-01-01T00:00:00Z\nMUSTER DONE alice 2026-01-01T00:05:00Z";
  const g = gradeCase({ check: "coordination-claim-window", expect: { winner: "alice" } }, unyielded);
  assert.equal(g.pass, false);
  assert.equal(g.checks.find((c) => c.name === "losersYielded").ok, false);
});

test("computeClaimWindows: a terminal receipt resets the floor so a stale prior-cycle claim can never out-rank a fresh re-claim", () => {
  const events = [
    { type: "CLAIMED", runner: "alice", ts: "2026-01-01T08:00:00Z" },
    { type: "FAILED", runner: "alice", ts: "2026-01-01T08:05:00Z" },
    { type: "CLAIMED", runner: "bob", ts: "2026-01-01T09:00:00Z" },
    { type: "DONE", runner: "bob", ts: "2026-01-01T09:10:00Z" },
  ];
  const { current } = computeClaimWindows(events);
  assert.equal(current.winner.runner, "bob");
  assert.equal(computeClaimWindowWinner(events).winner.runner, "bob");
});

test("interview-enriched-outcome: a measurable enriched outcome + non-empty successCriteria passes; a still-vague outcome or empty criteria fails", () => {
  const good = { enrichedOutcome: "Add JWT auth to the Express API, targeting 100% coverage on the auth middleware.", successCriteria: ["100% coverage", "returns a signed JWT"] };
  assert.equal(gradeCase({ check: "interview-enriched-outcome", expect: { clear: true, minCriteria: 2 } }, good).pass, true);

  const stillVague = { enrichedOutcome: "make it better", successCriteria: ["works well"] };
  assert.equal(gradeCase({ check: "interview-enriched-outcome", expect: { clear: true } }, stillVague).pass, false);

  const noCriteria = { enrichedOutcome: "Add JWT auth to the Express API, targeting 100% coverage.", successCriteria: [] };
  assert.equal(gradeCase({ check: "interview-enriched-outcome", expect: { clear: true, minCriteria: 1 } }, noCriteria).pass, false);
});

test("interview-backlog-measurable: a measurable stripped item text passes; a non-measurable one fails", () => {
  const measurable = "- [ ] Add a health-check endpoint with a latency target under 50ms {id: health-check} {deps: none}\n";
  assert.equal(gradeCase({ check: "interview-backlog-measurable", expect: { id: "health-check", clear: true } }, measurable).pass, true);

  const vague = "- [ ] make it better {id: vague-item} {deps: none}\n";
  assert.equal(gradeCase({ check: "interview-backlog-measurable", expect: { id: "vague-item", clear: true } }, vague).pass, false);
});

test("tournament-fusion-map: a map with all 5 required arrays passes; a map missing one fails", () => {
  const valid = { consensus: [], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] };
  assert.equal(gradeCase({ check: "tournament-fusion-map", expect: { ok: true } }, valid).pass, true);
  const invalid = { consensus: [], contradictions: [] };
  assert.equal(gradeCase({ check: "tournament-fusion-map", expect: { ok: true } }, invalid).pass, false);
});

test("tournament-fuse: real disagreement fuses the top-K; an invalid map, single-passing, or agreement each fall back", () => {
  const candidates = [
    { id: "a", total: 8, passing: true, content: "A" },
    { id: "b", total: 7, passing: true, content: "B" },
    { id: "c", total: 2, passing: false, content: "C" },
  ];
  const disagreeMap = { consensus: [], contradictions: ["x"], partialCoverage: [], uniqueInsights: [], blindSpots: [] };
  assert.equal(gradeCase({ check: "tournament-fuse", expect: { mode: "fuse", topKCount: 2 } }, { candidates, fusionMap: disagreeMap }).pass, true);

  const agreeMap = { consensus: ["x"], contradictions: [], partialCoverage: [], uniqueInsights: [], blindSpots: [] };
  assert.equal(gradeCase({ check: "tournament-fuse", expect: { mode: "fallback", reason: "candidates-agree" } }, { candidates, fusionMap: agreeMap }).pass, true);
  // Wrong expectation against the same real input fails, proving the check isn't a rubber stamp.
  assert.equal(gradeCase({ check: "tournament-fuse", expect: { mode: "fuse" } }, { candidates, fusionMap: agreeMap }).pass, false);
});

test("domain-classify: a matching keyword/workspace passes; a mismatched expectation fails", () => {
  assert.equal(gradeCase({ check: "domain-classify", expect: { domain: "pm", source: "outcome" } }, { outcome: "Build our roadmap.", profile: {} }).pass, true);
  assert.equal(gradeCase({ check: "domain-classify", expect: { domain: "business" } }, { outcome: "Build our roadmap.", profile: {} }).pass, false);
});

test("domain-pipeline-route: a keyword match beats the domain default; a wrong expected id fails", () => {
  const pipelines = [
    { id: "prd", domain: "pm", default: true, match: ["prd"] },
    { id: "epic", domain: "pm", match: ["epic"] },
  ];
  assert.equal(gradeCase({ check: "domain-pipeline-route", expect: { pipelineId: "epic" } }, { pipelines, outcome: "write the epic", domain: "pm" }).pass, true);
  assert.equal(gradeCase({ check: "domain-pipeline-route", expect: { pipelineId: "prd" } }, { pipelines, outcome: "write the epic", domain: "pm" }).pass, false);
});

test("advisor-request/response/budget: valid shapes and within-budget pass; invalid shapes and exhausted budget fail", () => {
  assert.equal(gradeCase({ check: "advisor-request", expect: { ok: true } }, { question: "q", context: "c", decisionType: "d" }).pass, true);
  assert.equal(gradeCase({ check: "advisor-request", expect: { ok: true } }, { context: "c", decisionType: "d" }).pass, false);
  assert.equal(gradeCase({ check: "advisor-response", expect: { ok: true } }, { recommendation: "r", rationale: "because" }).pass, true);
  assert.equal(gradeCase({ check: "advisor-response", expect: { ok: true } }, { recommendation: "r", rationale: "" }).pass, false);
  assert.equal(gradeCase({ check: "advisor-budget", expect: { consult: true } }, { consults: 0, maxConsults: 3 }).pass, true);
  assert.equal(gradeCase({ check: "advisor-budget", expect: { consult: true } }, { consults: 3, maxConsults: 3 }).pass, false);
});

test("greenfield-scaffold-shape: created+skipped covering every seed file with no overlap passes; a gap or overlap fails", () => {
  assert.equal(gradeCase({ check: "greenfield-scaffold-shape", expect: {} }, { created: SCAFFOLD_SEED_FILES, skipped: [] }).pass, true);
  const gap = gradeCase({ check: "greenfield-scaffold-shape", expect: {} }, { created: SCAFFOLD_SEED_FILES.slice(1), skipped: [] });
  assert.equal(gap.pass, false);
  assert.equal(gap.checks.find((c) => c.name === "coversAllSeeds").ok, false);
  const overlap = gradeCase({ check: "greenfield-scaffold-shape", expect: {} }, { created: SCAFFOLD_SEED_FILES, skipped: [SCAFFOLD_SEED_FILES[0]] });
  assert.equal(overlap.pass, false);
  assert.equal(overlap.checks.find((c) => c.name === "noOverlap").ok, false);
});

test("prd-pipeline-shape: a valid pipeline object passes validatePipeline; a shape missing gate fails", () => {
  const good = { id: "x", domain: "pm", phases: [{ id: "a", role: "author" }], gate: { criteria: ["c"], floor: 1, pass_total: 1 } };
  assert.equal(gradeCase({ check: "prd-pipeline-shape", expect: { ok: true } }, good).pass, true);
  const missingGate = { id: "x", domain: "pm", phases: [{ id: "a", role: "author" }] };
  assert.equal(gradeCase({ check: "prd-pipeline-shape", expect: { ok: true } }, missingGate).pass, false);
});

test("prd-gate-achievability: the floor-principle math (scoreArtifact) is graded directly — floor-met-but-total-short and weakest-below-floor both correctly fail passing", () => {
  const gate = { criteria: ["a", "b"], floor: 2, pass_total: 5 };
  const floorMetTotalShort = gradeCase({ check: "prd-gate-achievability", expect: { total: 4, passing: false } }, { scores: { a: 2, b: 2 }, gate });
  assert.equal(floorMetTotalShort.pass, true);
  const weakestBelowFloor = gradeCase({ check: "prd-gate-achievability", expect: { weakestCriterion: "a", passing: false } }, { scores: { a: 1, b: 4 }, gate });
  assert.equal(weakestBelowFloor.pass, true);
  const wrongExpectation = gradeCase({ check: "prd-gate-achievability", expect: { passing: true } }, { scores: { a: 1, b: 4 }, gate });
  assert.equal(wrongExpectation.pass, false);
});

test("roadmap-rice: real RICE math ranks correctly and fails loud on zero effort; a wrong expected rank order fails", () => {
  const items = [
    { name: "big", reach: 1000, impact: 2, confidence: 1, effort: 1 },
    { name: "small", reach: 10, impact: 1, confidence: 1, effort: 1 },
  ];
  assert.equal(gradeCase({ check: "roadmap-rice", expect: { rankOrder: ["big", "small"] } }, items).pass, true);
  assert.equal(gradeCase({ check: "roadmap-rice", expect: { rankOrder: ["small", "big"] } }, items).pass, false);
  assert.equal(gradeCase({ check: "roadmap-rice", expect: { throws: true } }, [{ name: "z", reach: 1, impact: 1, confidence: 1, effort: 0 }]).pass, true);
});

// --- content-pipeline grade-lib unit tests (eval/modes extended to pipelines/*.yaml) ---

test("citation-check: resolving [src: x] anchors pass; a dangling anchor fails an ok:true expectation", () => {
  const clean = "A claim with a citation [src: a].\n\n## Sources\n- a: https://example.com/a\n";
  assert.equal(gradeCase({ check: "citation-check", expect: { ok: true, minClaims: 1 } }, clean).pass, true);
  const dangling = "A claim with a citation [src: missing].\n\n## Sources\n- a: https://example.com/a\n";
  assert.equal(gradeCase({ check: "citation-check", expect: { ok: true } }, dangling).pass, false);
  assert.equal(gradeCase({ check: "citation-check", expect: { ok: false } }, dangling).pass, true);
});

test("humanizer-score: a clean passage passes the threshold; an AI-tell-laden passage fails a passing:true expectation", () => {
  const clean = "Open on a quiet office at dusk. The last engineer logs off for the night.";
  assert.equal(gradeCase({ check: "humanizer-score", expect: { passing: true } }, clean).pass, true);
  const tellLaden = "Let's dive in — we'll delve into a robust, seamless, cutting-edge paradigm that will truly elevate and foster synergy.";
  assert.equal(gradeCase({ check: "humanizer-score", expect: { passing: true } }, tellLaden).pass, false);
  assert.equal(gradeCase({ check: "humanizer-score", expect: { passing: false } }, tellLaden).pass, true);
});

test("evidence-table-shape: well-formed owned rows pass unownedFlagCount:0; an unowned action row fails that expectation", () => {
  const header = "| type | value | source-anchor | confidence | needs_review | subject-approval-status | owner | deadline |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n";
  const owned = header + "| action | ship it | notes.md:L1 | high | no | approved | jane | 2026-08-01 |\n";
  assert.equal(gradeCase({ check: "evidence-table-shape", expect: { rowsWellFormed: true, unownedFlagCount: 0 } }, owned).pass, true);
  const unowned = header + "| action | ship it | notes.md:L1 | high | no | approved | - | - |\n";
  assert.equal(gradeCase({ check: "evidence-table-shape", expect: { unownedFlagCount: 0 } }, unowned).pass, false);
  assert.equal(gradeCase({ check: "evidence-table-shape", expect: { unownedFlagCount: 1 } }, unowned).pass, true);
});

test("evidence-table-shape: a metric row with an empty source-anchor cell is malformed, not a passing uncited claim", () => {
  const header = "| type | value | source-anchor | confidence | needs_review | subject-approval-status | owner | deadline |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n";
  const uncited = header + "| metric | 40% reduction in onboarding time |  | high | no | approved | - | - |\n";
  assert.equal(gradeCase({ check: "evidence-table-shape", expect: { rowsWellFormed: false } }, uncited).pass, true);
  assert.equal(gradeCase({ check: "evidence-table-shape", expect: { rowsWellFormed: true } }, uncited).pass, false);
});

test("evidence-table-shape: a metric row with an empty subject-approval-status cell is malformed, not silently approved", () => {
  const header = "| type | value | source-anchor | confidence | needs_review | subject-approval-status | owner | deadline |\n| --- | --- | --- | --- | --- | --- | --- | --- |\n";
  const unapproved = header + "| metric | 40% reduction in onboarding time | metrics.csv:L2 | high | no |  | - | - |\n";
  assert.equal(gradeCase({ check: "evidence-table-shape", expect: { rowsWellFormed: false } }, unapproved).pass, true);
  assert.equal(gradeCase({ check: "evidence-table-shape", expect: { rowsWellFormed: true } }, unapproved).pass, false);
});

test("signal-diff-baseline: dated NEW/CHANGED + a summary line pass; per-item unchanged re-reporting fails a hasSummaryLine:true expectation", () => {
  const clean = "- NEW: a thing happened (2026-01-01)\n- unchanged: 3 signals (see baseline)\n";
  assert.equal(gradeCase({ check: "signal-diff-baseline", expect: { newChangedDated: true, hasSummaryLine: true, reReportsUnchanged: false } }, clean).pass, true);
  const violating = "- NEW: a thing happened (2026-01-01)\n- UNCHANGED: an old thing, still the same\n";
  assert.equal(gradeCase({ check: "signal-diff-baseline", expect: { hasSummaryLine: true } }, violating).pass, false);
  assert.equal(gradeCase({ check: "signal-diff-baseline", expect: { hasSummaryLine: false, reReportsUnchanged: true } }, violating).pass, true);
});

test("publish-packet-shape: a complete packet passes; a missing checklist/visual-verify/fence-stop each fail a true expectation", () => {
  const complete = { artifactPath: "docs/x.pdf", imagePrompts: ["p"], metadata: { title: "t" }, visualVerify: { screenshot: "s.png", consoleEvidence: "clean" }, checklist: ["c"], actionFenceStopped: true };
  assert.equal(gradeCase({ check: "publish-packet-shape", expect: { hasArtifactPath: true, hasImagePrompts: true, hasMetadata: true, hasVisualVerify: true, hasChecklist: true, actionFenceStopped: true } }, complete).pass, true);
  const incomplete = { artifactPath: "docs/x.pdf", imagePrompts: ["p"], metadata: { title: "t" }, visualVerify: {}, checklist: [], actionFenceStopped: false };
  assert.equal(gradeCase({ check: "publish-packet-shape", expect: { hasVisualVerify: true, hasChecklist: true, actionFenceStopped: true } }, incomplete).pass, false);
  assert.equal(gradeCase({ check: "publish-packet-shape", expect: { hasVisualVerify: false, hasChecklist: false, actionFenceStopped: false } }, incomplete).pass, true);
});

test("audience-voice-jargon: a jargon-free draft passes clean:true; a draft violating the banned-jargon list fails it", () => {
  const profile = { bannedJargon: ["leverage", "synergy"] };
  const clean = gradeCase({ check: "audience-voice-jargon", expect: { clean: true } }, { audienceProfile: profile, draft: "Ship the fix this week." });
  assert.equal(clean.pass, true);
  const violating = gradeCase({ check: "audience-voice-jargon", expect: { clean: true } }, { audienceProfile: profile, draft: "Let's leverage this synergy." });
  assert.equal(violating.pass, false);
  assert.equal(gradeCase({ check: "audience-voice-jargon", expect: { clean: false } }, { audienceProfile: profile, draft: "Let's leverage this synergy." }).pass, true);
});

test("gate-achievability: parameterizes over ANY pipeline's real gate (not just prd) -- floor-met-but-short and a passing scenario both grade correctly", () => {
  const gate = { criteria: ["a", "b"], floor: 2, pass_total: 5 };
  const floorMetTotalShort = gradeCase({ check: "gate-achievability", expect: { total: 4, passing: false } }, { scores: { a: 2, b: 2 }, gate });
  assert.equal(floorMetTotalShort.pass, true);
  const passing = gradeCase({ check: "gate-achievability", expect: { total: 5, passing: true } }, { scores: { a: 2, b: 3 }, gate });
  assert.equal(passing.pass, true);
  const wrongExpectation = gradeCase({ check: "gate-achievability", expect: { passing: true } }, { scores: { a: 2, b: 2 }, gate });
  assert.equal(wrongExpectation.pass, false);
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
// The skill-protocol layer (plugin/skills/*, router excluded — it already has
// eval:router). Every case's `mode` field names either one of the 6 verb prompts above
// OR one of these 10 skills — a single field, not a second "skill" key, because grade.mjs
// (frozen: `${r.mode.padEnd(9)}`) reads `mode` unconditionally on every row and would
// throw on a case that left it undefined.
const SKILLS = [
  "orchestrator",
  "review-gate",
  "coordination",
  "interview",
  "tournament",
  "domain-router",
  "advisor",
  "greenfield",
  "prd-pipeline",
  "roadmap-prioritization",
];
// The content-pipeline layer (eval/modes extended to pipelines/*.yaml phase prompts) --
// the "honest graded subset" of the content pipelines (knowledge/software pipelines like
// prd already have gate-achievability coverage from the skill-protocol layer above, so
// they're not duplicated here). Each pipeline's `mode` is its own pipeline id (not a
// generic "content-pipeline" bucket), same one-field convention MODES/SKILLS already set.
const CONTENT_PIPELINES = [
  "blog-post",
  "social-post",
  "newsletter",
  "case-study",
  "lead-magnet",
  "release-notes",
  "video-content",
  "executive-summary",
  "competitive-battlecard",
];

test("dataset covers all 6 mode prompts with at least 5 cases each, 30+ total", () => {
  const modeCases = dataset.cases.filter((c) => MODES.includes(c.mode));
  assert.ok(modeCases.length >= 30, `expected 30+ mode cases, got ${modeCases.length}`);
  const byMode = {};
  for (const c of modeCases) byMode[c.mode] = (byMode[c.mode] || 0) + 1;
  for (const mode of MODES) assert.ok((byMode[mode] || 0) >= 5, `mode "${mode}" has only ${byMode[mode] || 0} cases`);
});

test("dataset covers all 10 skill-protocol skills with at least 3 cases each, 33+ total", () => {
  const skillCases = dataset.cases.filter((c) => SKILLS.includes(c.mode));
  assert.ok(skillCases.length >= 33, `expected 33+ skill cases, got ${skillCases.length}`);
  const bySkill = {};
  for (const c of skillCases) bySkill[c.mode] = (bySkill[c.mode] || 0) + 1;
  for (const skill of SKILLS) assert.ok((bySkill[skill] || 0) >= 3, `skill "${skill}" has only ${bySkill[skill] || 0} cases`);
});

test("dataset covers all 9 content pipelines with at least 2 cases each, 18+ total", () => {
  const pipelineCases = dataset.cases.filter((c) => CONTENT_PIPELINES.includes(c.mode));
  assert.ok(pipelineCases.length >= 18, `expected 18+ content-pipeline cases, got ${pipelineCases.length}`);
  const byPipeline = {};
  for (const c of pipelineCases) byPipeline[c.mode] = (byPipeline[c.mode] || 0) + 1;
  for (const pipeline of CONTENT_PIPELINES) assert.ok((byPipeline[pipeline] || 0) >= 2, `pipeline "${pipeline}" has only ${byPipeline[pipeline] || 0} cases`);
});

test("every dataset case's mode is a known verb, skill, or content-pipeline name, and grade.mjs's row.mode is always a defined string", () => {
  const known = new Set([...MODES, ...SKILLS, ...CONTENT_PIPELINES]);
  for (const c of dataset.cases) {
    assert.equal(typeof c.mode, "string", `${c.id}: "mode" must be a defined string (grade.mjs calls .padEnd() on it unconditionally)`);
    assert.ok(known.has(c.mode), `${c.id}: unknown mode/skill/pipeline "${c.mode}" — not in MODES, SKILLS, or CONTENT_PIPELINES`);
  }
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

test("the prd-pipeline-shape fixture's id/domain/gate match the live pipelines/prd.yaml (drift guard)", async () => {
  const { parse } = await import("yaml");
  const { validatePipeline } = await import("../src/pipeline.js");
  const live = parse(await read("pipelines/prd.yaml"));
  assert.equal(validatePipeline(live).ok, true, "pipelines/prd.yaml itself must validate");
  const fixture = JSON.parse(await read("eval/modes/fixtures/skills/prd-pipeline/pipeline-shape.json"));
  assert.equal(fixture.id, live.id);
  assert.equal(fixture.domain, live.domain);
  assert.deepEqual(fixture.gate, live.gate);
  // The 4 prd-gate-achievability fixtures hardcode this same gate inline (not read from
  // this pipeline-shape fixture) — pin them too, so a pipelines/prd.yaml gate edit fails
  // this guard instead of silently stranding 4 achievability cases on stale numbers.
  const gateFixtures = ["gate-floor-insufficient.json", "gate-passing.json", "gate-weakest-below-floor.json"];
  for (const f of gateFixtures) {
    const g = JSON.parse(await read(`eval/modes/fixtures/skills/prd-pipeline/${f}`));
    assert.deepEqual(g.gate, live.gate, `${f}: gate must match the live pipelines/prd.yaml gate`);
  }
});

test("the content-pipeline gate-achievability fixtures' gate matches each pipeline's live yaml (drift guard)", async () => {
  const { parse } = await import("yaml");
  const pipelineGateFixtures = {
    "release-notes": ["gate-floor-insufficient.json", "gate-passing.json"],
    "executive-summary": ["gate-floor-insufficient.json", "gate-weakest-below-floor.json"],
  };
  for (const [pipelineId, files] of Object.entries(pipelineGateFixtures)) {
    const live = parse(await read(`pipelines/${pipelineId}.yaml`));
    for (const f of files) {
      const g = JSON.parse(await read(`eval/modes/fixtures/pipelines/${pipelineId}/${f}`));
      assert.deepEqual(g.gate, live.gate, `${pipelineId}/${f}: gate must match the live pipelines/${pipelineId}.yaml gate`);
    }
  }
});
