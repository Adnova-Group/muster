// test/test-support/hook-helpers.js — shared boilerplate for hook integration tests.
//
// Exports:
//   cleanDir(dir)               — rm -rf the directory, best-effort (ignores errors)
//   makeMarker(dir, waveId, opts) — write .muster/wave-active into an existing dir;
//                                   creates the .muster/ subdirectory if needed;
//                                   opts.mtime sets the marker file's mtime.
//   makeRunActive(dir, content) — write .muster/run-active into an existing dir;
//                                   creates the .muster/ subdirectory if needed.
//   editPayload(filePath, cwd, extra) — build a PreToolUse Edit-tool JSON payload.
//   spawnHook(hookPath, stdinText, env) — spawn `node hookPath`, pipe stdinText to
//                                   stdin, return { stdout, code }. Never rejects.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * Return a unique, per-run session id derived from `base`.
 *
 * The hook border-invitation markers (inline-budget.js: cumFile/cooldownFile/
 * directiveFile, and the Codex port's `muster-codex-border-*`) derive a
 * HOST-GLOBAL os.tmpdir() path from the session id ALONE. A test that hardcodes
 * a fixed sid therefore shares that exact path with every other process on the
 * host using the same sid -- so two concurrent full-suite runners (muster's own
 * wave model runs several worktrees' `npm test` at once) run the SAME hook test
 * against the SAME marker files and clobber each other's crossing state. Giving
 * each run a private sid gives it a private marker path, so the tests can never
 * collide. This is the general form of the mkdtemp-suffix trick
 * hook-border-long-session-sim.test.js already uses for exactly this reason.
 *
 * The result stays inside inline-budget.js's safeSession() charset
 * ([A-Za-z0-9_-]) so it survives sanitization byte-for-byte: callers pass a
 * `base` literal in that charset, process.pid is digits, and randomBytes hex is
 * [0-9a-f]. Both the pid and the crypto-random suffix are included so distinct
 * concurrent processes (same base) and repeated calls within one process (same
 * pid) are each unique.
 *
 * @param {string} base - stable, human-readable prefix (e.g. "border-flap")
 * @returns {string} `${base}-${pid}-${hex}`
 */
export function uniqueSid(base = "sid") {
  return `${base}-${process.pid}-${randomBytes(8).toString("hex")}`;
}

/**
 * Remove `dir` recursively, ignoring errors (best-effort cleanup).
 * @param {string} dir
 */
export function cleanDir(dir) {
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
}

/**
 * Write `.muster/wave-active` into an existing directory.
 * Creates `.muster/` if it does not exist.
 *
 * @param {string} dir    - pre-existing directory to write into
 * @param {string} waveId - content written to the marker file (default "wave-001")
 * @param {{ mtime?: Date|null }} opts - optional mtime to set on the marker file
 */
export function makeMarker(dir, waveId = "wave-001", { mtime = null } = {}) {
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  const markerPath = path.join(dir, ".muster", "wave-active");
  writeFileSync(markerPath, waveId);
  if (mtime !== null) {
    utimesSync(markerPath, mtime, mtime);
  }
}

/**
 * Write `.muster/run-active` into an existing directory.
 * Creates `.muster/` if it does not exist.
 *
 * @param {string} dir     - pre-existing directory to write into
 * @param {string} content - content written to the marker file (default "run-001")
 */
export function makeRunActive(dir, content = "run-001") {
  mkdirSync(path.join(dir, ".muster"), { recursive: true });
  writeFileSync(path.join(dir, ".muster", "run-active"), content);
}

/**
 * Build a PreToolUse Edit-tool JSON payload targeting `filePath` with the
 * given `cwd`. `extra` fields (e.g. session_id, agent_id) are merged in.
 *
 * @param {string} filePath
 * @param {string} cwd
 * @param {object} extra
 * @returns {string} JSON-stringified payload
 */
export function editPayload(filePath, cwd, extra = {}) {
  return JSON.stringify({
    tool_name: "Edit",
    tool_input: { file_path: filePath },
    cwd,
    ...extra,
  });
}

/**
 * Spawn `node hookPath`, pipe `stdinText` to stdin, and resolve with
 * `{ stdout, code }`. Never rejects.
 *
 * @param {string} hookPath   - absolute path to the hook .js file
 * @param {string} stdinText  - text sent to the hook's stdin
 * @param {object} env        - extra env vars merged over process.env
 * @returns {Promise<{ stdout: string, code: number }>}
 */
export function spawnHook(hookPath, stdinText, env = {}) {
  return new Promise((resolve) => {
    const child = execFile(
      "node",
      [hookPath],
      { env: { ...process.env, ...env } },
      (err, stdout) => {
        resolve({ stdout: stdout ?? err?.stdout ?? "", code: err?.code ?? 0 });
      },
    );
    child.stdin.end(stdinText);
  });
}
