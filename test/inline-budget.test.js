import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, writeFileSync, utimesSync, rmSync, symlinkSync, statSync,
  readFileSync as readFileSyncRaw,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  DEFAULT_SCALE,
  CROSSING_MAX_AGE_MS,
  DEFAULT_INVITE_COOLDOWN_MS,
  scaleThreshold,
  safeSession,
  isCrossingStale,
  cumFile,
  directiveFile,
  readCum,
  resetCum,
  recordCum,
  markNudged,
  cooldownFile,
  inviteCooldownMs,
  isInCooldown,
  recordInvite,
  isScaleCorroborated,
  corroboratingCount,
  resolveNow,
  markDirective,
} from "../plugin/hooks/inline-budget.js";

// Direct unit coverage for inline-budget.js — the spawnHook integration tests
// (test/hook-pre-tool-use-scale.test.js, test/hook-user-prompt-submit.test.js)
// only exercise these indirectly.

function tmpFile() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-ib-test-"));
  return { dir, file: path.join(dir, "state") };
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

test("scaleThreshold: decimal '2.9' is not an integer and falls back to default", () => {
  assert.equal(scaleThreshold({ MUSTER_INLINE_SCALE: "2.9" }), DEFAULT_SCALE);
});

// ── safeSession ─────────────────────────────────────────────────────────────
test("safeSession: keeps word chars, null on empty/unusable", () => {
  assert.equal(safeSession("abc-123_XY"), "abc-123_XY");
  assert.equal(safeSession("a/b c.d"), "abcd");
  assert.equal(safeSession("!!!"), null);
  assert.equal(safeSession(""), null);
  assert.equal(safeSession(undefined), null);
  assert.equal(safeSession(42), null);
});

// ── cumFile / directiveFile ─────────────────────────────────────────────────
test("cumFile: null for an all-punctuation session id", () => {
  assert.equal(cumFile("!!!"), null);
  assert.equal(cumFile(undefined), null);
});

test("cumFile: builds a muster-cum-<safe> path under tmp", () => {
  assert.equal(cumFile("sess-1", "/tmp"), path.join("/tmp", "muster-cum-sess-1"));
});

test("directiveFile: builds a muster-directive-<safe> path under tmp, distinct from cumFile", () => {
  assert.equal(directiveFile("sess-1", "/tmp"), path.join("/tmp", "muster-directive-sess-1"));
  assert.notEqual(directiveFile("sess-1", "/tmp"), cumFile("sess-1", "/tmp"));
});

// ── isCrossingStale: the shared per-crossing/age-reset rule ─────────────────
test("isCrossingStale: no prior marker (non-number mtime) is never stale", () => {
  assert.equal(isCrossingStale(null), false);
  assert.equal(isCrossingStale(undefined), false);
  assert.equal(isCrossingStale(NaN), false);
});

test("isCrossingStale: exactly at the boundary is not yet stale; just past it is", () => {
  const now = 1_000_000_000;
  assert.equal(isCrossingStale(now - CROSSING_MAX_AGE_MS, now), false, "exactly at boundary: not stale");
  assert.equal(isCrossingStale(now - CROSSING_MAX_AGE_MS - 1, now), true, "1ms past boundary: stale");
});

test("isCrossingStale: recent activity is not stale", () => {
  const now = 1_000_000_000;
  assert.equal(isCrossingStale(now - 1000, now), false);
});

// ── readCum / resetCum ───────────────────────────────────────────────────────
test("readCum: missing file -> empty shape", () => {
  const { dir, file } = tmpFile();
  try {
    assert.deepEqual(readCum(file), { files: [], nudged: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readCum: corrupt JSON -> empty shape, never throws", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, "{{{ not json");
    assert.deepEqual(readCum(file), { files: [], nudged: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readCum: filters non-string file entries, coerces nudged to boolean", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify({ files: ["a", 42, null, "b"], nudged: "yes" }));
    assert.deepEqual(readCum(file), { files: ["a", "b"], nudged: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resetCum: (re)writes the empty shape, tolerates an unwritable path", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify({ files: ["a.js"], nudged: true }));
    resetCum(file);
    assert.deepEqual(readCum(file), { files: [], nudged: false });
    assert.doesNotThrow(() => resetCum(dir), "resetCum on an unwritable (directory) path must not throw");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── recordCum ────────────────────────────────────────────────────────────────
test("recordCum: distinct keys raise the count; duplicates do not", () => {
  const { dir, file } = tmpFile();
  try {
    assert.deepEqual(recordCum(file, "a.js"), { count: 1, nudged: false });
    assert.deepEqual(recordCum(file, "b.js"), { count: 2, nudged: false });
    assert.deepEqual(recordCum(file, "a.js"), { count: 2, nudged: false }, "re-adding a.js does not raise the count");
    assert.deepEqual(recordCum(file, "c.js"), { count: 3, nudged: false });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordCum + markNudged: nudged flag persists across subsequent recordCum calls", () => {
  const { dir, file } = tmpFile();
  try {
    recordCum(file, "a.js");
    recordCum(file, "b.js");
    recordCum(file, "c.js");
    markNudged(file);
    assert.deepEqual(recordCum(file, "d.js"), { count: 4, nudged: true }, "nudged stays true once marked");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordCum: a fresh crossing (stale mtime) discards prior state instead of accumulating", () => {
  const { dir, file } = tmpFile();
  try {
    writeFileSync(file, JSON.stringify({ files: ["old-a.js", "old-b.js"], nudged: true }));
    const stale = new Date(Date.now() - (CROSSING_MAX_AGE_MS + 60_000));
    utimesSync(file, stale, stale);

    const result = recordCum(file, "new.js");
    assert.deepEqual(result, { count: 1, nudged: false }, "stale crossing re-arms: old files/nudged discarded");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordCum: fresh (non-stale) mtime accumulates normally, does not reset", () => {
  const { dir, file } = tmpFile();
  try {
    recordCum(file, "a.js");
    const recent = new Date(Date.now() - 1000);
    utimesSync(file, recent, recent);
    assert.deepEqual(recordCum(file, "b.js"), { count: 2, nudged: false }, "recent activity: still accumulates");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── symlink hardening (CWE-59): marker writes must not follow a planted symlink ──
// The marker path lives in a shared, world-writable tmpdir (os.tmpdir()) keyed
// only by a sanitized session id -- a co-resident, less-privileged process on
// the same host can plant a symlink at that exact path before muster's hook
// ever runs. A naive writeFileSync(file, ...) follows a symlink at `file` and
// truncates/overwrites whatever it points to. Every marker writer (resetCum,
// recordCum, markNudged) must refuse to follow it: the planted symlink's
// target must come out untouched. One test, looped over all three writers,
// per review-gate direction to add exactly one new regression test here.
test("marker writers (recordCum/resetCum/markNudged/recordInvite): a symlink planted at the marker path is never followed (CWE-59)", () => {
  const writers = {
    recordCum: (file) => recordCum(file, "a.js"),
    resetCum: (file) => resetCum(file),
    markNudged: (file) => markNudged(file),
    recordInvite: (file) => recordInvite(file),
  };
  for (const [name, write] of Object.entries(writers)) {
    const { dir, file } = tmpFile();
    const outsideDir = mkdtempSync(path.join(os.tmpdir(), "muster-ib-victim-"));
    const victim = path.join(outsideDir, "victim.txt");
    try {
      writeFileSync(victim, "untouched");
      symlinkSync(victim, file); // plant the symlink where the marker would live
      write(file);
      assert.equal(
        readFileSyncRaw(victim, "utf8"),
        "untouched",
        `${name}: planted symlink target must never be written through`,
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(outsideDir, { recursive: true, force: true });
    }
  }
});

// ── inviteCooldownMs / cooldownFile ─────────────────────────────────────────
test("inviteCooldownMs: unset falls back to DEFAULT_INVITE_COOLDOWN_MS", () => {
  assert.equal(inviteCooldownMs({}), DEFAULT_INVITE_COOLDOWN_MS);
});

test("inviteCooldownMs: a valid override is honored, including 0 (disables cooldown)", () => {
  assert.equal(inviteCooldownMs({ MUSTER_INVITE_COOLDOWN_MS: "0" }), 0);
  assert.equal(inviteCooldownMs({ MUSTER_INVITE_COOLDOWN_MS: "60000" }), 60000);
});

test("inviteCooldownMs: junk/negative falls back to default", () => {
  for (const v of ["-1", "abc", "2.9", ""]) {
    assert.equal(inviteCooldownMs({ MUSTER_INVITE_COOLDOWN_MS: v }), DEFAULT_INVITE_COOLDOWN_MS, `"${v}" -> default`);
  }
});

test("cooldownFile: null for an all-punctuation session id, distinct path from cumFile/directiveFile", () => {
  assert.equal(cooldownFile("!!!"), null);
  assert.equal(cooldownFile("sess-1", "/tmp"), path.join("/tmp", "muster-cooldown-sess-1"));
  assert.notEqual(cooldownFile("sess-1", "/tmp"), cumFile("sess-1", "/tmp"));
  assert.notEqual(cooldownFile("sess-1", "/tmp"), directiveFile("sess-1", "/tmp"));
});

// ── isInCooldown / recordInvite: the hysteresis shared by both signals ─────
test("isInCooldown: no marker yet (nothing invited) is never in cooldown", () => {
  const { dir, file } = tmpFile();
  try {
    assert.equal(isInCooldown(file), false);
    assert.equal(isInCooldown(null), false, "null file (unusable session id) is never in cooldown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isInCooldown: a just-recorded invite is in cooldown; past the window it is not", () => {
  const { dir, file } = tmpFile();
  try {
    recordInvite(file);
    const now = Date.now();
    const { mtimeMs } = statSync(file);
    assert.equal(isInCooldown(file, mtimeMs + 1000, {}), true, "1s after the invite: still in cooldown");
    assert.equal(
      isInCooldown(file, mtimeMs + DEFAULT_INVITE_COOLDOWN_MS + 1, {}),
      false,
      "just past the cooldown window: no longer in cooldown",
    );
    assert.ok(now >= mtimeMs, "sanity: recordInvite's mtime is not in the future");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("isInCooldown: MUSTER_INVITE_COOLDOWN_MS=0 disables the cooldown outright", () => {
  const { dir, file } = tmpFile();
  try {
    recordInvite(file);
    assert.equal(isInCooldown(file, Date.now(), { MUSTER_INVITE_COOLDOWN_MS: "0" }), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordInvite: a null file is a safe no-op", () => {
  assert.doesNotThrow(() => recordInvite(null));
});

// ── isScaleCorroborated: directive verb shape needs corroborating drift ────
test("isScaleCorroborated: zero prior files is never corroborated (the trivial one-file-turn case)", () => {
  assert.equal(isScaleCorroborated(0), false);
});

test("isScaleCorroborated: one or more prior files corroborates", () => {
  assert.equal(isScaleCorroborated(1), true);
  assert.equal(isScaleCorroborated(5), true);
});

test("isScaleCorroborated: non-number/NaN inputs are never corroborated (fail-safe)", () => {
  for (const v of [undefined, null, NaN, "1", {}]) {
    assert.equal(isScaleCorroborated(v), false, `${String(v)} -> not corroborated`);
  }
});

// ── corroboratingCount: the crossing-scoped count isScaleCorroborated checks ─
// Review-gate fix: a raw readCum(file).files.length ignores the file's own
// mtime, so a dead prior crossing's leftover count could wrongly corroborate
// a brand-new directive. corroboratingCount applies the same isCrossingStale
// rule recordCum itself uses before counting.
test("corroboratingCount: missing/null file -> 0", () => {
  const { dir, file } = tmpFile();
  try {
    assert.equal(corroboratingCount(file), 0, "no file yet -> 0");
    assert.equal(corroboratingCount(null), 0, "null file -> 0");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corroboratingCount: a fresh (non-stale) crossing returns its real count", () => {
  const { dir, file } = tmpFile();
  try {
    recordCum(file, "a.js");
    recordCum(file, "b.js");
    assert.equal(corroboratingCount(file), 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corroboratingCount: a STALE crossing (mtime past CROSSING_MAX_AGE_MS) returns 0, not its leftover count", () => {
  const { dir, file } = tmpFile();
  try {
    recordCum(file, "a.js");
    const stale = new Date(Date.now() - (CROSSING_MAX_AGE_MS + 60_000));
    utimesSync(file, stale, stale);
    assert.equal(
      corroboratingCount(file),
      0,
      "a dead prior crossing's leftover file count must never corroborate a new directive",
    );
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("corroboratingCount: exactly at the staleness boundary is not yet stale", () => {
  const { dir, file } = tmpFile();
  try {
    recordCum(file, "a.js");
    // Backdate the marker, then read the ACTUAL stored mtime -- filesystems round
    // mtime (second precision on some FSes), so the stored value differs from what
    // we wrote. Anchoring `now` to the stored mtime + CROSSING_MAX_AGE_MS puts us
    // EXACTLY at the boundary regardless of fs precision; isCrossingStale uses `>`
    // (strict), so exactly-at-boundary is not yet stale. (Deriving `now` from the
    // written value instead let fs rounding push it a hair past the boundary -- the
    // CI flake this replaces.)
    const anchor = Date.now() - CROSSING_MAX_AGE_MS;
    utimesSync(file, new Date(anchor), new Date(anchor));
    const now = statSync(file).mtimeMs + CROSSING_MAX_AGE_MS;
    assert.equal(corroboratingCount(file, now), 1, "exactly at the boundary: still counts");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── resolveNow: the injectable clock (MUSTER_TEST_NOW_MS test hook) ────────
//
// isCrossingStale/isInCooldown/corroboratingCount/recordCum already take an
// explicit `now`, defaulting to Date.now() -- the remaining wall-time
// dependence was the HOOK PROCESSES (pre-tool-use.js/user-prompt-submit.js)
// each independently calling Date.now() at whatever real instant they
// happened to run, with no fixed relationship to a test's own real-clock-
// relative fixture (e.g. a marker mtime backdated via utimesSync against
// Date.now() at fixture-build time) once spawned as a separate child
// process. resolveNow() gives every call site ONE injectable clock:
// MUSTER_TEST_NOW_MS (an integer epoch-ms string) wins over Date.now() when
// present and finite; absent -- the only path production ever takes -- it's
// plain Date.now(), unchanged behavior.
test("resolveNow: no override falls back to the real clock", () => {
  const before = Date.now();
  const now = resolveNow({});
  const after = Date.now();
  assert.ok(now >= before && now <= after, "falls back to Date.now() when unset");
});

test("resolveNow: MUSTER_TEST_NOW_MS overrides the clock exactly", () => {
  assert.equal(resolveNow({ MUSTER_TEST_NOW_MS: "1700000000000" }), 1_700_000_000_000);
});

test("resolveNow: junk/negative/empty MUSTER_TEST_NOW_MS falls back to the real clock, never NaN", () => {
  const before = Date.now();
  for (const v of ["abc", "-5", "2.9", ""]) {
    const now = resolveNow({ MUSTER_TEST_NOW_MS: v });
    assert.ok(Number.isFinite(now) && now >= before, `"${v}" -> falls back to the real clock, not NaN/garbage`);
  }
});

// ── writer functions stamp the marker's mtime to an explicit `now` ─────────
//
// Every marker writer below now takes the same injectable `now` (default
// Date.now()) and stamps the marker's mtime to EXACTLY that value after
// writing -- not whatever real OS write-time the filesystem would otherwise
// assign. This is what lets pre-tool-use.js/user-prompt-submit.js thread one
// resolveNow() reading through both the READ side (isCrossingStale/
// isInCooldown/corroboratingCount, already parameterized) and the WRITE
// side, so a test driving MUSTER_TEST_NOW_MS controls every mtime a hook
// invocation touches -- no real wall-clock race across the process boundary,
// regardless of how long the child actually takes to spawn.
test("recordCum: an explicit `now` stamps the marker's mtime exactly", () => {
  const { dir, file } = tmpFile();
  try {
    recordCum(file, "a.js", 1_700_000_000_000);
    assert.equal(statSync(file).mtimeMs, 1_700_000_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("markNudged: an explicit `now` stamps the marker's mtime exactly", () => {
  const { dir, file } = tmpFile();
  try {
    recordCum(file, "a.js", 1_700_000_000_000);
    markNudged(file, 1_700_000_060_000);
    assert.equal(statSync(file).mtimeMs, 1_700_000_060_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordInvite: an explicit `now` stamps the marker's mtime exactly", () => {
  const { dir, file } = tmpFile();
  try {
    recordInvite(file, 1_700_000_000_000);
    assert.equal(statSync(file).mtimeMs, 1_700_000_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("resetCum: an explicit `now` stamps the marker's mtime exactly", () => {
  const { dir, file } = tmpFile();
  try {
    resetCum(file, 1_700_000_000_000);
    assert.equal(statSync(file).mtimeMs, 1_700_000_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("markDirective: writes the marker and stamps its mtime exactly (UserPromptSubmit's writer, symlink-safe like the others)", () => {
  const { dir, file } = tmpFile();
  try {
    markDirective(file, 1_700_000_000_000);
    assert.equal(readFileSyncRaw(file, "utf8"), "1");
    assert.equal(statSync(file).mtimeMs, 1_700_000_000_000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("recordInvite: a null file is a safe no-op even with an explicit `now`", () => {
  assert.doesNotThrow(() => recordInvite(null, 1_700_000_000_000));
});

// ── clock-injection TDD: exact boundary, entirely test-controlled ─────────
// The point of resolveNow()/the writer stamps: a test can now drive
// isCrossingStale's exact boundary through the real recordCum call path
// using nothing but integers -- no utimesSync, no Date.now(), no real-clock
// race, regardless of --test-concurrency.
test("clock-injection TDD: recordCum's staleness check is driven entirely by an injected clock -- exact boundary, no wall-clock race", () => {
  const T0 = 1_700_000_000_000;
  {
    const { dir, file } = tmpFile();
    try {
      recordCum(file, "a.js", T0);
      assert.deepEqual(
        recordCum(file, "b.js", T0 + CROSSING_MAX_AGE_MS),
        { count: 2, nudged: false },
        "exactly at the boundary: still the same crossing",
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
  {
    const { dir, file } = tmpFile();
    try {
      recordCum(file, "a.js", T0);
      assert.deepEqual(
        recordCum(file, "b.js", T0 + CROSSING_MAX_AGE_MS + 1),
        { count: 1, nudged: false },
        "1ms past the boundary: a fresh crossing discards the prior state",
      );
    } finally { rmSync(dir, { recursive: true, force: true }); }
  }
});
