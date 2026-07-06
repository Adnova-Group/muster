// Pipeline layer of eval/modes/'s grading logic: the content-pipeline layer (eval/modes
// extended past the skill-protocol layer into the phase prompts of pipelines/*.yaml --
// blog-post, social-post, newsletter, case-study, lead-magnet, release-notes,
// video-content, executive-summary, competitive-battlecard) plus the knowledge-pipeline
// layer (the 11 remaining pipelines/*.yaml -- ai-implementation-spec, ai-test-plan, book,
// business-case, epic, launch-plan, okrs, prd, roadmap, runbook, user-story;
// epic/okrs/roadmap/prd reuse sprint-waves/assess/roadmap-rice/evidence-table-shape
// directly, no new grader needed for those). Combined into one module because both
// layers grade the same underlying artifact family (a pipeline phase's rendered output),
// and share this module's gate-achievability dispatch. One of grade-lib.mjs's layer
// modules (see grade-lib.mjs's header for the full layer list); grade-lib.mjs composes
// this module's CHECKS/ARTIFACT_KIND with the other layers' into the public dispatch
// tables. Same rule as every other eval/modes module -- callers read fixtures/build
// artifacts and pass them in via `artifacts`.
import { checkCitations } from "../../src/citation-guard.js";
import { scoreHumanness } from "../../src/humanizer-score.js";
import { escapeRe } from "../../src/keyword.js";
import { rowFormatCheck, gateAchievabilityCheck } from "./grade-core.mjs";

export { gateAchievabilityCheck };

// --- knowledge-pipeline checks ----------------------------------------------------------

// runbook.yaml's steps phase: "numbered, copy-pasteable steps; expected output for each".
const RUNBOOK_STEP_ROW_RE = /^\d+\.\s+`[^`]+`\s*(?:->|→)\s*expected:\s*.+$/;

function runbookStepPairsCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { lines, check } = rowFormatCheck(artifacts, RUNBOOK_STEP_ROW_RE, "step", { wantFormatValid: expect.formatValid ?? true });
  const checks = [check];
  if (expect.minSteps !== undefined) checks.push({ name: "minSteps", ok: lines.length >= expect.minSteps, detail: `${lines.length} step(s), expected >= ${expect.minSteps}` });
  return checks;
}

// book.yaml's continuity-ledger-tracked chapter manifest: `- Chapter N: <title> (status:
// drafted|scored|pending)`, sequential chapter numbers, no gaps/dupes.
const BOOK_CHAPTER_ROW_RE = /^-\s*Chapter\s+(\d+):\s*.+\(status:\s*(drafted|scored|pending)\)$/;

function bookChapterManifestCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { parsed, formatValid, check } = rowFormatCheck(artifacts, BOOK_CHAPTER_ROW_RE, "chapter", { wantFormatValid: expect.formatValid ?? true });
  const checks = [check];
  if (formatValid && expect.sequential !== undefined) {
    const numbers = parsed.map((m) => Number(m[1]));
    const sequential = numbers.every((n, i) => n === i + 1);
    checks.push({ name: "sequential", ok: sequential === expect.sequential, detail: sequential ? `chapter numbers are sequential 1..${numbers.length}` : `chapter numbers not sequential: ${JSON.stringify(numbers)}` });
  }
  return checks;
}

// ai-test-plan.yaml's cases phase: "per risk tier: happy/boundary/negative/security;
// data+env+owner" -- a markdown table `| tier | type | data | env | owner |`.
const AI_TEST_PLAN_ROW_RE = /^\|\s*(H|M|L)\s*\|\s*(happy|boundary|negative|security)\s*\|\s*([^|]*\S[^|]*?)\s*\|\s*([^|]*\S[^|]*?)\s*\|\s*([^|]*\S[^|]*?)\s*\|$/i;
const isTestPlanTableRow = (l) => l.startsWith("|") && !/^\|\s*tier\s*\|/i.test(l) && !/^\|[\s:-]+\|/.test(l);

function aiTestPlanCaseTableCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { parsed, formatValid, check } = rowFormatCheck(artifacts, AI_TEST_PLAN_ROW_RE, "case", { wantFormatValid: expect.formatValid ?? true, filterLines: isTestPlanTableRow });
  const checks = [check];
  if (formatValid && expect.typesInclude) {
    const types = new Set(parsed.map((m) => m[2].toLowerCase()));
    const missing = expect.typesInclude.filter((t) => !types.has(t));
    checks.push({ name: "typesInclude", ok: missing.length === 0, detail: missing.length ? `missing case type(s): ${missing.join(", ")}` : `case table covers all of ${JSON.stringify(expect.typesInclude)}` });
  }
  return checks;
}

// user-story.yaml's acceptance phase: "Given/When/Then (Gherkin); happy path + 2+
// edge/negative" -- scenario blocks each needing at least one Given/When/Then line.
const GHERKIN_SCENARIO_RE = /^Scenario:\s*.+$/;
const GHERKIN_STEP_RE = /^(Given|When|Then|And)\s+.+$/;

function userStoryGherkinShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = String(artifacts).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const scenarios = [];
  let current = null;
  for (const l of lines) {
    if (GHERKIN_SCENARIO_RE.test(l)) {
      current = { title: l, steps: [] };
      scenarios.push(current);
    } else if (current && GHERKIN_STEP_RE.test(l)) {
      current.steps.push(l);
    }
  }
  const wellFormed = scenarios.length > 0 && scenarios.every((s) => /^Given/.test(s.steps[0] || "") && s.steps.some((st) => /^When/.test(st)) && s.steps.some((st) => /^Then/.test(st)));
  const checks = [{ name: "scenariosWellFormed", ok: wellFormed === (expect.scenariosWellFormed ?? true), detail: wellFormed ? `${scenarios.length} scenario(s), each with Given/When/Then` : "a scenario is missing a Given/When/Then step" }];
  if (expect.minScenarios !== undefined) checks.push({ name: "minScenarios", ok: scenarios.length >= expect.minScenarios, detail: `${scenarios.length} scenario(s), expected >= ${expect.minScenarios}` });
  return checks;
}

// ai-implementation-spec.yaml's adr phase (MADR 4.0): "status lifecycle
// proposed|accepted|deprecated|superseded-by ADR-XXXX".
const ADR_ROW_RE = /^ADR-(\d+):.*status:\s*(proposed|accepted|deprecated|superseded-by ADR-\d+)\s*$/;

function adrStatusLifecycleCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { check } = rowFormatCheck(artifacts, ADR_ROW_RE, "ADR", { wantFormatValid: expect.formatValid ?? true });
  return [check];
}

// --- content-pipeline checks ------------------------------------------------------------

// A research phase's inline claims (blog-post's E-E-A-T sources, competitive-battlecard's
// "(cited)" competitor facts) cite `[src: anchor]`, checked against the REAL
// `checkCitations` (src/citation-guard.js) -- the exact same dangling-anchor/malformed-
// anchor rules review-gate's citation hygiene check enforces elsewhere.
function citationCheckCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const r = checkCitations(artifacts);
  const wantOk = expect.ok ?? true;
  const checks = [{ name: "ok", ok: r.ok === wantOk, detail: r.ok ? "no dangling or malformed citations" : `invalid: dangling=${JSON.stringify(r.danglingAnchors)}, malformed=${JSON.stringify(r.malformedCitations)}` }];
  if (expect.minClaims !== undefined) checks.push({ name: "minClaims", ok: r.claims >= expect.minClaims, detail: `claims=${r.claims}, expected >= ${expect.minClaims}` });
  return checks;
}

// Every content pipeline's terminal "humanize" phase strips AI tells for human delivery --
// graded directly against the REAL `scoreHumanness` (src/humanizer-score.js), the
// deterministic companion to the [[muster-humanizer]] LLM rewrite.
function humanizerScoreCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const threshold = expect.threshold ?? 85;
  const r = scoreHumanness(artifacts, { threshold });
  const wantPassing = expect.passing ?? true;
  const checks = [{ name: "passing", ok: r.passing === wantPassing, detail: `scoreHumanness(...).passing=${r.passing} (score=${r.score}, threshold=${threshold}), expected ${wantPassing}` }];
  if (expect.minScore !== undefined) checks.push({ name: "minScore", ok: r.score >= expect.minScore, detail: `score=${r.score}, expected >= ${expect.minScore}` });
  return checks;
}

// case-study.yaml's synthesis phase: one structured evidence table replacing freeform
// quote/metric/fact collection -- row types {quote, metric, fact, decision|action},
// columns {value, source-anchor, confidence, needs_review, subject-approval-status}, plus
// owner+deadline on decision|action rows only ("unowned actions and undated deadlines are
// flagged, not silently dropped" -- non-fatal detection, not a parse failure). No
// src/*.js function owns this row grammar (it's a pipeline-yaml-documented artifact shape,
// not shipped code) -- encoded directly here, same precedent as LEDGER_LINE_RE.
const EVIDENCE_ROW_RE = /^\|\s*(quote|metric|fact|decision|action)\s*\|\s*([^|]*\S[^|]*?)\s*\|\s*([^|]*\S[^|]*?)\s*\|\s*(high|medium|low)\s*\|\s*(yes|no)\s*\|\s*([^|]*\S[^|]*?)\s*\|\s*([^|]*?)\s*\|\s*([^|]*?)\s*\|$/i;

function evidenceTableShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = String(artifacts)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("|") && !/^\|\s*type\s*\|/i.test(l) && !/^\|[\s:-]+\|/.test(l));
  const parsed = lines.map((l) => EVIDENCE_ROW_RE.exec(l));
  const bad = lines.filter((_, i) => !parsed[i]);
  const rowsWellFormed = bad.length === 0;
  const checks = [];
  if (expect.rowsWellFormed !== undefined) {
    checks.push({ name: "rowsWellFormed", ok: rowsWellFormed === expect.rowsWellFormed, detail: rowsWellFormed ? `all ${lines.length} row(s) match the type/value/source-anchor/confidence/needs_review/approval/owner/deadline schema` : `malformed evidence row(s): ${JSON.stringify(bad)}` });
  }
  const rows = parsed.filter(Boolean).map((m) => ({ type: m[1].toLowerCase(), owner: m[7], deadline: m[8] }));
  const isUnset = (v) => !v || v.trim() === "" || v.trim() === "-";
  const unownedFlagged = rows.filter((r) => (r.type === "decision" || r.type === "action") && (isUnset(r.owner) || isUnset(r.deadline)));
  if (expect.minRows !== undefined) checks.push({ name: "minRows", ok: rows.length >= expect.minRows, detail: `${rows.length} row(s), expected >= ${expect.minRows}` });
  if (expect.unownedFlagCount !== undefined) checks.push({ name: "unownedFlagCount", ok: unownedFlagged.length === expect.unownedFlagCount, detail: `${unownedFlagged.length} unowned/undated decision|action row(s), expected ${expect.unownedFlagCount}` });
  return checks;
}

// newsletter.yaml's curate phase: a cross-run diff against a persisted baseline reports
// ONLY new/changed signals (each dated) -- unchanged signals collapse into one summary
// count line, never re-reported item-by-item. No src/*.js function owns this report
// shape -- encoded directly here, same precedent as the evidence-table check above.
const SIGNAL_NEW_RE = /^-\s*NEW:\s*.+\(\d{4}-\d{2}-\d{2}\)$/;
const SIGNAL_CHANGED_RE = /^-\s*CHANGED:\s*.+\(\d{4}-\d{2}-\d{2}\)$/;
const SIGNAL_SUMMARY_RE = /^-\s*unchanged:\s*\d+\s+signals?\b/i;
const SIGNAL_PER_ITEM_UNCHANGED_RE = /^-\s*UNCHANGED:\s*.+$/;

function signalDiffBaselineCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const lines = String(artifacts).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const newLines = lines.filter((l) => /^-\s*NEW:/i.test(l));
  const changedLines = lines.filter((l) => /^-\s*CHANGED:/i.test(l));
  const badDated = [...newLines, ...changedLines].filter((l) => !(SIGNAL_NEW_RE.test(l) || SIGNAL_CHANGED_RE.test(l)));
  const summaryLines = lines.filter((l) => SIGNAL_SUMMARY_RE.test(l));
  const perItemUnchanged = lines.filter((l) => SIGNAL_PER_ITEM_UNCHANGED_RE.test(l) && !SIGNAL_SUMMARY_RE.test(l));
  const checks = [];
  if (expect.newChangedDated !== undefined) {
    const ok = badDated.length === 0;
    checks.push({ name: "newChangedDated", ok: ok === expect.newChangedDated, detail: ok ? "every NEW/CHANGED line carries a (YYYY-MM-DD) date" : `undated NEW/CHANGED line(s): ${JSON.stringify(badDated)}` });
  }
  if (expect.hasSummaryLine !== undefined) {
    const ok = summaryLines.length > 0;
    checks.push({ name: "hasSummaryLine", ok: ok === expect.hasSummaryLine, detail: `unchanged-summary line present=${ok}, expected ${expect.hasSummaryLine}` });
  }
  if (expect.reReportsUnchanged !== undefined) {
    const ok = perItemUnchanged.length > 0;
    checks.push({ name: "reReportsUnchanged", ok: ok === expect.reReportsUnchanged, detail: ok ? `unchanged signal(s) re-reported individually: ${JSON.stringify(perItemUnchanged)}` : "no individual unchanged-signal re-reporting" });
  }
  if (expect.minNewOrChanged !== undefined) {
    checks.push({ name: "minNewOrChanged", ok: (newLines.length + changedLines.length) >= expect.minNewOrChanged, detail: `${newLines.length + changedLines.length} NEW/CHANGED line(s), expected >= ${expect.minNewOrChanged}` });
  }
  return checks;
}

// blog-post/social-post/lead-magnet's optional "publish" phase: assemble one packet
// (artifact path + image prompts + metadata), run a visual-verify pass (screenshot +
// console evidence), then STOP at the action fence -- publish actions require the human's
// explicit go-ahead. No src/*.js function owns this manifest shape -- encoded directly
// here, same precedent as the greenfield scaffold-shape check.
function publishPacketShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const a = artifacts || {};
  const checks = [];
  if (expect.hasArtifactPath !== undefined) {
    const ok = typeof a.artifactPath === "string" && a.artifactPath.length > 0;
    checks.push({ name: "artifactPath", ok: ok === expect.hasArtifactPath, detail: `artifactPath present=${ok}, expected ${expect.hasArtifactPath}` });
  }
  if (expect.hasImagePrompts !== undefined) {
    const ok = Array.isArray(a.imagePrompts) && a.imagePrompts.length > 0 && a.imagePrompts.every((p) => typeof p === "string" && p.trim());
    checks.push({ name: "imagePrompts", ok: ok === expect.hasImagePrompts, detail: `imagePrompts valid=${ok}, expected ${expect.hasImagePrompts}` });
  }
  if (expect.hasMetadata !== undefined) {
    const ok = !!a.metadata && typeof a.metadata === "object" && !Array.isArray(a.metadata) && Object.keys(a.metadata).length > 0;
    checks.push({ name: "metadata", ok: ok === expect.hasMetadata, detail: `metadata present=${ok}, expected ${expect.hasMetadata}` });
  }
  if (expect.hasVisualVerify !== undefined) {
    const vv = a.visualVerify || {};
    const ok = typeof vv.screenshot === "string" && vv.screenshot.length > 0 && typeof vv.consoleEvidence === "string" && vv.consoleEvidence.length > 0;
    checks.push({ name: "visualVerify", ok: ok === expect.hasVisualVerify, detail: `visualVerify complete=${ok}, expected ${expect.hasVisualVerify}` });
  }
  if (expect.hasChecklist !== undefined) {
    const ok = Array.isArray(a.checklist) && a.checklist.length > 0;
    checks.push({ name: "checklist", ok: ok === expect.hasChecklist, detail: `checklist present=${ok}, expected ${expect.hasChecklist}` });
  }
  if (expect.actionFenceStopped !== undefined) {
    checks.push({ name: "actionFenceStopped", ok: a.actionFenceStopped === expect.actionFenceStopped, detail: `actionFenceStopped=${a.actionFenceStopped}, expected ${expect.actionFenceStopped}` });
  }
  return checks;
}

// blog-post/social-post/newsletter's audience+voice profile resolution: the resolved
// audience profile (docs/profiles/AUDIENCES.md) calibrates jargon/depth/altitude -- graded
// here as a banned-jargon list lookup against the drafted text, reusing the real
// `escapeRe` (src/keyword.js) that `pickPipeline`'s own keyword matching already relies on.
function audienceVoiceJargonCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { audienceProfile, draft } = artifacts || {};
  const banned = audienceProfile && Array.isArray(audienceProfile.bannedJargon) ? audienceProfile.bannedJargon : [];
  const text = String(draft || "");
  const hits = banned.filter((term) => new RegExp(`\\b${escapeRe(term)}\\b`, "i").test(text));
  const isClean = hits.length === 0;
  const wantClean = expect.clean ?? true;
  return [{ name: "noBannedJargon", ok: isClean === wantClean, detail: isClean ? "draft carries none of the resolved audience profile's banned jargon" : `draft violates banned-jargon term(s): ${hits.join(", ")}` }];
}

export const ARTIFACT_KIND = {
  "citation-check": "text",
  "humanizer-score": "text",
  "evidence-table-shape": "text",
  "signal-diff-baseline": "text",
  "publish-packet-shape": "json",
  "audience-voice-jargon": "json",
  "gate-achievability": "json",
  "runbook-step-pairs": "text",
  "book-chapter-manifest": "text",
  "ai-test-plan-case-table": "text",
  "user-story-gherkin-shape": "text",
  "adr-status-lifecycle": "text",
};

export const CHECKS = {
  "citation-check": citationCheckCheck,
  "humanizer-score": humanizerScoreCheck,
  "evidence-table-shape": evidenceTableShapeCheck,
  "signal-diff-baseline": signalDiffBaselineCheck,
  "publish-packet-shape": publishPacketShapeCheck,
  "audience-voice-jargon": audienceVoiceJargonCheck,
  "gate-achievability": gateAchievabilityCheck,
  "runbook-step-pairs": runbookStepPairsCheck,
  "book-chapter-manifest": bookChapterManifestCheck,
  "ai-test-plan-case-table": aiTestPlanCaseTableCheck,
  "user-story-gherkin-shape": userStoryGherkinShapeCheck,
  "adr-status-lifecycle": adrStatusLifecycleCheck,
};
