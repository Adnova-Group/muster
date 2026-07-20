import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import {
  cleanDir, makeRunActive,
  editPayload as editPayloadBase, spawnHook, uniqueSid,
} from "./test-support/hook-helpers.js";
import { cumFile, readCum, CROSSING_MAX_AGE_MS, cooldownFile, DEFAULT_INVITE_COOLDOWN_MS } from "../plugin/hooks/inline-budget.js";

// The border invitation, PreToolUse half (see pre-tool-use.js docblock and
// guidance.js: CREW_INVITATION): a cumulative distinct-inline-file counter
// warns ONCE PER CROSSING once the running total (with no muster run active)
// reaches MUSTER_INLINE_SCALE, then stays silent until re-armed by a muster
// run starting, SessionStart, or 60 minutes of inactivity. NEVER a deny — the
// action-class fence (hook-pre-tool-use-action-fence.test.js) is the only
// deny surface left in this hook.

const HOOKDIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
);
const PRE = path.join(HOOKDIR, "pre-tool-use.js");

function runPre(stdinText, env = {}) {
  return spawnHook(PRE, stdinText, env);
}

// A working dir with .muster/ present but no run-active.
function noRunDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-border-test-"));
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  return dir;
}

function editPayload(filePath, cwd, sessionId, extra = {}) {
  return editPayloadBase(filePath, cwd, { session_id: sessionId, ...extra });
}

function bashPayload(command, cwd, sessionId) {
  return JSON.stringify({
    tool_name: "Bash",
    tool_input: { command },
    cwd,
    session_id: sessionId,
  });
}

function clearCum(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  try { rmSync(path.join(os.tmpdir(), `muster-cum-${safe}`), { force: true }); } catch { /* ignore */ }
  // Also clear the shared invite-cooldown marker (inline-budget.js:
  // cooldownFile) -- otherwise a prior run of this suite using the same
  // fixed session id string could leave a fresh cooldown marker behind and
  // suppress an invite this run legitimately expects.
  try { rmSync(path.join(os.tmpdir(), `muster-cooldown-${safe}`), { force: true }); } catch { /* ignore */ }
}

// Build the MUSTER_TEST_NOW_MS env override (see inline-budget.js:
// resolveNow) for a given instant `t`. Used by the two timing-sensitive
// tests below (flapping/age-reset) to drive staleness/cooldown boundaries
// with an explicit, test-controlled clock instead of racing the real wall
// clock across the spawned-hook-process boundary under --test-concurrency.
function nowEnv(t) {
  return { MUSTER_TEST_NOW_MS: String(t) };
}

function out(stdout) {
  return JSON.parse(stdout).hookSpecificOutput;
}

function decision(stdout) {
  return out(stdout).permissionDecision;
}

// ── core: 1st & 2nd allowed silently, 3rd crosses the border and warns once ──
test("no run active: 1st & 2nd distinct files silent, 3rd crosses the border and warns with value-toned copy", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-core-1");
  clearCum(sid);
  try {
    const a = await runPre(editPayload(path.join(dir, "src", "a.js"), dir, sid));
    const b = await runPre(editPayload(path.join(dir, "src", "b.js"), dir, sid));
    const c = await runPre(editPayload(path.join(dir, "src", "c.js"), dir, sid));

    assert.notEqual(decision(a.stdout), "deny", "1st file never denied");
    assert.notEqual(decision(b.stdout), "deny", "2nd file never denied");
    assert.notEqual(decision(c.stdout), "deny", "3rd file never denied (warn-only surface)");

    assert.ok(!("additionalContext" in out(a.stdout)), "1st file silent");
    assert.ok(!("additionalContext" in out(b.stdout)), "2nd file silent");

    const ctx = out(c.stdout).additionalContext;
    assert.ok(ctx, "3rd distinct file crosses the border and warns");
    assert.match(ctx, /parallel dispatch/i, "value copy: parallel dispatch");
    assert.match(ctx, /adversarial review/i, "value copy: adversarial review");
    assert.match(ctx, /receipts/i, "value copy: receipts trail");
    assert.match(ctx, /\/muster:go\b/, "warn names the verb");
    assert.match(ctx, /3/, "warn names the count");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

test("no run active: 4th distinct file in the same crossing stays silent (warned once)", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-core-2");
  clearCum(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid));
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, sid));
    const d = await runPre(editPayload(path.join(dir, "d.js"), dir, sid));

    assert.ok(out(c.stdout).additionalContext, "3rd file warns");
    assert.notEqual(decision(d.stdout), "deny", "4th file never denied");
    assert.ok(!("additionalContext" in out(d.stdout)), "4th file in the same crossing is silent");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── re-editing the same file never advances the count ───────────────────────
test("re-editing the same file never advances the cumulative count or warns", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-same-1");
  clearCum(sid);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await runPre(editPayload(path.join(dir, "only.js"), dir, sid));
      assert.notEqual(decision(r.stdout), "deny", `edit #${i + 1} never denied`);
      assert.ok(!("additionalContext" in out(r.stdout)), `edit #${i + 1} to the same file never crosses the border`);
    }
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── subagent edits are exempt and never counted ─────────────────────────────
test("subagent (agent_id) edits are never denied and never counted toward the border", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-sub-1");
  clearCum(sid);
  try {
    for (let i = 0; i < 4; i++) {
      const r = await runPre(editPayload(path.join(dir, `s${i}.js`), dir, sid, { agent_id: "sub-x" }));
      assert.notEqual(decision(r.stdout), "deny");
      assert.ok(!("additionalContext" in out(r.stdout)), "subagent edit never crosses the border");
    }
    const m1 = await runPre(editPayload(path.join(dir, "m1.js"), dir, sid));
    const m2 = await runPre(editPayload(path.join(dir, "m2.js"), dir, sid));
    assert.ok(!("additionalContext" in out(m1.stdout)));
    assert.ok(!("additionalContext" in out(m2.stdout)), "subagent edits didn't consume the border count");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── .muster/ writes are exempt (STATE bookkeeping) ──────────────────────────
test(".muster/ edits never count toward the border", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-muster-1");
  clearCum(sid);
  try {
    for (let i = 0; i < 4; i++) {
      const r = await runPre(editPayload(`.muster/note-${i}.md`, dir, sid));
      assert.notEqual(decision(r.stdout), "deny");
      assert.ok(!("additionalContext" in out(r.stdout)));
    }
    const m1 = await runPre(editPayload(path.join(dir, "x.js"), dir, sid));
    const m2 = await runPre(editPayload(path.join(dir, "y.js"), dir, sid));
    assert.ok(!("additionalContext" in out(m1.stdout)));
    assert.ok(!("additionalContext" in out(m2.stdout)), ".muster/ edits didn't consume the border count");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── missing/unusable session_id fails open (no tracking, no warn) ──────────
test("absent session_id: no tracking, no warn (fail-open)", async () => {
  const dir = noRunDir();
  try {
    const p = (f) => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: f }, cwd: dir });
    await runPre(p(path.join(dir, "a.js")));
    await runPre(p(path.join(dir, "b.js")));
    const c = await runPre(p(path.join(dir, "c.js")));
    assert.notEqual(decision(c.stdout), "deny");
    assert.ok(!("additionalContext" in out(c.stdout)), "no session id => never crosses the border");
  } finally {
    cleanDir(dir);
  }
});

test("all-punctuation session_id: no tracking, no warn (fail-open)", async () => {
  const dir = noRunDir();
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, "!!!"));
    await runPre(editPayload(path.join(dir, "b.js"), dir, "!!!"));
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, "!!!"));
    assert.notEqual(decision(c.stdout), "deny");
    assert.ok(!("additionalContext" in out(c.stdout)), "unusable session id => never crosses the border");
  } finally {
    cleanDir(dir);
  }
});

// ── Bash escape hatch is closed: shell writes count toward the border ──────
test("a high-confidence Bash file write counts toward the border (not an escape hatch)", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-bash-1");
  clearCum(sid);
  try {
    const a = await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    const b = await runPre(editPayload(path.join(dir, "b.js"), dir, sid));
    const c = await runPre(bashPayload("echo hi > /proj/c.js", dir, sid));
    assert.ok(!("additionalContext" in out(a.stdout)));
    assert.ok(!("additionalContext" in out(b.stdout)));
    assert.ok(out(c.stdout).additionalContext, "3rd distinct mutation via shell write still crosses the border");
    assert.notEqual(decision(c.stdout), "deny");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

test("distinct sed -i targets each consume a border slot (no key-collapse)", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-sedi-1");
  clearCum(sid);
  try {
    await runPre(bashPayload("sed -i 's/x/y/' /proj/a.js", dir, sid));
    await runPre(bashPayload("sed -i 's/x/y/' /proj/b.js", dir, sid));
    const c = await runPre(bashPayload("sed -i 's/x/y/' /proj/c.js", dir, sid));
    assert.ok(out(c.stdout).additionalContext, "3rd distinct sed -i target crosses the border");
    assert.notEqual(decision(c.stdout), "deny");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

test("mixed Edit + Bash write reach the border together", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-mixed-1");
  clearCum(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    await runPre(bashPayload("sed -i 's/a/b/' /proj/b.js", dir, sid));
    const c = await runPre(bashPayload("sed -i 's/a/b/' /proj/c.js", dir, sid));
    assert.ok(out(c.stdout).additionalContext, "editor + shell writes share one border count");
    assert.notEqual(decision(c.stdout), "deny");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

test("read-only Bash never counts toward the border and never denies", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-bash-2");
  clearCum(sid);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await runPre(bashPayload(`ls -la /proj/dir${i}`, dir, sid));
      assert.notEqual(decision(r.stdout), "deny");
      assert.ok(!("additionalContext" in out(r.stdout)));
    }
    const m1 = await runPre(editPayload(path.join(dir, "x.js"), dir, sid));
    const m2 = await runPre(editPayload(path.join(dir, "y.js"), dir, sid));
    assert.ok(!("additionalContext" in out(m1.stdout)));
    assert.ok(!("additionalContext" in out(m2.stdout)), "read-only bash never consumed the border count");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

test("a Bash write to an EXEMPT target (/tmp) never counts toward the border", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-exempt-1");
  clearCum(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid));
    const t = await runPre(bashPayload("echo hi > /tmp/out.txt", dir, sid));
    assert.ok(!("additionalContext" in out(t.stdout)), "/tmp write is exempt, doesn't cross the border");
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, sid));
    assert.ok(out(c.stdout).additionalContext, "the real 3rd distinct file still crosses the border");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── MUSTER_INLINE_SCALE overrides the border threshold ──────────────────────
test("MUSTER_INLINE_SCALE=2 crosses the border at the 2nd distinct file", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-env-1");
  clearCum(sid);
  try {
    const a = await runPre(editPayload(path.join(dir, "a.js"), dir, sid), { MUSTER_INLINE_SCALE: "2" });
    const b = await runPre(editPayload(path.join(dir, "b.js"), dir, sid), { MUSTER_INLINE_SCALE: "2" });
    assert.ok(!("additionalContext" in out(a.stdout)), "1st file silent");
    assert.ok(out(b.stdout).additionalContext, "2nd file crosses the border at threshold 2");
    assert.notEqual(decision(b.stdout), "deny");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── a live muster run resets the cumulative counter and doesn't record ─────
test("a live muster run resets the cumulative counter and doesn't record", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-run-1");
  clearCum(sid);
  const cFile = cumFile(sid, os.tmpdir());
  writeFileSync(cFile, JSON.stringify({ files: ["x.js", "y.js"], nudged: false }));
  makeRunActive(dir);
  try {
    const r = await runPre(editPayload(path.join(dir, "z.js"), dir, sid));
    assert.notEqual(decision(r.stdout), "deny");
    assert.ok(!("additionalContext" in out(r.stdout)), "no border warning while a muster run is active");
    assert.deepEqual(
      readCum(cFile),
      { files: [], nudged: false },
      "cumulative file reset while a muster run is active",
    );
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── flapping: hysteresis/cooldown absorbs a noisy, rapidly-re-arming border ─
//
// Driven by an explicit, test-controlled clock (see nowEnv() above /
// inline-budget.js: resolveNow) rather than real elapsed wall time: every
// spawned hook call below is pinned to `clock`, and "once the cooldown
// genuinely elapses" is simply advancing that integer, not waiting or
// backdating a marker against Date.now() and hoping a later child process's
// own real-clock read lands far enough past it.
test("flapping: a run restart re-arms the crossing immediately, but the shared cooldown absorbs the repeat fire", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-flap-1");
  clearCum(sid);
  let clock = 1_700_000_000_000; // arbitrary fixed instant; entirely test-controlled
  try {
    // First crossing: three distinct files, no run active -> warns once and
    // starts the shared invite cooldown.
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid), nowEnv(clock));
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid), nowEnv(clock));
    const first = await runPre(editPayload(path.join(dir, "c.js"), dir, sid), nowEnv(clock));
    assert.ok(out(first.stdout).additionalContext, "sanity: first crossing warns");

    // A muster run starts (resets the counter -- a fresh crossing) and stops
    // moments later (same instant on the injected clock): a noisy border
    // oscillating around the threshold via rapid restarts.
    makeRunActive(dir);
    await runPre(editPayload(path.join(dir, "reset-trigger.js"), dir, sid), nowEnv(clock));
    rmSync(path.join(dir, ".muster", "run-active"), { force: true });

    // The re-armed crossing crosses the border again -- without the
    // cooldown this would warn a second time at the same instant as the first.
    await runPre(editPayload(path.join(dir, "d.js"), dir, sid), nowEnv(clock));
    await runPre(editPayload(path.join(dir, "e.js"), dir, sid), nowEnv(clock));
    const second = await runPre(editPayload(path.join(dir, "f.js"), dir, sid), nowEnv(clock));
    assert.ok(
      !("additionalContext" in out(second.stdout)),
      "a crossing re-armed moments after the first invite stays silent -- cooldown absorbs the flap",
    );
    assert.notEqual(decision(second.stdout), "deny", "still never a deny, even suppressed by cooldown");

    // Once the cooldown genuinely elapses, the next genuine crossing invites
    // again -- the border is not permanently dead after one flap-suppressed cycle.
    clock += DEFAULT_INVITE_COOLDOWN_MS + 60_000;
    makeRunActive(dir);
    await runPre(editPayload(path.join(dir, "reset-trigger-2.js"), dir, sid), nowEnv(clock));
    rmSync(path.join(dir, ".muster", "run-active"), { force: true });
    await runPre(editPayload(path.join(dir, "g.js"), dir, sid), nowEnv(clock));
    await runPre(editPayload(path.join(dir, "h.js"), dir, sid), nowEnv(clock));
    const third = await runPre(editPayload(path.join(dir, "i.js"), dir, sid), nowEnv(clock));
    assert.ok(
      out(third.stdout).additionalContext,
      "once the cooldown clears, the next genuine crossing invites again",
    );
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── age-reset: a stale crossing re-arms ─────────────────────────────────────
// Driven by an explicit, test-controlled clock (nowEnv()) rather than
// Date.now(): the marker is stamped >60 minutes before a fixed T0, and every
// spawned hook call is pinned to that SAME T0 -- an exact, non-racing
// boundary regardless of real spawn/schedule latency under --test-concurrency.
test("age-reset: a crossing untouched past 60 minutes re-arms — the border warns again", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-age-1");
  clearCum(sid);
  const cFile = cumFile(sid, os.tmpdir());
  const T0 = 1_700_000_000_000; // arbitrary fixed instant; entirely test-controlled
  try {
    // Simulate an already-crossed-and-warned prior window, now stale relative to T0.
    writeFileSync(cFile, JSON.stringify({ files: ["old-a.js", "old-b.js", "old-c.js"], nudged: true }));
    const stale = new Date(T0 - (CROSSING_MAX_AGE_MS + 60_000));
    utimesSync(cFile, stale, stale);

    const env = nowEnv(T0);
    const a = await runPre(editPayload(path.join(dir, "new-a.js"), dir, sid), env);
    const b = await runPre(editPayload(path.join(dir, "new-b.js"), dir, sid), env);
    assert.ok(!("additionalContext" in out(a.stdout)), "1st file of the re-armed crossing is silent");
    const c = await runPre(editPayload(path.join(dir, "new-c.js"), dir, sid), env);
    assert.ok(out(c.stdout).additionalContext, "3rd file of the re-armed crossing warns again");
    assert.notEqual(decision(c.stdout), "deny");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});

// ── corrupt cum file fails open ──────────────────────────────────────────────
test("a corrupt cum file is treated as empty, never crashes and never denies", async () => {
  const dir = noRunDir();
  const sid = uniqueSid("border-corrupt-1");
  clearCum(sid);
  const cFile = cumFile(sid, os.tmpdir());
  writeFileSync(cFile, "{{{ not json at all");
  try {
    const r = await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    assert.equal(r.code, 0, "exit 0 despite a corrupt cumulative file");
    assert.notEqual(decision(r.stdout), "deny", "corrupt cum file fails open (treated empty)");
  } finally {
    clearCum(sid);
    cleanDir(dir);
  }
});
