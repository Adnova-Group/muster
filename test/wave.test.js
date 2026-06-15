import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWaves, nextTasks } from "../src/wave.js";

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

test("non-array input throws", () => {
  assert.throws(() => computeWaves(null), /must be an array/);
});

test("duplicate id throws", () => {
  assert.throws(() => computeWaves([{ id: "a", deps: [] }, { id: "a", deps: [] }]), /duplicate task id/);
});

// --- nextTasks: the single-agent / sequential driver --------------------------
const DIAMOND = [
  { id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }, { id: "d", deps: ["b", "c"] },
];

test("nextTasks: fresh start surfaces only the dependency-free frontier", () => {
  const r = nextTasks(DIAMOND, []);
  assert.equal(r.done, false);
  assert.equal(r.next.id, "a");
  assert.deepEqual(r.ready.map(t => t.id), ["a"]);
  assert.equal(r.ready[0].wave, 0);
  assert.equal(r.remaining, 4);
});

test("nextTasks: after a completes, b and c are the ready frontier; d stays blocked on both", () => {
  const r = nextTasks(DIAMOND, ["a"]);
  assert.deepEqual(r.ready.map(t => t.id).sort(), ["b", "c"]);
  assert.equal(r.ready.every(t => t.wave === 1), true);
  assert.deepEqual(r.blocked, [{ id: "d", missing: ["b", "c"] }]);
  assert.equal(r.next.id, "b");
});

test("nextTasks: with b and c done, d unblocks", () => {
  const r = nextTasks(DIAMOND, ["a", "b", "c"]);
  assert.equal(r.next.id, "d");
  assert.deepEqual(r.blocked, []);
});

test("nextTasks: all complete -> done, no next", () => {
  const r = nextTasks(DIAMOND, ["a", "b", "c", "d"]);
  assert.equal(r.done, true);
  assert.equal(r.next, null);
  assert.deepEqual(r.ready, []);
  assert.equal(r.remaining, 0);
});

test("nextTasks: next honors wave order (lowest wave first) in a linear chain", () => {
  const r = nextTasks([{ id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["b"] }], []);
  assert.equal(r.next.id, "a");
  assert.deepEqual(r.ready.map(t => t.id), ["a"]);
});

test("nextTasks: an unknown completed id is surfaced, not silently swallowed", () => {
  const r = nextTasks([{ id: "a", deps: [] }], ["ghost"]);
  assert.deepEqual(r.unknownCompleted, ["ghost"]);
  assert.equal(r.next.id, "a");
});

test("nextTasks: cycle propagates from computeWaves", () => {
  assert.throws(() => nextTasks([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }], []), /cycle/i);
});
