import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreArtifact } from "../src/score.js";

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
