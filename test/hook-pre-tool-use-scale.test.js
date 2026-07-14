import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import {
  cleanDir, makeMarker, makeRunActive,
  editPayload as editPayloadBase, spawnHook,
} from "./test-support/hook-helpers.js";
import { budgetFile, cumFile, readCum } from "../plugin/hooks/inline-budget.js";

// Scale-gate: the post-run enforcement. With NO active wave, the orchestrator
// main loop may edit 1-2 distinct files per turn (trivial/surgical falls
// through), but the 3rd distinct file in one turn is orchestration-scale and is
// gated back to a verb. This is the enforcement the advisory nudge could not
// provide, covering the window AFTER a wave marker is removed.

const HOOKDIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
);
const PRE = path.join(HOOKDIR, "pre-tool-use.js");
const UPS = path.join(HOOKDIR, "user-prompt-submit.js");

function runPre(stdinText, env = {}) {
  return spawnHook(PRE, stdinText, env);
}

// A no-wave working dir: .muster/ exists but no wave-active marker.
function noWaveDir() {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-scale-test-"));
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  return dir;
}

// This file's callers pass session_id as its own positional arg (distinct from
// the canonical hook-helpers.js signature) — thin wrapper over the canonical
// editPayload so the payload-construction logic itself stays in ONE place
// (P2-19) without touching every one of this file's call sites.
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

// Remove the per-session tmp budget file so tests don't contaminate each other.
function clearBudget(sessionId) {
  const file = budgetFile(sessionId);
  if (file) try { rmSync(file, { force: true }); } catch { /* ignore */ }
}

// Remove the per-session cumulative cross-turn file.
function clearCum(sessionId) {
  const file = cumFile(sessionId);
  if (file) try { rmSync(file, { force: true }); } catch { /* ignore */ }
}

function decision(stdout) {
  return JSON.parse(stdout).hookSpecificOutput.permissionDecision;
}

// ── core repro→fix: 1st & 2nd distinct file allowed, 3rd denied ─────────────
// NOTE: all Edit file_path values are INSIDE the `dir` cwd so GUARD-SCOPE does
// not early-allow them before the scale gate is reached.
test("no wave: 3rd distinct inline file edit in a turn is denied", async () => {
  const dir = noWaveDir();
  const sid = "scale-core-1";
  clearBudget(sid);
  try {
    const a = await runPre(editPayload(path.join(dir, "src", "a.js"), dir, sid));
    const b = await runPre(editPayload(path.join(dir, "src", "b.js"), dir, sid));
    const c = await runPre(editPayload(path.join(dir, "src", "c.js"), dir, sid));
    assert.notEqual(decision(a.stdout), "deny", "1st file allowed");
    assert.notEqual(decision(b.stdout), "deny", "2nd file allowed");
    assert.equal(decision(c.stdout), "deny", "3rd distinct file denied");
    assert.match(
      JSON.parse(c.stdout).hookSpecificOutput.permissionDecisionReason,
      /\/muster:go\b/,
      "deny reason leads with /muster:go",
    );
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── re-editing the SAME file does not accumulate ────────────────────────────
test("no wave: repeated edits to the same file never trip the gate", async () => {
  const dir = noWaveDir();
  const sid = "scale-same-1";
  clearBudget(sid);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await runPre(editPayload(path.join(dir, "src", "only.js"), dir, sid));
      assert.notEqual(decision(r.stdout), "deny", `edit #${i + 1} to same file allowed`);
    }
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── subagent edits are exempt and do not count toward the budget ────────────
test("no wave: subagent (agent_id) edits never denied, don't consume budget", async () => {
  const dir = noWaveDir();
  const sid = "scale-sub-1";
  clearBudget(sid);
  try {
    for (let i = 0; i < 4; i++) {
      const r = await runPre(
        editPayload(path.join(dir, "src", `s${i}.js`), dir, sid, { agent_id: "sub-x" }),
      );
      assert.notEqual(decision(r.stdout), "deny", "subagent edit allowed");
    }
    // main-loop edits afterward still get a fresh 1-2 file budget
    const m1 = await runPre(editPayload(path.join(dir, "src", "m1.js"), dir, sid));
    const m2 = await runPre(editPayload(path.join(dir, "src", "m2.js"), dir, sid));
    assert.notEqual(decision(m1.stdout), "deny");
    assert.notEqual(decision(m2.stdout), "deny", "subagent edits didn't eat the budget");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── .muster/ writes are exempt (STATE bookkeeping) ──────────────────────────
test("no wave: edits under .muster/ don't consume the scale budget", async () => {
  const dir = noWaveDir();
  const sid = "scale-muster-1";
  clearBudget(sid);
  try {
    for (let i = 0; i < 4; i++) {
      const r = await runPre(editPayload(`.muster/note-${i}.md`, dir, sid));
      assert.notEqual(decision(r.stdout), "deny", ".muster/ edit allowed");
    }
    const m1 = await runPre(editPayload(path.join(dir, "src", "x.js"), dir, sid));
    const m2 = await runPre(editPayload(path.join(dir, "src", "y.js"), dir, sid));
    assert.notEqual(decision(m1.stdout), "deny");
    assert.notEqual(decision(m2.stdout), "deny", ".muster edits didn't eat the budget");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── MUSTER_WAVE_GUARD=off disables the scale gate ───────────────────────────
test("no wave: MUSTER_WAVE_GUARD=off lets the 3rd file through", async () => {
  const dir = noWaveDir();
  const sid = "scale-off-1";
  clearBudget(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid), { MUSTER_WAVE_GUARD: "off" });
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid), { MUSTER_WAVE_GUARD: "off" });
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, sid), { MUSTER_WAVE_GUARD: "off" });
    assert.notEqual(decision(c.stdout), "deny", "off => no scale gate");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── MUSTER_WAVE_GUARD=warn allows but attaches a reminder ───────────────────
test("no wave: MUSTER_WAVE_GUARD=warn allows 3rd file with a reminder", async () => {
  const dir = noWaveDir();
  const sid = "scale-warn-1";
  clearBudget(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid), { MUSTER_WAVE_GUARD: "warn" });
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid), { MUSTER_WAVE_GUARD: "warn" });
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, sid), { MUSTER_WAVE_GUARD: "warn" });
    const out = JSON.parse(c.stdout).hookSpecificOutput;
    assert.notEqual(out.permissionDecision, "deny", "warn => allowed");
    assert.match(out.additionalContext || "", /\/muster:go\b/, "warn attaches a routing reminder leading with /muster:go");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── missing session_id => fail-open (preserves legacy behavior) ─────────────
test("no wave: absent session_id disables the gate (fail-open)", async () => {
  const dir = noWaveDir();
  try {
    // No session_id in payload; 3 distinct in-cwd edits, none should deny.
    const p = (f) => JSON.stringify({ tool_name: "Edit", tool_input: { file_path: f }, cwd: dir });
    await runPre(p(path.join(dir, "a.js")));
    await runPre(p(path.join(dir, "b.js")));
    const c = await runPre(p(path.join(dir, "c.js")));
    assert.notEqual(decision(c.stdout), "deny", "no session => no gate");
  } finally {
    cleanDir(dir);
  }
});

// ── Bash escape hatch is closed: shell writes count toward the budget ───────
test("no wave: a high-confidence Bash file write counts toward the scale budget", async () => {
  const dir = noWaveDir();
  const sid = "scale-bash-1";
  clearBudget(sid);
  try {
    const a = await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    const b = await runPre(editPayload(path.join(dir, "b.js"), dir, sid));
    // 3rd distinct mutation is a shell write — must be gated, not a bypass.
    // Bash commands use the full command as the budget key (not the file path),
    // so GUARD-SCOPE does not apply (target="" for Bash).
    const c = await runPre(bashPayload("echo hi > /proj/c.js", dir, sid));
    assert.notEqual(decision(a.stdout), "deny");
    assert.notEqual(decision(b.stdout), "deny");
    assert.equal(decision(c.stdout), "deny", "shell write is not an escape hatch");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── sed -i writes to distinct files each consume a budget slot (no key-collapse)
test("no wave: distinct sed -i targets each consume budget (not one shared slot)", async () => {
  const dir = noWaveDir();
  const sid = "scale-sedi-1";
  clearBudget(sid);
  try {
    // Bash commands: target="" so GUARD-SCOPE does not apply; budget key is full command.
    const a = await runPre(bashPayload("sed -i 's/x/y/' /proj/a.js", dir, sid));
    const b = await runPre(bashPayload("sed -i 's/x/y/' /proj/b.js", dir, sid));
    const c = await runPre(bashPayload("sed -i 's/x/y/' /proj/c.js", dir, sid));
    assert.notEqual(decision(a.stdout), "deny", "1st sed -i allowed");
    assert.notEqual(decision(b.stdout), "deny", "2nd sed -i allowed");
    assert.equal(decision(c.stdout), "deny", "3rd distinct sed -i target denied — no key-collapse");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── mixed Edit + sed -i reaches the threshold together ──────────────────────
test("no wave: Edit + sed -i to distinct files reach the scale threshold", async () => {
  const dir = noWaveDir();
  const sid = "scale-sedi-2";
  clearBudget(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    // Bash sed -i: target="", budget key is full command.
    await runPre(bashPayload("sed -i 's/a/b/' /proj/b.js", dir, sid));
    const c = await runPre(bashPayload("sed -i 's/a/b/' /proj/c.js", dir, sid));
    assert.equal(decision(c.stdout), "deny", "editor + shell writes share one budget");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── non-write Bash never counts and never denies ────────────────────────────
test("no wave: read-only Bash commands don't consume the budget or deny", async () => {
  const dir = noWaveDir();
  const sid = "scale-bash-2";
  clearBudget(sid);
  try {
    for (let i = 0; i < 5; i++) {
      const r = await runPre(bashPayload(`ls -la /proj/dir${i}`, dir, sid));
      assert.notEqual(decision(r.stdout), "deny", "read-only bash allowed");
    }
    // budget untouched: two in-cwd edits still fall through
    const m1 = await runPre(editPayload(path.join(dir, "x.js"), dir, sid));
    const m2 = await runPre(editPayload(path.join(dir, "y.js"), dir, sid));
    assert.notEqual(decision(m1.stdout), "deny");
    assert.notEqual(decision(m2.stdout), "deny", "read-only bash didn't eat the budget");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── an active wave still routes through the wave-guard, not the scale gate ───
test("active wave: first inline edit already denied by wave-guard (unchanged)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-scale-test-"));
  makeMarker(dir, "wave-099");
  // Write run-active so the B-scoping logic sees a legitimately active wave
  // (wave-guard fires, not scale-gate).
  makeRunActive(dir);
  const sid = "scale-wave-1";
  clearBudget(sid);
  try {
    // In-cwd path: GUARD-SCOPE allows outside-cwd paths before wave-guard fires.
    const r = await runPre(editPayload(path.join(dir, "src", "a.js"), dir, sid));
    assert.equal(decision(r.stdout), "deny", "wave-guard denies from the 1st file");
    assert.match(JSON.parse(r.stdout).hookSpecificOutput.permissionDecisionReason, /wave-099/);
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── MUSTER_INLINE_SCALE override lowers the threshold ───────────────────────
test("no wave: MUSTER_INLINE_SCALE=2 denies the 2nd distinct file", async () => {
  const dir = noWaveDir();
  const sid = "scale-env-1";
  clearBudget(sid);
  try {
    const a = await runPre(editPayload(path.join(dir, "a.js"), dir, sid), { MUSTER_INLINE_SCALE: "2" });
    const b = await runPre(editPayload(path.join(dir, "b.js"), dir, sid), { MUSTER_INLINE_SCALE: "2" });
    assert.notEqual(decision(a.stdout), "deny", "1st allowed");
    assert.equal(decision(b.stdout), "deny", "2nd denied at threshold 2");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── stale marker (>60min) applies the scale gate, not the wave-guard ────────
test("stale marker: scale gate denies the 3rd distinct file (not wave-guard)", async () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "muster-scale-test-"));
  const stale = new Date(Date.now() - 61 * 60 * 1000);
  makeMarker(dir, "wave-stale", { mtime: stale });
  const sid = "scale-stale-1";
  clearBudget(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid));
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, sid));
    const out = JSON.parse(c.stdout).hookSpecificOutput;
    assert.equal(out.permissionDecision, "deny", "3rd file denied under stale marker");
    assert.doesNotMatch(out.permissionDecisionReason, /wave-stale/, "scale-gate reason, not wave-guard");
    assert.match(out.permissionDecisionReason, /\/muster:go\b/, "deny reason leads with /muster:go");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── a denied file stays counted: the 4th distinct file is also denied ───────
test("no wave: once tripped, subsequent distinct files stay denied", async () => {
  const dir = noWaveDir();
  const sid = "scale-post-1";
  clearBudget(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid));
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, sid));
    const d = await runPre(editPayload(path.join(dir, "d.js"), dir, sid));
    assert.equal(decision(c.stdout), "deny", "3rd denied");
    assert.equal(decision(d.stdout), "deny", "4th also denied (denied file stayed counted)");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── all non-empty exact session ids participate in the PreToolUse gate ──────
test("no wave: all-punctuation session_id is hashed and gated", async () => {
  const dir = noWaveDir();
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, "!!!"));
    await runPre(editPayload(path.join(dir, "b.js"), dir, "!!!"));
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, "!!!"));
    assert.equal(decision(c.stdout), "deny", "exact punctuation id gets its own budget");
  } finally {
    cleanDir(dir);
  }
});

// ── Bash write to an EXEMPT target doesn't consume budget in the no-wave gate ─
test("no wave: Bash write to /tmp (exempt) consumes no scale budget", async () => {
  const dir = noWaveDir();
  const sid = "scale-exempt-1";
  clearBudget(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid));
    // exempt-target shell write as the 3rd operation: must NOT trip the gate
    const t = await runPre(bashPayload("echo hi > /tmp/out.txt", dir, sid));
    assert.notEqual(decision(t.stdout), "deny", "/tmp write is exempt, no budget consumed");
    // ...and a genuine 3rd distinct in-cwd file still trips it
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, sid));
    assert.equal(decision(c.stdout), "deny", "real 3rd file still denied");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── UserPromptSubmit resets the per-turn budget ─────────────────────────────
test("a new user turn resets the scale budget", async () => {
  const dir = noWaveDir();
  const sid = "scale-reset-1";
  clearBudget(sid);
  try {
    await runPre(editPayload(path.join(dir, "a.js"), dir, sid));
    await runPre(editPayload(path.join(dir, "b.js"), dir, sid));
    const c = await runPre(editPayload(path.join(dir, "c.js"), dir, sid));
    assert.equal(decision(c.stdout), "deny", "3rd file denied before reset");

    // New user turn fires UserPromptSubmit for the same session.
    await spawnHook(UPS, JSON.stringify({ session_id: sid, prompt: "keep going" }));

    const d = await runPre(editPayload(path.join(dir, "d.js"), dir, sid));
    assert.notEqual(decision(d.stdout), "deny", "budget reset => new turn gets fresh allowance");
  } finally {
    clearBudget(sid);
    cleanDir(dir);
  }
});

// ── cumulative cross-turn drift counter ─────────────────────────────────────
// Careful 1-2-file-per-turn inline work never trips the per-turn gate no
// matter how many turns it spans. The cumulative counter (persists across
// UserPromptSubmit resets) closes that gap: once the total distinct files
// edited inline (with no muster run active) reaches the scale threshold, the
// caller gets a one-time WARN (never a deny) naming the count.

test("cumulative drift: 3rd distinct file across two turns warns (names the count), never denies", async () => {
  const dir = noWaveDir();
  const sid = "cum-drift-1";
  clearBudget(sid);
  clearCum(sid);
  try {
    const a = await runPre(editPayload(path.join(dir, "src", "fileA.js"), dir, sid));
    const b = await runPre(editPayload(path.join(dir, "src", "fileB.js"), dir, sid));
    assert.notEqual(decision(a.stdout), "deny", "turn 1, file A allowed");
    assert.notEqual(decision(b.stdout), "deny", "turn 1, file B allowed");
    assert.doesNotMatch(
      JSON.parse(a.stdout).hookSpecificOutput.additionalContext || "",
      /drift/i,
      "turn 1, file A: no cumulative-drift warning yet",
    );
    assert.doesNotMatch(
      JSON.parse(b.stdout).hookSpecificOutput.additionalContext || "",
      /drift/i,
      "turn 1, file B: no cumulative-drift warning yet",
    );

    // Simulate a new turn: reset the per-turn budget (what UserPromptSubmit
    // does), WITHOUT touching the cumulative file.
    await spawnHook(UPS, JSON.stringify({ session_id: sid, prompt: "keep going" }));

    const c = await runPre(editPayload(path.join(dir, "src", "fileC.js"), dir, sid));
    assert.notEqual(decision(c.stdout), "deny", "3rd distinct file overall, but fresh per-turn budget: allowed");
    const out = JSON.parse(c.stdout).hookSpecificOutput;
    assert.match(out.additionalContext || "", /drift/i, "cumulative-drift warning present");
    assert.match(out.additionalContext || "", /3/, "cumulative-drift warning names the count (3)");
  } finally {
    clearBudget(sid);
    clearCum(sid);
    cleanDir(dir);
  }
});

test("cumulative drift: warning fires once per session — the 4th file across turns is allowed with no repeated warn", async () => {
  const dir = noWaveDir();
  const sid = "cum-drift-2";
  clearBudget(sid);
  clearCum(sid);
  try {
    await runPre(editPayload(path.join(dir, "src", "fileA.js"), dir, sid));
    await runPre(editPayload(path.join(dir, "src", "fileB.js"), dir, sid));
    await spawnHook(UPS, JSON.stringify({ session_id: sid, prompt: "keep going" }));
    const c = await runPre(editPayload(path.join(dir, "src", "fileC.js"), dir, sid));
    assert.match(
      JSON.parse(c.stdout).hookSpecificOutput.additionalContext || "",
      /drift/i,
      "3rd distinct file: cumulative warning fires",
    );

    await spawnHook(UPS, JSON.stringify({ session_id: sid, prompt: "keep going" }));
    const d = await runPre(editPayload(path.join(dir, "src", "fileD.js"), dir, sid));
    assert.notEqual(decision(d.stdout), "deny", "4th distinct file across turns is allowed");
    assert.doesNotMatch(
      JSON.parse(d.stdout).hookSpecificOutput.additionalContext || "",
      /drift/i,
      "4th distinct file: no repeated cumulative warning (nudged flag)",
    );
  } finally {
    clearBudget(sid);
    clearCum(sid);
    cleanDir(dir);
  }
});

test("cumulative drift: re-editing the same file across turns never increments the cumulative count", async () => {
  const dir = noWaveDir();
  const sid = "cum-drift-same-1";
  clearBudget(sid);
  clearCum(sid);
  try {
    await runPre(editPayload(path.join(dir, "src", "only.js"), dir, sid));
    for (let i = 0; i < 4; i++) {
      await spawnHook(UPS, JSON.stringify({ session_id: sid, prompt: "keep going" }));
      const r = await runPre(editPayload(path.join(dir, "src", "only.js"), dir, sid));
      assert.notEqual(decision(r.stdout), "deny", `turn ${i + 2}: same-file re-edit allowed`);
      assert.doesNotMatch(
        JSON.parse(r.stdout).hookSpecificOutput.additionalContext || "",
        /drift/i,
        `turn ${i + 2}: re-editing the same file must never trip the cumulative warn`,
      );
    }
    const state = readCum(cumFile(sid, os.tmpdir()));
    assert.equal(state.files.length, 1, "cumulative distinct count stays at 1 across repeated same-file edits");
  } finally {
    clearBudget(sid);
    clearCum(sid);
    cleanDir(dir);
  }
});

test("cumulative drift: an active muster run resets the cumulative counter and doesn't record", async () => {
  const dir = noWaveDir();
  const sid = "cum-drift-run-1";
  clearBudget(sid);
  clearCum(sid);
  const cFile = cumFile(sid, os.tmpdir());
  writeFileSync(cFile, JSON.stringify({ files: ["x.js", "y.js"], nudged: false }));
  makeRunActive(dir);
  try {
    const r = await runPre(editPayload(path.join(dir, "src", "z.js"), dir, sid));
    assert.notEqual(decision(r.stdout), "deny", "per-turn behavior unchanged while a run is active");
    assert.doesNotMatch(
      JSON.parse(r.stdout).hookSpecificOutput.additionalContext || "",
      /drift/i,
      "no cumulative-drift warning while a muster run is active",
    );
    assert.deepEqual(
      readCum(cFile),
      { files: [], nudged: false },
      "cumulative file reset while a muster run is active — no cross-turn accumulation during a run",
    );
  } finally {
    clearBudget(sid);
    clearCum(sid);
    cleanDir(dir);
  }
});

test("cumulative drift: a corrupt cum file is treated as empty, never crashes the gate", async () => {
  const dir = noWaveDir();
  const sid = "cum-drift-corrupt-1";
  clearBudget(sid);
  clearCum(sid);
  const cFile = cumFile(sid, os.tmpdir());
  writeFileSync(cFile, "{{{ not json at all");
  try {
    const r = await runPre(editPayload(path.join(dir, "src", "a.js"), dir, sid));
    assert.equal(r.code, 0, "exit 0 despite a corrupt cumulative file");
    assert.notEqual(decision(r.stdout), "deny", "corrupt cum file fails open (treated empty)");
  } finally {
    clearBudget(sid);
    clearCum(sid);
    cleanDir(dir);
  }
});
