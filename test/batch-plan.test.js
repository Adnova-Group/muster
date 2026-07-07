import { test } from "node:test";
import assert from "node:assert/strict";
import { parseBacklogRef, crossItemConflicts } from "../src/batch-plan.js";

// --- parseBacklogRef: run.md step 0b's batch-ref grammar --------------------------------
// Mirrors sprint.md step 1's three source forms (file / issues:<label> / linear:<key>),
// plus the "everything else is an outcome" default that keeps /muster:run's single-outcome
// path byte-identical for plain outcomes.

test("parseBacklogRef: .muster/backlog.md is a file ref", () => {
  assert.deepEqual(parseBacklogRef(".muster/backlog.md"), { kind: "file", path: ".muster/backlog.md" });
});

test("parseBacklogRef: any single whitespace-free .md token is a file ref", () => {
  assert.deepEqual(parseBacklogRef("docs/sprint-backlog.md"), { kind: "file", path: "docs/sprint-backlog.md" });
});

test("parseBacklogRef: surrounding whitespace is trimmed off a file ref", () => {
  assert.deepEqual(parseBacklogRef("  .muster/backlog.md  "), { kind: "file", path: ".muster/backlog.md" });
});

test("parseBacklogRef: issues:<label> is an issues ref, label verbatim", () => {
  assert.deepEqual(parseBacklogRef("issues:sprint-1"), { kind: "issues", label: "sprint-1" });
});

test("parseBacklogRef: linear:<key> is a linear ref, key verbatim", () => {
  assert.deepEqual(parseBacklogRef("linear:MUS"), { kind: "linear", key: "MUS" });
});

test("parseBacklogRef: issues: with an empty label is invalid, not a silent outcome", () => {
  const r = parseBacklogRef("issues:");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /issues/);
});

test("parseBacklogRef: linear: with an empty key is invalid, not a silent outcome", () => {
  const r = parseBacklogRef("linear:  ");
  assert.equal(r.kind, "invalid");
  assert.match(r.reason, /linear/);
});

test("parseBacklogRef: a plain outcome is an outcome", () => {
  assert.deepEqual(parseBacklogRef("Add dark mode toggle to the settings page"), { kind: "outcome" });
});

test("parseBacklogRef: an outcome MENTIONING a .md file is still an outcome (whitespace present)", () => {
  assert.deepEqual(parseBacklogRef("Fix the broken links in README.md"), { kind: "outcome" });
});

test("parseBacklogRef: an issue ref stays an outcome here (run.md step 0 owns issue refs)", () => {
  assert.deepEqual(parseBacklogRef("#42"), { kind: "outcome" });
});

test("parseBacklogRef: empty and non-string inputs are outcomes (run.md's empty-guard fires first)", () => {
  assert.deepEqual(parseBacklogRef(""), { kind: "outcome" });
  assert.deepEqual(parseBacklogRef("   "), { kind: "outcome" });
  assert.deepEqual(parseBacklogRef(undefined), { kind: "outcome" });
});

// --- crossItemConflicts: the batch plan's advisory cross-item file-conflict flags --------
// Deliberately ADVISORY, never a gate: manifest fences stay opaque path labels
// (validateManifest does no glob matching; disjointness stays orchestrator judgment).
// This function only surfaces prefix-shaped overlaps for the human to weigh at the
// batch-plan approval stop.

test("crossItemConflicts: identical owns labels across two items are flagged", () => {
  const r = crossItemConflicts([
    { id: "a", owns: ["src/auth/**"] },
    { id: "b", owns: ["src/auth/**"] },
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].a, "a");
  assert.equal(r.conflicts[0].b, "b");
  assert.deepEqual(r.unfenced, []);
});

test("crossItemConflicts: a glob prefix covering another item's file is flagged", () => {
  const r = crossItemConflicts([
    { id: "auth", owns: ["src/auth/**", "test/auth/**"] },
    { id: "sessions", owns: ["src/auth/session.js"] },
    { id: "docs", owns: ["docs/**"] },
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([r.conflicts[0].a, r.conflicts[0].b], ["auth", "sessions"]);
  assert.ok(r.conflicts[0].overlaps.length >= 1);
});

test("crossItemConflicts: disjoint trees produce no flags", () => {
  const r = crossItemConflicts([
    { id: "retry", owns: ["src/fetch/retry.js"] },
    { id: "logging", owns: ["src/logging/**"] },
  ]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.unfenced, []);
});

test("crossItemConflicts: a sibling name that merely shares a string prefix is NOT flagged", () => {
  // 'src/auth' vs 'src/auth-tokens' share a string prefix but not a path boundary.
  const r = crossItemConflicts([
    { id: "a", owns: ["src/auth/**"] },
    { id: "b", owns: ["src/auth-tokens/**"] },
  ]);
  assert.deepEqual(r.conflicts, []);
});

test("crossItemConflicts: an item with no owns is reported unfenced, never flagged", () => {
  const r = crossItemConflicts([
    { id: "retry", owns: ["src/fetch/**"] },
    { id: "metrics", owns: [] },
    { id: "docs" },
  ]);
  assert.deepEqual(r.conflicts, []);
  assert.deepEqual(r.unfenced, ["metrics", "docs"]);
});

test("crossItemConflicts: a bare '**' owns everything and conflicts with any fenced item", () => {
  const r = crossItemConflicts([
    { id: "sweep", owns: ["**"] },
    { id: "docs", owns: ["docs/**"] },
  ]);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual([r.conflicts[0].a, r.conflicts[0].b], ["sweep", "docs"]);
});

test("crossItemConflicts: pair order follows input order and each pair appears once", () => {
  const r = crossItemConflicts([
    { id: "one", owns: ["shared/**"] },
    { id: "two", owns: ["shared/a.js"] },
    { id: "three", owns: ["shared/b.js"] },
  ]);
  assert.deepEqual(
    r.conflicts.map((c) => [c.a, c.b]),
    [["one", "two"], ["one", "three"]]
  );
});

test("crossItemConflicts: non-array input degrades to empty results, never throws", () => {
  assert.deepEqual(crossItemConflicts(undefined), { conflicts: [], unfenced: [] });
  assert.deepEqual(crossItemConflicts("nope"), { conflicts: [], unfenced: [] });
});
