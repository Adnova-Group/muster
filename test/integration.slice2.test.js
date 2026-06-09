import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";
import { computeWaves } from "../src/wave.js";
import { tallyReview } from "../src/review.js";
import { pickWinner } from "../src/tournament.js";

test("a valid diamond manifest schedules into 3 waves", () => {
  const m = {
    outcome: "ship feature", successCriteria: ["tests green"],
    crew: [{ stage: "implement", provider: "muster-builder", source: "builtin", model: "sonnet",
             rationale: "r", evidence: "e", fallback: "inline" }],
    recommendations: [], degradations: [],
    plan: [
      { id: "a", task: "scaffold", mode: "single", deps: [] },
      { id: "b", task: "api", mode: "single", deps: ["a"] },
      { id: "c", task: "auth", mode: "tournament", deps: ["a"] },
      { id: "d", task: "wire", mode: "single", deps: ["b", "c"] }
    ]
  };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  const waves = computeWaves(m.plan).map(w => w.map(t => t.id));
  assert.deepEqual(waves, [["a"], ["b", "c"], ["d"]]);
});

test("review gate blocks then a tournament resolves a winner", () => {
  const gate = tallyReview([
    { reviewer: "builtin", findings: [{ severity: "blocker", note: "missing validation" }] }
  ]);
  assert.equal(gate.blocked, true);

  const pick = pickWinner([
    { id: "approach-A", total: 6, passing: true },
    { id: "approach-B", total: 8, passing: true },
    { id: "approach-C", total: 9, passing: false }
  ]);
  assert.equal(pick.winner, "approach-B");
  assert.equal(pick.escalate, false);
});
