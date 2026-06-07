import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWaves } from "../src/wave.js";

const ids = waves => waves.map(w => w.map(t => t.id));

test("no deps -> single wave", () => {
  const w = computeWaves([{ id: "a", deps: [] }, { id: "b", deps: [] }]);
  assert.deepEqual(ids(w), [["a", "b"]]);
});

test("linear chain -> one task per wave", () => {
  const w = computeWaves([{ id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["b"] }]);
  assert.deepEqual(ids(w), [["a"], ["b"], ["c"]]);
});

test("diamond -> middle pair shares a wave", () => {
  const w = computeWaves([
    { id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }, { id: "d", deps: ["b", "c"] }
  ]);
  assert.deepEqual(ids(w), [["a"], ["b", "c"], ["d"]]);
});

test("cycle -> throws", () => {
  assert.throws(() => computeWaves([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }]), /cycle/i);
});

test("missing dep -> throws", () => {
  assert.throws(() => computeWaves([{ id: "a", deps: ["ghost"] }]), /unknown dep/i);
});

test("missing deps field defaults to no deps", () => {
  const w = computeWaves([{ id: "a" }, { id: "b" }]);
  assert.deepEqual(ids(w), [["a", "b"]]);
});
