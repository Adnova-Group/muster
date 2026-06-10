// test/test-support/hook-helpers.js — shared boilerplate for hook integration tests.
//
// Exports:
//   cleanDir(dir)               — rm -rf the directory, best-effort (ignores errors)
//   makeMarker(dir, waveId, opts) — write .muster/wave-active into an existing dir;
//                                   creates the .muster/ subdirectory if needed;
//                                   opts.mtime sets the marker file's mtime.
//   spawnHook(hookPath, stdinText, env) — spawn `node hookPath`, pipe stdinText to
//                                   stdin, return { stdout, code }. Never rejects.

import { execFile } from "node:child_process";
import { mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import path from "node:path";

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
