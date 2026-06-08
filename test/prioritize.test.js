import { test } from "node:test";
import assert from "node:assert/strict";
import { prioritizeRICE, prioritize } from "../src/prioritize.js";

test("prioritizeRICE: unambiguous known ranking with 1-based ranks", () => {
  // Hand-computed RICE = (reach * impact * confidence) / effort:
  //   alpha = (1000 * 2 * 0.8) / 4   = 400
  //   beta  = (500  * 1 * 0.5) / 5   = 50
  //   gamma = (100  * 3 * 1.0) / 2   = 150
  // Order desc: alpha (400) > gamma (150) > beta (50).
  const items = [
    { name: "beta", reach: 500, impact: 1, confidence: 0.5, effort: 5 },
    { name: "alpha", reach: 1000, impact: 2, confidence: 0.8, effort: 4 },
    { name: "gamma", reach: 100, impact: 3, confidence: 1.0, effort: 2 },
  ];
  const out = prioritizeRICE(items);
  assert.deepEqual(out.map(i => i.name), ["alpha", "gamma", "beta"]);
  assert.deepEqual(out.map(i => i.rank), [1, 2, 3]);
  assert.equal(out[0].score, 400);
  assert.equal(out[1].score, 150);
  assert.equal(out[2].score, 50);
});

test("prioritizeRICE: returns a new array, does not mutate input", () => {
  const items = [{ name: "a", reach: 10, impact: 1, confidence: 1, effort: 2 }];
  const out = prioritizeRICE(items);
  assert.notEqual(out, items);
  assert.equal(items[0].rank, undefined);
  assert.equal(out[0].rank, 1);
});

test("prioritizeRICE: score rounded to 2 decimals", () => {
  // (10 * 1 * 1) / 3 = 3.3333... -> 3.33
  const out = prioritizeRICE([{ name: "x", reach: 10, impact: 1, confidence: 1, effort: 3 }]);
  assert.equal(out[0].score, 3.33);
});

test("prioritizeRICE: effort 0 throws (divide-by-zero guard)", () => {
  assert.throws(
    () => prioritizeRICE([{ name: "z", reach: 1, impact: 1, confidence: 1, effort: 0 }]),
    /effort must be > 0/,
  );
});

test("prioritizeRICE: negative effort throws", () => {
  assert.throws(
    () => prioritizeRICE([{ name: "z", reach: 1, impact: 1, confidence: 1, effort: -3 }]),
    /effort must be > 0/,
  );
});

test("prioritizeRICE: non-numeric factor throws", () => {
  assert.throws(
    () => prioritizeRICE([{ name: "z", reach: "lots", impact: 1, confidence: 1, effort: 2 }]),
    /reach/,
  );
});

test("prioritizeRICE: NaN factor throws", () => {
  assert.throws(
    () => prioritizeRICE([{ name: "z", reach: 1, impact: NaN, confidence: 1, effort: 2 }]),
    /impact/,
  );
});

test("prioritizeRICE: non-positive factor throws", () => {
  assert.throws(
    () => prioritizeRICE([{ name: "z", reach: 0, impact: 1, confidence: 1, effort: 2 }]),
    /reach/,
  );
});

test("prioritizeRICE: missing name throws", () => {
  assert.throws(
    () => prioritizeRICE([{ reach: 1, impact: 1, confidence: 1, effort: 2 }]),
    /name/,
  );
});

test("prioritizeRICE: empty-string name throws", () => {
  assert.throws(
    () => prioritizeRICE([{ name: "  ", reach: 1, impact: 1, confidence: 1, effort: 2 }]),
    /name/,
  );
});

test("prioritizeRICE: non-array throws", () => {
  assert.throws(() => prioritizeRICE("nope"), /array/);
  assert.throws(() => prioritizeRICE(null), /array/);
});

test("prioritizeRICE: tie-break by name ascending", () => {
  // Both score (10*1*1)/2 = 5; "apple" sorts before "banana" -> rank 1.
  const out = prioritizeRICE([
    { name: "banana", reach: 10, impact: 1, confidence: 1, effort: 2 },
    { name: "apple", reach: 10, impact: 1, confidence: 1, effort: 2 },
  ]);
  assert.deepEqual(out.map(i => i.name), ["apple", "banana"]);
  assert.deepEqual(out.map(i => i.rank), [1, 2]);
});

test("prioritize: dispatches rice by default", () => {
  const out = prioritize([{ name: "a", reach: 10, impact: 1, confidence: 1, effort: 2 }]);
  assert.equal(out[0].score, 5);
  assert.equal(out[0].rank, 1);
});

test("prioritize: unknown model throws", () => {
  assert.throws(
    () => prioritize([], "wsjf"),
    /unsupported model: wsjf \(supported: rice\)/,
  );
});
