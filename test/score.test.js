import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreArtifact, calibrateScores } from "../src/score.js";

test("calibrateScores is identity with no offsets", () => {
  const s = { a: 2, b: 3 };
  assert.deepEqual(calibrateScores(s), s);
  assert.deepEqual(calibrateScores(s, {}), s);
});

test("calibrateScores applies a per-criterion offset and clamps to [0,3]", () => {
  const r = calibrateScores({ a: 2, b: 3, c: 0 }, { a: -1, b: +1, c: -1 });
  assert.deepEqual(r, { a: 1, b: 3, c: 0 }); // b clamped at 3, c clamped at 0
});

test("calibrateScores throws on non-finite input", () => {
  assert.throws(() => calibrateScores({ a: NaN }), /finite number/);
});

test("passes when floor + total met", () => {
  const r = scoreArtifact({ a: 3, b: 3, c: 2 }, { floor: 2, pass_total: 7 });
  assert.equal(r.passing, true);
  assert.equal(r.total, 8);
});
test("fails on floor — one weak dimension reported", () => {
  const r = scoreArtifact({ a: 3, b: 1, c: 3 }, { floor: 2, pass_total: 5 });
  assert.equal(r.passing, false);
  assert.equal(r.weakest.criterion, "b");
});
test("fails on total even if floor met", () => {
  const r = scoreArtifact({ a: 2, b: 2, c: 2 }, { floor: 2, pass_total: 10 });
  assert.equal(r.passing, false);
});

test("non-finite score values are rejected before they can corrupt the gate", () => {
  // A string score must not be silently string-concatenated into `total`
  // (which would yield a wrong-typed result downstream numeric checks trust).
  assert.throws(
    () => scoreArtifact({ a: "high", b: "low" }, {}),
    /score for "a" must be a finite number, got high/,
    "a non-numeric score must throw, not corrupt total via string concat");
  // NaN and Infinity are numbers but not finite — they poison comparisons.
  assert.throws(() => scoreArtifact({ a: NaN }, {}), /must be a finite number/,
    "NaN must be rejected");
  assert.throws(() => scoreArtifact({ a: Infinity }, {}), /must be a finite number/,
    "Infinity must be rejected");
  assert.throws(() => scoreArtifact({ a: null }, {}), /must be a finite number/,
    "null must be rejected");
});

test("empty / nullish input -> zeroed result, never throws, never passes", () => {
  // An artifact with no scored dimensions must not pass the gate (there is
  // nothing to clear the floor with) and must not crash the pipeline. The
  // weakest must report a null criterion with value 0, and total 0.
  const empty = scoreArtifact({}, { floor: 0, pass_total: 0 });
  assert.deepEqual(empty, { total: 0, weakest: { criterion: null, value: 0 }, passing: false });
  // null and undefined are coerced to {} via `scores || {}` — identical shape,
  // no throw. A degenerate judge output must degrade gracefully, not poison.
  assert.deepEqual(scoreArtifact(null, { floor: 0, pass_total: 0 }),
    { total: 0, weakest: { criterion: null, value: 0 }, passing: false });
  assert.deepEqual(scoreArtifact(undefined, { floor: 0, pass_total: 0 }),
    { total: 0, weakest: { criterion: null, value: 0 }, passing: false });
});

test("tie for weakest -> first by insertion order wins (deterministic tie-break)", () => {
  // a and b both score the lowest (1). Strict `<` keeps the first-inserted one,
  // so the reported weakest must be deterministic and equal to insertion order.
  const r1 = scoreArtifact({ a: 1, b: 1, c: 3 }, { floor: 2, pass_total: 0 });
  assert.equal(r1.weakest.criterion, "a",
    "on a tie, the first criterion by insertion order must be reported weakest");
  // Reversing insertion order flips the winner — proving the tie-break is
  // insertion-order driven, not value- or name-driven.
  const r2 = scoreArtifact({ b: 1, a: 1, c: 3 }, { floor: 2, pass_total: 0 });
  assert.equal(r2.weakest.criterion, "b",
    "tie-break follows insertion order, so reordering keys changes the winner");
});

test("calibrateScores rejects a non-finite offset (audit regression)", () => {
  assert.throws(() => calibrateScores({ a: 2 }, { a: NaN }), /offset.*finite/);
  assert.throws(() => calibrateScores({ a: 2 }, { a: "x" }), /offset.*finite/);
  assert.deepEqual(calibrateScores({ a: 2 }, { b: 1 }), { a: 2 }, "an offset for an absent criterion is ignored");
});
