import { test } from "node:test";
import assert from "node:assert/strict";
import { tallyReview } from "../src/review.js";

test("no blockers -> not blocked, counts tallied", () => {
  const r = tallyReview([
    { reviewer: "x", findings: [{ severity: "nit", note: "n" }, { severity: "risk", note: "r" }] }
  ]);
  assert.equal(r.blocked, false);
  assert.deepEqual(r.counts, { blocker: 0, risk: 1, nit: 1 });
});

test("any blocker (single reviewer) -> blocked, lists it", () => {
  const r = tallyReview([
    { reviewer: "a", findings: [{ severity: "nit", note: "n" }] },
    { reviewer: "b", findings: [{ severity: "blocker", note: "boom" }] }
  ]);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockers, [{ reviewer: "b", note: "boom" }]);
  assert.equal(r.counts.blocker, 1);
});

test("empty verdicts -> not blocked, zero counts", () => {
  assert.deepEqual(tallyReview([]), { blocked: false, blockers: [], counts: { blocker: 0, risk: 0, nit: 0 } });
});
