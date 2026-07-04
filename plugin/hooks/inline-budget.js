// muster inline-edit budget — per-turn, per-session state backing the PreToolUse
// scale gate.
//
// The wave-guard (pre-tool-use.js) only fires WHILE a wave marker is present. The
// window AFTER a run completes (marker removed) has no harness-level enforcement,
// so the orchestrator can drift back to doing orchestration-scale work inline. This
// module bounds that: the main loop may touch 1-2 distinct files per turn (trivial
// /surgical work falls through, per the routing policy), but the Nth distinct file
// in a single turn is orchestration-scale and gets gated back to a verb — matching
// muster's surgeon "refuses 3+ files" boundary.
//
// State is per-session in os.tmpdir() (same pattern as the nudge turn-counter), so
// it never litters project trees and never collides across sessions. Reset on every
// UserPromptSubmit (a new turn = a fresh allowance).
//
// SELF-CONTAINED: only node: builtins. Ships under plugin/hooks/ with the hooks.

import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { envInt } from "./env-util.js";

// Distinct-file count at which an inline turn is treated as orchestration-scale.
// Deny fires when the count REACHES this (so 1..N-1 fall through, the Nth is gated).
export const DEFAULT_SCALE = 3;

export function scaleThreshold(env = process.env) {
  // min: 2 — a threshold of 1 would deny the very first file in every turn
  // (no trivial/surgical fallthrough), which is what MUSTER_WAVE_GUARD is for.
  // Junk/negative/1 therefore fall back to the default.
  return envInt("MUSTER_INLINE_SCALE", { min: 2, def: DEFAULT_SCALE }, env);
}

// Sanitize a session id for use in a filename; null if nothing usable remains.
// Exported so the sibling turn-counter (user-prompt-submit.js) shares one rule.
export function safeSession(sessionId) {
  if (typeof sessionId !== "string") return null;
  const s = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return s.length > 0 ? s : null;
}

// Absolute path to the per-session budget file, or null if the session id is unusable.
export function budgetFile(sessionId, tmp = os.tmpdir()) {
  const s = safeSession(sessionId);
  return s ? path.join(tmp, `muster-inline-${s}`) : null;
}

// ── cumulative cross-turn drift counter ─────────────────────────────────────
//
// The per-turn budget above (budgetFile/readBudget/resetBudget/recordFile) is
// wiped every UserPromptSubmit, so careful 1-2-file-per-turn inline work never
// trips it no matter how many turns it spans. This second, cumulative counter
// persists ACROSS turns (never reset by UserPromptSubmit) so that drift is
// still visible: once the total distinct inline-edited files reaches the
// scale threshold with no muster run active, the caller warns once per
// session. It is reset when a muster run starts (the run tracks/dispatches
// that work, so it's no longer "drift") and at SessionStart (fresh session).
//
// Same key space as the per-turn budget (resolved edit target, or the full
// Bash command for a high-confidence shell write) so "the same file again"
// never double-counts here either.

// Absolute path to the per-session cumulative file, or null if the session id
// is unusable. Distinct filename from budgetFile so the two never collide.
export function cumFile(sessionId, tmp = os.tmpdir()) {
  const s = safeSession(sessionId);
  return s ? path.join(tmp, `muster-cum-${s}`) : null;
}

// Read the cumulative state: { files: string[], nudged: boolean }.
// Missing/corrupt/malformed -> the empty shape (never throws).
export function readCum(file) {
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const v = raw && typeof raw === "object" ? raw : {};
    const files = Array.isArray(v.files) ? v.files.filter((x) => typeof x === "string") : [];
    const nudged = Boolean(v.nudged);
    return { files, nudged };
  } catch {
    return { files: [], nudged: false };
  }
}

// Reset the cumulative state to empty (new session, or a muster run started).
export function resetCum(file) {
  try { writeFileSync(file, JSON.stringify({ files: [], nudged: false })); } catch { /* best-effort */ }
}

// Add `key` to the cumulative distinct-file set if absent, persist, and return
// the resulting { count, nudged }. Re-adding an already-recorded key does not
// increase the count (matches recordFile's re-edit semantics).
export function recordCum(file, key) {
  const state = readCum(file);
  if (!state.files.includes(key)) state.files.push(key);
  try { writeFileSync(file, JSON.stringify(state)); } catch { /* best-effort */ }
  return { count: state.files.length, nudged: state.nudged };
}

// Mark the once-per-session cumulative-drift warning as already fired.
export function markNudged(file) {
  const state = readCum(file);
  state.nudged = true;
  try { writeFileSync(file, JSON.stringify(state)); } catch { /* best-effort */ }
}

// Read the turn's distinct-file set (array of strings). Missing/corrupt → [].
export function readBudget(file) {
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Clear the turn's budget (start of a new user turn).
export function resetBudget(file) {
  try { writeFileSync(file, "[]"); } catch { /* best-effort */ }
}

// Add `target` to the distinct-file set, persist, and return the new distinct count.
// Re-adding a file already recorded this turn does not increase the count.
//
// The entry is persisted UNCONDITIONALLY: a caller that goes on to deny the tool
// call does not roll back, so a retry of the same target finds it already counted
// (no double-count) and a retry of a *different* target correctly raises the count.
//
// NOT atomic (read-modify-write, no lock). Safe because main-loop tool calls are
// sequential in this harness; only agent_id-bearing subagents run concurrently and
// they never reach this path. If parallel main-loop tool calls are ever introduced,
// switch to a temp-file + rename swap.
export function recordFile(file, target) {
  const files = readBudget(file);
  if (!files.includes(target)) files.push(target);
  try { writeFileSync(file, JSON.stringify(files)); } catch { /* best-effort */ }
  return files.length;
}
