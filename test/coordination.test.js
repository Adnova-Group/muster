import { test } from "node:test";
import assert from "node:assert/strict";
import {
  MUSTER_RECEIPT_PATTERNS,
  computeClaimWindows,
  computeClaimWindowWinner,
  isHumanHoldResumeAuthorized,
} from "../src/coordination.js";

// Direct unit tests for src/coordination.js -- the single executable source of the
// claim-window rules (moved verbatim out of eval/modes/grade-lib.mjs; the eval's own
// test/mode-evals.test.js proves grade-lib's re-exported behavior is unchanged).

test("MUSTER_RECEIPT_PATTERNS classifies every receipt type", () => {
  assert.match("MUSTER CLAIMED alice 2026-01-01T00:00:00Z", MUSTER_RECEIPT_PATTERNS.CLAIMED);
  assert.match("MUSTER DONE alice 2026-01-01T00:00:00Z", MUSTER_RECEIPT_PATTERNS.DONE);
  assert.match("MUSTER BLOCKED alice 2026-01-01T00:00:00Z the question", MUSTER_RECEIPT_PATTERNS.BLOCKED);
  assert.match("MUSTER HUMAN-HOLD alice 2026-01-01T00:00:00Z authorizer=bob the question", MUSTER_RECEIPT_PATTERNS["HUMAN-HOLD"]);
  assert.match("MUSTER FAILED alice 2026-01-01T00:00:00Z the reason", MUSTER_RECEIPT_PATTERNS.FAILED);
  assert.match("MUSTER YIELD alice 2026-01-01T00:00:00Z lost the race", MUSTER_RECEIPT_PATTERNS.YIELD);
});

test("computeClaimWindows: a single claimant with no race wins its own window", () => {
  const events = [
    { type: "CLAIMED", runner: "alice", ts: "2026-01-01T09:00:00Z" },
    { type: "DONE", runner: "alice", ts: "2026-01-01T09:10:00Z" },
  ];
  const { current } = computeClaimWindows(events);
  assert.equal(current.winner.runner, "alice");
  assert.deepEqual(current.losers, []);
});

test("computeClaimWindows: the earliest CLAIMED in a window wins; later claimants are losers", () => {
  const events = [
    { type: "CLAIMED", runner: "bob", ts: "2026-01-01T00:00:05Z" },
    { type: "CLAIMED", runner: "alice", ts: "2026-01-01T00:00:00Z" },
    { type: "YIELD", runner: "bob", ts: "2026-01-01T00:00:10Z" },
    { type: "DONE", runner: "alice", ts: "2026-01-01T00:05:00Z" },
  ];
  const { current } = computeClaimWindows(events);
  assert.equal(current.winner.runner, "alice");
  assert.deepEqual(current.losers.map((l) => l.runner), ["bob"]);
});

test("computeClaimWindows: FAILED resets the floor so a stale prior-cycle claim can never out-rank a fresh re-claim", () => {
  const events = [
    { type: "CLAIMED", runner: "alice", ts: "2026-01-01T08:00:00Z" },
    { type: "FAILED", runner: "alice", ts: "2026-01-01T08:05:00Z" },
    { type: "CLAIMED", runner: "bob", ts: "2026-01-01T09:00:00Z" },
    { type: "DONE", runner: "bob", ts: "2026-01-01T09:10:00Z" },
  ];
  const { current } = computeClaimWindows(events);
  assert.equal(current.winner.runner, "bob");
  assert.equal(computeClaimWindowWinner(events).winner.runner, "bob");
});

test("computeClaimWindows: HUMAN-HOLD resets the window floor exactly like DONE/BLOCKED/FAILED", () => {
  const events = [
    { type: "CLAIMED", runner: "alice", ts: "2026-01-01T08:00:00Z" },
    { type: "HUMAN-HOLD", runner: "alice", ts: "2026-01-01T08:05:00Z" },
    { type: "CLAIMED", runner: "carol", ts: "2026-01-01T09:00:00Z" },
    { type: "DONE", runner: "carol", ts: "2026-01-01T09:10:00Z" },
  ];
  const { current } = computeClaimWindows(events);
  assert.equal(current.winner.runner, "carol");
});

// [P1 cov] BLOCKED as a floor-resetting terminal was previously untested: every prior
// floor-reset case used FAILED or HUMAN-HOLD as the resetting terminal, never plain
// BLOCKED, even though computeClaimWindows treats it identically (same `else if` branch).
test("computeClaimWindows: BLOCKED resets the window floor exactly like DONE/HUMAN-HOLD/FAILED", () => {
  const events = [
    { type: "CLAIMED", runner: "alice", ts: "2026-01-01T08:00:00Z" },
    { type: "BLOCKED", runner: "alice", ts: "2026-01-01T08:05:00Z" },
    { type: "CLAIMED", runner: "bob", ts: "2026-01-01T09:00:00Z" },
    { type: "DONE", runner: "bob", ts: "2026-01-01T09:10:00Z" },
  ];
  const { windows, current } = computeClaimWindows(events);
  // The BLOCKED-resolved window: alice's stale claim is its own winner (nobody else was
  // in that window), and it must NOT bleed into the next window's comparison.
  assert.equal(windows[0].winner.runner, "alice");
  assert.equal(windows[0].resolvedBy.type, "BLOCKED");
  // The floor reset means bob's fresh claim (09:00, timestamp-later than alice's 08:00)
  // wins the CURRENT window outright -- alice's earlier-but-stale claim never re-enters.
  assert.equal(current.winner.runner, "bob");
  assert.equal(computeClaimWindowWinner(events).winner.runner, "bob");
});

test("isHumanHoldResumeAuthorized: only a reply from the named authorizer resumes; any other replier is inert", () => {
  const wrongParty = isHumanHoldResumeAuthorized(["MUSTER HUMAN-HOLD alice 2026-01-01T08:05:00Z authorizer=bob", "REPLY carol: looks fine to me"]);
  assert.equal(wrongParty.authorizer, "bob");
  assert.equal(wrongParty.resumed, false);
  const rightParty = isHumanHoldResumeAuthorized(["MUSTER HUMAN-HOLD alice 2026-01-01T08:05:00Z authorizer=bob", "REPLY bob: approved"]);
  assert.equal(rightParty.resumed, true);
});

test("isHumanHoldResumeAuthorized: no HUMAN-HOLD receipt at all -> no authorizer, not resumed", () => {
  const r = isHumanHoldResumeAuthorized(["REPLY bob: approved"]);
  assert.equal(r.authorizer, null);
  assert.equal(r.resumed, false);
});
