import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWinner } from "../src/tournament.js";

test("highest passing total wins", () => {
  const r = pickWinner([
    { id: "a", total: 7, passing: true },
    { id: "b", total: 9, passing: true },
    { id: "c", total: 10, passing: false }
  ]);
  assert.equal(r.winner, "b");
  assert.equal(r.escalate, false);
  assert.deepEqual(r.ranking.map(x => x.id), ["c", "b", "a"]);
});

test("none passing -> escalate, no winner", () => {
  const r = pickWinner([{ id: "a", total: 3, passing: false }, { id: "b", total: 4, passing: false }]);
  assert.equal(r.winner, null);
  assert.equal(r.escalate, true);
});

test("empty -> escalate", () => {
  assert.deepEqual(pickWinner([]), { winner: null, escalate: true, ranking: [] });
});

test("ties broken by id ascending", () => {
  const r = pickWinner([
    { id: "zeta", total: 8, passing: true },
    { id: "alpha", total: 8, passing: true }
  ]);
  assert.equal(r.winner, "alpha");
});

// CORE-2 — Array.isArray guard
test("pickWinner: plain object returns clean escalation, no throw", () => {
  const r = pickWinner({});
  assert.equal(r.winner, null);
  assert.equal(r.escalate, true);
  assert.deepEqual(r.ranking, []);
});

test("pickWinner: null returns clean escalation, no throw", () => {
  const r = pickWinner(null);
  assert.equal(r.winner, null);
  assert.equal(r.escalate, true);
  assert.deepEqual(r.ranking, []);
});

test("pickWinner: scalar (number) returns clean escalation, no throw", () => {
  const r = pickWinner(42);
  assert.equal(r.winner, null);
  assert.equal(r.escalate, true);
  assert.deepEqual(r.ranking, []);
});
