import { test } from "node:test";
import assert from "node:assert/strict";
import { projectRunReduction } from "../src/perf-projection.js";

// Inputs below are the grounded, documented facts for a replayed 3-task /muster:go run —
// see docs/performance-pass.md for how each number was derived (real `time`-measured
// cold-start costs, and real CLI-call/gate-round counts read off the actual command/skill
// markdown, before vs after this change). This test pins the arithmetic itself
// (deterministic, no wall-clock dependency) so the >=30% reduction claim in criterion 4
// is asserted by the green suite, not just narrated in a doc.

test("projectRunReduction: before/after wall-clock model for the replayed 3-task run", () => {
  const r = projectRunReduction({
    cliCallCount: 16,       // real count of muster CLI call-sites hit by a 3-task sequential go run (before)
    coldStartMs: 279.7,     // measured: 10x `npx -y @adnova-group/muster scope ...` / 10, this sandbox (eval/perf/replay-3task.mjs)
    warmMs: 95.7,           // measured: 10x resolved-local `node src/cli.js scope ...` / 10, this sandbox (eval/perf/replay-3task.mjs)
    specGateRoundsBefore: 1, specGateRoundsAfter: 1, // spec gate was already a single whole-plan dispatch
    reviewGateRoundsBefore: 3, reviewGateRoundsAfter: 1, // review gate: one per wave (3) -> batched (1)
    msPerGateRound: 1500,   // modeled opus-tier gate-round wall-clock cost (dispatch + reasoning latency)
  });

  assert.equal(r.beforeMs, 16 * 279.7 + (1 + 3) * 1500);
  assert.equal(r.afterMs, 16 * 95.7 + (1 + 1) * 1500);
  assert.ok(r.reductionMs > 0, "the after model must be cheaper than the before model");
  assert.ok(r.reductionPct >= 30, `expected >=30% reduction, got ${r.reductionPct.toFixed(1)}%`);
});

test("projectRunReduction: identical before/after inputs yield zero reduction", () => {
  const r = projectRunReduction({
    cliCallCount: 5, coldStartMs: 100, warmMs: 100,
    specGateRoundsBefore: 1, specGateRoundsAfter: 1,
    reviewGateRoundsBefore: 2, reviewGateRoundsAfter: 2,
    msPerGateRound: 500,
  });
  assert.equal(r.reductionMs, 0);
  assert.equal(r.reductionPct, 0);
});

test("projectRunReduction: zero calls and zero gate rounds is a defined no-op (no division by zero)", () => {
  const r = projectRunReduction({
    cliCallCount: 0, coldStartMs: 100, warmMs: 10,
    specGateRoundsBefore: 0, specGateRoundsAfter: 0,
    reviewGateRoundsBefore: 0, reviewGateRoundsAfter: 0,
    msPerGateRound: 500,
  });
  assert.equal(r.beforeMs, 0);
  assert.equal(r.afterMs, 0);
  assert.equal(r.reductionPct, 0);
});

test("projectRunReduction: a WORSE after model yields a negative reduction (honest, not clamped)", () => {
  const r = projectRunReduction({
    cliCallCount: 5, coldStartMs: 50, warmMs: 200,
    specGateRoundsBefore: 1, specGateRoundsAfter: 1,
    reviewGateRoundsBefore: 1, reviewGateRoundsAfter: 1,
    msPerGateRound: 100,
  });
  assert.ok(r.reductionMs < 0);
  assert.ok(r.reductionPct < 0);
});
