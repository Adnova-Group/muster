// Skill-protocol layer of eval/modes/'s grading logic (eval/modes extended past the 6
// verb prompts into plugin/skills/*, router excluded -- it already has eval:router). One
// of grade-lib.mjs's layer modules (see grade-lib.mjs's header for the full layer list);
// grade-lib.mjs composes this module's CHECKS/ARTIFACT_KIND with the other layers' into
// the public dispatch tables. Each import below is a pure, synchronous, no-IO function a
// skill's SKILL.md documents as its deterministic step, reused here directly rather than
// re-implemented as a fixture-only check.
import { assessOutcome } from "../../src/interview.js";
import { computeSprintWaves } from "../../src/sprint-waves.js";
import { tallyReview } from "../../src/review.js";
import { validateFusionMap, fuse } from "../../src/fusion.js";
import { validateAdviceRequest, validateAdviceResponse, consultBudget } from "../../src/advisor.js";
import { classifyDomain } from "../../src/domain.js";
import { validatePipeline, routePipeline } from "../../src/pipeline.js";
import { prioritizeRICE } from "../../src/prioritize.js";
import { MUSTER_RECEIPT_PATTERNS, computeClaimWindowWinner, isHumanHoldResumeAuthorized } from "../../src/coordination.js";
import { gateAchievabilityCheck } from "./grade-core.mjs";

export { gateAchievabilityCheck };

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

// review-gate/SKILL.md's "Mutant-kill gate" section: a wave introducing a new test or eval
// guard PASSes only with a demonstrated kill (the mutation, the failing output, the
// byte-identical restore) recorded in the review evidence. No src/*.js pure function backs
// a gate's prose (it's assembled doc text, not data) -- this grades a checked-in fixture
// copy of the section's text structurally, same tier orchestrator-brief above. A
// "corrupt-twin" fixture with the evidence shape thinned (see
// fixtures/skills/review-gate/mutant-kill-rule-missing-evidence-shape.md) demonstrates the
// check itself catches a silently eroded rule -- exactly the failure mode the rule it grades
// exists to prevent.
const MUTANT_KILL_HEADING_RE = /^## Mutant-kill gate$/m;
const MUTATION_STEP_RE = /\*\*The mutation\*\*/;
const FAILING_OUTPUT_STEP_RE = /\*\*The failing output\*\*/;
const BYTE_IDENTICAL_RESTORE_STEP_RE = /\*\*The byte-identical restore\*\*/;
const AUTOMATIC_FAIL_RE = /automatic FAIL/;

function reviewGateMutantKillRuleCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const text = String(artifacts);
  const checks = [];
  const requirePattern = (name, want, re, okDetail, missDetail) => {
    if (want === undefined) return;
    const has = re.test(text);
    checks.push({ name, ok: has === want, detail: has ? okDetail : missDetail });
  };
  requirePattern("rulePresent", expect.rulePresent, MUTANT_KILL_HEADING_RE,
    "Mutant-kill gate heading is present", "no '## Mutant-kill gate' heading found");
  requirePattern("mutationStep", expect.requiresMutationStep, MUTATION_STEP_RE,
    "states the mutation evidence step", "missing the 'The mutation' evidence step");
  requirePattern("failingOutputStep", expect.requiresFailingOutputStep, FAILING_OUTPUT_STEP_RE,
    "states the failing-output evidence step", "missing the 'The failing output' evidence step");
  requirePattern("byteIdenticalRestoreStep", expect.requiresByteIdenticalRestoreStep, BYTE_IDENTICAL_RESTORE_STEP_RE,
    "states the byte-identical-restore evidence step", "missing the 'The byte-identical restore' evidence step");
  requirePattern("automaticFailOnMissingEvidence", expect.requiresAutomaticFailOnMissingEvidence, AUTOMATIC_FAIL_RE,
    "states the automatic-FAIL default for missing evidence", "missing the automatic-FAIL-on-no-evidence statement");
  return checks;
}

// coordination/SKILL.md Binding A (GitHub issues): comments are `MUSTER
// CLAIMED|DONE|BLOCKED|FAILED|YIELD <runner> <ts>`, first line fixed, free-text detail
// may follow on later (non-MUSTER-prefixed) lines of the SAME comment -- those are
// ignored here, not grammar violations. MUSTER_RECEIPT_PATTERNS/computeClaimWindows/
// isHumanHoldResumeAuthorized live in src/coordination.js (imported above); this local
// classifyMusterLine stays here -- it's eval-only plumbing turning a raw MUSTER line into
// the `{type, runner, ts, line}` event shape computeClaimWindows expects, not part of the
// claim-window rule itself.
function classifyMusterLine(line) {
  for (const [type, re] of Object.entries(MUSTER_RECEIPT_PATTERNS)) {
    const m = re.exec(line);
    if (m) return { type, runner: m[1], ts: m[2], line };
  }
  return null;
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
    const winnerTerminal = events.find((e) => e.runner === winner?.runner && (e.type === "DONE" || e.type === "BLOCKED" || e.type === "HUMAN-HOLD" || e.type === "FAILED"));
    checks.push({ name: "winnerTerminalReceipt", ok: winnerTerminal?.type === expect.terminalType, detail: `winner's terminal receipt type="${winnerTerminal?.type}", expected "${expect.terminalType}"` });
  }
  return checks;
}

function coordinationHumanHoldResumeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = String(artifacts).split(/\r?\n/);
  const { authorizer, resumed } = isHumanHoldResumeAuthorized(lines);
  return [
    {
      name: "resumeAuthorized",
      ok: resumed === expect.resumeAuthorized,
      detail: `authorizer="${authorizer}", resumeAuthorized=${resumed}, expected ${expect.resumeAuthorized}`,
    },
  ];
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
// contract (same precedent as WAVE_COMMIT_RE/MUSTER_RECEIPT_PATTERNS): known limitation,
// not a live re-run of `scaffoldProject` itself.
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
// floor-principle math (`scoreArtifact`, src/score.js, wrapped by grade-core.mjs's
// gateAchievabilityCheck) -- the same function `muster score` runs. A drift guard
// (test/mode-evals.test.js) pins the hardcoded pipeline/gate fixtures used here against
// the live pipelines/prd.yaml file.
function prdPipelineShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const v = validatePipeline(artifacts);
  const wantOk = expect.ok ?? true;
  return [{ name: "ok", ok: v.ok === wantOk, detail: v.ok ? "pipeline shape valid" : `invalid: ${v.errors.join("; ")}` }];
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

// --- capture checks (eval/modes extended to plugin/commands/capture.md, the 7th mode --
// the conversation-to-backlog generator). capture.md documents its extract/validate/
// dedupe/write machinery as protocol prose (no src/*.js home of its own), but three of
// its five documented rules genuinely reuse real code already imported above
// (assessOutcome for the reword-cap/UNMEASURABLE rule) or the SAME annotation grammar
// src/sprint-waves.js documents (its `stripAnnotations` helper isn't exported, so the
// dedupe check below copies that grammar directly -- same honest-limitation posture as
// WAVE_COMMIT_RE/RECEIPT_PATTERNS). The other two (the exclusions block, the cap-10
// holdback arithmetic, and the approval-precedes-write ordering) have no src/*.js home
// either -- graded directly here, same precedent as EVIDENCE_ROW_RE/SIGNAL_*_RE. ------

// capture.md step 1's five documented exclusion reasons (never captured, even if raised):
// a musing/opinion with no decision behind it; work already completed this session; an
// item already on the backlog (dedupe below enforces this mechanically, this is intent-
// level); an outcome later actioned/superseded in the same discussion (latest call wins);
// anything the user explicitly parked. A candidate's `excludedReason` (if any) must name
// one of these -- anything else is an invented reason, not a documented one.
export const CAPTURE_EXCLUSION_REASONS = ["musing-without-decision", "already-completed", "already-on-backlog", "superseded", "parked"];

function captureExclusionsCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const candidates = Array.isArray(artifacts?.candidates) ? artifacts.candidates : [];
  const bad = candidates.filter((c) => c.excludedReason != null && !CAPTURE_EXCLUSION_REASONS.includes(c.excludedReason));
  const checks = [{ name: "reasonsValid", ok: (bad.length === 0) === (expect.reasonsValid ?? true), detail: bad.length ? `undocumented exclusion reason(s): ${JSON.stringify(bad.map((c) => c.excludedReason))}` : "every excludedReason is one of the 5 documented exclusion rules" }];
  if (expect.survivors) {
    const survivors = candidates.filter((c) => c.excludedReason == null).map((c) => c.text);
    checks.push({ name: "survivors", ok: JSON.stringify(survivors) === JSON.stringify(expect.survivors), detail: `survivors=${JSON.stringify(survivors)}, expected ${JSON.stringify(expect.survivors)}` });
  }
  return checks;
}

// capture.md step 1's cap: "if more than 10 candidates survive... present only the 10
// most recent/decision-weighted... and state how many were held back". Pure arithmetic
// over the counts a real capture run would report -- deterministic either way (no cap
// triggered at <=10, or exactly `candidateCount - 10` held back above it).
function captureCapHoldbackCheck(testCase, artifacts) {
  const { candidateCount, presentedCount, heldBackStated } = artifacts || {};
  const expectedPresented = Math.min(candidateCount, 10);
  const expectedHeldBack = Math.max(candidateCount - 10, 0);
  const arithmeticCorrect = presentedCount === expectedPresented && heldBackStated === expectedHeldBack && presentedCount <= 10;
  return [{ name: "arithmeticCorrect", ok: arithmeticCorrect, detail: `presentedCount=${presentedCount} (expected ${expectedPresented}), heldBackStated=${heldBackStated} (expected ${expectedHeldBack})` }];
}

// capture.md step 2's assess-passable rule: fold in criteria "capped at 2 reword
// attempts" -- if still not `clear: true` after 2 attempts, surface UNMEASURABLE with its
// assess signals attached rather than fabricating a metric. Reuses the REAL assessOutcome
// (src/interview.js) on every attempt (original + up to 2 rewords), the same gate
// run.md's own vague-outcome cases already grade.
function captureRewordCapCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const attempts = Array.isArray(artifacts?.attempts) ? artifacts.attempts : [];
  const assessed = attempts.map((a) => assessOutcome(a));
  const clearAt = assessed.findIndex((r) => r.clear);
  const derivedStatus = clearAt !== -1 && clearAt <= 2 ? "clear" : "UNMEASURABLE";
  const checks = [{ name: "finalStatus", ok: derivedStatus === expect.finalStatus, detail: `derived status "${derivedStatus}" (clear at attempt ${clearAt}), expected "${expect.finalStatus}"` }];
  if (derivedStatus === "UNMEASURABLE") {
    const lastSignals = assessed[assessed.length - 1]?.signals || [];
    checks.push({ name: "signalsAttached", ok: lastSignals.length > 0, detail: `UNMEASURABLE surfaces signals=${JSON.stringify(lastSignals)}` });
  }
  return checks;
}

// capture.md step 4: "Nothing is written until the user approves" -- the AskUserQuestion
// approval prompt must precede any WRITTEN marker in the transcript, and a Cancel flow
// must carry no write at all. No src/*.js home (protocol ordering, not shipped code) --
// graded the same way runner-receipts' claim-before-work ordering is: an index comparison
// over a fixture transcript.
function captureApprovalOrderCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const text = String(artifacts);
  const approvalIdx = text.search(/^AskUserQuestion:/m);
  const writeIdx = text.search(/^WRITTEN:/m);
  const hasWrite = writeIdx !== -1;
  const checks = [{ name: "expectWrite", ok: hasWrite === expect.expectWrite, detail: `WRITTEN marker present=${hasWrite}, expected ${expect.expectWrite}` }];
  if (hasWrite) {
    const ok = approvalIdx !== -1 && approvalIdx < writeIdx;
    checks.push({ name: "approvalPrecedesWrite", ok, detail: ok ? "AskUserQuestion approval precedes the WRITTEN marker" : `approval index=${approvalIdx}, write index=${writeIdx} -- approval does not precede write` });
  }
  return checks;
}

// capture.md step 3's dedupe rule: strip the trailing `{key: value}` annotation block from
// both the candidate and each existing backlog line's text, then compare -- a match skips
// the candidate. src/sprint-waves.js's own `stripAnnotations` isn't exported, so this is a
// faithful copy of its trailing-only grammar (same honest-limitation precedent as
// WAVE_COMMIT_RE/RECEIPT_PATTERNS/SCAFFOLD_SEED_FILES), not a re-derivation of a divergent
// rule: only a run of one-or-more `{key: value}` groups anchored to the END of the line is
// stripped -- a `{...}`-shaped substring earlier in the line, followed by non-annotation
// prose, is left as literal item text, mirroring sprint-waves.js's own anti-forgery
// rationale for anchoring to the trailing block.
function stripAnnotationsForDedupe(text) {
  const body = String(text).replace(/^- \[[ xX]\]\s*/, "");
  const trailingBlock = body.match(/(?:\s*\{\s*[A-Za-z][\w-]*\s*:\s*[^}]*\})+\s*$/);
  const stripped = trailingBlock ? body.slice(0, trailingBlock.index) : body;
  return stripped.replace(/\s+/g, " ").trim();
}

function captureDedupeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { existingBacklog, candidates } = artifacts || {};
  const existingTexts = new Set(
    String(existingBacklog || "")
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .map(stripAnnotationsForDedupe)
  );
  const kept = [];
  const skipped = [];
  for (const c of candidates || []) {
    (existingTexts.has(stripAnnotationsForDedupe(c)) ? skipped : kept).push(c);
  }
  const checks = [];
  if (expect.kept) checks.push({ name: "kept", ok: JSON.stringify(kept) === JSON.stringify(expect.kept), detail: `kept=${JSON.stringify(kept)}, expected ${JSON.stringify(expect.kept)}` });
  if (expect.skipped) checks.push({ name: "skipped", ok: JSON.stringify(skipped) === JSON.stringify(expect.skipped), detail: `skipped=${JSON.stringify(skipped)}, expected ${JSON.stringify(expect.skipped)}` });
  return checks;
}

// plugin/agents/muster-runner.md's "## Dispatch contract" section: the protocol between
// a driver (go-backlog wave mode / coordination's per-item worktree runners) and the
// muster-runner lifecycle agent. Like orchestrator-brief, no src/*.js pure function backs
// a brief or a receipts report (assembled prose) -- both directions of the contract are
// graded structurally against checked-in golden fixtures (fixtures/agents/*).
const RUNNER_ITEM_LINE_RE = /^ITEM: \S+/m;
const RUNNER_OUTCOME_LINE_RE = /^OUTCOME: .+$/m;
const RUNNER_ISOLATION_LINE_RE = /^ISOLATION: .*(worktree|branch).*$/m;
// Anchored to the ISOLATION line: a stray "database"/"codebase" in outcome prose must not
// satisfy the base-ref requirement.
const RUNNER_BASE_RE = /^ISOLATION: .*\bbase\b\s+\S+/m;
const RUNNER_DISPOSITION_LINE_RE = /^DISPOSITION: (\S+)/m;
const RUNNER_SOURCE_LINE_RE = /^SOURCE: \S+/m;
const RUNNER_RETURN_CONTRACT_RE = /return contract/i;
const RUNNER_VERDICT_PASS_RE = /VERDICT: PASS/;
const RUNNER_PR_LINE_RE = /^PR: https?:\/\/\S+/m;
const RUNNER_FILES_TOUCHED_RE = /^Files touched:\n(?:- .+\n?)+/m;
// Receipts prove GREEN, not merely pasted: a result line must show a passed count AND a
// zero failed count ("0 passed, 12 failed" carries digits + "passed" yet is red).
const RUNNER_TEST_BASELINE_RE = /^- baseline: .+->.*\b\d+ passed?\b.*\b0 failed\b/m;
const RUNNER_TEST_FINAL_RE = /^- final: .+->.*\b\d+ passed?\b.*\b0 failed\b/m;
// "no fix loops" is as valid as "1 fix loop" — the def mandates the count, not digits.
const RUNNER_FIX_LOOP_COUNT_RE = /\b(\d+|no) fix loops?\b/;

function runnerDispatchBriefCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const text = String(artifacts);
  const checks = [];
  const requireLine = (name, want, re) => {
    if (want === undefined) return;
    const has = re.test(text);
    checks.push({ name, ok: has === want, detail: `${name} line present=${has}, expected ${want}` });
  };
  requireLine("itemId", expect.requireItemId, RUNNER_ITEM_LINE_RE);
  requireLine("outcome", expect.requireOutcome, RUNNER_OUTCOME_LINE_RE);
  requireLine("isolation", expect.requireIsolation, RUNNER_ISOLATION_LINE_RE);
  requireLine("baseRef", expect.requireBase, RUNNER_BASE_RE);
  requireLine("sourceRef", expect.requireSourceRef, RUNNER_SOURCE_LINE_RE);
  if (expect.requireDisposition !== undefined) {
    const m = RUNNER_DISPOSITION_LINE_RE.exec(text);
    const got = m ? m[1] : null;
    checks.push({ name: "disposition", ok: got === expect.requireDisposition, detail: `DISPOSITION: ${got ?? "(missing)"}, expected ${expect.requireDisposition}` });
  }
  // Unconditional, same posture as orchestrator-brief's returnContractPresent: a dispatch
  // without a stated return contract leaves the runner's receipts to chance.
  const rc = RUNNER_RETURN_CONTRACT_RE.test(text);
  checks.push({ name: "returnContractPresent", ok: rc, detail: rc ? "brief states a return contract" : "brief has no return-contract block" });
  return checks;
}

function runnerReturnReceiptsCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const text = String(artifacts);
  const checks = [];
  const requirePattern = (name, want, re, okDetail, missDetail) => {
    if (want === undefined) return;
    const has = re.test(text);
    checks.push({ name, ok: has === want, detail: has ? okDetail : missDetail });
  };
  requirePattern("verdictPass", expect.requireVerdictPass, RUNNER_VERDICT_PASS_RE,
    "receipts carry the explicit VERDICT: PASS line", "no explicit VERDICT: PASS line -- the gate verdict is the receipt that matters most");
  requirePattern("prUrl", expect.requirePrUrl, RUNNER_PR_LINE_RE,
    "receipts carry the PR URL", "no PR: <url> line in the receipts");
  requirePattern("filesTouched", expect.requireFilesTouched, RUNNER_FILES_TOUCHED_RE,
    "receipts list the files touched", "no 'Files touched:' list in the receipts");
  if (expect.requireTestEvidence !== undefined) {
    const has = RUNNER_TEST_BASELINE_RE.test(text) && RUNNER_TEST_FINAL_RE.test(text);
    checks.push({ name: "testEvidence", ok: has === expect.requireTestEvidence, detail: has ? "baseline + final test results are pasted" : "missing pasted baseline and/or final test results" });
  }
  requirePattern("fixLoopCount", expect.requireFixLoopCount, RUNNER_FIX_LOOP_COUNT_RE,
    "receipts state the fix-loop count", "receipts do not state how many fix loops the gate took");
  return checks;
}

export const ARTIFACT_KIND = {
  "orchestrator-brief": "text",
  "runner-dispatch-brief": "text",
  "runner-return-receipts": "text",
  "review-gate-verdict": "text",
  "review-gate-mutant-kill-rule": "text",
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
  "coordination-human-hold-resume": "text",
  "capture-exclusions": "json",
  "capture-cap-holdback": "json",
  "capture-reword-cap": "json",
  "capture-approval-order": "text",
  "capture-dedupe": "json",
};

export const CHECKS = {
  "orchestrator-brief": orchestratorBriefCheck,
  "runner-dispatch-brief": runnerDispatchBriefCheck,
  "runner-return-receipts": runnerReturnReceiptsCheck,
  "review-gate-verdict": reviewGateVerdictCheck,
  "review-gate-mutant-kill-rule": reviewGateMutantKillRuleCheck,
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
  "prd-gate-achievability": gateAchievabilityCheck,
  "roadmap-rice": roadmapRiceCheck,
  "coordination-human-hold-resume": coordinationHumanHoldResumeCheck,
  "capture-exclusions": captureExclusionsCheck,
  "capture-cap-holdback": captureCapHoldbackCheck,
  "capture-reword-cap": captureRewordCapCheck,
  "capture-approval-order": captureApprovalOrderCheck,
  "capture-dedupe": captureDedupeCheck,
};
