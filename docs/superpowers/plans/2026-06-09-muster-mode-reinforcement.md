# Muster Mode Reinforcement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `UserPromptSubmit` hook that periodically re-asserts muster mode (short nudge every N turns, full principles every N·K turns) so a session stops drifting back to default Claude behavior.

**Architecture:** A new self-contained, fail-safe hook spawned per user turn keeps a per-session turn counter in an `os.tmpdir()` file and injects guidance via `hookSpecificOutput.additionalContext`. A new shared `guidance.js` holds the single source of truth for the principles/verbs/nudge text; the existing `session-start.js` is refactored to consume it.

**Tech Stack:** Node ≥20 ESM, `node:test` runner (`node --test`), node: builtins only (hooks ship under `plugin/` and must stand alone).

---

## File Structure

- `plugin/hooks/guidance.js` — **new.** Shared text + `detect(cwd)`. Exports `PRINCIPLES`, `VERBS`, `ROUTING_POLICY`, `SHORT_NUDGE`, `detect`.
- `plugin/hooks/session-start.js` — **modify.** Import from `guidance.js`; compose `PRINCIPLES + VERBS + ROUTING_POLICY + detect`. Adds one `ROUTING_POLICY` line vs. today.
- `plugin/hooks/user-prompt-submit.js` — **new.** Per-turn counter + cadence + nudge emission.
- `plugin/hooks/hooks.json` — **modify.** Register the `UserPromptSubmit` hook.
- `test/hook-user-prompt-submit.test.js` — **new.** Full behavior coverage of the new hook.
- `test/hook-session-start.test.js` — **modify.** One added assertion: full payload regardless of `source`.

Run the whole suite with: `node --test`. Run one file with: `node --test test/<file>.js`.

---

## Task 1: Extract shared `guidance.js` and refactor `session-start.js`

This is a refactor guarded by the existing `test/hook-session-start.test.js` — no behavior change.

**Files:**
- Create: `plugin/hooks/guidance.js`
- Modify: `plugin/hooks/session-start.js`
- Test (existing, used as guard): `test/hook-session-start.test.js`

- [ ] **Step 1: Confirm the guard is green before refactoring**

Run: `node --test test/hook-session-start.test.js`
Expected: PASS (3 tests). This is the safety net for the refactor.

- [ ] **Step 2: Create the shared guidance module**

Create `plugin/hooks/guidance.js`:

```js
// muster shared guidance — single source of truth for the text the hooks inject.
//
// SELF-CONTAINED: only node: builtins. Ships under plugin/, must stand alone.
import { existsSync } from "node:fs";
import path from "node:path";

export const PRINCIPLES = [
  "muster principles:",
  "- Think before coding; state your assumptions before you act.",
  "- TDD: write the failing test first, then make it pass.",
  "- Surgical changes: touch only what the task needs.",
  "- Glass-box reasoning: show the crew and the decisions, never hide them.",
  "- Prefer code over the model for deterministic work (routing, retries, transforms).",
  "- Fail loud: verify before claiming done.",
].join("\n");

export const VERBS =
  "Verbs: /muster:run (plan + show), /muster:autopilot (hands-off lifecycle), " +
  "/muster:diagnose (failure-first fix), /muster:audit (whole-codebase review-and-fix).";

export const ROUTING_POLICY = [
  "Default routing: in this muster repo, drive actionable prompts through muster —",
  "route directives and substantive questions to the verbs (/muster:run · :autopilot ·",
  ":diagnose · :audit) where applicable, and content/copy work through the muster content",
  "pipeline (humanizer). Let conversational or trivial turns fall through. Honor explicit",
  "/muster commands as given.",
].join(" ");

export const SHORT_NUDGE =
  "muster mode — drive directives through the muster verbs (don't default to plain inline " +
  "work), route copy/content through the humanizer, keep reasoning glass-box. Conversational " +
  "turns fall through. Verbs: /muster:run · /muster:autopilot · /muster:diagnose · /muster:audit.";

export function detect(cwd) {
  const has = (f) => {
    try {
      return existsSync(path.join(cwd, f));
    } catch {
      return false;
    }
  };

  const git = has(".git");
  let stack;
  if (has("package.json")) stack = "Node project";
  else if (has("pyproject.toml")) stack = "Python project";
  else if (has("go.mod")) stack = "Go project";
  else if (has("Cargo.toml")) stack = "Rust project";

  if (!stack) {
    return git
      ? "Detected: a git repo with no recognized project type"
      : "No recognized project in the current directory";
  }
  return git ? `Detected: ${stack} in a git repo` : `Detected: ${stack}`;
}
```

- [ ] **Step 3: Refactor `session-start.js` to consume the module**

Replace the entire contents of `plugin/hooks/session-start.js` with:

```js
#!/usr/bin/env node
// muster SessionStart hook — injects always-on guidance into every session.
//
// Self-contained apart from the sibling guidance.js (also under plugin/hooks/).
// The plugin ships only plugin/, so both files travel together.
//
// FAIL-SAFE: this runs at every session start (including source "compact" and
// "resume"). On ANY error we print minimal valid JSON and exit 0. Never throw.

import { PRINCIPLES, VERBS, ROUTING_POLICY, detect } from "./guidance.js";

const EVENT = "SessionStart";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

try {
  emit({
    hookSpecificOutput: {
      hookEventName: EVENT,
      additionalContext: [PRINCIPLES, VERBS, ROUTING_POLICY, detect(process.cwd())].join("\n"),
    },
  });
} catch {
  // Minimal valid output so the session is never broken.
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
}

process.exit(0);
```

- [ ] **Step 4: Run the guard to verify the refactor is clean**

Run: `node --test test/hook-session-start.test.js`
Expected: PASS (3 tests). Output identical to before — text moved, not changed.

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/guidance.js plugin/hooks/session-start.js
git commit -m "refactor(hooks): extract shared guidance.js as single source of truth"
```

---

## Task 2: New `UserPromptSubmit` hook with turn counter and two-tier cadence

**Files:**
- Create: `test/hook-user-prompt-submit.test.js`
- Create: `plugin/hooks/user-prompt-submit.js`

- [ ] **Step 1: Write the failing tests**

Create `test/hook-user-prompt-submit.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      [HOOK],
      { env: { ...process.env, ...env } },
      (err, stdout) => {
        resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
      },
    );
    child.stdin.end(stdinText);
  });
}

// Convenience: one turn for a given session id.
function runTurn(sessionId, env = {}) {
  return runRaw(JSON.stringify({ session_id: sessionId }), env);
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test test/hook-user-prompt-submit.test.js`
Expected: FAIL — the hook file does not exist yet (spawn errors / non-parseable stdout).

- [ ] **Step 3: Write the hook implementation**

Create `plugin/hooks/user-prompt-submit.js`:

```js
#!/usr/bin/env node
// muster UserPromptSubmit hook — periodically re-asserts muster mode to counter
// in-session drift back to default Claude behavior.
//
// Two tiers, keyed off a per-session turn counter:
//   - every N turns        -> short nudge        (MUSTER_NUDGE_EVERY, default 3)
//   - every N*K turns       -> full principles    (MUSTER_PRINCIPLES_EVERY, default 3)
//
// Self-contained apart from sibling guidance.js. FAIL-SAFE: whole body in
// try/catch; on ANY error or missing state, emit minimal valid JSON and exit 0.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { PRINCIPLES, VERBS, ROUTING_POLICY, SHORT_NUDGE } from "./guidance.js";

const EVENT = "UserPromptSubmit";

function emit(obj) {
  process.stdout.write(JSON.stringify(obj));
}

function posInt(value, fallback) {
  const n = Number.parseInt(value, 10);
  return Number.isInteger(n) && n > 0 ? n : fallback;
}

// Increment and persist a per-session turn counter; return the new count.
function bumpTurn(sessionId) {
  const safe = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  const file = path.join(os.tmpdir(), `muster-turns-${safe}`);
  let count = 0;
  try {
    count = posInt(readFileSync(file, "utf8").trim(), 0); // missing/junk -> 0
  } catch {
    count = 0;
  }
  count += 1;
  writeFileSync(file, String(count));
  return count;
}

try {
  let sessionId;
  try {
    sessionId = JSON.parse(readFileSync(0, "utf8")).session_id;
  } catch {
    sessionId = undefined;
  }

  if (typeof sessionId !== "string" || sessionId.length === 0) {
    emit({ hookSpecificOutput: { hookEventName: EVENT } });
    process.exit(0);
  }

  const N = posInt(process.env.MUSTER_NUDGE_EVERY, 3);
  const K = posInt(process.env.MUSTER_PRINCIPLES_EVERY, 3);
  const count = bumpTurn(sessionId);

  let additionalContext;
  if (count % (N * K) === 0) additionalContext = `${PRINCIPLES}\n${VERBS}\n${ROUTING_POLICY}`;
  else if (count % N === 0) additionalContext = SHORT_NUDGE;

  const out = { hookEventName: EVENT };
  if (additionalContext) out.additionalContext = additionalContext;
  emit({ hookSpecificOutput: out });
} catch {
  emit({ hookSpecificOutput: { hookEventName: EVENT } });
}

process.exit(0);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test test/hook-user-prompt-submit.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/user-prompt-submit.js test/hook-user-prompt-submit.test.js
git commit -m "feat(hooks): periodic UserPromptSubmit nudge to counter muster drift"
```

---

## Task 3: Register the hook and pin the compact-backstop contract

**Files:**
- Modify: `plugin/hooks/hooks.json`
- Modify: `test/hook-session-start.test.js`

- [ ] **Step 1: Add a guard test for the compact backstop**

Append this test to `test/hook-session-start.test.js` (it documents that the hook emits the full payload regardless of `source`, since compaction relies on it). Add `execFile`-with-stdin support by inserting this helper near the top, after the existing `runHook` definition:

```js
// Run the hook with a stdin payload (e.g. a compact-source SessionStart event).
function runHookStdin(cwd, stdinText) {
  return new Promise((resolve) => {
    const child = execFile("node", [HOOK], { cwd }, (err, stdout) => {
      resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
    });
    child.stdin.end(stdinText);
  });
}
```

Then add the test at the end of the file:

```js
test("session-start hook: emits full payload on a compact-source event (backstop)", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "muster-hook-compact-"));
  await writeFile(path.join(dir, "package.json"), "{}");

  const { stdout, code } = await runHookStdin(
    dir,
    JSON.stringify({ source: "compact", session_id: "x" }),
  );
  assert.equal(code, 0, "exit 0");

  const ctx = JSON.parse(stdout).hookSpecificOutput.additionalContext;
  assert.match(ctx, /muster principles:/, "full principles present after compact");
  for (const verb of ["run", "autopilot", "diagnose", "audit"]) {
    assert.match(ctx, new RegExp(verb), `mentions ${verb}`);
  }
});
```

- [ ] **Step 2: Run the augmented test to verify it passes**

Run: `node --test test/hook-session-start.test.js`
Expected: PASS (4 tests). The hook ignores stdin, so it emits the full payload regardless of source — this test pins that contract.

- [ ] **Step 3: Register the UserPromptSubmit hook**

Replace the entire contents of `plugin/hooks/hooks.json` with:

```json
{
  "hooks": {
    "SessionStart": [
      { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/session-start.js\"" } ] }
    ],
    "UserPromptSubmit": [
      { "hooks": [ { "type": "command", "command": "node \"${CLAUDE_PLUGIN_ROOT}/hooks/user-prompt-submit.js\"" } ] }
    ]
  }
}
```

- [ ] **Step 4: Verify hooks.json is valid JSON and the full suite is green**

Run: `node -e "JSON.parse(require('fs').readFileSync('plugin/hooks/hooks.json','utf8')); console.log('hooks.json OK')"`
Expected: `hooks.json OK`

Run: `node --test`
Expected: PASS — entire suite, including the two hook test files.

- [ ] **Step 5: Commit**

```bash
git add plugin/hooks/hooks.json test/hook-session-start.test.js
git commit -m "feat(hooks): register UserPromptSubmit hook; pin compact-backstop contract"
```

---

## Self-Review

**Spec coverage:**
- Short nudge every N (default 3) → Task 2 Step 1 test "no nudge before turn N…", impl Step 3. ✓
- Full principles every N·K (default 3 → turn 9) → Task 2 "turn N*2… turn N*K". ✓
- Shared `guidance.js` single source of truth → Task 1. ✓
- `session-start.js` refactor, output unchanged → Task 1, guarded by existing tests. ✓
- Env knobs `MUSTER_NUDGE_EVERY`, `MUSTER_PRINCIPLES_EVERY`; junk → default → Task 2 tests 3–5. ✓
- Fail-safe (missing session_id, malformed stdin) → Task 2 tests 6–7. ✓
- `hooks.json` registration → Task 3. ✓
- Compact backstop unchanged + pinned → Task 3 Step 1. ✓
- Full periodic payload is `PRINCIPLES + VERBS + ROUTING_POLICY` (no `detect`) → impl Step 3 matches spec. ✓
- Default routing posture (directives→verbs, copy→humanizer, conversational falls through) → `ROUTING_POLICY` + routing clause in `SHORT_NUDGE` (Task 1 Step 2), injected at SessionStart (Task 1 Step 3) and on the periodic full payload (Task 2 Step 3); asserted by the `humanizer`/`Default routing` test matchers (Task 2 Step 1). ✓

**Placeholder scan:** none — every code/command step is complete.

**Type/name consistency:** `PRINCIPLES`, `VERBS`, `ROUTING_POLICY`, `SHORT_NUDGE`, `detect` exported by `guidance.js` and imported by both hooks with matching names; `bumpTurn`, `posInt`, `EVENT` used consistently; env var names identical across spec, impl, and tests. Existing session-start tests still pass because the added `ROUTING_POLICY` line does not remove any verb or principle keyword they match on.

**Out of scope (per spec):** counter-file cleanup, `.muster` config file, transcript-based counting, `plugin.json` version bump.
