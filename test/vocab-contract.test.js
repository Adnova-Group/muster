/**
 * Vocabulary contract tests (audit 2026-07-27, slice S12).
 *
 * Two vocabularies are duplicated between src/ and plugin/ with no shared
 * source — these tests pin the copies together so drift fails CI instead of
 * silently desyncing enforcement:
 *
 * 1. Action classes: src/manifest.js's ACTION_CLASSES (what a crew manifest
 *    may forbid) vs plugin/hooks/action-guard.js's classifier vocabulary
 *    (what the PreToolUse fence actually catches). Hooks ship standalone (no
 *    cross-import from src/), so the hook side is parsed from source text:
 *    the TOOL_NAME_CLASSES array plus every BASH_PATTERNS `cls:` value. The
 *    manifest side's const is also unexported, so it is extracted
 *    behaviorally — validateManifest's unknown-class error enumerates the
 *    live set.
 *
 * 2. Humanizer vocab: src/humanizer-score.js's banned-opener and tier-1-vocab
 *    regex alternations vs the prose lists in
 *    plugin/builtins/muster-humanizer/SKILL.md — the deterministic scorer
 *    must grade exactly the words the rewriter is told to remove. The
 *    scorer's DETECTORS table is unexported, so both regexes are parsed from
 *    source; the SKILL.md lists are parsed from their prose lines.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { validateManifest } from "../src/manifest.js";

const ACTION_GUARD_SRC = readFileSync(new URL("../plugin/hooks/action-guard.js", import.meta.url), "utf8");
const HUMANIZER_SCORE_SRC = readFileSync(new URL("../src/humanizer-score.js", import.meta.url), "utf8");
const HUMANIZER_SKILL_MD = readFileSync(new URL("../plugin/builtins/muster-humanizer/SKILL.md", import.meta.url), "utf8");

const sorted = (xs) => [...xs].sort();

// --- extractors ------------------------------------------------------------

// Manifest side: feed an unknown class and read the enumerated live set out
// of the validator's error ("must be one of send|sign|...").
function manifestActionClasses() {
  const { errors } = validateManifest({ forbiddenActions: ["__probe__"] });
  const err = errors.find((e) => e.includes("unknown action class"));
  assert.ok(err, "validateManifest should enumerate action classes on an unknown class");
  const m = err.match(/must be one of ([^)]+)\)/);
  assert.ok(m, `could not parse class list from error: ${err}`);
  return m[1].split("|");
}

// Hook side: union of the TOOL_NAME_CLASSES array literal and every
// BASH_PATTERNS `cls: "..."` value (the full vocabulary the fence can emit).
function hookActionClasses() {
  const classes = new Set();
  const arr = ACTION_GUARD_SRC.match(/TOOL_NAME_CLASSES\s*=\s*\[([^\]]*)\]/);
  assert.ok(arr, "could not find TOOL_NAME_CLASSES in action-guard.js");
  for (const s of arr[1].matchAll(/"([^"]+)"/g)) classes.add(s[1]);
  for (const s of ACTION_GUARD_SRC.matchAll(/cls:\s*"([^"]+)"/g)) classes.add(s[1]);
  return [...classes];
}

// Scorer side: pull the `re:` literal for a DETECTORS category, then take its
// plain-word alternation group (the (?:a|b|c) group whose alternatives are
// all bare words — skips structural groups like (?:^|\n)).
function scorerVocab(category) {
  const det = HUMANIZER_SCORE_SRC.match(new RegExp(`category: "${category}"[^}]*?re: /([^/]+)/[a-z]*`));
  assert.ok(det, `could not find DETECTORS entry for "${category}"`);
  const groups = [...det[1].matchAll(/\(\?:([^()]*)\)/g)].map((g) => g[1]);
  const wordGroup = groups.find((g) => g.split("|").every((w) => /^[A-Za-z][A-Za-z-]*$/.test(w)));
  assert.ok(wordGroup, `no plain-word alternation group in the "${category}" regex`);
  return wordGroup.split("|");
}

// SKILL.md side: parse a comma-separated prose list, e.g.
// "... paragraphs: Certainly, Moreover, ..., Overall." or
// "**Tier 1 — always rewrite:** delve, ..., unlock."
function skillList(re, label) {
  const m = HUMANIZER_SKILL_MD.match(re);
  assert.ok(m, `could not find the ${label} list in muster-humanizer/SKILL.md`);
  return m[1].split(",").map((w) => w.trim().replace(/\.$/, ""));
}

// --- contracts -------------------------------------------------------------

test("contract: manifest forbiddenActions classes == action-guard hook classes", () => {
  assert.deepEqual(sorted(manifestActionClasses()), sorted(hookActionClasses()));
});

test("contract: humanizer-score banned-opener regex == SKILL.md banned-opener list", () => {
  const scorer = scorerVocab("banned-opener");
  const skill = skillList(/No banned openers\*\*[^:]*:\s*([A-Za-z, ]+)\./, "banned-opener");
  assert.deepEqual(sorted(scorer), sorted(skill));
});

test("contract: humanizer-score tier1-vocab regex == SKILL.md tier-1 list", () => {
  const scorer = scorerVocab("tier1-vocab");
  const skill = skillList(/\*\*Tier 1 — always rewrite:\*\*\s*([A-Za-z, -]+)\./, "tier-1 vocab");
  assert.deepEqual(sorted(scorer), sorted(skill));
});
