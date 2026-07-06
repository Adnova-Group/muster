// Pure grading logic for the mode-prompt evals (eval/modes/), shared by the CLI report
// (grade.mjs) and the CI regression test (test/mode-evals.test.js). No IO here — callers
// read fixtures/build artifacts and pass them in via `artifacts`.
//
// Unlike eval/router (which grades a live model's manifest output against a judge rubric),
// most mode prompts don't have a single "the model's output" artifact worth calling live —
// several steps in run.md/autopilot.md/diagnose.md/audit.md are themselves deterministic
// pipeline code (assessOutcome, parseIssueRef, classifyFailure, buildDiagnoseManifest,
// buildAuditManifest, computeSprintWaves). Where a mode step IS deterministic code, a case
// grades that code directly — zero fixture, zero manual step, cheapest tier (code >> model
// >> human, src/prompt-eval.js's stated order). Where a mode step is genuinely model-driven
// (the router's crew choice, a runner's actual claim/receipt trail), a case grades a
// CHECKED-IN golden fixture instead (see eval/modes/README.md for how those are produced).
import { validateManifest } from "../../src/manifest.js";
import { computeSprintWaves } from "../../src/sprint-waves.js";
import { assessOutcome } from "../../src/interview.js";
import { parseIssueRef } from "../../src/issue.js";
import { classifyFailure, buildDiagnoseManifest } from "../../src/diagnose.js";
import { buildAuditManifest } from "../../src/audit.js";
// --- skill-protocol layer (eval/modes extended past the 6 verb prompts into
// plugin/skills/*, per the same code >> model >> human order): each import below is a
// pure, synchronous, no-IO function a skill's SKILL.md documents as its deterministic
// step, reused here directly rather than re-implemented as a fixture-only check.
import { tallyReview } from "../../src/review.js";
import { validateFusionMap, fuse } from "../../src/fusion.js";
import { validateAdviceRequest, validateAdviceResponse, consultBudget } from "../../src/advisor.js";
import { classifyDomain } from "../../src/domain.js";
import { validatePipeline, routePipeline } from "../../src/pipeline.js";
import { scoreArtifact } from "../../src/score.js";
import { prioritizeRICE } from "../../src/prioritize.js";

// --- shared helpers -------------------------------------------------------------------

// Fences invariant (run.md/autopilot.md: parallel plan tasks must carry owns/frozen so
// concurrent workers don't collide). Only applies once a plan actually has more than one
// task — a single-task plan has nothing to fence. A task that DEPENDS on something isn't
// "parallel" in the collision sense (it runs after its deps), so a dep is also exempt.
export function planFencesOk(m) {
  const plan = Array.isArray(m?.plan) ? m.plan : [];
  if (plan.length <= 1) return true;
  return plan.every(
    (p) =>
      (Array.isArray(p.deps) && p.deps.length > 0) ||
      (Array.isArray(p.owns) && p.owns.length > 0) ||
      (Array.isArray(p.frozen) && p.frozen.length > 0)
  );
}

// autopilot.md step 8 + its Unattended subsection: merge-local/merge-push downgrade to pr
// when there is no attended human to push/merge to the base branch for. Attended, or any
// other declared value (pr/keep/ask), passes through unchanged.
export function resolveMergeDisposition(declared, { attended } = {}) {
  if (!attended && (declared === "merge-local" || declared === "merge-push")) return "pr";
  return declared;
}

// autopilot.md step 6: "commit (`feat(wave N): <summary>`)" per green + reviewed wave.
export const WAVE_COMMIT_RE = /^feat\(wave \d+\): .+/;

// coordination/SKILL.md Binding B's exact receipt grammar (the run STATE's `## Coordination`
// section) plus the BLOCKED->RESUME `ANSWER <slug>: <text>` line it also documents.
export const RECEIPT_PATTERNS = {
  CLAIMED: /^CLAIMED (\S+) (\S+) (\S+)(?:\s+.*)?$/,
  DONE: /^DONE (\S+) (\S+) (\S+) (\S+)$/,
  BLOCKED: /^BLOCKED (\S+) (\S+) (\S+) (.+)$/,
  FAILED: /^FAILED (\S+) (\S+) (\S+) (.+)$/,
  IDLE: /^IDLE (\S+) (\S+) — nothing claimable$/,
  LEDGER: /^LEDGER (\S+) last-seen=(\S+) last-item=(\S+) result=(claimed|done|blocked|failed|idle)$/,
  ANSWER: /^ANSWER (\S+): (.+)$/,
};

function receiptLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("#"));
}

function classifyReceiptLine(line) {
  for (const [type, re] of Object.entries(RECEIPT_PATTERNS)) {
    const m = re.exec(line);
    if (m) return { type, m, line };
  }
  return null;
}

// audit.md step 4's ledger line shape: `- P[0-2] \`path:line\` — problem — Fix: fix text.`
export const LEDGER_LINE_RE = /^- (P[0-2]) `([^`\n]+:\d+)` — (.+?) — Fix: (.+)$/;
const SEVERITY_RANK = { P0: 0, P1: 1, P2: 2 };

// --- per-check graders: (testCase, artifacts) -> [{name, ok, detail}] -----------------

function diagnoseClassifyCheck(testCase) {
  const expect = testCase.expect || {};
  if (expect.throws) {
    let threw = false;
    try {
      classifyFailure(testCase.outcome);
    } catch {
      threw = true;
    }
    return [{ name: "throws", ok: threw, detail: threw ? "classifyFailure threw as expected on empty input" : "classifyFailure did not throw" }];
  }
  const c = classifyFailure(testCase.outcome);
  return [{ name: "mode", ok: c.mode === expect.mode, detail: `classifyFailure(outcome).mode = "${c.mode}", expected "${expect.mode}"` }];
}

function diagnoseManifestCheck(testCase) {
  const expect = testCase.expect || {};
  const classified = classifyFailure(testCase.outcome);
  const m = buildDiagnoseManifest(classified, {});
  const v = validateManifest(m);
  const checks = [{ name: "validates", ok: v.ok, detail: v.ok ? "manifest valid" : `invalid: ${v.errors.join("; ")}` }];
  if (expect.planIds) {
    const ids = m.plan.map((p) => p.id);
    checks.push({ name: "planIds", ok: JSON.stringify(ids) === JSON.stringify(expect.planIds), detail: `plan ids ${JSON.stringify(ids)}, expected ${JSON.stringify(expect.planIds)}` });
  }
  if (expect.crewRoles) {
    const roles = m.crew.map((c) => c.stage);
    checks.push({ name: "crewRoles", ok: JSON.stringify(roles) === JSON.stringify(expect.crewRoles), detail: `crew roles ${JSON.stringify(roles)}, expected ${JSON.stringify(expect.crewRoles)}` });
  }
  return checks;
}

// audit.md's prompt-quality dimension is gated on a "prompting" signal computed upstream
// by src/detect.js's hasPromptingSignal — filesystem-bound async I/O over a real
// package.json (already exercised end-to-end with real fixtures in test/detect.test.js).
// gradeCase is called synchronously and un-awaited by the frozen grade.mjs CLI report, so
// this eval cannot also re-run that live async detection without forking that consumer's
// contract. These audit-manifest cases therefore grade buildAuditManifest's *construction*
// given a signal value the case supplies directly — `expect.givenPromptingSignal`, named
// so it reads honestly as a construction input, not a re-derivation of live detection.
function auditManifestCheck(testCase) {
  const expect = testCase.expect || {};
  const m = buildAuditManifest({}, { prompting: !!expect.givenPromptingSignal });
  const v = validateManifest(m);
  const checks = [{ name: "validates", ok: v.ok, detail: v.ok ? "manifest valid" : `invalid: ${v.errors.join("; ")}` }];
  if (expect.planIdsInclude) {
    const ids = m.plan.map((p) => p.id);
    const missing = expect.planIdsInclude.filter((id) => !ids.includes(id));
    checks.push({ name: "planIdsInclude", ok: missing.length === 0, detail: missing.length ? `missing plan ids: ${missing.join(", ")}` : `plan includes all of ${JSON.stringify(expect.planIdsInclude)}` });
  }
  if (expect.planIdsExclude) {
    const ids = m.plan.map((p) => p.id);
    const present = expect.planIdsExclude.filter((id) => ids.includes(id));
    checks.push({ name: "planIdsExclude", ok: present.length === 0, detail: present.length ? `unexpectedly present plan ids: ${present.join(", ")}` : `plan excludes all of ${JSON.stringify(expect.planIdsExclude)}` });
  }
  if (expect.crewCoversRoles) {
    // Exact stage match, not the router grade-lib's substring-based `covers()`: audit's
    // crew shape is ours (makeStage(role, ...) sets `stage` to the role verbatim), and
    // buildAuditManifest's task text ends in trailing punctuation (e.g. "...fix)"), whose
    // `split(/\W+/)` yields an empty-string token that trivially substring-matches ANY
    // role under `covers()` — exact match is both correct and meaningful here.
    const stages = new Set((m.crew || []).map((c) => c.stage));
    const missing = expect.crewCoversRoles.filter((r) => !stages.has(r));
    checks.push({ name: "crewCoversRoles", ok: missing.length === 0, detail: missing.length ? `crew missing role coverage: ${missing.join(", ")}` : "crew covers all expected roles" });
  }
  return checks;
}

function auditLedgerCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = String(artifacts).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const parsed = lines.map((l) => LEDGER_LINE_RE.exec(l));
  const bad = lines.filter((_, i) => !parsed[i]);
  const checks = [{ name: "formatValid", ok: bad.length === 0, detail: bad.length ? `malformed finding line(s): ${JSON.stringify(bad)}` : `all ${lines.length} finding(s) match severity/location/problem/fix` }];
  if (expect.minFindings != null) checks.push({ name: "minFindings", ok: lines.length >= expect.minFindings, detail: `${lines.length} finding(s), expected >= ${expect.minFindings}` });
  if (expect.sortedBySeverity) {
    const sevs = parsed.filter(Boolean).map((m) => SEVERITY_RANK[m[1]]);
    const sorted = sevs.every((s, i) => i === 0 || s >= sevs[i - 1]);
    checks.push({ name: "sortedBySeverity", ok: sorted, detail: sorted ? "findings ranked P0 before P1 before P2" : `severity order violated: ${JSON.stringify(sevs)}` });
  }
  return checks;
}

function sprintWavesCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const r = computeSprintWaves(artifacts);
  const checks = [];
  if (expect.ok !== undefined) checks.push({ name: "ok", ok: r.ok === expect.ok, detail: `ok=${r.ok}, expected ${expect.ok}` });
  if (expect.annotated !== undefined) checks.push({ name: "annotated", ok: r.annotated === expect.annotated, detail: `annotated=${r.annotated}, expected ${expect.annotated}` });
  if (expect.waves !== undefined) checks.push({ name: "waves", ok: JSON.stringify(r.waves) === JSON.stringify(expect.waves), detail: `waves=${JSON.stringify(r.waves)}, expected ${JSON.stringify(expect.waves)}` });
  if (expect.errorsNonEmpty) checks.push({ name: "errorsNonEmpty", ok: r.errors.length > 0, detail: `errors=${JSON.stringify(r.errors)}` });
  if (expect.itemDispositions) {
    for (const [id, disp] of Object.entries(expect.itemDispositions)) {
      const got = r.items[id] && r.items[id].disposition;
      checks.push({ name: `disposition:${id}`, ok: got === disp, detail: `items[${id}].disposition=${got}, expected ${disp}` });
    }
  }
  if (expect.itemEscalated) {
    for (const [id, esc] of Object.entries(expect.itemEscalated)) {
      const got = r.items[id] && r.items[id].escalated;
      checks.push({ name: `escalated:${id}`, ok: got === esc, detail: `items[${id}].escalated=${got}, expected ${esc}` });
    }
  }
  return checks;
}

function oneAttendedStopCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const marker = expect.marker || "## Batch report";
  const text = String(artifacts);
  const markerCount = text.split(marker).length - 1;
  const promptCount = (text.match(/AskUserQuestion/g) || []).length;
  const expectPrompts = expect.promptCount ?? 1;
  return [
    { name: "singleBatchReportMarker", ok: markerCount === 1, detail: `found ${markerCount} occurrence(s) of "${marker}", expected exactly 1` },
    { name: "singleAttendedPrompt", ok: promptCount === expectPrompts, detail: `found ${promptCount} AskUserQuestion occurrence(s), expected ${expectPrompts}` },
  ];
}

function assessCheck(testCase) {
  const expect = testCase.expect || {};
  const r = assessOutcome(testCase.outcome);
  const checks = [{ name: "clear", ok: r.clear === expect.clear, detail: `assessOutcome(outcome).clear = ${r.clear}, expected ${expect.clear}` }];
  if (expect.signalsInclude) {
    const missing = expect.signalsInclude.filter((s) => !r.signals.includes(s));
    checks.push({ name: "signalsInclude", ok: missing.length === 0, detail: missing.length ? `missing signal(s): ${missing.join(", ")} (got ${JSON.stringify(r.signals)})` : `signals include ${JSON.stringify(expect.signalsInclude)}` });
  }
  return checks;
}

function issueRefCheck(testCase) {
  const expect = testCase.expect || {};
  const r = parseIssueRef(testCase.outcome);
  const isIssueRef = r.kind === "issue";
  const checks = [{ name: "isIssueRef", ok: isIssueRef === expect.isIssueRef, detail: `parseIssueRef(outcome).kind = "${r.kind}", expected isIssueRef=${expect.isIssueRef}` }];
  if (expect.number != null) checks.push({ name: "number", ok: r.number === expect.number, detail: `number=${r.number}, expected ${expect.number}` });
  return checks;
}

function manifestCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const v = validateManifest(artifacts);
  const wantValid = expect.validates ?? true;
  const checks = [{ name: "validates", ok: v.ok === wantValid, detail: v.ok ? "manifest valid" : `invalid: ${v.errors.join("; ")}` }];
  if (expect.requireFences) {
    const ok = planFencesOk(artifacts);
    checks.push({ name: "fences", ok, detail: ok ? "parallel plan tasks carry owns/frozen fences" : "a parallel plan task is missing both owns and frozen" });
  }
  if (expect.expectRoles) {
    // Exact stage match (crew[i].stage is always the role name — validateManifest requires
    // it, and every builder in this codebase sets it verbatim). Deliberately not router
    // grade-lib's substring-based `covers()`: its plan-text tokenizer (`split(/\W+/)`) can
    // yield an empty-string token on trailing punctuation, which trivially substring-matches
    // ANY role and silently defeats a missing-role check — exact match sidesteps that.
    const stages = new Set((artifacts.crew || []).map((c) => c.stage));
    const missing = expect.expectRoles.filter((r) => !stages.has(r));
    checks.push({ name: "roleCoverage", ok: missing.length === 0, detail: missing.length ? `missing role coverage: ${missing.join(", ")}` : "all expected roles covered" });
  }
  if (expect.nonInline) {
    const crew = artifacts.crew || [];
    const ok = crew.length > 0 && !crew.every((c) => c.source === "inline");
    checks.push({ name: "nonInline", ok, detail: ok ? "crew is not all-inline" : "crew is all-inline (routing bypassed)" });
  }
  return checks;
}

function dispositionCheck(testCase) {
  const expect = testCase.expect || {};
  const resolved = resolveMergeDisposition(expect.declared, { attended: expect.attended });
  return [{ name: "resolvedDisposition", ok: resolved === expect.expected, detail: `resolveMergeDisposition("${expect.declared}", attended=${expect.attended}) = "${resolved}", expected "${expect.expected}"` }];
}

function commitMessageCheck(testCase, artifacts) {
  const lines = String(artifacts).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const bad = lines.filter((l) => !WAVE_COMMIT_RE.test(l));
  return [{ name: "allMatchWaveConvention", ok: bad.length === 0, detail: bad.length ? `non-conforming line(s): ${JSON.stringify(bad)}` : `all ${lines.length} commit message(s) match "feat(wave N): ..."` }];
}

function runnerReceiptsCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = receiptLines(artifacts);
  const parsed = lines.map(classifyReceiptLine);
  const checks = [];

  const badLines = lines.filter((_, i) => !parsed[i]);
  checks.push({ name: "grammarValid", ok: badLines.length === 0, detail: badLines.length ? `unrecognized receipt line(s): ${JSON.stringify(badLines)}` : `all ${lines.length} receipt line(s) match the coordination grammar` });

  const claimedByItem = new Map();
  for (const p of parsed) {
    if (p && p.type === "CLAIMED") {
      const id = p.m[1], ts = p.m[3];
      if (!claimedByItem.has(id)) claimedByItem.set(id, []);
      claimedByItem.get(id).push(ts);
    }
  }
  const terminal = parsed.filter((p) => p && (p.type === "DONE" || p.type === "BLOCKED" || p.type === "FAILED"));
  const unclaimed = terminal.filter((p) => {
    const claims = claimedByItem.get(p.m[1]) || [];
    return !claims.some((c) => c <= p.m[3]);
  });
  checks.push({ name: "claimBeforeWork", ok: unclaimed.length === 0, detail: unclaimed.length ? `terminal receipt(s) with no prior CLAIMED: ${unclaimed.map((p) => p.line).join(" | ")}` : "every terminal receipt is preceded by a CLAIMED receipt for the same item" });

  if (expect.expectDisposition) {
    const doneLines = parsed.filter((p) => p && p.type === "DONE");
    const bad = doneLines.filter((p) => p.m[4] !== expect.expectDisposition);
    checks.push({ name: "dispositionForced", ok: bad.length === 0, detail: bad.length ? `DONE line(s) with unexpected disposition: ${bad.map((p) => p.line).join(" | ")}` : `every DONE receipt carries disposition "${expect.expectDisposition}"` });
  }

  const ledgerByRunner = new Map();
  for (const p of parsed) if (p && p.type === "LEDGER") ledgerByRunner.set(p.m[1], (ledgerByRunner.get(p.m[1]) || 0) + 1);
  const overLimit = [...ledgerByRunner.entries()].filter(([, n]) => n > 1);
  checks.push({ name: "oneLedgerHeartbeatPerRunner", ok: overLimit.length === 0, detail: overLimit.length ? `runner(s) with >1 LEDGER line: ${overLimit.map(([r, n]) => `${r}:${n}`).join(", ")}` : "every runner has at most one LEDGER heartbeat line" });

  return checks;
}

// --- skill-protocol checks (eval/modes extended to plugin/skills/*, router excluded --
// it already has eval:router) --------------------------------------------------------

// orchestrator/SKILL.md's "Scope fences" + "Return contract" sections: a dispatched
// crew brief must carry its fences verbatim (OWNS:/FROZEN:/FORBIDDEN ACTIONS: lines,
// only when the manifest task actually has them) and must state the return-contract
// char caps + verdict-first rule for reviewers. No src/*.js pure function backs a
// "brief" (it's assembled prose, not data) -- this grades a checked-in fixture brief
// structurally, the same tier fixture/audit-ledger and fixture/runner-receipts use.
const OWNS_LINE_RE = /^OWNS: .+$/m;
const FROZEN_LINE_RE = /^FROZEN: .+$/m;
const FORBIDDEN_ACTIONS_LINE_RE = /^FORBIDDEN ACTIONS: .+$/m;

function orchestratorBriefCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const text = String(artifacts);
  const checks = [];
  if (expect.requireOwns !== undefined) {
    const has = OWNS_LINE_RE.test(text);
    checks.push({ name: "ownsLine", ok: has === expect.requireOwns, detail: `OWNS: line present=${has}, expected ${expect.requireOwns}` });
  }
  if (expect.requireFrozen !== undefined) {
    const has = FROZEN_LINE_RE.test(text);
    checks.push({ name: "frozenLine", ok: has === expect.requireFrozen, detail: `FROZEN: line present=${has}, expected ${expect.requireFrozen}` });
  }
  if (expect.requireForbiddenActions !== undefined) {
    const has = FORBIDDEN_ACTIONS_LINE_RE.test(text);
    checks.push({ name: "forbiddenActionsLine", ok: has === expect.requireForbiddenActions, detail: `FORBIDDEN ACTIONS: line present=${has}, expected ${expect.requireForbiddenActions}` });
  }
  const returnContractPresent = /return contract/i.test(text);
  checks.push({ name: "returnContractPresent", ok: returnContractPresent, detail: returnContractPresent ? "brief states a return contract" : "brief has no return-contract block" });
  if (expect.returnContractCaps) {
    const missing = expect.returnContractCaps.filter((cap) => !new RegExp(`<=\\s*${cap}\\s*chars`, "i").test(text));
    checks.push({ name: "returnContractCaps", ok: missing.length === 0, detail: missing.length ? `missing stated char cap(s): ${missing.join(", ")}` : `brief states cap(s) ${JSON.stringify(expect.returnContractCaps)}` });
  }
  if (expect.verdictFirstInstruction) {
    const ok = /verdict FIRST/i.test(text);
    checks.push({ name: "verdictFirstInstruction", ok, detail: ok ? "brief instructs verdict FIRST" : "brief does not instruct returning the verdict first" });
  }
  return checks;
}

// review-gate/SKILL.md: reviewers return findings `[{severity, note}]`, tallied by the
// REAL `tallyReview` (src/review.js -- ANY blocker blocks, not majority) into a pass/
// escalate verdict. This case grades a fixture of the reviewer's RENDERED response text
// (the model-produced artifact) for two structural rules at once: "verdict-first shape"
// (the response's first line IS the verdict, never buried after the findings) and
// "findings-precede-verdict" (the declared verdict must be exactly what tallying the
// findings implies -- a verdict is a FUNCTION of the findings, never asserted
// independently of them, even though it is rendered before them).
const VERDICT_LINE_RE = /^VERDICT: (PASS|ESCALATE)$/;
const FINDING_LINE_RE = /^- (BLOCKER|RISK|NIT): (.+)$/i;

function reviewGateVerdictCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = String(artifacts).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const [firstLine, ...rest] = lines;
  const verdictMatch = VERDICT_LINE_RE.exec(firstLine || "");
  const checks = [{ name: "verdictFirst", ok: !!verdictMatch, detail: verdictMatch ? `first line declares VERDICT: ${verdictMatch[1]}` : `first non-empty line "${firstLine}" is not a "VERDICT: PASS|ESCALATE" line` }];

  const parsedFindings = rest.map((l) => FINDING_LINE_RE.exec(l));
  const badFindings = rest.filter((_, i) => !parsedFindings[i]);
  checks.push({ name: "severityTagsValid", ok: badFindings.length === 0, detail: badFindings.length ? `finding line(s) with no valid severity tag: ${JSON.stringify(badFindings)}` : `all ${rest.length} finding line(s) carry a blocker|risk|nit severity tag` });

  if (verdictMatch) {
    const declared = verdictMatch[1];
    const findings = parsedFindings.filter(Boolean).map((m) => ({ severity: m[1].toLowerCase(), note: m[2] }));
    const tally = tallyReview([{ reviewer: "fixture", findings }]);
    const implied = tally.blocked ? "ESCALATE" : "PASS";
    checks.push({ name: "findingsPrecedeVerdict", ok: declared === implied, detail: `declared VERDICT: ${declared}; tallyReview(findings).blocked=${tally.blocked} implies ${implied}` });
    if (expect.verdict) checks.push({ name: "verdict", ok: declared === expect.verdict, detail: `verdict="${declared}", expected "${expect.verdict}"` });
  }
  return checks;
}

// coordination/SKILL.md Binding A (GitHub issues): comments are `MUSTER
// CLAIMED|DONE|BLOCKED|FAILED|YIELD <runner> <ts>`, first line fixed, free-text detail
// may follow on later (non-MUSTER-prefixed) lines of the SAME comment -- those are
// ignored here, not grammar violations. The claim-window race rule is genuinely
// deterministic (an ordering computation over timestamps) but has no src/*.js home (it's
// documented protocol, not shipped code) -- encoded here directly, same precedent as
// RECEIPT_PATTERNS/WAVE_COMMIT_RE above.
export const MUSTER_RECEIPT_PATTERNS = {
  CLAIMED: /^MUSTER CLAIMED (\S+) (\S+)(?:\s.*)?$/,
  DONE: /^MUSTER DONE (\S+) (\S+)(?:\s.*)?$/,
  BLOCKED: /^MUSTER BLOCKED (\S+) (\S+)(?:\s.*)?$/,
  FAILED: /^MUSTER FAILED (\S+) (\S+)(?:\s.*)?$/,
  YIELD: /^MUSTER YIELD (\S+) (\S+)(?:\s.*)?$/,
};

function classifyMusterLine(line) {
  for (const [type, re] of Object.entries(MUSTER_RECEIPT_PATTERNS)) {
    const m = re.exec(line);
    if (m) return { type, runner: m[1], ts: m[2], line };
  }
  return null;
}

// Walk the thread chronologically (events are assumed already in the fixture's posted
// order, same as a real comment thread), accumulating CLAIMED comments into the CURRENT
// open window. Each DONE/BLOCKED/FAILED terminal comment resolves that window (its
// earliest claim is the winner, every other claim in it a loser) and starts a fresh one
// -- deliberately NOT YIELD (coordination/SKILL.md's own rationale: a loser's yield
// landing before the winner's re-read would otherwise floor the winner's own claim out
// of its window, making the win undecidable). Returns every window plus `current`, the
// still-open (possibly unresolved) trailing window a live thread ends in.
export function computeClaimWindows(events) {
  const windows = [];
  let claims = [];
  let floor = "";
  const resolve = (resolvedBy) => {
    const sorted = [...claims].sort((a, b) => (a.ts < b.ts ? -1 : a.ts > b.ts ? 1 : a.runner.localeCompare(b.runner)));
    windows.push({ floor, claims: sorted, winner: sorted[0] || null, losers: sorted.slice(1), resolvedBy });
  };
  for (const e of events) {
    if (e.type === "CLAIMED") claims.push(e);
    else if (e.type === "DONE" || e.type === "BLOCKED" || e.type === "FAILED") {
      resolve(e);
      floor = e.ts;
      claims = [];
    }
    // YIELD: never resolves or floors a window -- ignored for this walk.
  }
  const current = claims.length || windows.length === 0 ? (resolve(null), windows[windows.length - 1]) : windows[windows.length - 1];
  return { windows, current };
}

// Convenience wrapper: the winner/losers of the thread's CURRENT (most recent, possibly
// still-open) claim window -- what a runner reading the thread right now would compute.
export function computeClaimWindowWinner(events) {
  return computeClaimWindows(events).current;
}

function coordinationClaimWindowCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = String(artifacts).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const musterLines = lines.filter((l) => l.startsWith("MUSTER "));
  const parsed = musterLines.map(classifyMusterLine);
  const bad = musterLines.filter((_, i) => !parsed[i]);
  const checks = [{ name: "grammarValid", ok: bad.length === 0, detail: bad.length ? `unrecognized MUSTER receipt line(s): ${JSON.stringify(bad)}` : `all ${musterLines.length} MUSTER receipt line(s) match CLAIMED|DONE|BLOCKED|FAILED|YIELD` }];

  const events = parsed.filter(Boolean);
  const { winner, losers } = computeClaimWindowWinner(events);
  checks.push({ name: "winner", ok: winner?.runner === expect.winner, detail: `computed claim-window winner="${winner?.runner}", expected "${expect.winner}"` });

  const yieldRunners = new Set(events.filter((e) => e.type === "YIELD").map((e) => e.runner));
  const unyielded = losers.filter((l) => !yieldRunners.has(l.runner));
  checks.push({ name: "losersYielded", ok: unyielded.length === 0, detail: unyielded.length ? `losing claimant(s) with no YIELD receipt: ${unyielded.map((l) => l.runner).join(", ")}` : `every losing claimant (${losers.map((l) => l.runner).join(", ") || "none"}) left a YIELD receipt` });

  if (expect.terminalType) {
    const winnerTerminal = events.find((e) => e.runner === winner?.runner && (e.type === "DONE" || e.type === "BLOCKED" || e.type === "FAILED"));
    checks.push({ name: "winnerTerminalReceipt", ok: winnerTerminal?.type === expect.terminalType, detail: `winner's terminal receipt type="${winnerTerminal?.type}", expected "${expect.terminalType}"` });
  }
  return checks;
}

// interview/SKILL.md: the approved output is `{enrichedOutcome, successCriteria}` --
// the enriched outcome must itself clear the same `assessOutcome` gate (src/interview.js)
// that triggered the interview in the first place (a real interview that only rephrases
// without adding measurable criteria hasn't actually closed the gap), and successCriteria
// must be a non-empty array of non-empty strings.
function interviewEnrichedOutcomeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { enrichedOutcome, successCriteria } = artifacts || {};
  const r = assessOutcome(enrichedOutcome);
  const wantClear = expect.clear ?? true;
  const checks = [{ name: "clear", ok: r.clear === wantClear, detail: `assessOutcome(enrichedOutcome).clear=${r.clear}, expected ${wantClear} (signals=${JSON.stringify(r.signals)})` }];
  const minCriteria = expect.minCriteria ?? 1;
  const criteriaOk = Array.isArray(successCriteria) && successCriteria.length >= minCriteria && successCriteria.every((c) => typeof c === "string" && c.trim().length > 0);
  checks.push({ name: "successCriteriaShape", ok: criteriaOk, detail: criteriaOk ? `successCriteria has ${successCriteria.length} non-empty string item(s) (>= ${minCriteria})` : `successCriteria is not a non-empty-string array of length >= ${minCriteria} (got ${JSON.stringify(successCriteria)})` });
  return checks;
}

// interview/SKILL.md's Decomposition check: "each item must embed at least one number or
// measurable keyword so `assess "<item text>"` -- run with every `{key: value}`
// annotation stripped generically -- returns clear:true standalone". Reuses TWO real
// pipeline functions together: `computeSprintWaves` (src/sprint-waves.js) strips the
// annotations and produces `items[id].text`, then `assessOutcome` (src/interview.js)
// grades that stripped text directly -- exactly the two functions the interview's own
// rule names, wired the same way sprint.md consumes them.
function interviewBacklogMeasurableCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const r = computeSprintWaves(artifacts);
  const checks = [{ name: "parses", ok: r.ok === true, detail: r.ok ? "backlog item parses" : `backlog failed to parse: ${r.errors.join("; ")}` }];
  const item = r.items[expect.id];
  const itemFound = !!item;
  checks.push({ name: "itemFound", ok: itemFound, detail: itemFound ? `item "${expect.id}" found` : `item "${expect.id}" not found among ${JSON.stringify(Object.keys(r.items))}` });
  if (itemFound) {
    const assessed = assessOutcome(item.text);
    const wantClear = expect.clear ?? true;
    checks.push({ name: "measurable", ok: assessed.clear === wantClear, detail: `assessOutcome(items["${expect.id}"].text).clear=${assessed.clear}, expected ${wantClear} (stripped text: "${item.text}")` });
  }
  return checks;
}

// tournament/SKILL.md step 2b: the judge's fusion map must validate against the REAL
// `validateFusionMap` (src/fusion.js) -- the exact schema `muster fuse` enforces.
function tournamentFusionMapCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const v = validateFusionMap(artifacts);
  const wantOk = expect.ok ?? true;
  return [{ name: "ok", ok: v.ok === wantOk, detail: v.ok ? "fusion map valid" : `invalid: ${v.errors.join("; ")}` }];
}

// tournament/SKILL.md steps 3-4: `muster fuse` (src/fusion.js's `fuse`) is the
// deterministic decision engine over `{candidates, fusionMap}` -- this grades its real
// decision output directly (mode/reason/winner/topK), not a re-description of it.
function tournamentFuseCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { candidates, fusionMap } = artifacts || {};
  const r = fuse(candidates, fusionMap);
  const checks = [{ name: "mode", ok: r.mode === expect.mode, detail: `fuse(...).mode="${r.mode}", expected "${expect.mode}"` }];
  if (expect.reason) checks.push({ name: "reason", ok: r.reason === expect.reason, detail: `reason="${r.reason}", expected "${expect.reason}"` });
  // Fallback shape's `winner` field is the FULL `pickWinner` result ({winner, escalate,
  // ranking}, src/tournament.js), not a bare id — `expect.winnerId` names the id inside it.
  if (expect.winnerId !== undefined) checks.push({ name: "winnerId", ok: r.winner?.winner === expect.winnerId, detail: `winner.winner=${JSON.stringify(r.winner?.winner)}, expected ${JSON.stringify(expect.winnerId)}` });
  if (expect.topKCount !== undefined) checks.push({ name: "topKCount", ok: Array.isArray(r.topK) && r.topK.length === expect.topKCount, detail: `topK=${JSON.stringify(r.topK)}, expected length ${expect.topKCount}` });
  if (expect.topKIncludes) {
    const missing = expect.topKIncludes.filter((id) => !(r.topK || []).includes(id));
    checks.push({ name: "topKIncludes", ok: missing.length === 0, detail: missing.length ? `topK missing id(s): ${missing.join(", ")} (topK=${JSON.stringify(r.topK)})` : `topK includes all of ${JSON.stringify(expect.topKIncludes)}` });
  }
  return checks;
}

// domain-router/SKILL.md step 1: `classifyDomain` (src/domain.js) is the real
// keyword/workspace classifier the skill's `muster route`-adjacent `muster domain` CLI
// wraps.
function domainClassifyCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { outcome, profile, override } = artifacts || {};
  const r = classifyDomain(outcome, profile, override);
  const checks = [{ name: "domain", ok: r.domain === expect.domain, detail: `classifyDomain(...).domain="${r.domain}", expected "${expect.domain}"` }];
  if (expect.source) checks.push({ name: "source", ok: r.source === expect.source, detail: `source="${r.source}", expected "${expect.source}"` });
  return checks;
}

// domain-router/SKILL.md step 1: `routePipeline` (src/pipeline.js) picks the specific
// pipeline by keyword match (earliest position wins), falling back to the domain's
// default -- the real function `muster route` wraps.
function domainPipelineRouteCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { pipelines, outcome, domain } = artifacts || {};
  const r = routePipeline(pipelines, outcome, domain);
  const gotId = r ? r.id : null;
  return [{ name: "pipelineId", ok: gotId === expect.pipelineId, detail: `routePipeline(...) -> id=${JSON.stringify(gotId)}, expected ${JSON.stringify(expect.pipelineId)}` }];
}

// advisor/SKILL.md's request/response/budget contracts: all three are pure validators
// in src/advisor.js, graded directly against real advice-request/response shapes and
// budget states rather than re-describing the validation rules.
function advisorRequestCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const v = validateAdviceRequest(artifacts);
  const wantOk = expect.ok ?? true;
  return [{ name: "ok", ok: v.ok === wantOk, detail: v.ok ? "advice request valid" : `invalid: ${v.errors.join("; ")}` }];
}

function advisorResponseCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const v = validateAdviceResponse(artifacts);
  const wantOk = expect.ok ?? true;
  return [{ name: "ok", ok: v.ok === wantOk, detail: v.ok ? "advice response valid" : `invalid: ${v.errors.join("; ")}` }];
}

function advisorBudgetCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { consults, maxConsults } = artifacts || {};
  const r = consultBudget({ consults, maxConsults });
  const checks = [{ name: "consult", ok: r.consult === expect.consult, detail: `consultBudget(...).consult=${r.consult}, expected ${expect.consult}` }];
  if (expect.reason) checks.push({ name: "reason", ok: r.reason === expect.reason, detail: `reason="${r.reason}", expected "${expect.reason}"` });
  return checks;
}

// greenfield/SKILL.md step 3 (`muster setup` / src/setup.js's `scaffoldProject`): the
// seed file set it creates when absent. `scaffoldProject` performs real filesystem
// writes (mkdir/writeFile/git init) and is not itself a pure function this eval can call
// without IO (grade-lib.mjs stays no-IO, per its header) -- so this grades a checked-in
// `{created, skipped}` result shape against the seed set documented here as a literal
// contract (same precedent as WAVE_COMMIT_RE/MUSTER_RECEIPT_PATTERNS above): known
// limitation, not a live re-run of `scaffoldProject` itself.
export const SCAFFOLD_SEED_FILES = [".git", ".gitignore", "docs/design/.gitkeep", "docs/plan/.gitkeep", "README.md", "AGENTS.md"];

function greenfieldScaffoldShapeCheck(testCase, artifacts) {
  const { created, skipped } = artifacts || {};
  const shapeOk = Array.isArray(created) && Array.isArray(skipped) && created.every((s) => typeof s === "string") && skipped.every((s) => typeof s === "string");
  const checks = [{ name: "shape", ok: shapeOk, detail: shapeOk ? "created/skipped are string arrays" : `malformed shape: created=${JSON.stringify(created)}, skipped=${JSON.stringify(skipped)}` }];
  if (!shapeOk) return checks;
  // scaffoldProject's ".git (git unavailable)" skip entry carries trailing detail — compare
  // by the seed-file token (first word) only.
  const createdBase = created.map((s) => s.split(" ")[0]);
  const skippedBase = skipped.map((s) => s.split(" ")[0]);
  const overlap = createdBase.filter((f) => skippedBase.includes(f));
  checks.push({ name: "noOverlap", ok: overlap.length === 0, detail: overlap.length ? `file(s) in both created and skipped: ${overlap.join(", ")}` : "created and skipped are disjoint" });
  const union = new Set([...createdBase, ...skippedBase]);
  const missing = SCAFFOLD_SEED_FILES.filter((f) => !union.has(f));
  checks.push({ name: "coversAllSeeds", ok: missing.length === 0, detail: missing.length ? `seed file(s) neither created nor skipped: ${missing.join(", ")}` : `created+skipped covers all ${SCAFFOLD_SEED_FILES.length} seed files` });
  return checks;
}

// prd-pipeline/SKILL.md phase "score": validates the real `pipelines/prd.yaml` shape
// (`validatePipeline`, src/pipeline.js) and grades gate achievability via the REAL
// floor-principle math (`scoreArtifact`, src/score.js) -- the same function `muster
// score` runs. A drift guard (test/mode-evals.test.js) pins the hardcoded pipeline/gate
// fixtures used here against the live pipelines/prd.yaml file.
function prdPipelineShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const v = validatePipeline(artifacts);
  const wantOk = expect.ok ?? true;
  return [{ name: "ok", ok: v.ok === wantOk, detail: v.ok ? "pipeline shape valid" : `invalid: ${v.errors.join("; ")}` }];
}

function prdGateAchievabilityCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { scores, gate } = artifacts || {};
  const r = scoreArtifact(scores, gate);
  const checks = [];
  if (expect.total !== undefined) checks.push({ name: "total", ok: r.total === expect.total, detail: `total=${r.total}, expected ${expect.total}` });
  if (expect.weakestCriterion !== undefined) checks.push({ name: "weakestCriterion", ok: r.weakest.criterion === expect.weakestCriterion, detail: `weakest.criterion="${r.weakest.criterion}", expected "${expect.weakestCriterion}"` });
  if (expect.passing !== undefined) checks.push({ name: "passing", ok: r.passing === expect.passing, detail: `passing=${r.passing}, expected ${expect.passing}` });
  return checks;
}

// roadmap-prioritization/SKILL.md step 4: "Code does the math; the model only supplies
// the factors" -- grades the REAL `prioritizeRICE` (src/prioritize.js) directly: rank
// order, exact scores, and the documented fail-loud-on-zero-effort behavior.
function roadmapRiceCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  if (expect.throws) {
    let threw = false;
    try {
      prioritizeRICE(artifacts);
    } catch {
      threw = true;
    }
    return [{ name: "throws", ok: threw, detail: threw ? "prioritizeRICE threw as expected" : "prioritizeRICE did not throw" }];
  }
  const r = prioritizeRICE(artifacts);
  const checks = [];
  if (expect.rankOrder) {
    const order = [...r].sort((a, b) => a.rank - b.rank).map((i) => i.name);
    checks.push({ name: "rankOrder", ok: JSON.stringify(order) === JSON.stringify(expect.rankOrder), detail: `rank order=${JSON.stringify(order)}, expected ${JSON.stringify(expect.rankOrder)}` });
  }
  if (expect.scores) {
    for (const [name, score] of Object.entries(expect.scores)) {
      const got = r.find((i) => i.name === name)?.score;
      checks.push({ name: `score:${name}`, ok: got === score, detail: `score["${name}"]=${got}, expected ${score}` });
    }
  }
  return checks;
}

// --- dispatch --------------------------------------------------------------------------

// What kind of artifact each check needs, so a caller (grade.mjs / the CI test) knows
// whether to read+JSON.parse a fixture file, read it as raw text, or pass nothing (the
// check is computed purely from testCase.outcome via an imported src/*.js function).
export const ARTIFACT_KIND = {
  "diagnose-classify": "none",
  "diagnose-manifest": "none",
  "audit-manifest": "none",
  "audit-ledger": "text",
  "audit-backlog-waves": "text",
  assess: "none",
  "issue-ref": "none",
  manifest: "json",
  "sprint-waves": "text",
  "sprint-one-attended-stop": "text",
  disposition: "none",
  "commit-message": "text",
  "runner-receipts": "text",
  "orchestrator-brief": "text",
  "review-gate-verdict": "text",
  "coordination-claim-window": "text",
  "interview-enriched-outcome": "json",
  "interview-backlog-measurable": "text",
  "tournament-fusion-map": "json",
  "tournament-fuse": "json",
  "domain-classify": "json",
  "domain-pipeline-route": "json",
  "advisor-request": "json",
  "advisor-response": "json",
  "advisor-budget": "json",
  "greenfield-scaffold-shape": "json",
  "prd-pipeline-shape": "json",
  "prd-gate-achievability": "json",
  "roadmap-rice": "json",
};

export const CHECKS = {
  "diagnose-classify": diagnoseClassifyCheck,
  "diagnose-manifest": diagnoseManifestCheck,
  "audit-manifest": auditManifestCheck,
  "audit-ledger": auditLedgerCheck,
  "audit-backlog-waves": sprintWavesCheck,
  assess: assessCheck,
  "issue-ref": issueRefCheck,
  manifest: manifestCheck,
  "sprint-waves": sprintWavesCheck,
  "sprint-one-attended-stop": oneAttendedStopCheck,
  disposition: dispositionCheck,
  "commit-message": commitMessageCheck,
  "runner-receipts": runnerReceiptsCheck,
  "orchestrator-brief": orchestratorBriefCheck,
  "review-gate-verdict": reviewGateVerdictCheck,
  "coordination-claim-window": coordinationClaimWindowCheck,
  "interview-enriched-outcome": interviewEnrichedOutcomeCheck,
  "interview-backlog-measurable": interviewBacklogMeasurableCheck,
  "tournament-fusion-map": tournamentFusionMapCheck,
  "tournament-fuse": tournamentFuseCheck,
  "domain-classify": domainClassifyCheck,
  "domain-pipeline-route": domainPipelineRouteCheck,
  "advisor-request": advisorRequestCheck,
  "advisor-response": advisorResponseCheck,
  "advisor-budget": advisorBudgetCheck,
  "greenfield-scaffold-shape": greenfieldScaffoldShapeCheck,
  "prd-pipeline-shape": prdPipelineShapeCheck,
  "prd-gate-achievability": prdGateAchievabilityCheck,
  "roadmap-rice": roadmapRiceCheck,
};

// Grade one case against its (already-loaded) artifacts. Never throws: a grader exception
// (e.g. a malformed fixture) becomes a single failing check instead of crashing the report.
export function gradeCase(testCase, artifacts) {
  const fn = CHECKS[testCase.check];
  if (!fn) return { pass: false, checks: [{ name: "check", ok: false, detail: `unknown check "${testCase.check}"` }] };
  let checks;
  try {
    checks = fn(testCase, artifacts);
  } catch (e) {
    checks = [{ name: "error", ok: false, detail: `grader threw: ${e.message}` }];
  }
  return { pass: checks.length > 0 && checks.every((c) => c.ok), checks };
}
