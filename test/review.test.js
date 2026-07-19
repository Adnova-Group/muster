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
  assert.deepEqual(tallyReview([]), {
    blocked: false, blockers: [], counts: { blocker: 0, risk: 0, nit: 0 },
    blockedReasons: [], exhausted: []
  });
});

test("unknown severity is skipped — outside the known set, must not touch counts or verdict", () => {
  const r = tallyReview([
    { reviewer: "x", findings: [
      { severity: "critical", note: "not a recognized severity" },
      { severity: "risk", note: "r" }
    ] }
  ]);
  // "critical" is not in {blocker,risk,nit}: it must be ignored entirely so an
  // unrecognized severity can never silently inflate a count or flip the gate.
  assert.deepEqual(r.counts, { blocker: 0, risk: 1, nit: 0 },
    "unknown severity 'critical' must not increment any known count");
  assert.equal(r.blocked, false,
    "unknown severity must not block — only 'blocker' blocks the gate");
  assert.deepEqual(r.blockers, [],
    "unknown severity must not be recorded as a blocker");
});

// Worker-exhaustion escalation (backlog item tally-worker-exhaustion-contract).
// Live incident, 2026-07-19 Codex dogfood: an agent-watch budget killed a required
// reviewer mid-run. The orchestrator, with no vocabulary to say "this reviewer never
// verdicted," fed synthetic FAIL/blocker-shaped strings into muster_tally -- but
// tallyReview only ever parses the severity vocabulary {blocker,risk,nit}, so those
// synthetic strings were silently skipped exactly like the "unknown severity" case
// above, and the gate answered blocked:false. The orchestrator had to improvise its
// own halt outside the deterministic gate math. This fixture reproduces that exact
// shape: a reviewer entry that carries ONLY exhaustion noise (a severity the tally
// vocabulary has never recognized) instead of a real verdict.
test("exhausted reviewer with only synthetic noise (the dogfood shape) blocks with a named reason, not via findings", () => {
  const r = tallyReview([
    { reviewer: "a", findings: [{ severity: "nit", note: "n" }] },
    { reviewer: "b", status: "exhausted", findings: [
      { severity: "FAIL", note: "reviewer killed by agent-watch budget mid-review" }
    ] }
  ]);
  assert.equal(r.blocked, true, "an exhausted required reviewer must block the tally");
  assert.deepEqual(r.blockedReasons, ["reviewer b exhausted before verdict"]);
  // Never counted as PASS or FAIL: the synthetic "FAIL" noise must not appear in
  // counts/blockers at all -- exhaustion is its own named channel, not a finding.
  assert.deepEqual(r.counts, { blocker: 0, risk: 0, nit: 1 });
  assert.deepEqual(r.blockers, []);
  assert.deepEqual(r.exhausted, [{ reviewer: "b", status: "exhausted" }]);
});

test("exhausted reviewer with a spoofed blocker-severity finding still never counts it — exhaustion always wins over silence, findings on an exhausted entry are never trusted", () => {
  const r = tallyReview([
    { reviewer: "b", status: "exhausted", findings: [
      { severity: "blocker", note: "synthetic blocker fed by the orchestrator, not a real finding" }
    ] }
  ]);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockedReasons, ["reviewer b exhausted before verdict"]);
  assert.deepEqual(r.counts, { blocker: 0, risk: 0, nit: 0 },
    "a spoofed blocker on an exhausted entry must never be tallied as a real blocker finding");
  assert.deepEqual(r.blockers, []);
});

test("absent reviewer (never dispatched/never responded) blocks with its own named reason", () => {
  const r = tallyReview([
    { reviewer: "c", status: "absent" }
  ]);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockedReasons, ["reviewer c absent before verdict"]);
  assert.deepEqual(r.exhausted, [{ reviewer: "c", status: "absent" }]);
  assert.deepEqual(r.counts, { blocker: 0, risk: 0, nit: 0 });
});

test("one exhausted reviewer among otherwise-passing reviewers still blocks the whole tally", () => {
  const r = tallyReview([
    { reviewer: "a", findings: [{ severity: "nit", note: "n" }] },
    { reviewer: "b", findings: [{ severity: "risk", note: "r" }] },
    { reviewer: "c", status: "exhausted" }
  ]);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockedReasons, ["reviewer c exhausted before verdict"]);
  // the two real reviewers' findings still tally normally alongside the block
  assert.deepEqual(r.counts, { blocker: 0, risk: 1, nit: 1 });
});

test("an unrecognized status value is not worker-exhaustion vocabulary — ignored, findings parsed normally (same unknown-vocabulary discipline as severity)", () => {
  const r = tallyReview([
    { reviewer: "x", status: "on-vacation", findings: [{ severity: "nit", note: "n" }] }
  ]);
  assert.equal(r.blocked, false);
  assert.deepEqual(r.blockedReasons, []);
  assert.deepEqual(r.exhausted, []);
  assert.deepEqual(r.counts, { blocker: 0, risk: 0, nit: 1 });
});

test("an entry with no status behaves exactly as before status existed — full backward compatibility", () => {
  const r = tallyReview([
    { reviewer: "a", findings: [{ severity: "blocker", note: "boom" }] }
  ]);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockers, [{ reviewer: "a", note: "boom" }]);
  assert.deepEqual(r.blockedReasons, []);
  assert.deepEqual(r.exhausted, []);
});

// exhaustion-status-producer item, carried review finding: an exhausted/absent entry
// with no `reviewer` field previously interpolated the literal string "undefined" into
// blockedReasons ("reviewer undefined exhausted before verdict") -- unguarded template
// interpolation of a missing field, not a real reviewer name. Name it instead.
test("exhausted/absent entry with no reviewer field is named, not interpolated as undefined", () => {
  const r = tallyReview([
    { status: "exhausted" }
  ]);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockedReasons, ["(unnamed reviewer) exhausted before verdict"]);
  assert.deepEqual(r.exhausted, [{ reviewer: "(unnamed reviewer)", status: "exhausted" }]);
});

test("two simultaneously exhausted reviewers both get named reasons and both block", () => {
  const r = tallyReview([
    { reviewer: "a", status: "exhausted" },
    { reviewer: "b", status: "exhausted" }
  ]);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockedReasons, [
    "reviewer a exhausted before verdict",
    "reviewer b exhausted before verdict"
  ]);
  assert.deepEqual(r.exhausted, [
    { reviewer: "a", status: "exhausted" },
    { reviewer: "b", status: "exhausted" }
  ]);
});
