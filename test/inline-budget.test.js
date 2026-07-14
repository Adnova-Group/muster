import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, symlinkSync, statSync, readdirSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_SCALE,
  scaleThreshold,
  safeSession,
  budgetFile,
  readBudget,
  resetBudget,
  recordFile,
} from "../plugin/hooks/inline-budget.js";

// Direct unit coverage for inline-budget.js — the spawnHook integration tests
// only exercise these indirectly.

function tmpFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-ib-test-"));
  return { dir, file: path.join(dir, "budget") };
}

// ── scaleThreshold ──────────────────────────────────────────────────────────
test("scaleThreshold: unset falls back to DEFAULT_SCALE", () => {
  assert.equal(scaleThreshold({}), DEFAULT_SCALE);
});

test("scaleThreshold: a valid override > 1 is honored", () => {
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "2" }), 2);
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "5" }), 5);
});

test("scaleThreshold: 1, 0, negatives, and junk fall back to default (n>1 guard)", () => {
  for (const v of ["1", "0", "-3", "abc", ""]) {
    assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: v }), DEFAULT_SCALE, `"${v}" -> default`);
  }
});

test("scaleThreshold: decimal '2.9' is not an integer and falls back to default (CORE-1 fix)", () => {
  // Old behavior: parseInt truncated "2.9" -> 2 (silently wrong).
  // New behavior: envInt rejects non-integer strings via /^-?\d+$/ regex -> DEFAULT_SCALE.
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "2.9" }), DEFAULT_SCALE);
});

// ── safeSession ─────────────────────────────────────────────────────────────
test("safeSession: hashes the exact non-empty session id without collisions or disclosure", () => {
  assert.match(safeSession("abc-123_XY"), /^[a-f0-9]{64}$/);
  assert.notEqual(safeSession("a/b c.d"), safeSession("abcd"));
  assert.notEqual(safeSession("a/b"), safeSession("ab"));
  assert.match(safeSession("!!!"), /^[a-f0-9]{64}$/);
  assert.equal(safeSession(""), null);
  assert.equal(safeSession(undefined), null);
  assert.equal(safeSession(42), null);
});

// ── budgetFile ──────────────────────────────────────────────────────────────
test("budgetFile: null only for a missing or empty session id", () => {
  assert.match(budgetFile("!!!"), /muster-inline-[a-f0-9]{64}$/);
  assert.equal(budgetFile(undefined), null);
});

test("budgetFile: creates a private state directory and uses a hashed filename", (t) => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "muster-state-parent-"));
  t.after(() => rmSync(tmp, { recursive: true, force: true }));
  const file = budgetFile("sess-1", tmp);
  assert.equal(path.dirname(file).startsWith(tmp + path.sep), true);
  assert.match(path.basename(file), /^muster-inline-[a-f0-9]{64}$/);
  if (process.platform !== "win32") assert.equal(statSync(path.dirname(file)).mode & 0o077, 0, "state dir is private");
});

// ── readBudget ──────────────────────────────────────────────────────────────
test("readBudget: missing file -> []", () => {
  const { dir, file } = tmpFile();
  try {
    assert.deepEqual(readBudget(file), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readBudget: valid-JSON-but-not-array -> [] (corrupt state resets)", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify({ files: [] }));
    assert.deepEqual(readBudget(file), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readBudget: filters non-string entries", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify(["a", 42, null, "b", { x: 1 }]));
    assert.deepEqual(readBudget(file), ["a", "b"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── recordFile + resetBudget ────────────────────────────────────────────────
test("recordFile: distinct targets raise the count; duplicates do not", () => {
  const { dir, file } = tmpFile();
  try {
    assert.equal(recordFile(file, "a.js"), 1);
    assert.equal(recordFile(file, "b.js"), 2);
    assert.equal(recordFile(file, "a.js"), 2, "re-adding a.js does not increase count");
    assert.equal(recordFile(file, "c.js"), 3);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resetBudget: clears the set back to empty", () => {
  const { dir, file } = tmpFile();
  try {
    recordFile(file, "a.js");
    recordFile(file, "b.js");
    resetBudget(file);
    assert.deepEqual(readBudget(file), []);
    assert.equal(recordFile(file, "x.js"), 1, "count restarts at 1 after reset");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resetBudget: tolerates an unwritable path (best-effort, no throw)", () => {
  // A directory path can't be written as a file; must not throw.
  const { dir } = tmpFile();
  try {
    assert.doesNotThrow(() => resetBudget(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
  assert.ok(!existsSync(path.join(dir, "nope")));
});

test("state reads and replacements reject a symlink file without touching its victim", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-ib-symlink-"));
  const victim = path.join(dir, "victim");
  const file = path.join(dir, "budget");
  writeFileSync(victim, JSON.stringify(["secret"]));
  try { symlinkSync(victim, file); }
  catch (error) { rmSync(dir, { recursive: true, force: true }); t.skip(`symlinks unavailable: ${error.code}`); return; }
  try {
    assert.deepEqual(readBudget(file), []);
    resetBudget(file);
    assert.equal(readFileSync(victim, "utf8"), JSON.stringify(["secret"]));
    assert.equal(readdirSync(dir).some((name) => name.includes(".muster-tmp-")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
