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

import {
  readFileSync, writeFileSync, openSync, closeSync, fstatSync, lstatSync,
  mkdirSync, chmodSync, renameSync, unlinkSync, fsyncSync, constants,
} from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash, randomBytes } from "node:crypto";
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

const NOFOLLOW = constants.O_NOFOLLOW || 0;

// Hash the exact session id for use in a filename. This neither discloses the id
// in the shared temp namespace nor aliases distinct ids through sanitization.
export function safeSession(sessionId) {
  if (typeof sessionId !== "string" || sessionId.length === 0) return null;
  return createHash("sha256").update(sessionId, "utf8").digest("hex");
}

function stateDirectory(tmp) {
  const identity = typeof process.getuid === "function"
    ? String(process.getuid())
    : createHash("sha256").update(os.userInfo().username).digest("hex").slice(0, 16);
  const dir = path.join(tmp, `muster-hook-state-${identity}`);
  try { mkdirSync(dir, { mode: 0o700 }); } catch (error) { if (error?.code !== "EEXIST") throw error; }
  const info = lstatSync(dir);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("unsafe muster hook state directory");
  if (typeof process.getuid === "function" && info.uid !== process.getuid())
    throw new Error("muster hook state directory has the wrong owner");
  if (process.platform !== "win32") {
    chmodSync(dir, 0o700);
    if ((lstatSync(dir).mode & 0o077) !== 0) throw new Error("muster hook state directory is not private");
  }
  return dir;
}

function sessionFile(kind, sessionId, tmp = os.tmpdir()) {
  const hash = safeSession(sessionId);
  if (!hash) return null;
  try { return path.join(stateDirectory(tmp), `muster-${kind}-${hash}`); }
  catch { return null; }
}

function regularInfo(file) {
  try {
    const info = lstatSync(file);
    return !info.isSymbolicLink() && info.isFile() ? info : null;
  } catch { return null; }
}

export function readStateText(file) {
  let fd;
  try {
    const before = regularInfo(file);
    if (!before) return null;
    fd = openSync(file, constants.O_RDONLY | NOFOLLOW);
    const opened = fstatSync(fd);
    if (!opened.isFile() || (before.ino && opened.ino && (before.ino !== opened.ino || before.dev !== opened.dev))) return null;
    return readFileSync(fd, "utf8");
  } catch { return null; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* best-effort */ } }
}

export function stateFileExists(file) {
  return readStateText(file) !== null;
}

export function replaceState(file, content) {
  const parent = path.dirname(file);
  const parentInfo = (() => { try { return lstatSync(parent); } catch { return null; } })();
  if (!parentInfo?.isDirectory() || parentInfo.isSymbolicLink()) return false;
  const existing = (() => { try { return lstatSync(file); } catch (error) { return error?.code === "ENOENT" ? undefined : null; } })();
  if (existing === null || (existing && (existing.isSymbolicLink() || !existing.isFile()))) return false;
  const bytes = Buffer.from(content);
  const temp = path.join(parent, `.${path.basename(file)}.${process.pid}.${randomBytes(12).toString("hex")}.muster-tmp-`);
  let fd;
  try {
    fd = openSync(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    writeFileSync(fd, bytes);
    fsyncSync(fd);
    closeSync(fd);
    fd = undefined;
    const staged = readStateText(temp);
    if (staged === null || !Buffer.from(staged).equals(bytes)) return false;
    const current = (() => { try { return lstatSync(file); } catch (error) { return error?.code === "ENOENT" ? undefined : null; } })();
    if (current === null || (current && (current.isSymbolicLink() || !current.isFile()))) return false;
    renameSync(temp, file);
    const published = readStateText(file);
    return published !== null && Buffer.from(published).equals(bytes);
  } catch { return false; }
  finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best-effort */ }
    try { unlinkSync(temp); } catch { /* renamed or never created */ }
  }
}

// Absolute path to the per-session budget file, or null if the session id is unusable.
export function budgetFile(sessionId, tmp = os.tmpdir()) {
  return sessionFile("inline", sessionId, tmp);
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
  return sessionFile("cum", sessionId, tmp);
}

// ── once-per-session directive-nudge marker ─────────────────────────────────
//
// Absolute path to the per-session directive-nudge marker file (see isDirective
// in guidance.js / user-prompt-submit.js), or null if the session id is
// unusable. Same safeSession/null pattern as cumFile, distinct filename so it
// never collides with the budget/cumulative files.
export function directiveFile(sessionId, tmp = os.tmpdir()) {
  return sessionFile("directive", sessionId, tmp);
}

export function turnFile(sessionId, tmp = os.tmpdir()) {
  return sessionFile("turns", sessionId, tmp);
}

// Read the cumulative state: { files: string[], nudged: boolean }.
// Missing/corrupt/malformed -> the empty shape (never throws).
export function readCum(file) {
  try {
    const text = readStateText(file);
    if (text === null) return { files: [], nudged: false };
    const raw = JSON.parse(text);
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
  replaceState(file, JSON.stringify({ files: [], nudged: false }));
}

// Add `key` to the cumulative distinct-file set if absent, persist, and return
// the resulting { count, nudged }. Re-adding an already-recorded key does not
// increase the count (matches recordFile's re-edit semantics).
export function recordCum(file, key) {
  const state = readCum(file);
  if (!state.files.includes(key)) state.files.push(key);
  replaceState(file, JSON.stringify(state));
  return { count: state.files.length, nudged: state.nudged };
}

// Mark the once-per-session cumulative-drift warning as already fired.
export function markNudged(file) {
  const state = readCum(file);
  state.nudged = true;
  replaceState(file, JSON.stringify(state));
}

// Read the turn's distinct-file set (array of strings). Missing/corrupt → [].
export function readBudget(file) {
  try {
    const text = readStateText(file);
    if (text === null) return [];
    const v = JSON.parse(text);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

// Clear the turn's budget (start of a new user turn).
export function resetBudget(file) {
  replaceState(file, "[]");
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
  replaceState(file, JSON.stringify(files));
  return files.length;
}
