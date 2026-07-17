// test/hook-border-long-session-sim.test.js
//
// Simulates a week-long, long-lived tmux session (a "homebase" profile: one
// session_id, one working directory, never restarted) driving the PreToolUse
// border invitation across several simulated days. Proves the success
// criterion in the border-tuning item directly: a week-long session log
// shows AT MOST ONE invitation PER GENUINE CROSSING -- not per-session-once
// (dead for the rest of the week after firing once) and not flapping
// (repeat-firing within a crossing or a rapid re-arm).
//
// Real time cannot be made to pass in a unit test, so "a day passes" is
// simulated with the SAME injectable clock pre-tool-use.js resolves via
// inline-budget.js: resolveNow() (MUSTER_TEST_NOW_MS) -- advance a
// test-local `clock` variable past both re-arm windows (CROSSING_MAX_AGE_MS,
// DEFAULT_INVITE_COOLDOWN_MS) and pass it as env to every spawned hook call.
// This is the same re-arm mechanism production code uses when a session is
// genuinely idle overnight, driven by an explicit integer instead of
// utimesSync-backdating a marker against Date.now() and hoping a later
// spawned child process's OWN real-clock read lands far enough past it --
// that real-clock-race is exactly what made this test flake under
// --test-concurrency (two independent Date.now() reads, on either side of a
// process boundary, with no fixed relationship between them under load).
// With the clock injected, every comparison this test drives is exact
// regardless of how long a hook process actually takes to spawn.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import { cleanDir, makeRunActive, spawnHook } from "./test-support/hook-helpers.js";
import { cumFile, cooldownFile, CROSSING_MAX_AGE_MS, DEFAULT_INVITE_COOLDOWN_MS } from "../plugin/hooks/inline-budget.js";

const HOOKDIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
);
const PRE = path.join(HOOKDIR, "pre-tool-use.js");

// Arbitrary fixed instant; entirely test-controlled (see MUSTER_TEST_NOW_MS /
// inline-budget.js: resolveNow). Never read from Date.now() -- there is
// nothing for this test to race once every spawned hook call is pinned to an
// explicit clock value.
let clock = 1_700_000_000_000;

function nowEnv() {
  return { MUSTER_TEST_NOW_MS: String(clock) };
}

function runPre(stdinText) {
  return spawnHook(PRE, stdinText, nowEnv());
}

function editPayload(filePath, cwd, sessionId) {
  return JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: filePath },
    cwd,
    session_id: sessionId,
  });
}

function out(stdout) {
  return JSON.parse(stdout).hookSpecificOutput;
}

function invited(stdout) {
  return "additionalContext" in out(stdout);
}

function clearSessionState(sid) {
  for (const f of [cumFile(sid, os.tmpdir()), cooldownFile(sid, os.tmpdir())]) {
    if (f) { try { rmSync(f, { force: true }); } catch { /* ignore */ } }
  }
}

// Simulates an overnight (or longer) gap between tmux-session days: advance
// the injected clock past BOTH re-arm windows so the next touch starts a
// genuinely fresh, cooldown-clear crossing -- exactly what a real multi-day
// gap would produce. No filesystem mtime manipulation needed: every marker
// this session touches was itself stamped with the (previous) injected clock
// value by the hook's own writer functions (inline-budget.js: recordCum/
// markNudged/recordInvite all stamp `now` after writing), so simply moving
// `clock` forward makes the NEXT hook invocation see them as however old the
// new clock says they are.
function simulateOvernightGap() {
  clock += CROSSING_MAX_AGE_MS + 60_000; // > both CROSSING_MAX_AGE_MS and the (shorter) cooldown
}

test("long-lived session (simulated week, homebase tmux profile): at most one invite per genuine crossing, zero on trivial single-file days, never dead for the week", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-week-sim-"));
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  const sid = "homebase-week-sim";
  clearSessionState(sid);

  // Day plan across a simulated week: "active" days genuinely cross the
  // border (3 distinct files); "trivial" days touch a single file and must
  // never invite. Each day after the first starts with a simulated overnight
  // gap (re-arms both the crossing and the cooldown).
  const plan = [
    { day: 1, active: true },
    { day: 2, active: false }, // trivial day: one small single-file fix
    { day: 3, active: true },
    { day: 4, active: false },
    { day: 5, active: true },
    { day: 6, active: false },
    { day: 7, active: true },
  ];

  let totalInvites = 0;
  const log = [];

  try {
    for (const { day, active } of plan) {
      if (day > 1) simulateOvernightGap();

      if (!active) {
        // Trivial day: a single distinct file touched all day long -- well
        // under MUSTER_INLINE_SCALE (default 3). Must never invite.
        const r = await runPre(editPayload(path.join(dir, `day${day}-trivial.js`), dir, sid));
        assert.ok(!invited(r.stdout), `day ${day} (trivial): a single-file day never invites`);
        log.push({ day, invites: 0 });
        continue;
      }

      // Active day: three distinct files touched inline with no muster run
      // active -- a genuine crossing. The 1st and 2nd stay silent; the 3rd
      // crosses the border and invites exactly once.
      const a = await runPre(editPayload(path.join(dir, `day${day}-a.js`), dir, sid));
      const b = await runPre(editPayload(path.join(dir, `day${day}-b.js`), dir, sid));
      const c = await runPre(editPayload(path.join(dir, `day${day}-c.js`), dir, sid));
      assert.ok(!invited(a.stdout), `day ${day}: 1st file silent`);
      assert.ok(!invited(b.stdout), `day ${day}: 2nd file silent`);
      assert.ok(invited(c.stdout), `day ${day}: 3rd file crosses the border and invites`);
      let dayInvites = 1;

      // Same-day noise: an editor/tmux-pane restart (a muster run start/stop,
      // resetting the counter mid-day) followed by three MORE distinct files
      // touched the SAME simulated day (no gap introduced). This is the same
      // "genuine crossing" in tmux-homebase terms -- the invite cooldown
      // must absorb it, not fire a second time hours apart within one day.
      makeRunActive(dir);
      await runPre(editPayload(path.join(dir, `day${day}-reset-trigger.js`), dir, sid));
      rmSync(path.join(dir, ".muster", "run-active"), { force: true });
      await runPre(editPayload(path.join(dir, `day${day}-d.js`), dir, sid));
      await runPre(editPayload(path.join(dir, `day${day}-e.js`), dir, sid));
      const f = await runPre(editPayload(path.join(dir, `day${day}-f.js`), dir, sid));
      assert.ok(
        !invited(f.stdout),
        `day ${day}: same-day restart-and-recross does not invite a second time (cooldown, not flap)`,
      );

      log.push({ day, invites: dayInvites });
      totalInvites += dayInvites;
    }

    const activeDays = plan.filter((p) => p.active).length;
    assert.equal(
      totalInvites,
      activeDays,
      `exactly one invite per genuine (active) day across the week -- log: ${JSON.stringify(log)}`,
    );
    assert.ok(totalInvites > 0, "the week-long session is not dead: it invited on its genuine crossings");
    assert.ok(
      totalInvites < plan.length * 3,
      "not flapping: total invites stay far below the total number of file touches",
    );
  } finally {
    clearSessionState(sid);
    cleanDir(dir);
  }
});
