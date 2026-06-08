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
