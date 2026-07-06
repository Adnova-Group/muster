// Native-builtin layer of eval/modes/'s grading logic (eval/modes extended to
// plugin/builtins/muster-*/SKILL.md, the 7 built-in pipeline-role providers). One of
// grade-lib.mjs's layer modules (see grade-lib.mjs's header for the full layer list);
// grade-lib.mjs composes this module's CHECKS/ARTIFACT_KIND with the other layers' into
// the public dispatch tables. No IO here, same rule as every other eval/modes module --
// callers read fixtures/build artifacts and pass them in via `artifacts`.
import { scoreArtifact } from "../../src/score.js";
import { selectWinner } from "../../src/prompt-optimize.js";
import { rowFormatCheck } from "./grade-core.mjs";

// muster-image/SKILL.md's output contract: a "hero" prompt + 2+ "variant" prompts per
// artifact, each self-contained (brand constraints inlined, never "match the brand
// file"), each followed by an "Avoid:" negative-rules line. No src/*.js home (assembled
// prose) -- graded structurally, same precedent as orchestrator-brief above.
const IMAGE_HERO_RE = /^### .+ — hero\s*$/gm;
const IMAGE_VARIANT_RE = /^### .+ — variant \d+\s*$/gm;
const IMAGE_AVOID_LINE_RE = /^Avoid: .+$/gm;
const IMAGE_BRAND_FILE_REFERENCE_RE = /match the brand file/i;
const IMAGE_HEX_COLOR_RE = /#[0-9a-fA-F]{6}\b/;

function imagePromptSetShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const text = String(artifacts);
  const heroCount = (text.match(IMAGE_HERO_RE) || []).length;
  const variantCount = (text.match(IMAGE_VARIANT_RE) || []).length;
  const avoidCount = (text.match(IMAGE_AVOID_LINE_RE) || []).length;
  const checks = [];
  if (expect.minHeroCount !== undefined) checks.push({ name: "heroCount", ok: heroCount >= expect.minHeroCount, detail: `${heroCount} hero section(s), expected >= ${expect.minHeroCount}` });
  if (expect.minVariantCount !== undefined) checks.push({ name: "variantCount", ok: variantCount >= expect.minVariantCount, detail: `${variantCount} variant section(s), expected >= ${expect.minVariantCount}` });
  if (expect.avoidPerSection !== undefined) {
    const ok = avoidCount >= heroCount + variantCount;
    checks.push({ name: "avoidPerSection", ok: ok === expect.avoidPerSection, detail: `${avoidCount} "Avoid:" line(s) for ${heroCount + variantCount} section(s), expected an Avoid line per section: ${expect.avoidPerSection}` });
  }
  if (expect.brandConstraintsInlined !== undefined) {
    const ok = IMAGE_HEX_COLOR_RE.test(text);
    checks.push({ name: "brandConstraintsInlined", ok: ok === expect.brandConstraintsInlined, detail: ok ? "a brand hex value is inlined in the prompt text" : "no inlined brand hex value found" });
  }
  if (expect.noBrandFileReference !== undefined) {
    const hasRef = IMAGE_BRAND_FILE_REFERENCE_RE.test(text);
    checks.push({ name: "noBrandFileReference", ok: !hasRef === expect.noBrandFileReference, detail: hasRef ? `prompt punts to the brand file instead of inlining constraints` : "no brand-file-reference punt found" });
  }
  return checks;
}

// muster-video/SKILL.md's b-roll shot-list output: `[MM:SS–MM:SS] shot description —
// rationale`, one row per line. No src/*.js home -- graded the same way audit-ledger's
// LEDGER_LINE_RE grades a findings ledger, via the shared rowFormatCheck (grade-core.mjs).
const VIDEO_SHOT_ROW_RE = /^\[\d{2}:\d{2}[–-]\d{2}:\d{2}\]\s+.+[—-]\s*.+$/;

function videoShotListShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { lines, check } = rowFormatCheck(artifacts, VIDEO_SHOT_ROW_RE, "shot", { wantFormatValid: expect.formatValid ?? true });
  const checks = [check];
  if (expect.minRows !== undefined) checks.push({ name: "minRows", ok: lines.length >= expect.minRows, detail: `${lines.length} row(s), expected >= ${expect.minRows}` });
  return checks;
}

// muster-humanizer/SKILL.md's voice-calibration rule: when a named voice profile
// resolved, check the rewrite against ITS anti-patterns list FIRST, before the generic
// tiered-vocabulary/tell-taxonomy checks -- "the voice profile is the sharper... instrument;
// the generic checks... are the floor every artifact clears regardless of voice." Graded
// as document-structure ordering (a voice-profile section preceding the generic-tells
// section), no src/*.js home (a diagnosis-rendering rule, not shipped code).
const HUMANIZER_VOICE_SECTION_RE = /^Voice-profile anti-patterns:.*$/m;
const HUMANIZER_GENERIC_SECTION_RE = /^Generic tells:.*$/m;

function humanizerPrecedenceCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const text = String(artifacts);
  const voiceMatch = HUMANIZER_VOICE_SECTION_RE.exec(text);
  const genericMatch = HUMANIZER_GENERIC_SECTION_RE.exec(text);
  const hasVoice = !!voiceMatch;
  const checks = [];
  if (expect.hasVoiceProfileSection !== undefined) checks.push({ name: "hasVoiceSection", ok: hasVoice === expect.hasVoiceProfileSection, detail: `voice-profile section present=${hasVoice}, expected ${expect.hasVoiceProfileSection}` });
  const hasGeneric = !!genericMatch;
  checks.push({ name: "hasGenericSection", ok: hasGeneric, detail: hasGeneric ? "diagnosis carries a generic-tells section" : "diagnosis is missing its generic-tells section" });
  if (hasVoice && hasGeneric) {
    const ok = voiceMatch.index < genericMatch.index;
    checks.push({ name: "voicePrecedesGeneric", ok, detail: ok ? "voice-profile anti-patterns are checked before the generic tells" : "generic tells precede the voice-profile check -- wrong precedence" });
  }
  return checks;
}

// muster-scorer/SKILL.md's stated contract: "For EACH criterion, assign 0-3" -- an
// integer range gate-achievability's generic scoreArtifact doesn't itself enforce (it
// only requires a finite number). This check adds that range constraint, then delegates
// the floor-principle pass/fail to the REAL scoreArtifact (src/score.js), same function
// gate-achievability/prd-gate-achievability already reuse.
function scorerVerdictShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const { scores, gate } = artifacts || {};
  const entries = Object.entries(scores || {});
  const inRange = entries.length > 0 && entries.every(([, v]) => Number.isInteger(v) && v >= 0 && v <= 3);
  const checks = [{ name: "scoresInRange", ok: inRange === (expect.scoresInRange ?? true), detail: inRange ? "every criterion score is an integer in [0,3]" : `out-of-contract score(s): ${JSON.stringify(entries.filter(([, v]) => !(Number.isInteger(v) && v >= 0 && v <= 3)))}` }];
  const r = scoreArtifact(scores, gate);
  if (expect.passing !== undefined) checks.push({ name: "passing", ok: r.passing === expect.passing, detail: `passing=${r.passing}, expected ${expect.passing}` });
  if (expect.weakestCriterion !== undefined) checks.push({ name: "weakestCriterion", ok: r.weakest.criterion === expect.weakestCriterion, detail: `weakest.criterion="${r.weakest.criterion}", expected "${expect.weakestCriterion}"` });
  return checks;
}

// muster-prompt-smith/SKILL.md step 3's documented `muster prompt optimize` output shape
// `{ winner, winnerPrompt, regression, escalate, ranking }` -- graded directly against the
// REAL `selectWinner` (src/prompt-optimize.js), the exact function the CLI wraps.
function promptSmithProposalCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const r = selectWinner(artifacts);
  const checks = [];
  if (expect.winner !== undefined) checks.push({ name: "winner", ok: r.winner === expect.winner, detail: `winner="${r.winner}", expected "${expect.winner}"` });
  if (expect.regression !== undefined) checks.push({ name: "regression", ok: r.regression === expect.regression, detail: `regression=${r.regression}, expected ${expect.regression}` });
  if (expect.escalate !== undefined) checks.push({ name: "escalate", ok: r.escalate === expect.escalate, detail: `escalate=${r.escalate}, expected ${expect.escalate}` });
  return checks;
}

// muster-author/SKILL.md's stated output contract: "Pick a framework and follow it...
// State which you used" (AIDA/PAS/BAB/QUEST/PASTOR) and "One clear CTA." No src/*.js
// home (assembled copy, not shipped code) -- graded structurally, same precedent as
// orchestrator-brief/image-prompt-set-shape above.
const AUTHOR_FRAMEWORK_LINE_RE = /^Framework:\s*(AIDA|PAS|BAB|QUEST|PASTOR)\s*$/m;
const AUTHOR_CTA_LINE_RE = /^CTA:\s*.+$/gm;

function authorDraftShapeCheck(testCase, artifacts) {
  const expect = testCase.expect || {};
  const text = String(artifacts);
  const frameworkMatch = AUTHOR_FRAMEWORK_LINE_RE.exec(text);
  const ctaMatches = text.match(AUTHOR_CTA_LINE_RE) || [];
  const checks = [];
  if (expect.framework !== undefined) checks.push({ name: "framework", ok: (frameworkMatch ? frameworkMatch[1] : null) === expect.framework, detail: `framework=${JSON.stringify(frameworkMatch ? frameworkMatch[1] : null)}, expected ${JSON.stringify(expect.framework)}` });
  if (expect.ctaCount !== undefined) checks.push({ name: "ctaCount", ok: ctaMatches.length === expect.ctaCount, detail: `${ctaMatches.length} CTA line(s), expected ${expect.ctaCount}` });
  return checks;
}

export const ARTIFACT_KIND = {
  "image-prompt-set-shape": "text",
  "video-shot-list-shape": "text",
  "humanizer-precedence": "text",
  "scorer-verdict-shape": "json",
  "prompt-smith-optimize-proposal": "json",
  "author-draft-shape": "text",
};

export const CHECKS = {
  "image-prompt-set-shape": imagePromptSetShapeCheck,
  "video-shot-list-shape": videoShotListShapeCheck,
  "humanizer-precedence": humanizerPrecedenceCheck,
  "scorer-verdict-shape": scorerVerdictShapeCheck,
  "prompt-smith-optimize-proposal": promptSmithProposalCheck,
  "author-draft-shape": authorDraftShapeCheck,
};
