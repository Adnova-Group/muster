// fusion.js — deterministic fusion decision engine for muster tournaments.
//
// Pure functions, no LLM calls, no Math.random / Date.now.
//
// Decision flow for fuse(candidates, map, opts):
//   1. Validate the fusion-map schema; fall back if invalid (fail-safe).
//   2. Require ≥ 2 passing candidates; fall back on 0 or 1.
//   3. Agreement gate: if the map carries too little disagreement, fusion
//      adds no value — fall back (candidates-agree).
//   4. Fuse: select top-K by score, de-identify, order by stable id-hash
//      (decoupled from rank to kill position bias per LLM-Blender/MoA).
//
// NOTE (wave 2): candidate.content / candidate.text may be absent when rows
// come from .muster/candidates.json — the SKILL that calls fuse is responsible
// for enriching rows with the full response text before passing them in.

import { pickWinner } from "./tournament.js";

// ---------------------------------------------------------------------------
// validateFusionMap
// ---------------------------------------------------------------------------

const REQUIRED_ARRAY_KEYS = [
  "consensus",
  "contradictions",
  "partialCoverage",
  "uniqueInsights",
  "blindSpots",
];

/**
 * Validate a fusion-map object produced by a debate/MoA SKILL.
 * Returns { ok: boolean, errors: string[] }.
 * Validates structure leniently: array entries in contradictions /
 * uniqueInsights may be strings or objects — only the top-level arrays are
 * required to exist.
 */
export function validateFusionMap(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { ok: false, errors: ["fusionMap: must be a non-null, non-array object"] };
  }
  const errors = [];
  for (const key of REQUIRED_ARRAY_KEYS) {
    if (!(key in map)) {
      errors.push(`${key}: required array is missing`);
    } else if (!Array.isArray(map[key])) {
      errors.push(`${key}: must be an array`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Deterministic djb2-style hash for a string → unsigned 32-bit integer.
 * Used to order top-K candidates independently of their score rank,
 * eliminating position bias in the synthesizer prompt.
 */
function stableHash(str) {
  let h = 5381;
  for (let i = 0; i < str.length; i++) h = ((h << 5) + h) ^ str.charCodeAt(i);
  return h >>> 0; // unsigned 32-bit
}

/**
 * Compute the minimum-disagreement threshold from the environment.
 * Default: 1 (any single point of disagreement unlocks fusion).
 */
function minDisagreementThreshold() {
  const raw = process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n)) return n;
  }
  return 1;
}

/**
 * Compute the top-K limit from the environment.
 * Default: 3.
 */
function topKLimit() {
  const raw = process.env.MUSTER_FUSE_TOPK;
  if (raw !== undefined && raw !== "") {
    const n = parseInt(raw, 10);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 3;
}

// ---------------------------------------------------------------------------
// fuse
// ---------------------------------------------------------------------------

/**
 * Decide whether to fuse or fall back for a set of tournament candidates.
 *
 * @param {Array}  candidates - Tournament candidate rows:
 *                   { id, total, passing, content?, text?, model?, ... }
 * @param {object} map        - Fusion map from a debate/MoA SKILL.
 * @param {object} [opts]     - Reserved for future per-call overrides.
 *
 * @returns {{ mode:'fuse'|'fallback', reason:string, winner?, topK?, synthesizerInput? }}
 *
 * Fallback shapes:
 *   { mode:'fallback', reason:'invalid-map'|'single-or-none-passing'|'candidates-agree',
 *     winner: <pickWinner(candidates) result> }
 *
 * Fuse shape:
 *   { mode:'fuse', reason:'fusion',
 *     topK: [id, ...],          // ids in hash-stable presented order
 *     synthesizerInput: {
 *       references: [{ index, content }],   // de-identified, no model/id
 *       fusionMap: map
 *     }
 *   }
 */
export function fuse(candidates, map, opts = {}) {
  // 1. Validate fusion map — fail safe: never throw the tournament.
  const validation = validateFusionMap(map);
  if (!validation.ok) {
    return { mode: "fallback", reason: "invalid-map", winner: pickWinner(candidates) };
  }

  // 2. Require at least 2 passing candidates for meaningful fusion.
  const passing = candidates.filter(c => c.passing);
  if (passing.length <= 1) {
    return {
      mode: "fallback",
      reason: "single-or-none-passing",
      winner: pickWinner(candidates),
    };
  }

  // 3. Agreement gate: fusion adds no value when candidates already agree.
  //    Disagreement score = count of map entries that signal divergence.
  const disagreementScore =
    map.contradictions.length +
    map.partialCoverage.length +
    map.uniqueInsights.length +
    map.blindSpots.length;

  const threshold = minDisagreementThreshold();
  if (disagreementScore < threshold) {
    return {
      mode: "fallback",
      reason: "candidates-agree",
      winner: pickWinner(candidates),
    };
  }

  // 4. Fuse: select top-K passing candidates by total score (desc), then
  //    order the selected set by stable id-hash to decouple presentation
  //    order from rank (kills position bias in the synthesizer prompt).
  const K = Math.min(topKLimit(), passing.length);

  const ranked = [...passing].sort(
    (a, b) => b.total - a.total || String(a.id).localeCompare(String(b.id))
  );
  const topKRows = ranked.slice(0, K);

  // Order by stable hash of id — deterministic but not score-ordered.
  const ordered = [...topKRows].sort(
    (a, b) => stableHash(String(a.id)) - stableHash(String(b.id))
  );

  // Build de-identified references: strip model/agent/id so the synthesizer
  // cannot exhibit self-bias toward a particular model or candidate identity.
  // Content fallback order: content → text → id (wave 2 SKILL supplies content).
  const references = ordered.map((c, i) => ({
    index: i + 1,
    // eslint-disable-next-line no-undefined -- explicit chain
    content: c.content !== undefined ? c.content : c.text !== undefined ? c.text : c.id,
  }));

  return {
    mode: "fuse",
    reason: "fusion",
    topK: ordered.map(c => c.id),
    synthesizerInput: {
      references,
      fusionMap: map,
    },
  };
}
