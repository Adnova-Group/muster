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
//
// This module is the COMPOSING ENTRY over four layer modules (grade-modes.mjs's 6 verb
// prompts, grade-skills.mjs's plugin/skills/* protocol layer, grade-pipelines.mjs's
// content- and knowledge-pipeline phase prompts, grade-builtins.mjs's native-builtin
// layer) plus grade-core.mjs's cross-layer helpers (rowFormatCheck, gateAchievabilityCheck)
// -- it merges each layer's CHECKS/ARTIFACT_KIND dispatch tables and re-exports every name
// this module has ever publicly exported, so grade.mjs and test/mode-evals.test.js see the
// exact same public API as before the split. src/coordination.js is the single executable
// source of coordination/SKILL.md Binding A's claim-window rules (moved out of here so
// shipped runtime code and this eval share one implementation); imported and re-exported
// unchanged below.
import { MUSTER_RECEIPT_PATTERNS, computeClaimWindows, computeClaimWindowWinner, isHumanHoldResumeAuthorized } from "../../src/coordination.js";
import { rowFormatCheck, gateAchievabilityCheck, resolveArtifactUrl } from "./grade-core.mjs";
import {
  CHECKS as MODES_CHECKS,
  ARTIFACT_KIND as MODES_ARTIFACT_KIND,
  planFencesOk,
  resolveMergeDisposition,
  WAVE_COMMIT_RE,
  RECEIPT_PATTERNS,
  LEDGER_LINE_RE,
} from "./grade-modes.mjs";
import { CHECKS as SKILLS_CHECKS, ARTIFACT_KIND as SKILLS_ARTIFACT_KIND, SCAFFOLD_SEED_FILES, CAPTURE_EXCLUSION_REASONS } from "./grade-skills.mjs";
import { CHECKS as PIPELINES_CHECKS, ARTIFACT_KIND as PIPELINES_ARTIFACT_KIND } from "./grade-pipelines.mjs";
import { CHECKS as BUILTINS_CHECKS, ARTIFACT_KIND as BUILTINS_ARTIFACT_KIND } from "./grade-builtins.mjs";

export {
  MUSTER_RECEIPT_PATTERNS,
  computeClaimWindows,
  computeClaimWindowWinner,
  isHumanHoldResumeAuthorized,
  rowFormatCheck,
  gateAchievabilityCheck,
  resolveArtifactUrl,
  planFencesOk,
  resolveMergeDisposition,
  WAVE_COMMIT_RE,
  RECEIPT_PATTERNS,
  LEDGER_LINE_RE,
  SCAFFOLD_SEED_FILES,
  CAPTURE_EXCLUSION_REASONS,
};

// What kind of artifact each check needs, so a caller (grade.mjs / the CI test) knows
// whether to read+JSON.parse a fixture file, read it as raw text, or pass nothing (the
// check is computed purely from testCase.outcome via an imported src/*.js function).
// Dispatch-key namespaces don't collide across layers (verified by test/mode-evals.test.js
// exercising every one), so a flat merge is exact, not an approximation.
export const ARTIFACT_KIND = { ...MODES_ARTIFACT_KIND, ...SKILLS_ARTIFACT_KIND, ...PIPELINES_ARTIFACT_KIND, ...BUILTINS_ARTIFACT_KIND };

export const CHECKS = { ...MODES_CHECKS, ...SKILLS_CHECKS, ...PIPELINES_CHECKS, ...BUILTINS_CHECKS };

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
