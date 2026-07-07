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
  isHumanHoldResumeAuthorized,
  SCAFFOLD_SEED_FILES,
  CAPTURE_EXCLUSION_REASONS,
  resolveArtifactUrl,
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

test("backlog-ref: each ref form classifies, and a plain outcome fails a file expectation", () => {
  assert.equal(gradeCase({ check: "backlog-ref", outcome: ".muster/backlog.md", expect: { kind: "file", path: ".muster/backlog.md" } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "backlog-ref", outcome: "issues:sprint-1", expect: { kind: "issues", label: "sprint-1" } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "backlog-ref", outcome: "linear:MUS", expect: { kind: "linear", key: "MUS" } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "backlog-ref", outcome: "issues:", expect: { kind: "invalid" } }, undefined).pass, true);
  assert.equal(gradeCase({ check: "backlog-ref", outcome: "Add dark mode to settings", expect: { kind: "file" } }, undefined).pass, false);
  assert.equal(gradeCase({ check: "backlog-ref", outcome: "Add dark mode to settings", expect: { kind: "outcome" } }, undefined).pass, true);
});

test("batch-conflicts: overlap flagged + unfenced reported pass; a wrong pair expectation fails", () => {
  const overlap = { items: [{ id: "auth", owns: ["src/auth/**"] }, { id: "sessions", owns: ["src/auth/session.js"] }, { id: "docs", owns: ["docs/**"] }] };
  assert.equal(gradeCase({ check: "batch-conflicts", expect: { conflictPairs: [["auth", "sessions"]], unfenced: [] } }, overlap).pass, true);
  assert.equal(gradeCase({ check: "batch-conflicts", expect: { conflictPairs: [["auth", "docs"]] } }, overlap).pass, false);
  const disjoint = { items: [{ id: "retry", owns: ["src/fetch/**"] }, { id: "metrics", owns: [] }] };
  assert.equal(gradeCase({ check: "batch-conflicts", expect: { conflictPairs: [], unfenced: ["metrics"] } }, disjoint).pass, true);
  assert.equal(gradeCase({ check: "batch-conflicts", expect: { conflictPairs: [], unfenced: [] } }, disjoint).pass, false);
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

test("runner-dispatch-brief: a brief carrying the full dispatch contract passes; each missing input fails", () => {
  const full = "ITEM: retry\nOUTCOME: retries with backoff.\nISOLATION: worktree .worktrees/retry on branch item/retry, base main @ abc1234\nDISPOSITION: pr\nSOURCE: backlog.md#retry\n\nRETURN CONTRACT: receipts, <= 2000 chars.";
  const expectAll = { requireItemId: true, requireOutcome: true, requireIsolation: true, requireBase: true, requireDisposition: "pr", requireSourceRef: true };
  assert.equal(gradeCase({ check: "runner-dispatch-brief", expect: expectAll }, full).pass, true);

  // The runner's own rule is BLOCKED on any missing brief input — so each omission must
  // grade as a failing brief. One field mutated per case, so per-check attribution is real.
  const wrongDisposition = full.replace("DISPOSITION: pr", "DISPOSITION: merge");
  const wd = gradeCase({ check: "runner-dispatch-brief", expect: expectAll }, wrongDisposition);
  assert.equal(wd.pass, false);
  assert.equal(wd.checks.find((c) => c.name === "disposition").ok, false);
  assert.equal(wd.checks.find((c) => c.name === "itemId").ok, true);

  const noReturnContract = full.replace(/RETURN CONTRACT.*$/m, "Just report back whatever.");
  const nrc = gradeCase({ check: "runner-dispatch-brief", expect: expectAll }, noReturnContract);
  assert.equal(nrc.pass, false);
  assert.equal(nrc.checks.find((c) => c.name === "returnContractPresent").ok, false);

  // The base ref is anchored to the ISOLATION line: an ISOLATION line without a base ref
  // fails baseRef even when unrelated prose ("database migration") carries the word "base".
  const baseMissing = full
    .replace("ISOLATION: worktree .worktrees/retry on branch item/retry, base main @ abc1234", "ISOLATION: worktree .worktrees/retry on branch item/retry")
    .replace("OUTCOME: retries with backoff.", "OUTCOME: retries for the database migration with backoff.");
  const bm = gradeCase({ check: "runner-dispatch-brief", expect: expectAll }, baseMissing);
  assert.equal(bm.pass, false);
  assert.equal(bm.checks.find((c) => c.name === "baseRef").ok, false);
  assert.equal(bm.checks.find((c) => c.name === "isolation").ok, true);

  // Removing the whole ISOLATION line fails isolation AND baseRef — coupled by design.
  const noIsolation = full.replace(/^ISOLATION: .*\n/m, "");
  const ni = gradeCase({ check: "runner-dispatch-brief", expect: expectAll }, noIsolation);
  assert.equal(ni.pass, false);
  assert.equal(ni.checks.find((c) => c.name === "isolation").ok, false);
});

test("runner-return-receipts: receipts with verdict/PR/files/pasted-green-tests pass; a missing verdict, paraphrased or red tests each fail", () => {
  const full = "ITEM: retry — disposition pr\nPR: https://github.com/x/y/pull/7\n\nFiles touched:\n- src/retry.js — backoff\n\nTests (pasted, not paraphrased):\n- baseline: `npm test` -> 10 passed, 0 failed\n- final: `npm test` -> 12 passed, 0 failed\n\nReview gate: VERDICT: PASS after 1 fix loop";
  const expectAll = { requireVerdictPass: true, requirePrUrl: true, requireFilesTouched: true, requireTestEvidence: true, requireFixLoopCount: true };
  assert.equal(gradeCase({ check: "runner-return-receipts", expect: expectAll }, full).pass, true);

  // A clean pass phrased "with no fix loops" is valid receipts grammar too.
  const cleanNoLoops = full.replace("after 1 fix loop", "with no fix loops");
  assert.equal(gradeCase({ check: "runner-return-receipts", expect: expectAll }, cleanNoLoops).pass, true);

  // One field mutated per case, so per-check attribution is real.
  const noVerdict = full.replace("VERDICT: PASS after", "all good after");
  const nv = gradeCase({ check: "runner-return-receipts", expect: expectAll }, noVerdict);
  assert.equal(nv.pass, false);
  assert.equal(nv.checks.find((c) => c.name === "verdictPass").ok, false);
  assert.equal(nv.checks.find((c) => c.name === "fixLoopCount").ok, true);

  const paraphrasedTests = full.replace(/- baseline: .*\n- final: .*\n/, "- all tests green\n");
  const pt = gradeCase({ check: "runner-return-receipts", expect: expectAll }, paraphrasedTests);
  assert.equal(pt.pass, false);
  assert.equal(pt.checks.find((c) => c.name === "testEvidence").ok, false);

  // Receipts prove GREEN: a red final run fails testEvidence even though digits + "passed" appear.
  const redFinal = full.replace("- final: `npm test` -> 12 passed, 0 failed", "- final: `npm test` -> 0 passed, 12 failed");
  const rf = gradeCase({ check: "runner-return-receipts", expect: expectAll }, redFinal);
  assert.equal(rf.pass, false);
  assert.equal(rf.checks.find((c) => c.name === "testEvidence").ok, false);

  const noPr = full.replace(/^PR: .*\n/m, "");
  const np = gradeCase({ check: "runner-return-receipts", expect: expectAll }, noPr);
  assert.equal(np.pass, false);
  assert.equal(np.checks.find((c) => c.name === "prUrl").ok, false);
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

test("review-gate-mutant-kill-rule: the full evidence shape passes; a thinned rule missing a required step fails", () => {
  const fullExpect = { rulePresent: true, requiresMutationStep: true, requiresFailingOutputStep: true, requiresByteIdenticalRestoreStep: true, requiresAutomaticFailOnMissingEvidence: true };
  const full = "## Mutant-kill gate\n\n1. **The mutation** -- ...\n2. **The failing output** -- ...\n3. **The byte-identical restore** -- ...\n\nA fired gate with no recorded evidence in this shape is an automatic FAIL for the wave.";
  assert.equal(gradeCase({ check: "review-gate-mutant-kill-rule", expect: fullExpect }, full).pass, true);

  const noRule = "Some unrelated section with no mutant-kill content at all.";
  const nr = gradeCase({ check: "review-gate-mutant-kill-rule", expect: { rulePresent: true } }, noRule);
  assert.equal(nr.pass, false);
  assert.equal(nr.checks.find((c) => c.name === "rulePresent").ok, false);

  // A "corrupt-twin" thinning: keeps steps 1-2 and the heading, drops step 3
  // (byte-identical restore) and the automatic-FAIL default entirely.
  const thinned = "## Mutant-kill gate\n\n1. **The mutation** -- ...\n2. **The failing output** -- ...";
  assert.equal(gradeCase({ check: "review-gate-mutant-kill-rule", expect: fullExpect }, thinned).pass, false, "the full-shape expectation must fail against a thinned rule");
  const thinnedGraded = gradeCase({ check: "review-gate-mutant-kill-rule", expect: { rulePresent: true, requiresMutationStep: true, requiresFailingOutputStep: true, requiresByteIdenticalRestoreStep: false, requiresAutomaticFailOnMissingEvidence: false } }, thinned);
  assert.equal(thinnedGraded.pass, true);
  assert.equal(thinnedGraded.checks.find((c) => c.name === "byteIdenticalRestoreStep").ok, true);
});

test("coordination-claim-window: MUSTER_RECEIPT_PATTERNS classify every receipt type", () => {
  assert.match("MUSTER CLAIMED alice 2026-01-01T00:00:00Z", MUSTER_RECEIPT_PATTERNS.CLAIMED);
  assert.match("MUSTER DONE alice 2026-01-01T00:00:00Z", MUSTER_RECEIPT_PATTERNS.DONE);
  assert.match("MUSTER BLOCKED alice 2026-01-01T00:00:00Z the question", MUSTER_RECEIPT_PATTERNS.BLOCKED);
  assert.match("MUSTER HUMAN-HOLD alice 2026-01-01T00:00:00Z authorizer=bob the question", MUSTER_RECEIPT_PATTERNS["HUMAN-HOLD"]);
  assert.match("MUSTER FAILED alice 2026-01-01T00:00:00Z the reason", MUSTER_RECEIPT_PATTERNS.FAILED);
  assert.match("MUSTER YIELD alice 2026-01-01T00:00:00Z lost the race", MUSTER_RECEIPT_PATTERNS.YIELD);
});

test("computeClaimWindows: HUMAN-HOLD resets the window floor exactly like DONE/BLOCKED/FAILED", () => {
  const events = [
    { type: "CLAIMED", runner: "alice", ts: "2026-01-01T08:00:00Z" },
    { type: "HUMAN-HOLD", runner: "alice", ts: "2026-01-01T08:05:00Z" },
    { type: "CLAIMED", runner: "carol", ts: "2026-01-01T09:00:00Z" },
    { type: "DONE", runner: "carol", ts: "2026-01-01T09:10:00Z" },
  ];
  const { current } = computeClaimWindows(events);
  assert.equal(current.winner.runner, "carol");
  assert.equal(gradeCase({ check: "coordination-claim-window", expect: { winner: "carol", terminalType: "DONE" } }, "MUSTER CLAIMED alice 2026-01-01T08:00:00Z\nMUSTER HUMAN-HOLD alice 2026-01-01T08:05:00Z authorizer=bob\nMUSTER CLAIMED carol 2026-01-01T09:00:00Z\nMUSTER DONE carol 2026-01-01T09:10:00Z").pass, true);
});

test("isHumanHoldResumeAuthorized: only a reply from the named authorizer resumes; any other replier is inert", () => {
  const wrongParty = isHumanHoldResumeAuthorized(["MUSTER HUMAN-HOLD alice 2026-01-01T08:05:00Z authorizer=bob", "REPLY carol: looks fine to me"]);
  assert.equal(wrongParty.authorizer, "bob");
  assert.equal(wrongParty.resumed, false);
  const rightParty = isHumanHoldResumeAuthorized(["MUSTER HUMAN-HOLD alice 2026-01-01T08:05:00Z authorizer=bob", "REPLY bob: approved"]);
  assert.equal(rightParty.resumed, true);
});

test("coordination-human-hold-resume: a wrong-party reply fails a resumeAuthorized:true expectation; the authorizer's own reply passes it", () => {
  const wrongParty = "MUSTER HUMAN-HOLD alice 2026-01-01T08:05:00Z authorizer=bob\nREPLY carol: looks fine to me";
  assert.equal(gradeCase({ check: "coordination-human-hold-resume", expect: { resumeAuthorized: false } }, wrongParty).pass, true);
  assert.equal(gradeCase({ check: "coordination-human-hold-resume", expect: { resumeAuthorized: true } }, wrongParty).pass, false);
  const rightParty = "MUSTER HUMAN-HOLD alice 2026-01-01T08:05:00Z authorizer=bob\nREPLY bob: approved";
  assert.equal(gradeCase({ check: "coordination-human-hold-resume", expect: { resumeAuthorized: true } }, rightParty).pass, true);
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

// --- capture grade-lib unit tests (eval/modes extended to plugin/commands/capture.md,
// the 7th mode) ------------------------------------------------------------------------

test("capture-exclusions: a documented exclusion reason passes; an undocumented one fails a reasonsValid:true expectation", () => {
  const candidates = [{ text: "keep me", excludedReason: null }, { text: "drop me", excludedReason: "already-completed" }];
  const good = gradeCase({ check: "capture-exclusions", expect: { reasonsValid: true, survivors: ["keep me"] } }, { candidates });
  assert.equal(good.pass, true);
  const invented = [{ text: "keep me", excludedReason: null }, { text: "drop me", excludedReason: "vibes" }];
  assert.equal(gradeCase({ check: "capture-exclusions", expect: { reasonsValid: true } }, { candidates: invented }).pass, false);
  assert.equal(gradeCase({ check: "capture-exclusions", expect: { reasonsValid: false } }, { candidates: invented }).pass, true);
  assert.ok(CAPTURE_EXCLUSION_REASONS.includes("already-completed"));
});

test("capture-cap-holdback: correct 10-cap arithmetic passes under and over the cap; wrong arithmetic fails", () => {
  assert.equal(gradeCase({ check: "capture-cap-holdback", expect: {} }, { candidateCount: 6, presentedCount: 6, heldBackStated: 0 }).pass, true);
  assert.equal(gradeCase({ check: "capture-cap-holdback", expect: {} }, { candidateCount: 14, presentedCount: 10, heldBackStated: 4 }).pass, true);
  assert.equal(gradeCase({ check: "capture-cap-holdback", expect: {} }, { candidateCount: 14, presentedCount: 10, heldBackStated: 3 }).pass, false);
  assert.equal(gradeCase({ check: "capture-cap-holdback", expect: {} }, { candidateCount: 14, presentedCount: 12, heldBackStated: 4 }).pass, false);
});

test("capture-reword-cap: clearing assessOutcome within the 2-reword cap reports clear; staying vague reports UNMEASURABLE with signals attached", () => {
  const clears = gradeCase({ check: "capture-reword-cap", expect: { finalStatus: "clear" } }, { attempts: ["make it faster", "make the checkout endpoint faster", "Reduce checkout endpoint p95 latency to under 200ms"] });
  assert.equal(clears.pass, true);
  const staysVague = gradeCase({ check: "capture-reword-cap", expect: { finalStatus: "UNMEASURABLE" } }, { attempts: ["make it better", "improve the user experience across the board", "make things feel smoother and more pleasant overall"] });
  assert.equal(staysVague.pass, true);
  assert.equal(gradeCase({ check: "capture-reword-cap", expect: { finalStatus: "clear" } }, { attempts: ["make it better"] }).pass, false);
});

test("capture-approval-order: a WRITTEN marker after AskUserQuestion passes; a Cancel flow with no write passes an expectWrite:false expectation", () => {
  const approved = "AskUserQuestion: Approve all\nUser selected: Approve all\n\nWRITTEN: item-1";
  assert.equal(gradeCase({ check: "capture-approval-order", expect: { expectWrite: true } }, approved).pass, true);
  const cancelled = "AskUserQuestion: Cancel\nUser selected: Cancel (capture nothing)";
  assert.equal(gradeCase({ check: "capture-approval-order", expect: { expectWrite: false } }, cancelled).pass, true);
  const writeBeforeApproval = "WRITTEN: item-1\nAskUserQuestion: Approve all";
  const bad = gradeCase({ check: "capture-approval-order", expect: { expectWrite: true } }, writeBeforeApproval);
  assert.equal(bad.pass, false);
  assert.equal(bad.checks.find((c) => c.name === "approvalPrecedesWrite").ok, false);
});

test("capture-dedupe: a candidate matching an existing (annotation-stripped) line is skipped; a new one is kept", () => {
  const artifacts = { existingBacklog: "- [ ] Add rate limiting {id: rate-limit} {deps: none}\n", candidates: ["Add rate limiting {mentioned: again}", "Add a brand-new item"] };
  const g = gradeCase({ check: "capture-dedupe", expect: { kept: ["Add a brand-new item"], skipped: ["Add rate limiting {mentioned: again}"] } }, artifacts);
  assert.equal(g.pass, true);
});

// --- native-builtin grade-lib unit tests (eval/modes extended to plugin/builtins/muster-*) -

test("image-prompt-set-shape: hero+2 variants with inlined hex + Avoid lines pass; a single variant punting to the brand file fails", () => {
  const clean = "### a — hero\ntext #112233\nAvoid: x\n\n### a — variant 1\ntext #112233\nAvoid: x\n\n### a — variant 2\ntext #112233\nAvoid: x";
  assert.equal(gradeCase({ check: "image-prompt-set-shape", expect: { minHeroCount: 1, minVariantCount: 2, avoidPerSection: true, brandConstraintsInlined: true, noBrandFileReference: true } }, clean).pass, true);
  const punt = "### a — hero\nmatch the brand file\n\n### a — variant 1\nmatch the brand file";
  assert.equal(gradeCase({ check: "image-prompt-set-shape", expect: { brandConstraintsInlined: false, noBrandFileReference: false, avoidPerSection: false } }, punt).pass, true);
  assert.equal(gradeCase({ check: "image-prompt-set-shape", expect: { minVariantCount: 2 } }, punt).pass, false);
});

test("video-shot-list-shape: well-formed timestamped rows pass; a missing rationale or unpadded timestamp fails a formatValid:true expectation", () => {
  const clean = "[00:00–00:10] a shot — why it matters\n[00:10–00:20] another shot — why it matters";
  assert.equal(gradeCase({ check: "video-shot-list-shape", expect: { formatValid: true, minRows: 2 } }, clean).pass, true);
  const bad = "[00:00-00:10] a shot with no rationale\n[5:00-5:10] unpadded — rationale";
  assert.equal(gradeCase({ check: "video-shot-list-shape", expect: { formatValid: true } }, bad).pass, false);
  assert.equal(gradeCase({ check: "video-shot-list-shape", expect: { formatValid: false } }, bad).pass, true);
});

test("humanizer-precedence: a voice-profile section before the generic-tells section passes; reversed order fails", () => {
  const correct = "Voice-profile anti-patterns: none\nGeneric tells: stripped 1 word";
  assert.equal(gradeCase({ check: "humanizer-precedence", expect: { hasVoiceProfileSection: true } }, correct).pass, true);
  const reversed = "Generic tells: stripped 1 word\nVoice-profile anti-patterns: none";
  const bad = gradeCase({ check: "humanizer-precedence", expect: { hasVoiceProfileSection: true } }, reversed);
  assert.equal(bad.pass, false);
  assert.equal(bad.checks.find((c) => c.name === "voicePrecedesGeneric").ok, false);
  const noProfile = "Generic tells: stripped 1 word";
  assert.equal(gradeCase({ check: "humanizer-precedence", expect: { hasVoiceProfileSection: false } }, noProfile).pass, true);
});

test("humanizer-precedence: the checked-in reversed-order fixture (unit-test-only -- voicePrecedesGeneric isn't expect-comparable, so it can't be a dataset case) fails the same way", async () => {
  const reversedFixture = await read("eval/modes/fixtures/builtins/muster-humanizer/precedence-order-reversed.md");
  const bad = gradeCase({ check: "humanizer-precedence", expect: { hasVoiceProfileSection: true } }, reversedFixture);
  assert.equal(bad.pass, false);
  assert.equal(bad.checks.find((c) => c.name === "voicePrecedesGeneric").ok, false);
});

test("scorer-verdict-shape: integer 0-3 scores passing the floor pass; an out-of-contract score (e.g. 4) fails a scoresInRange:true expectation even though the floor math alone wouldn't catch it", () => {
  const gate = { criteria: ["a", "b"], floor: 2, pass_total: 5 };
  assert.equal(gradeCase({ check: "scorer-verdict-shape", expect: { scoresInRange: true, passing: true } }, { scores: { a: 2, b: 3 }, gate }).pass, true);
  const outOfRange = gradeCase({ check: "scorer-verdict-shape", expect: { scoresInRange: true } }, { scores: { a: 4, b: 3 }, gate });
  assert.equal(outOfRange.pass, false);
  assert.equal(gradeCase({ check: "scorer-verdict-shape", expect: { scoresInRange: false } }, { scores: { a: 4, b: 3 }, gate }).pass, true);
});

test("prompt-smith-optimize-proposal: a stronger non-baseline winner reports no regression; a passing candidate below a failed baseline's total reports regression", () => {
  const improved = [{ id: "baseline", prompt: "p", total: 8, passing: true }, { id: "add-examples", prompt: "p2", total: 12, passing: true }];
  assert.equal(gradeCase({ check: "prompt-smith-optimize-proposal", expect: { winner: "add-examples", regression: false } }, improved).pass, true);
  const regressed = [{ id: "baseline", prompt: "p", total: 15, passing: false }, { id: "add-role", prompt: "p2", total: 9, passing: true }];
  assert.equal(gradeCase({ check: "prompt-smith-optimize-proposal", expect: { winner: "add-role", regression: true } }, regressed).pass, true);
  assert.equal(gradeCase({ check: "prompt-smith-optimize-proposal", expect: { regression: false } }, regressed).pass, false);
});

test("author-draft-shape: a stated framework + single CTA pass; no framework and multiple CTAs are correctly detected as such", () => {
  const clean = "Framework: PAS\n\nbody text\n\nCTA: buy now.";
  assert.equal(gradeCase({ check: "author-draft-shape", expect: { framework: "PAS", ctaCount: 1 } }, clean).pass, true);
  const bad = "just buy it\n\nCTA: buy now.\nCTA: also read this.";
  assert.equal(gradeCase({ check: "author-draft-shape", expect: { framework: null, ctaCount: 2 } }, bad).pass, true);
  assert.equal(gradeCase({ check: "author-draft-shape", expect: { framework: "PAS" } }, bad).pass, false);
});

// --- knowledge-pipeline grade-lib unit tests (eval/modes extended to the 11 remaining
// pipelines/*.yaml -- epic/okrs/roadmap/prd reuse sprint-waves/assess/roadmap-rice/
// evidence-table-shape directly and are already covered by those checks' own unit tests
// above) ----------------------------------------------------------------------------

test("runbook-step-pairs: numbered command->expected pairs pass; a step missing its expected output fails a formatValid:true expectation", () => {
  const clean = "1. `cmd1` -> expected: ok\n2. `cmd2` -> expected: ok";
  assert.equal(gradeCase({ check: "runbook-step-pairs", expect: { formatValid: true, minSteps: 2 } }, clean).pass, true);
  const bad = "1. `cmd1` -> expected: ok\n2. `cmd2`";
  assert.equal(gradeCase({ check: "runbook-step-pairs", expect: { formatValid: true } }, bad).pass, false);
  assert.equal(gradeCase({ check: "runbook-step-pairs", expect: { formatValid: false } }, bad).pass, true);
});

test("book-chapter-manifest: sequential numbered chapters pass; a gap in numbering fails a sequential:true expectation", () => {
  const sequential = "- Chapter 1: A (status: drafted)\n- Chapter 2: B (status: pending)";
  assert.equal(gradeCase({ check: "book-chapter-manifest", expect: { formatValid: true, sequential: true } }, sequential).pass, true);
  const gap = "- Chapter 1: A (status: drafted)\n- Chapter 3: C (status: pending)";
  assert.equal(gradeCase({ check: "book-chapter-manifest", expect: { sequential: true } }, gap).pass, false);
  assert.equal(gradeCase({ check: "book-chapter-manifest", expect: { formatValid: true, sequential: false } }, gap).pass, true);
});

test("ai-test-plan-case-table: a well-formed risk/type/data/env/owner table passes; a row missing its owner cell fails formatValid:true", () => {
  const header = "| tier | type | data | env | owner |\n| --- | --- | --- | --- | --- |\n";
  const clean = header + "| H | happy | d | e | o |\n";
  assert.equal(gradeCase({ check: "ai-test-plan-case-table", expect: { formatValid: true, typesInclude: ["happy"] } }, clean).pass, true);
  const bad = header + "| H | happy | d | e | |\n";
  assert.equal(gradeCase({ check: "ai-test-plan-case-table", expect: { formatValid: true } }, bad).pass, false);
  assert.equal(gradeCase({ check: "ai-test-plan-case-table", expect: { formatValid: false } }, bad).pass, true);
});

test("user-story-gherkin-shape: Given/When/Then scenarios pass; a scenario missing Then fails a scenariosWellFormed:true expectation", () => {
  const clean = "Scenario: happy path\nGiven a thing\nWhen it happens\nThen the outcome";
  assert.equal(gradeCase({ check: "user-story-gherkin-shape", expect: { scenariosWellFormed: true, minScenarios: 1 } }, clean).pass, true);
  const bad = "Scenario: happy path\nGiven a thing\nWhen it happens";
  assert.equal(gradeCase({ check: "user-story-gherkin-shape", expect: { scenariosWellFormed: true } }, bad).pass, false);
  assert.equal(gradeCase({ check: "user-story-gherkin-shape", expect: { scenariosWellFormed: false } }, bad).pass, true);
});

test("adr-status-lifecycle: a valid proposed|accepted|deprecated|superseded-by status passes; an undocumented status fails formatValid:true", () => {
  const clean = "ADR-001: x -- status: accepted\nADR-002: y -- status: superseded-by ADR-9";
  assert.equal(gradeCase({ check: "adr-status-lifecycle", expect: { formatValid: true } }, clean).pass, true);
  const bad = "ADR-001: x -- status: in-review";
  assert.equal(gradeCase({ check: "adr-status-lifecycle", expect: { formatValid: true } }, bad).pass, false);
  assert.equal(gradeCase({ check: "adr-status-lifecycle", expect: { formatValid: false } }, bad).pass, true);
});

// --- dataset + fixtures: the checked-in material grades green ---------------------------

const dataset = JSON.parse(await read("eval/modes/dataset.json"));
// "capture" is a mode prompt (plugin/commands/capture.md) — a conversation-to-backlog
// generator with no Run-active lifecycle of its own, closed out alongside the others.
//
// DECISION (vl-t6, closing the net): run.md/autopilot.md/sprint.md were the original
// verb prompts; the verb-lexicon work (vl-t2/vl-t3/vl-t4) moved their real behavior to
// plan.md/plan-backlog.md (run's single-outcome front half + its batch-plan form split
// into two files) and go.md/go-backlog.md (autopilot's and sprint's hands-off behavior,
// renamed), leaving run/autopilot/sprint as thin 8-line alias stubs (frontmatter + one
// guidance line + a Read-and-execute directive) with NO behavior of their own left to
// grade empirically. MODES therefore names the 8 real verb prompts (the 4 renamed ones
// plus the 4 unchanged ones); ALIASES below documents run/autopilot/sprint's target and
// gets a structural "alias-class check" instead of dataset.json cases (same posture this
// eval already takes for prose-only surfaces with no independent behavior to fixture --
// see the "alias-shape equivalence"/"alias-guidance" tests near the end of this file). No
// dataset.json case may declare mode:"run"/"autopilot"/"sprint" (enforced below) --
// PR #5's original run.md cases were migrated to plan/plan-backlog (see the case-count
// floor test), and the pre-existing autopilot/sprint cases were relabeled to go/go-backlog
// for the same reason (their `check`s test go.md/go-backlog.md's real deterministic
// steps, not the alias stub files' 2-line bodies).
const MODES = ["plan", "plan-backlog", "go", "go-backlog", "runner", "audit", "diagnose", "capture"];
const ALIASES = { run: "plan", autopilot: "go", sprint: "go-backlog" };
// The skill-protocol layer (plugin/skills/*, router excluded — it already has
// eval:router). Every case's `mode` field names either one of the 8 mode prompts above
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
// The native-builtin layer (eval/modes extended to plugin/builtins/muster-*/SKILL.md) --
// the 7 built-in pipeline-role providers (the gsd-*/sp-*/wsh-* builtins are vendored
// generic technique skills, not muster's own pipeline-role prompts, and are out of scope
// for this eval — see README's coverage table).
const BUILTINS = ["muster-research", "muster-image", "muster-video", "muster-humanizer", "muster-scorer", "muster-prompt-smith", "muster-author"];
// The knowledge-pipeline layer (eval/modes extended to the 11 remaining pipelines/*.yaml
// not already covered by the content-pipeline layer above: ai-implementation-spec,
// ai-test-plan, book, business-case, epic, launch-plan, okrs, prd, roadmap, runbook,
// user-story). `prd`'s own pipeline-id mode is distinct from the skill-protocol layer's
// `prd-pipeline` mode above — same real pipelines/prd.yaml gate, dispatched twice by
// design (see the dataset case's own comment).
const KNOWLEDGE_PIPELINES = ["ai-implementation-spec", "ai-test-plan", "book", "business-case", "epic", "launch-plan", "okrs", "prd", "roadmap", "runbook", "user-story"];

test("dataset covers all 8 mode prompts with at least 5 cases each, 40+ total", () => {
  const modeCases = dataset.cases.filter((c) => MODES.includes(c.mode));
  assert.ok(modeCases.length >= 40, `expected 40+ mode cases, got ${modeCases.length}`);
  const byMode = {};
  for (const c of modeCases) byMode[c.mode] = (byMode[c.mode] || 0) + 1;
  for (const mode of MODES) assert.ok((byMode[mode] || 0) >= 5, `mode "${mode}" has only ${byMode[mode] || 0} cases`);
});

test("no dataset case declares an alias name as its mode (run/autopilot/sprint are alias-class-checked structurally, not via dataset cases)", () => {
  for (const c of dataset.cases) {
    assert.ok(!(c.mode in ALIASES), `${c.id}: mode "${c.mode}" is an alias name — alias behavior is graded structurally (see the alias-shape/alias-guidance tests below), not via a dataset case`);
  }
});

// [vl-t6] CASE-COUNT FLOOR: PR #5's run.md batch-plan cases (and the earlier
// autopilot/sprint cases) were migrated (relabeled to plan/plan-backlog/go/go-backlog),
// never deleted -- this pins the pre-migration total so a future "migrate by deleting the
// inconvenient half" can't silently shrink coverage.
test("dataset case-count floor: total >= 164 (pre-t6-migration baseline)", () => {
  assert.ok(dataset.cases.length >= 164, `expected >=164 total dataset cases (the pre-migration baseline), got ${dataset.cases.length}`);
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

test("dataset covers all 7 native builtins with at least 2 cases each, 14+ total", () => {
  const builtinCases = dataset.cases.filter((c) => BUILTINS.includes(c.mode));
  assert.ok(builtinCases.length >= 14, `expected 14+ native-builtin cases, got ${builtinCases.length}`);
  const byBuiltin = {};
  for (const c of builtinCases) byBuiltin[c.mode] = (byBuiltin[c.mode] || 0) + 1;
  for (const builtin of BUILTINS) assert.ok((byBuiltin[builtin] || 0) >= 2, `builtin "${builtin}" has only ${byBuiltin[builtin] || 0} cases`);
});

test("dataset covers all 11 knowledge pipelines with at least 1 gate-achievability case each, 11+ total", () => {
  const pipelineCases = dataset.cases.filter((c) => KNOWLEDGE_PIPELINES.includes(c.mode));
  assert.ok(pipelineCases.length >= 11, `expected 11+ knowledge-pipeline cases, got ${pipelineCases.length}`);
  const byPipeline = {};
  for (const c of pipelineCases) byPipeline[c.mode] = (byPipeline[c.mode] || 0) + 1;
  for (const pipeline of KNOWLEDGE_PIPELINES) assert.ok((byPipeline[pipeline] || 0) >= 1, `knowledge pipeline "${pipeline}" has only ${byPipeline[pipeline] || 0} cases`);
});

test("every dataset case's mode is a known verb, skill, content-pipeline, builtin, or knowledge-pipeline name, and grade.mjs's row.mode is always a defined string", () => {
  const known = new Set([...MODES, ...SKILLS, ...CONTENT_PIPELINES, ...BUILTINS, ...KNOWLEDGE_PIPELINES]);
  for (const c of dataset.cases) {
    assert.equal(typeof c.mode, "string", `${c.id}: "mode" must be a defined string (grade.mjs calls .padEnd() on it unconditionally)`);
    assert.ok(known.has(c.mode), `${c.id}: unknown mode/skill/pipeline "${c.mode}" — not in MODES, SKILLS, CONTENT_PIPELINES, BUILTINS, or KNOWLEDGE_PIPELINES`);
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

// review-gate/SKILL.md's prose can't be imported like sprint-waves'/prd.yaml's real code/data
// can (it's assembled doc text -- same "no src/*.js home" posture as orchestrator-brief), so
// this drift guard reads the LIVE SKILL.md directly and asserts the checked-in
// mutant-kill-rule-clean.md fixture is byte-identical to its "## Mutant-kill gate" section --
// a future edit to review-gate/SKILL.md that silently drops or thins the rule fails this test
// instead of the fixture quietly going stale.
test("the review-gate mutant-kill-rule fixture matches the live plugin/skills/review-gate/SKILL.md section (drift guard)", async () => {
  const live = await read("plugin/skills/review-gate/SKILL.md");
  const headingIndex = live.indexOf("## Mutant-kill gate");
  assert.ok(headingIndex >= 0, "plugin/skills/review-gate/SKILL.md must contain a '## Mutant-kill gate' section");
  const liveSection = live.slice(headingIndex);
  const fixture = await read("eval/modes/fixtures/skills/review-gate/mutant-kill-rule-clean.md");
  assert.equal(liveSection, fixture, "fixtures/skills/review-gate/mutant-kill-rule-clean.md must be byte-identical to the live SKILL.md's '## Mutant-kill gate' section onward");
});

test("package.json wires eval:modes to eval/modes/grade.mjs", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.equal(pkg.scripts["eval:modes"], "node eval/modes/grade.mjs");
});

// [P2 sec] grade.mjs resolves dataset.json's `artifact` field into a fixture URL via
// resolveArtifactUrl -- it must stay contained inside the eval/modes/ tree. dataset.json
// is checked-in and reviewed today, but the containment check is cheap insurance against a
// future artifact path (accidental or malicious) resolving outside the tree it's meant to
// read from, same posture as any other path-traversal guard in this codebase.
test("resolveArtifactUrl: a normal in-tree relative path resolves; a traversal path outside eval/modes/ throws a clear error", () => {
  const base = new URL("../eval/modes/", import.meta.url);
  const resolved = resolveArtifactUrl("fixtures/skills/coordination/claim-single-winner.md", base);
  assert.ok(resolved.pathname.endsWith("fixtures/skills/coordination/claim-single-winner.md"));

  assert.throws(() => resolveArtifactUrl("../../etc/passwd", base), /escapes|outside/i);
  assert.throws(() => resolveArtifactUrl("../../../../../../etc/passwd", base), /escapes|outside/i);
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

test("the 11 knowledge-pipeline gate-achievability fixtures' gate matches each pipeline's live yaml (drift guard)", async () => {
  const { parse } = await import("yaml");
  for (const pipelineId of KNOWLEDGE_PIPELINES) {
    const live = parse(await read(`pipelines/${pipelineId}.yaml`));
    const g = JSON.parse(await read(`eval/modes/fixtures/pipelines/${pipelineId}/gate-passing.json`));
    assert.deepEqual(g.gate, live.gate, `${pipelineId}/gate-passing.json: gate must match the live pipelines/${pipelineId}.yaml gate`);
  }
});

// --- coverage-table drift guard (eval/modes/README.md's coverage table) -----------------
// The README's coverage table enumerates every prompt surface this eval suite is
// responsible for. This test asserts the table's own universe (the 5 layers already
// tracked above: MODES/SKILLS/CONTENT_PIPELINES/BUILTINS/KNOWLEDGE_PIPELINES, plus the
// router skill counted separately since it has its own eval:router, plus the ALIASES
// documented above) against the ACTUAL file inventory via glob counts, so a new
// command/skill/builtin/pipeline file added later makes this test fail instead of letting
// the table silently go stale.
test("coverage-table surfaces match the actual file inventory (glob counts) — table can't silently stale", async () => {
  const { readdir } = await import("node:fs/promises");
  const aliasNames = Object.keys(ALIASES);
  const commandFiles = (await readdir(new URL("../plugin/commands", import.meta.url))).filter((f) => f.endsWith(".md"));
  assert.equal(commandFiles.length, MODES.length + aliasNames.length, `plugin/commands/*.md has ${commandFiles.length} file(s), expected ${MODES.length + aliasNames.length} (${MODES.length} MODES + ${aliasNames.length} ALIASES)`);

  const skillDirs = await readdir(new URL("../plugin/skills", import.meta.url));
  assert.equal(skillDirs.length, SKILLS.length + 1, `plugin/skills/* has ${skillDirs.length} dir(s), expected ${SKILLS.length + 1} (10 SKILLS + router, which has its own eval:router)`);

  const builtinDirs = (await readdir(new URL("../plugin/builtins", import.meta.url))).filter((d) => d.startsWith("muster-"));
  assert.equal(builtinDirs.length, BUILTINS.length, `plugin/builtins/muster-*/ has ${builtinDirs.length} dir(s), expected ${BUILTINS.length} (BUILTINS)`);

  const pipelineFiles = (await readdir(new URL("../pipelines", import.meta.url))).filter((f) => f.endsWith(".yaml"));
  assert.equal(pipelineFiles.length, CONTENT_PIPELINES.length + KNOWLEDGE_PIPELINES.length, `pipelines/*.yaml has ${pipelineFiles.length} file(s), expected ${CONTENT_PIPELINES.length + KNOWLEDGE_PIPELINES.length} (9 CONTENT_PIPELINES + 11 KNOWLEDGE_PIPELINES)`);

  const readmeText = await read("eval/modes/README.md");
  for (const name of [...MODES, ...aliasNames, ...SKILLS, ...CONTENT_PIPELINES, ...BUILTINS, ...KNOWLEDGE_PIPELINES, "router"]) {
    assert.ok(readmeText.includes(name), `README's coverage table is missing surface "${name}"`);
  }
});

// --- alias-class checks (run.md/autopilot.md/sprint.md) --------------------------------
// Aliases carry no dataset.json cases (see the DECISION comment above MODES/ALIASES) --
// these structural checks are their entire eval coverage: (a) shape equivalence pins an
// alias to ONLY frontmatter + one guidance line + a Read-and-execute directive, so a
// future edit can't silently fatten an alias back into real logic; (b) the guidance line
// names the correct replacement command, per alias.

test("alias-shape equivalence: run.md/autopilot.md/sprint.md contain ONLY frontmatter + a guidance line + a Read-and-execute directive whose target file exists", async () => {
  for (const [alias, target] of Object.entries(ALIASES)) {
    const text = await read(`plugin/commands/${alias}.md`);
    const fmMatch = text.match(/^---\n[\s\S]*?\n---\n/);
    assert.ok(fmMatch, `${alias}.md must open with a --- frontmatter block`);
    const body = text.slice(fmMatch[0].length).trim();
    const paragraphs = body.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    assert.equal(paragraphs.length, 2, `${alias}.md body must be exactly 2 paragraphs (a guidance line + a Read-and-execute directive) — found ${paragraphs.length}, alias may have fattened back into real logic`);
    const [guidance, directive] = paragraphs;
    assert.match(guidance, /^Heads-up for the user/, `${alias}.md's first paragraph must be the heads-up guidance line`);
    assert.match(directive, /^Read plugin\/commands\/[\w-]+\.md /, `${alias}.md's second paragraph must be the Read-and-execute directive`);
    const targetMatch = directive.match(/^Read plugin\/commands\/([\w-]+)\.md /);
    assert.equal(targetMatch[1], target, `${alias}.md must delegate to ${target}.md — found "${targetMatch[1]}.md"`);
    assert.match(directive, /execute its instructions exactly, with the arguments given to this command\.$/, `${alias}.md's directive must execute the target's instructions exactly, passing arguments through unchanged`);
    await read(`plugin/commands/${target}.md`); // throws (ENOENT) if the named target file doesn't exist
  }
});

test("alias-guidance: each alias's heads-up line names the correct replacement command", async () => {
  for (const [alias, target] of Object.entries(ALIASES)) {
    const text = await read(`plugin/commands/${alias}.md`);
    assert.match(text, new RegExp(`/muster:${alias} is now /muster:${target}\\b`), `${alias}.md's guidance line must name /muster:${target} as its replacement`);
  }
});

// --- scope-confirm coverage (plan.md / go.md) -------------------------------------------
// plan.md and go.md are the two bare-verb entry points that resolve scope (item vs.
// backlog) before doing anything else — both must invoke the real `muster scope` CLI,
// require citing its `signals` verbatim (never paraphrased) in any confirm, and announce
// the artifact they're about to produce before step 0/1 runs.

test("scope-confirm coverage: plan.md and go.md invoke muster scope, require verbatim signals, and announce the artifact", async () => {
  for (const file of ["plan", "go"]) {
    const text = await read(`plugin/commands/${file}.md`);
    assert.match(text, /muster scope/, `${file}.md must invoke muster scope`);
    assert.match(text, /every string in `signals`\s*\*\*verbatim\*\*/, `${file}.md must require citing signals verbatim, not paraphrased`);
    assert.match(text, /Announce the artifact/, `${file}.md must announce the artifact it will produce`);
  }
});
