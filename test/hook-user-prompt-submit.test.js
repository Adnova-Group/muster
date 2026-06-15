import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHook } from "./test-support/hook-helpers.js";

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

// Spawn the hook, pipe `stdinText` to it, return { stdout, code }. Never rejects.
function runRaw(stdinText, env = {}) {
  return spawnHook(HOOK, stdinText, env);
}

// Convenience: one turn for a given session id.
function runTurn(sessionId, env = {}) {
  return runRaw(JSON.stringify({ session_id: sessionId }), env);
}

// One turn carrying a prompt (the UserPromptSubmit payload includes `prompt`).
function runPrompt(sessionId, prompt, env = {}) {
  return runRaw(JSON.stringify({ session_id: sessionId, prompt }), env);
}

function ctxOf(stdout) {
  const out = JSON.parse(stdout).hookSpecificOutput;
  assert.equal(out.hookEventName, "UserPromptSubmit");
  return out; // { hookEventName, additionalContext? }
}

test("no nudge before turn N, short nudge at turn N (default N=3)", async () => {
  const sid = uniqSession();
  for (const turn of [1, 2]) {
    const { stdout, code } = await runTurn(sid);
    assert.equal(code, 0, `turn ${turn} exit 0`);
    assert.ok(!("additionalContext" in ctxOf(stdout)), `turn ${turn} silent`);
  }
  const { stdout } = await runTurn(sid);
  const ctx = ctxOf(stdout).additionalContext;
  assert.match(ctx, /muster mode/i, "turn 3 short nudge");
  assert.match(ctx, /humanizer/i, "short nudge carries the routing clause");
  for (const v of ["run", "autopilot", "diagnose", "audit"]) {
    assert.match(ctx, new RegExp(v), `nudge mentions ${v}`);
  }
  assert.doesNotMatch(ctx, /muster principles:/, "short nudge is not the full payload");
});

test("turn N*2 is a short-only turn; turn N*K (=9) is the full payload", async () => {
  const sid = uniqSession();
  let last;
  for (let t = 1; t <= 6; t++) last = await runTurn(sid);
  const six = ctxOf(last.stdout).additionalContext;
  assert.match(six, /muster mode/i, "turn 6 short nudge");
  assert.doesNotMatch(six, /muster principles:/, "turn 6 not full");

  for (let t = 7; t <= 9; t++) last = await runTurn(sid);
  const nine = ctxOf(last.stdout).additionalContext;
  assert.match(nine, /muster principles:/, "turn 9 full principles");
  assert.match(nine, /TDD|verify|glass-box/i, "turn 9 has a principle keyword");
  assert.match(nine, /Default routing|humanizer/i, "turn 9 carries the routing policy");
  for (const v of ["run", "autopilot", "diagnose", "audit"]) {
    assert.match(nine, new RegExp(v), `full payload mentions ${v}`);
  }
});

test("MUSTER_NUDGE_EVERY overrides the short cadence", async () => {
  const sid = uniqSession();
  const env = { MUSTER_NUDGE_EVERY: "5" };
  for (let t = 1; t <= 4; t++) {
    const { stdout } = await runTurn(sid, env);
    assert.ok(!("additionalContext" in ctxOf(stdout)), `turn ${t} silent with N=5`);
  }
  const { stdout } = await runTurn(sid, env);
  assert.match(ctxOf(stdout).additionalContext, /muster mode/i, "turn 5 nudge with N=5");
});

test("MUSTER_PRINCIPLES_EVERY overrides the full cadence (K=2 -> full at turn 6)", async () => {
  const sid = uniqSession();
  const env = { MUSTER_PRINCIPLES_EVERY: "2" };
  let last;
  for (let t = 1; t <= 6; t++) last = await runTurn(sid, env);
  assert.match(ctxOf(last.stdout).additionalContext, /muster principles:/, "full at turn 6 with K=2");
});

test("junk env values fall back to defaults", async () => {
  const sid = uniqSession();
  const env = { MUSTER_NUDGE_EVERY: "abc", MUSTER_PRINCIPLES_EVERY: "-1" };
  for (let t = 1; t <= 2; t++) {
    const { stdout } = await runTurn(sid, env);
    assert.ok(!("additionalContext" in ctxOf(stdout)), `turn ${t} silent (default N=3)`);
  }
  const { stdout } = await runTurn(sid, env);
  assert.match(ctxOf(stdout).additionalContext, /muster mode/i, "turn 3 nudge under junk env");
});

// Slash-command turns must be transparent: no injected context (which in a relayed
// remote session can land ahead of the command and break slash parsing), and they
// must not consume the turn counter.
test("slash-command prompt gets no nudge and does not consume the turn count", async () => {
  const sid = uniqSession();
  for (let t = 1; t <= 2; t++) {
    const { stdout } = await runPrompt(sid, "do some work");
    assert.ok(!("additionalContext" in ctxOf(stdout)), `turn ${t} silent`);
  }
  // A slash turn where a normal turn 3 would nudge: must stay silent...
  const slash = await runPrompt(sid, "/muster:run ship it");
  assert.equal(slash.code, 0);
  assert.ok(!("additionalContext" in ctxOf(slash.stdout)), "slash-command turn injects nothing");
  // ...and must not have consumed the count: the next normal turn is the real turn 3.
  const { stdout } = await runPrompt(sid, "another task");
  assert.match(ctxOf(stdout).additionalContext, /muster mode/i, "slash turn was transparent to the counter");
});

test("leading-whitespace slash command is still treated as a slash command", async () => {
  const sid = uniqSession();
  for (let t = 1; t <= 2; t++) await runPrompt(sid, "work");
  const { stdout } = await runPrompt(sid, "   /muster:autopilot do it");
  assert.ok(!("additionalContext" in ctxOf(stdout)), "leading whitespace before / still skips injection");
});

test("a normal prompt at a nudge turn still nudges (guard does not over-fire)", async () => {
  const sid = uniqSession();
  let last;
  for (let t = 1; t <= 3; t++) last = await runPrompt(sid, "regular request");
  assert.match(ctxOf(last.stdout).additionalContext, /muster mode/i, "non-slash prompt nudges as before");
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

// ── session_id that sanitizes to empty string must not write the bare tmp file ─
test("session_id of only non-word chars sanitizes to empty: no file write, exits 0, valid JSON", async () => {
  // "!!!" sanitizes to "" via replace(/[^a-zA-Z0-9_-]/g, "")
  const badId = "!!!";

  // Remove the bare file if it pre-exists (from old hook versions) so we can
  // verify the fixed hook does not (re-)create it.
  const os = await import("node:os");
  const path = await import("node:path");
  const { existsSync, rmSync } = await import("node:fs");
  const bareFile = path.default.join(os.default.tmpdir(), "muster-turns-");
  try { rmSync(bareFile); } catch { /* not present — fine */ }

  const { stdout, code } = await runRaw(JSON.stringify({ session_id: badId }));
  assert.equal(code, 0, "exit 0");
  assert.doesNotThrow(() => JSON.parse(stdout), "stdout is valid JSON");
  const out = ctxOf(stdout);
  // Must not nudge (turn-counting is skipped)
  assert.ok(!("additionalContext" in out), "empty sanitized session_id -> no nudge (turn-counting skipped)");

  // Verify the bare file was NOT written.
  assert.ok(!existsSync(bareFile), "bare tmp file must not be written when session_id sanitizes to empty");
});
