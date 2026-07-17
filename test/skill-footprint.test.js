import { test } from "node:test";
import assert from "node:assert/strict";
import {
  computeSkillFootprint,
  rankSkillFootprints,
  reductionPct,
  meetsReductionTarget,
  MIN_REDUCTION_PCT,
} from "../src/skill-footprint.js";

// speed-tuning item, criterion 2: skill prompt-size audit. Pure arithmetic only -- the
// REAL fs.readFileSync measurement lives in eval/perf/skill-size-audit.mjs, mirroring
// src/token-projection.js's split (pure module tested here, live measurement in the eval
// script that calls it with real numbers).

test("computeSkillFootprint: chars is content.length, tokens is chars/charsPerToken (default 4)", () => {
  const r = computeSkillFootprint("router", "a".repeat(400));
  assert.equal(r.name, "router");
  assert.equal(r.chars, 400);
  assert.equal(r.tokens, 100);
});

test("computeSkillFootprint: charsPerToken is overridable", () => {
  const r = computeSkillFootprint("router", "a".repeat(400), { charsPerToken: 8 });
  assert.equal(r.tokens, 50);
});

test("computeSkillFootprint: rejects a missing name or a non-string content", () => {
  assert.throws(() => computeSkillFootprint("", "x"), /name is required/i);
  assert.throws(() => computeSkillFootprint("router", 123), /content must be a string/i);
});

test("rankSkillFootprints: sorts largest-chars-first and slices the top `count`", () => {
  const footprints = [
    { name: "small", chars: 100, tokens: 25 },
    { name: "huge", chars: 40000, tokens: 10000 },
    { name: "medium", chars: 5000, tokens: 1250 },
    { name: "tiny", chars: 10, tokens: 2.5 },
  ];
  const { all, largest } = rankSkillFootprints(footprints, { count: 2 });
  assert.deepEqual(all.map((f) => f.name), ["huge", "medium", "small", "tiny"]);
  assert.deepEqual(largest.map((f) => f.name), ["huge", "medium"]);
});

test("rankSkillFootprints: defaults count to 5 (this item's audited slice)", () => {
  const footprints = Array.from({ length: 8 }, (_, i) => ({ name: `s${i}`, chars: i * 100, tokens: i * 25 }));
  const { largest } = rankSkillFootprints(footprints);
  assert.equal(largest.length, 5);
  assert.deepEqual(largest.map((f) => f.name), ["s7", "s6", "s5", "s4", "s3"]);
});

test("rankSkillFootprints: rejects a non-array input or a negative/non-integer count", () => {
  assert.throws(() => rankSkillFootprints("nope"), /must be an array/i);
  assert.throws(() => rankSkillFootprints([], { count: -1 }), /non-negative integer/i);
  assert.throws(() => rankSkillFootprints([], { count: 1.5 }), /non-negative integer/i);
});

test("reductionPct: (before - after) / before * 100", () => {
  assert.equal(reductionPct(1000, 600), 40);
  assert.equal(reductionPct(1000, 400), 60);
  assert.equal(reductionPct(1000, 1000), 0);
});

test("reductionPct: an all-zero before is 0% (no division by zero)", () => {
  assert.equal(reductionPct(0, 0), 0);
});

test("reductionPct: rejects a negative/non-finite before or after", () => {
  assert.throws(() => reductionPct(-1, 0), /beforeChars must be a non-negative finite number/i);
  assert.throws(() => reductionPct(100, -1), /afterChars must be a non-negative finite number/i);
  assert.throws(() => reductionPct(NaN, 0), /beforeChars must be a non-negative finite number/i);
});

test("MIN_REDUCTION_PCT is this item's stated >=40% cut target", () => {
  assert.equal(MIN_REDUCTION_PCT, 40);
});

test("meetsReductionTarget: true at/above the default 40% cut, false below it", () => {
  assert.equal(meetsReductionTarget(1000, 600), true); // exactly 40%
  assert.equal(meetsReductionTarget(1000, 601), false); // just under 40%
  assert.equal(meetsReductionTarget(1000, 500), true); // 50%, comfortably over
});

test("meetsReductionTarget: minPct is overridable", () => {
  assert.equal(meetsReductionTarget(1000, 900), false); // 10% cut
  assert.equal(meetsReductionTarget(1000, 900, { minPct: 10 }), true);
});
