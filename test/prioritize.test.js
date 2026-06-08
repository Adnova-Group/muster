import { test } from "node:test";
import assert from "node:assert/strict";
import {
  prioritizeRICE,
  prioritizeICE,
  prioritizeWSJF,
  prioritizeWeighted,
  prioritize,
} from "../src/prioritize.js";

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

test("prioritize: unknown model throws and lists every supported model", () => {
  assert.throws(
    () => prioritize([], "moscow"),
    /unsupported model: moscow \(supported: rice, ice, wsjf, weighted\)/,
  );
});

test("prioritize: dispatches each model", () => {
  assert.equal(prioritize([{ name: "a", reach: 10, impact: 1, confidence: 1, effort: 2 }], "rice")[0].score, 5);
  assert.equal(prioritize([{ name: "a", impact: 2, confidence: 3, ease: 4 }], "ice")[0].score, 24);
  assert.equal(prioritize([{ name: "a", costOfDelay: 20, jobSize: 5 }], "wsjf")[0].score, 4);
  assert.equal(prioritize([{ name: "a", criteria: [{ weight: 2, score: 3 }] }], "weighted")[0].score, 6);
});

// ---- ICE: Impact x Confidence x Ease ----

test("prioritizeICE: unambiguous known ranking with 1-based ranks", () => {
  // ICE = impact * confidence * ease:
  //   alpha = 8 * 9 * 5 = 360
  //   beta  = 2 * 2 * 2 = 8
  //   gamma = 5 * 4 * 6 = 120
  const items = [
    { name: "beta", impact: 2, confidence: 2, ease: 2 },
    { name: "alpha", impact: 8, confidence: 9, ease: 5 },
    { name: "gamma", impact: 5, confidence: 4, ease: 6 },
  ];
  const out = prioritizeICE(items);
  assert.deepEqual(out.map(i => i.name), ["alpha", "gamma", "beta"]);
  assert.deepEqual(out.map(i => i.rank), [1, 2, 3]);
  assert.deepEqual(out.map(i => i.score), [360, 120, 8]);
});

test("prioritizeICE: does not mutate input, rounds to 2 decimals, tie-breaks by name", () => {
  const items = [
    { name: "banana", impact: 1, confidence: 1, ease: 3.333 },
    { name: "apple", impact: 1, confidence: 1, ease: 3.333 },
  ];
  const out = prioritizeICE(items);
  assert.equal(items[0].rank, undefined);
  assert.equal(out[0].score, 3.33);
  assert.deepEqual(out.map(i => i.name), ["apple", "banana"]);
});

test("prioritizeICE: non-finite / non-positive factor throws", () => {
  assert.throws(() => prioritizeICE([{ name: "z", impact: 0, confidence: 1, ease: 1 }]), /impact/);
  assert.throws(() => prioritizeICE([{ name: "z", impact: 1, confidence: NaN, ease: 1 }]), /confidence/);
  assert.throws(() => prioritizeICE([{ name: "z", impact: 1, confidence: 1, ease: -2 }]), /ease/);
});

test("prioritizeICE: missing name and non-array throw", () => {
  assert.throws(() => prioritizeICE([{ impact: 1, confidence: 1, ease: 1 }]), /name/);
  assert.throws(() => prioritizeICE("nope"), /array/);
});

// ---- WSJF: Cost of Delay / Job Size ----

test("prioritizeWSJF: unambiguous known ranking with 1-based ranks", () => {
  // WSJF = costOfDelay / jobSize:
  //   alpha = 40 / 2 = 20
  //   beta  = 10 / 5 = 2
  //   gamma = 30 / 3 = 10
  const items = [
    { name: "beta", costOfDelay: 10, jobSize: 5 },
    { name: "alpha", costOfDelay: 40, jobSize: 2 },
    { name: "gamma", costOfDelay: 30, jobSize: 3 },
  ];
  const out = prioritizeWSJF(items);
  assert.deepEqual(out.map(i => i.name), ["alpha", "gamma", "beta"]);
  assert.deepEqual(out.map(i => i.rank), [1, 2, 3]);
  assert.deepEqual(out.map(i => i.score), [20, 10, 2]);
});

test("prioritizeWSJF: jobSize 0 throws (divide-by-zero guard)", () => {
  assert.throws(
    () => prioritizeWSJF([{ name: "z", costOfDelay: 10, jobSize: 0 }]),
    /jobSize must be > 0/,
  );
});

test("prioritizeWSJF: negative jobSize and non-finite costOfDelay throw", () => {
  assert.throws(() => prioritizeWSJF([{ name: "z", costOfDelay: 10, jobSize: -1 }]), /jobSize must be > 0/);
  assert.throws(() => prioritizeWSJF([{ name: "z", costOfDelay: NaN, jobSize: 1 }]), /costOfDelay/);
  assert.throws(() => prioritizeWSJF([{ name: "z", costOfDelay: 0, jobSize: 1 }]), /costOfDelay/);
});

test("prioritizeWSJF: missing name and non-array throw", () => {
  assert.throws(() => prioritizeWSJF([{ costOfDelay: 1, jobSize: 1 }]), /name/);
  assert.throws(() => prioritizeWSJF(null), /array/);
});

// ---- Weighted scorecard: sum of weight_i * score_i ----

test("prioritizeWeighted: sums weighted criteria, ranks desc", () => {
  // weighted = sum(weight * score):
  //   alpha = 3*8 + 2*9 = 42
  //   beta  = 3*2 + 2*1 = 8
  //   gamma = 3*5 + 2*5 = 25
  const items = [
    { name: "beta", criteria: [{ weight: 3, score: 2 }, { weight: 2, score: 1 }] },
    { name: "alpha", criteria: [{ weight: 3, score: 8 }, { weight: 2, score: 9 }] },
    { name: "gamma", criteria: [{ weight: 3, score: 5 }, { weight: 2, score: 5 }] },
  ];
  const out = prioritizeWeighted(items);
  assert.deepEqual(out.map(i => i.name), ["alpha", "gamma", "beta"]);
  assert.deepEqual(out.map(i => i.rank), [1, 2, 3]);
  assert.deepEqual(out.map(i => i.score), [42, 25, 8]);
});

test("prioritizeWeighted: a zero criterion score is allowed (scores 0, ranks last)", () => {
  const out = prioritizeWeighted([
    { name: "low", criteria: [{ weight: 5, score: 0 }] },
    { name: "high", criteria: [{ weight: 5, score: 2 }] },
  ]);
  assert.deepEqual(out.map(i => i.name), ["high", "low"]);
  assert.deepEqual(out.map(i => i.score), [10, 0]);
});

test("prioritizeWeighted: empty/missing criteria throws", () => {
  assert.throws(() => prioritizeWeighted([{ name: "z", criteria: [] }]), /criteria/);
  assert.throws(() => prioritizeWeighted([{ name: "z" }]), /criteria/);
});

test("prioritizeWeighted: non-finite or non-positive weight, negative score throw", () => {
  assert.throws(() => prioritizeWeighted([{ name: "z", criteria: [{ weight: 0, score: 1 }] }]), /weight/);
  assert.throws(() => prioritizeWeighted([{ name: "z", criteria: [{ weight: NaN, score: 1 }] }]), /weight/);
  assert.throws(() => prioritizeWeighted([{ name: "z", criteria: [{ weight: 1, score: -1 }] }]), /score/);
  assert.throws(() => prioritizeWeighted([{ name: "z", criteria: [{ weight: 1, score: NaN }] }]), /score/);
});

test("prioritizeWeighted: missing name and non-array throw", () => {
  assert.throws(() => prioritizeWeighted([{ criteria: [{ weight: 1, score: 1 }] }]), /name/);
  assert.throws(() => prioritizeWeighted("nope"), /array/);
});
