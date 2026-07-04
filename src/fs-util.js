import { readdir, readFile, stat } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Normalizes a dir argument to a filesystem path string.
// Accepts a URL instance (fileURLToPath) or a bare string — callers need not branch.
export function resolveDir(dir) {
  return dir instanceof URL ? fileURLToPath(dir) : dir;
}

// Resolves a relative path from a module's import.meta.url to a filesystem path.
// Uses fileURLToPath so the result is correct on all platforms — in particular,
// on native Windows Node a bare `new URL(rel, importMetaUrl).pathname` yields
// `/C:/...` which breaks path.join; fileURLToPath normalises it to `C:\...`.
export function dirFromImportMeta(importMetaUrl, rel) {
  return fileURLToPath(new URL(rel, importMetaUrl));
}

// Canonical existence check. Returns false ONLY for a genuinely-absent path
// (ENOENT) or a non-directory component in the path (ENOTDIR). Any other error
// (EACCES, EIO, …) rethrows — a permission or IO fault must fail loud, not be
// silently reported as "doesn't exist".
export async function exists(p) {
  try { await stat(p); return true; }
  catch (err) {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return false;
    throw err;
  }
}

// Reads + parses JSON with graceful degradation that distinguishes the two
// failure modes: a genuinely-absent/unreadable file stays silent and returns
// null; a file that is present but not valid JSON warns to stderr (fail loud)
// while still returning null so callers degrade rather than crash.
export async function readJson(p) {
  let raw;
  try {
    raw = await readFile(p, "utf8");
  } catch {
    return null; // absent (ENOENT) or unreadable — silent
  }
  try {
    return JSON.parse(raw);
  } catch {
    process.stderr.write(`muster: warning: ${p} is present but not valid JSON\n`);
    return null;
  }
}

// Directory listing with graceful degradation: a missing dir, a plain file, or
// any unreadable path lists as empty rather than throwing.
export async function readdirSafe(p) {
  try { return await readdir(p); } catch { return []; }
}
