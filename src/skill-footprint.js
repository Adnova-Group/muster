// speed-tuning item, criterion 2: skill prompt-size audit.
//
// Every muster skill (plugin/skills/*/SKILL.md) loads its full content into whichever
// dispatch invokes it -- the router loads router/SKILL.md once per full-pipeline crew
// assembly, each reviewer dispatch independently loads review-gate/SKILL.md (see
// eval/perf/replay-fast-path.mjs's step 1), the orchestrator loads orchestrator/SKILL.md
// once per run, and so on. A skill's on-disk byte size is therefore a direct, measurable
// proxy for the token cost every dispatch of it pays -- shrinking the largest few gives
// the biggest aggregate return per byte cut, which is exactly the target this module's
// ranking exists to surface.
//
// Pure ranking/measurement functions only (no fs access here -- eval/perf/skill-size-audit.mjs
// does the REAL fs.readFileSync measurement and calls into this module, mirroring
// src/token-projection.js's split between pure arithmetic (tested here) and live
// measurement (the eval script)).
import { estimateTokens, DEFAULT_CHARS_PER_TOKEN } from "./token-projection.js";

// Computes one skill's measured footprint from its REAL content (caller reads the file;
// this function never touches disk itself).
export function computeSkillFootprint(name, content, { charsPerToken = DEFAULT_CHARS_PER_TOKEN } = {}) {
  if (typeof name !== "string" || !name.trim()) {
    throw new Error("computeSkillFootprint: name is required (non-empty string)");
  }
  if (typeof content !== "string") {
    throw new Error("computeSkillFootprint: content must be a string");
  }
  const chars = content.length;
  return { name, chars, tokens: estimateTokens(chars, charsPerToken) };
}

// Ranks a list of already-computed footprints (largest chars first) and slices the top
// `count` -- the "5 largest" this item's criterion 2 targets for a >=40% cut each. `count`
// is caller-overridable so a smaller/larger audit slice is testable without a magic 5
// baked into the pure function itself (the eval script defaults it to 5).
export function rankSkillFootprints(footprints, { count = 5 } = {}) {
  if (!Array.isArray(footprints)) throw new Error("rankSkillFootprints: footprints must be an array");
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    throw new Error("rankSkillFootprints: count must be a non-negative integer");
  }
  const sorted = [...footprints].sort((a, b) => b.chars - a.chars);
  return { all: sorted, largest: sorted.slice(0, count) };
}

// Reduction check for one skill's before/after footprint against this item's >=40% target
// (`MIN_REDUCTION_PCT`). Returns the actual percentage either way -- an honest miss (per
// this item's brief pragmatics) is reported as a real, non-fabricated number, never
// silently rounded up to look like a pass.
export const MIN_REDUCTION_PCT = 40;

export function reductionPct(beforeChars, afterChars) {
  if (typeof beforeChars !== "number" || !Number.isFinite(beforeChars) || beforeChars < 0) {
    throw new Error("reductionPct: beforeChars must be a non-negative finite number");
  }
  if (typeof afterChars !== "number" || !Number.isFinite(afterChars) || afterChars < 0) {
    throw new Error("reductionPct: afterChars must be a non-negative finite number");
  }
  if (beforeChars === 0) return 0;
  return ((beforeChars - afterChars) / beforeChars) * 100;
}

export function meetsReductionTarget(beforeChars, afterChars, { minPct = MIN_REDUCTION_PCT } = {}) {
  return reductionPct(beforeChars, afterChars) >= minPct;
}
