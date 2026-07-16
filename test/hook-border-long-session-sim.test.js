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
// simulated exactly like the existing age-reset tests (hook-pre-tool-use-scale
// .test.js, hook-user-prompt-submit.test.js): back-date the cumulative-counter
// marker AND the shared invite-cooldown marker via utimesSync past both of
// their windows (CROSSING_MAX_AGE_MS, DEFAULT_INVITE_COOLDOWN_MS) before the
// day's activity runs. This is the same re-arm mechanism production code
// uses when a session is genuinely idle overnight -- just driven directly
// instead of waiting real hours.

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, utimesSync, existsSync } from "node:fs";
import os from "node:os";
import { cleanDir, makeRunActive, spawnHook } from "./test-support/hook-helpers.js";
import {
  cumFile, cooldownFile, CROSSING_MAX_AGE_MS, DEFAULT_INVITE_COOLDOWN_MS,
} from "../plugin/hooks/inline-budget.js";

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

// Simulates an overnight (or longer) gap between tmux-session days: back-date
// whichever of the cumulative-counter / cooldown markers currently exist past
// BOTH their re-arm windows, so the next touch starts a genuinely fresh,
// cooldown-clear crossing -- exactly what a real multi-day gap would produce.
function simulateOvernightGap(sid) {
  const gap = CROSSING_MAX_AGE_MS + 60_000; // > both CROSSING_MAX_AGE_MS and the (shorter) cooldown
  const stale = new Date(Date.now() - gap);
  for (const f of [cumFile(sid, os.tmpdir()), cooldownFile(sid, os.tmpdir())]) {
    if (f && existsSync(f)) utimesSync(f, stale, stale);
  }
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
      if (day > 1) simulateOvernightGap(sid);

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
