// test/hook-user-prompt-submit.test.js
//
// The periodic every-N-turns nudge tier (short nudge, then full principles)
// is gone. The ONLY prompt-time nudge left is the isDirective-triggered
// border invitation (see pre-tool-use.js for its PreToolUse-side twin): fires
// once per crossing when a directive-shaped prompt lands with no muster run
// active, re-arming on a run starting, SessionStart, or 60 minutes of
// inactivity (inline-budget.js: isCrossingStale).

import { test, after } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import os from "node:os";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnHook, cleanDir } from "./test-support/hook-helpers.js";
import {
  directiveFile, CROSSING_MAX_AGE_MS, cumFile, recordCum,
  DEFAULT_INVITE_COOLDOWN_MS,
} from "../plugin/hooks/inline-budget.js";

// Scale correlation (see user-prompt-submit.js/inline-budget.js:
// isScaleCorroborated): the isDirective signal only fires when at least one
// distinct file has already been recorded this crossing by the PreToolUse
// cumulative counter. Tests that want the OLD "directive alone fires"
// behavior must first seed that corroborating file-touch; tests proving the
// trivial-directive fix do NOT seed it. `now` (default Date.now(), threaded
// straight into recordCum) lets the timing-sensitive tests below stamp the
// seed at an explicit, test-controlled instant instead of the real clock.
function seedCorroboration(sessionId, now = Date.now()) {
  recordCum(cumFile(sessionId, os.tmpdir()), "seed.js", now);
}

// Build the MUSTER_TEST_NOW_MS env override (see inline-budget.js:
// resolveNow) for a given instant `t` -- drives a spawned hook's staleness/
// cooldown comparisons off an explicit, test-controlled clock instead of the
// real wall clock, so no assertion below can race a spawned hook process's
// own Date.now() read under --test-concurrency.
function nowEnv(t) {
  return { MUSTER_TEST_NOW_MS: String(t) };
}

// Directive-nudge tests need a run cwd guaranteed to have no `.muster/run-active`.
// This repo's own cwd is not reliable for that (a live orchestrator run may be in
// progress against this very tree), so give those tests an isolated, guaranteed-
// clean cwd via payload.cwd rather than falling back to process.cwd().
const NO_RUN_DIR = mkdtempSync(path.join(os.tmpdir(), "muster-ups-norun-"));
after(() => cleanDir(NO_RUN_DIR));

const HOOK = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "user-prompt-submit.js",
);

// Unique per process run so tmpdir counter files never collide across runs.
let seq = 0;
function uniqSession() {
  seq += 1;
  return `test-${process.pid}-${seq}-${Math.random().toString(36).slice(2)}`;
}

function runRaw(stdinText, env = {}) {
  return spawnHook(HOOK, stdinText, env);
}

function runPromptCwd(sessionId, prompt, cwd, env = {}) {
  return runRaw(JSON.stringify({ session_id: sessionId, prompt, cwd }), env);
}

function ctxOf(stdout) {
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "UserPromptSubmit");
  return out; // { hookEventName, additionalContext? }
}

// ── no periodic tier left: many plain turns never inject anything ──────────
test("no periodic tier: 10 non-directive, non-slash turns never inject additionalContext", async () => {
  const sid = uniqSession();
  for (let t = 1; t <= 10; t++) {
    const { stdout, code } = await runPromptCwd(sid, "just a regular question about the codebase?", NO_RUN_DIR);
    assert.equal(code, 0, `turn ${t} exit 0`);
    assert.ok(!("additionalContext" in ctxOf(stdout)), `turn ${t}: no periodic tier exists anymore`);
  }
});

test("missing session_id: valid JSON, exit 0, no nudge", async () => {
  const { stdout, code } = await runRaw(JSON.stringify({ foo: "bar" }));
  assert.equal(code, 0);
  assert.ok(!("additionalContext" in ctxOf(stdout)), "no session id -> no nudge");
});

test("malformed stdin: valid JSON, exit 0, no nudge (fail-safe)", async () => {
  const { stdout, code } = await runRaw("not json {");
  assert.equal(code, 0);
  assert.doesNotThrow(() => JSON.parse(stdout), "stdout is valid JSON");
  assert.ok(!("additionalContext" in ctxOf(stdout)), "garbage stdin -> no nudge");
});

// Slash-command turns must be transparent: no injected context (which in a relayed
// remote session can land ahead of the command and break slash parsing).
test("slash-command prompt gets no nudge, even if directive-shaped", async () => {
  const sid = uniqSession();
  const slash = await runPromptCwd(sid, "/muster:run fix the bug", NO_RUN_DIR);
  assert.equal(slash.code, 0);
  assert.ok(!("additionalContext" in ctxOf(slash.stdout)), "slash-command turn injects nothing");
});

test("leading-whitespace slash command is still treated as a slash command", async () => {
  const sid = uniqSession();
  const { stdout } = await runPromptCwd(sid, "   /muster:autopilot do it", NO_RUN_DIR);
  assert.ok(!("additionalContext" in ctxOf(stdout)), "leading whitespace before / still skips injection");
});

// ── T-directive: the isDirective-triggered border invitation ───────────────
//
// Scale-correlation tuning: isDirective alone is verb-opener detection, not
// scale — "fix typo" matches it exactly as well as a genuine multi-file
// build. The signal now also requires at least one distinct file already
// recorded this crossing by the PreToolUse cumulative counter
// (inline-budget.js: isScaleCorroborated) before it may fire.

test("T-directive: trivial one-file directive turn (\"fix typo\") with no established scale never invites", async () => {
  const sid = uniqSession();
  const { stdout, code } = await runPromptCwd(sid, "fix typo", NO_RUN_DIR);
  assert.equal(code, 0);
  assert.ok(
    !("additionalContext" in ctxOf(stdout)),
    "a cold, isolated directive with zero prior inline drift is not scale-corroborated -- no invite",
  );
});

test("T-directive: a STALE prior crossing's leftover file count must not corroborate a new, trivial directive (review-gate fix)", async () => {
  const sid = uniqSession();
  const T0 = 1_700_000_000_000; // arbitrary fixed instant; entirely test-controlled
  // 1 file recorded, but stamped >60 minutes before T0 -- that prior crossing
  // is dead by the time the hook below is pinned to T0 (see nowEnv()).
  seedCorroboration(sid, T0 - (CROSSING_MAX_AGE_MS + 60_000));

  const { stdout, code } = await runPromptCwd(sid, "fix typo", NO_RUN_DIR, nowEnv(T0));
  assert.equal(code, 0);
  assert.ok(
    !("additionalContext" in ctxOf(stdout)),
    "a dead prior crossing's leftover count must not corroborate a brand-new, genuinely trivial directive",
  );
});

test("T-directive: directive prompt corroborated by prior inline drift (>=1 file this crossing) nudges with value-toned copy", async () => {
  const sid = uniqSession();
  seedCorroboration(sid);
  const { stdout, code } = await runPromptCwd(sid, "fix the flaky test", NO_RUN_DIR);
  assert.equal(code, 0);
  const ctx = ctxOf(stdout).additionalContext;
  assert.ok(ctx, "directive-shaped prompt, no run active, corroborated by prior drift: nudges");
  assert.match(ctx, /parallel dispatch/i, "value copy: parallel dispatch");
  assert.match(ctx, /adversarial review/i, "value copy: adversarial review");
  assert.match(ctx, /receipts/i, "value copy: receipts trail");
  assert.match(ctx, /\/muster:go\b/, "nudge names the verb");
});

test("T-directive: second directive prompt, same crossing: suppressed (no repeat)", async () => {
  const sid = uniqSession();
  seedCorroboration(sid);
  await runPromptCwd(sid, "fix the flaky test", NO_RUN_DIR); // fires, marks the crossing
  const { stdout } = await runPromptCwd(sid, "fix another flaky test", NO_RUN_DIR);
  assert.ok(!("additionalContext" in ctxOf(stdout)), "same crossing: nudge suppressed");
});

test("T-directive: non-directive prompts (questions, conversational) never nudge", async () => {
  const question = await runPromptCwd(uniqSession(), "how does the router work?", NO_RUN_DIR);
  assert.ok(!("additionalContext" in ctxOf(question.stdout)), "question is not directive-shaped");

  const chatter = await runPromptCwd(uniqSession(), "thanks, looks good", NO_RUN_DIR);
  assert.ok(!("additionalContext" in ctxOf(chatter.stdout)), "conversational turn is not directive-shaped");
});

test("T-directive: directive prompt with .muster/run-active present: no nudge", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-ups-test-"));
  try {
    mkdirSync(path.join(dir, ".muster"), { recursive: true });
    writeFileSync(path.join(dir, ".muster", "run-active"), "1");
    const sid = uniqSession();
    const { stdout, code } = await runPromptCwd(sid, "fix the bug", dir);
    assert.equal(code, 0);
    assert.ok(
      !("additionalContext" in ctxOf(stdout)),
      "directive nudge suppressed while a muster run is active in the payload cwd",
    );
  } finally {
    cleanDir(dir);
  }
});

test("T-directive: polite prefix nudges (once corroborated); question form does not", async () => {
  const politeSid = uniqSession();
  seedCorroboration(politeSid);
  const polite = await runPromptCwd(politeSid, "please fix the hook", NO_RUN_DIR);
  assert.match(ctxOf(polite.stdout).additionalContext, /parallel dispatch/i, "polite prefix still directive-shaped");

  const question = await runPromptCwd(uniqSession(), "can you explain the hook?", NO_RUN_DIR);
  assert.ok(!("additionalContext" in ctxOf(question.stdout)), "question form is never directive-shaped");
});

// ── re-arm triggers: run-start and age ──────────────────────────────────────

// Driven by an explicit, test-controlled clock (`clock`, advanced with
// nowEnv()) instead of real elapsed wall time: "real time has barely moved"
// / "once the cooldown window has genuinely elapsed" are exact by
// construction here, not an assumption about how fast a spawned hook process
// happens to run under --test-concurrency.
test("T-directive: a muster run starting re-arms the crossing, but the shared cooldown still stands down an immediate repeat (run-boundary stand-down, not flap)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-ups-rearm-run-"));
  const sid = uniqSession();
  let clock = 1_700_000_000_000; // arbitrary fixed instant; entirely test-controlled
  try {
    seedCorroboration(sid, clock);
    // Turn 1: directive prompt, no run active — fires, marks the crossing and
    // starts the shared invite cooldown.
    const t1 = await runPromptCwd(sid, "fix the flaky test", dir, nowEnv(clock));
    assert.ok(ctxOf(t1.stdout).additionalContext, "sanity: turn 1 fires");
    const dFile = directiveFile(sid, os.tmpdir());
    assert.ok(dFile, "sanity: directive marker path resolves");

    // A muster run starts and is observed by a turn (any prompt suffices).
    mkdirSync(path.join(dir, ".muster"), { recursive: true });
    writeFileSync(path.join(dir, ".muster", "run-active"), "1");
    await runPromptCwd(sid, "status check", dir, nowEnv(clock));

    // The run ends.
    const { rmSync } = await import("node:fs");
    rmSync(path.join(dir, ".muster", "run-active"), { force: true });

    // Next directive prompt, no run active: the crossing re-armed (marker
    // unlinked while the run was observed), but the invite cooldown started
    // by turn 1 is still within its window (the injected clock hasn't moved)
    // -- this is the flap case a rapid run-restart must NOT re-invite through.
    const rapid = await runPromptCwd(sid, "fix another flaky test", dir, nowEnv(clock));
    assert.ok(
      !("additionalContext" in ctxOf(rapid.stdout)),
      "run-boundary re-arm alone does not re-invite while the shared cooldown is still active",
    );

    // Real stand-down: once the cooldown window has genuinely elapsed (the
    // injected clock advances past it), the next directive prompt in the
    // (still-corroborated, re-armed) crossing invites again -- proves the
    // session is not dead for good.
    clock += DEFAULT_INVITE_COOLDOWN_MS + 60_000;
    const standDown = await runPromptCwd(sid, "fix yet another flaky test", dir, nowEnv(clock));
    assert.ok(
      ctxOf(standDown.stdout).additionalContext,
      "once the cooldown clears, a completed muster run's re-armed crossing invites again",
    );
  } finally {
    cleanDir(dir);
  }
});

test("T-directive: age-reset — a crossing untouched past 60 minutes re-arms (cooldown also long since cleared)", async () => {
  const sid = uniqSession();
  let clock = 1_700_000_000_000; // arbitrary fixed instant; entirely test-controlled
  seedCorroboration(sid, clock);
  await runPromptCwd(sid, "fix the flaky test", NO_RUN_DIR, nowEnv(clock)); // fires, marks the crossing, starts cooldown

  // 60+ minutes pass for the directive crossing (and the shorter cooldown
  // clears with it) -- the corroborating file-touch crossing is re-touched
  // "just now" at the new instant, exactly like a session where the
  // PreToolUse counter saw fresher inline activity than the last directive
  // nudge (isolates this test to the DIRECTIVE marker's own age-reset, not
  // corroboratingCount's independent staleness rule -- see the "STALE prior
  // crossing" test above for that one).
  clock += CROSSING_MAX_AGE_MS + 60_000;
  seedCorroboration(sid, clock);

  const { stdout } = await runPromptCwd(sid, "fix another flaky test", NO_RUN_DIR, nowEnv(clock));
  assert.ok(
    ctxOf(stdout).additionalContext,
    "a crossing older than 60 minutes re-arms — the same-session directive prompt nudges again",
  );
});

test("session_id of only non-word chars sanitizes to empty: no nudge, exits 0, valid JSON", async () => {
  const { stdout, code } = await runRaw(JSON.stringify({ session_id: "!!!", prompt: "fix the bug" }));
  assert.equal(code, 0, "exit 0");
  assert.doesNotThrow(() => JSON.parse(stdout), "stdout is valid JSON");
  assert.ok(!("additionalContext" in ctxOf(stdout)), "unusable session_id -> no nudge (fail-open)");
});
