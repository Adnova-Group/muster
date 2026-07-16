// muster inline-edit budget — per-session state backing the PreToolUse
// border invitation (see pre-tool-use.js) and the UserPromptSubmit
// isDirective nudge (see user-prompt-submit.js).
//
// muster's enforcement stack has exactly one warn-only "border invitation"
// surface, fed by two independent signals that share the same re-arm cadence:
//   - PreToolUse: a cumulative distinct-inline-file counter (cumFile/
//     recordCum/markNudged/resetCum below) — the Nth distinct file touched
//     inline across turns, with no muster run active, crosses the border.
//   - UserPromptSubmit: the isDirective prompt detector (guidance.js),
//     tracked by a per-session marker file (directiveFile below).
//
// Both signals warn ONCE PER CROSSING (never denying — the action fence in
// pre-tool-use.js is the only hard deny in the stack), then stay silent until
// the crossing is re-armed by one of three triggers:
//   (a) a muster run starting (.muster/run-active observed present),
//   (b) SessionStart (a genuinely fresh session — see session-start.js),
//   (c) age — the marker file's last update is older than CROSSING_MAX_AGE_MS,
//       treated as a new crossing window even with no explicit reset.
// isCrossingStale() implements (c) as one shared, pure, unit-tested rule so
// both signals re-arm identically; (a) and (b) are explicit resets performed
// by each call site (resetCum here; unlinking directiveFile in
// session-start.js/user-prompt-submit.js).
//
// State is per-session in os.tmpdir() (never litters project trees, never
// collides across sessions).
//
// SELF-CONTAINED: only node: builtins. Ships under plugin/hooks/ with the hooks.

import { readFileSync, writeFileSync, statSync, lstatSync, unlinkSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { envInt } from "./env-util.js";

// Symlink-safe write (CWE-59 hardening): the marker files below live in a
// shared, world-writable tmpdir (os.tmpdir()) keyed only by a sanitized
// session id -- a co-resident, less-privileged process on the same host can
// plant a symlink at that exact path before this hook ever runs. A plain
// writeFileSync(file, ...) follows a symlink at `file` and truncates/
// overwrites whatever it points to. Refuse that: if something already sits at
// `file` and it is not a plain regular file (a symlink, fifo, etc.), remove it
// first so the write always lands on a fresh regular file at this exact path,
// never wherever a symlink resolves to. ENOENT (nothing there yet, the common
// case) needs no action. Any other lstat/unlink failure is swallowed here so
// the write below still attempts and surfaces its own error to the caller,
// exactly as before this guard existed (every call site already wraps its
// writeFileSync in a best-effort try/catch).
function safeWriteFileSync(file, content) {
  try {
    const st = lstatSync(file);
    if (!st.isFile()) unlinkSync(file);
  } catch {
    // ENOENT, or unlink failed (e.g. EISDIR on a directory) -- fall through;
    // writeFileSync below throws its own error in that case.
  }
  writeFileSync(file, content);
}

// Distinct-file count at which the cumulative counter crosses the border and
// warns (so 1..N-1 fall through silently, the Nth crosses it).
export const DEFAULT_SCALE = 3;

export function scaleThreshold(env = process.env) {
  // min: 2 — a threshold of 1 would warn on the very first file touched
  // inline every turn, which defeats the "trivial/surgical falls through"
  // routing policy this border is meant to protect.
  return envInt("MUSTER_INLINE_SCALE", { min: 2, def: DEFAULT_SCALE }, env);
}

// Sanitize a session id for use in a filename; null if nothing usable remains.
export function safeSession(sessionId) {
  if (typeof sessionId !== "string") return null;
  const s = sessionId.replace(/[^a-zA-Z0-9_-]/g, "");
  return s.length > 0 ? s : null;
}

// How long (ms) a border-invitation marker may sit untouched before its
// crossing is considered stale and re-arms on the next observation. Shared by
// both signals via isCrossingStale() below.
export const CROSSING_MAX_AGE_MS = 60 * 60 * 1000; // 60 minutes

// True when `mtimeMs` (a marker file's last-modified time) is old enough that
// its crossing should be treated as re-armed rather than still-warned. A
// non-number (no prior marker) is never stale — there is nothing to re-arm.
export function isCrossingStale(mtimeMs, now = Date.now()) {
  return typeof mtimeMs === "number" && isFinite(mtimeMs) && (now - mtimeMs) > CROSSING_MAX_AGE_MS;
}

// ── cumulative cross-turn drift counter (PreToolUse border signal) ─────────
//
// Tracks distinct inline-edited-file keys (resolved edit target, or the full
// Bash command for a high-confidence shell write) across turns, with no
// muster run active. Reset when a muster run starts (that work is tracked/
// dispatched, not drift) and at SessionStart; also re-arms on its own if left
// untouched past CROSSING_MAX_AGE_MS (see recordCum below).

// Absolute path to the per-session cumulative file, or null if the session id
// is unusable.
export function cumFile(sessionId, tmp = os.tmpdir()) {
  const s = safeSession(sessionId);
  return s ? path.join(tmp, `muster-cum-${s}`) : null;
}

// ── once-per-crossing directive-nudge marker ────────────────────────────────
//
// Absolute path to the per-session directive-nudge marker file (see
// isDirective in guidance.js / user-prompt-submit.js), or null if the session
// id is unusable. Distinct filename from cumFile so the two never collide —
// this is a separate signal (prompt-shaped, not file-count-shaped) sharing
// the same re-arm cadence.
export function directiveFile(sessionId, tmp = os.tmpdir()) {
  const s = safeSession(sessionId);
  return s ? path.join(tmp, `muster-directive-${s}`) : null;
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
  try { safeWriteFileSync(file, JSON.stringify({ files: [], nudged: false })); } catch { /* best-effort */ }
}

// Add `key` to the cumulative distinct-file set if absent, persist, and return
// the resulting { count, nudged }. Re-adding an already-recorded key does not
// increase the count. If the file's own mtime shows this crossing has gone
// stale (untouched past CROSSING_MAX_AGE_MS), the prior state is discarded
// first — this call starts a fresh crossing rather than resuming a stale one.
export function recordCum(file, key, now = Date.now()) {
  let mtimeMs = null;
  try { mtimeMs = statSync(file).mtimeMs; } catch { mtimeMs = null; }

  const state = isCrossingStale(mtimeMs, now) ? { files: [], nudged: false } : readCum(file);
  if (!state.files.includes(key)) state.files.push(key);
  try { safeWriteFileSync(file, JSON.stringify(state)); } catch { /* best-effort */ }
  return { count: state.files.length, nudged: state.nudged };
}

// Mark the once-per-crossing cumulative-drift warning as already fired.
export function markNudged(file) {
  const state = readCum(file);
  state.nudged = true;
  try { safeWriteFileSync(file, JSON.stringify(state)); } catch { /* best-effort */ }
}
