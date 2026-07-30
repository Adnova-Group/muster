// Shared filesystem-safety primitives (audit S4): the single home for the
// no-follow regular-file read, the temp-write-then-rename atomic write, the
// path-containment guards (lexical + canonical), and the traversal-token guard
// that used to be re-implemented -- with subtly divergent semantics -- across
// init.js, install.js, codex-release.js, codex-doctor.js, vendor.js,
// codex-install.js, kimi-install.js, scope.js, and batch-plan.js.
//
// Each primitive below carries the exact contract its original call sites
// pinned (error messages included -- tests match on them); the call sites now
// wrap these with their own labeling rather than re-implementing the syscall
// discipline. The comments on each primitive preserve the TOCTOU rationale
// from the original implementations -- read them before changing anything.

import { closeSync, constants as fsConstants, fstatSync, openSync, readFileSync } from "node:fs";
import { lstat, open, realpath, rename, rm, unlink } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

// --- Traversal-token guards --------------------------------------------------

// Windows drive-letter ("C:\x" or "C:/x") and backslash-rooted ("\x", including
// the double-backslash UNC form "\\server\x") path shapes. node:path's
// isAbsolute is platform-DYNAMIC: on a POSIX runtime it returns false for all
// of these (path.win32.isAbsolute treats a single leading backslash as absolute
// too, not just the double-backslash UNC form), so a Windows-absolute candidate
// would otherwise slip through a POSIX-side guard as merely "relative" and
// reach join()/readFile(). Checking these shapes explicitly makes the verdict
// platform-independent instead of platform-dynamic.
const WINDOWS_DRIVE_RE = /^[A-Za-z]:[\\/]/;
// A single leading backslash also matches the double-backslash UNC form, so
// this one pattern covers both shapes.
const WINDOWS_UNC_RE = /^\\/;

// True when a token names an absolute location on EITHER platform's shape
// rules (POSIX-absolute, Windows drive-letter, or Windows backslash-rooted/UNC)
// -- or is not a string at all. An absolute token names an out-of-project file
// outright; no ".." traversal is needed.
export function isAbsolutePathToken(token) {
  return (
    typeof token !== "string" ||
    isAbsolute(token) ||
    WINDOWS_DRIVE_RE.test(token) ||
    WINDOWS_UNC_RE.test(token)
  );
}

// Traversal guard for an untrusted path token (CLI text, issue text, manifest
// entries): rejects anything isAbsolutePathToken rejects plus any ".." substring
// anywhere in the token, before the token ever reaches join()/readFile(). The
// ".." check is deliberately a raw substring match (not a segment match): a
// literal ".." inside a filename (e.g. "notes..txt") trips it too -- a false
// positive that degrades to "not a file ref", never a security hole.
export function isUnsafePathToken(token) {
  return isAbsolutePathToken(token) || (typeof token === "string" && token.includes(".."));
}

// --- Lexical path validation -------------------------------------------------

// init.js's safeRelative, verbatim: a strictly lexical validator for a
// single-`/`-separated relative path that is about to be join()ed under a root.
// Rejects empty/oversized/NUL-bearing/backslash-bearing/absolute/drive-letter/
// UNC-shaped input and any empty, ".", or ".." segment. Returns the input
// unchanged so it can wrap an expression.
export function safeRelativePath(path) {
  if (typeof path !== "string" || Buffer.byteLength(path) < 1 || Buffer.byteLength(path) > 256 ||
      path.includes("\0") || path.includes("\\") || isAbsolute(path) || /^[A-Za-z]:/.test(path) ||
      path.startsWith("//")) throw new Error(`unsafe relative path: ${path}`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe relative path: ${path}`);
  return path;
}

// --- Containment guards ------------------------------------------------------

// LEXICAL containment: true when `target` resolves to `base` itself or to a
// path strictly inside it, comparing resolve()d paths via relative() only --
// no symlink resolution, no IO. An escape shows up as a ".." (or absolute, on
// win32 cross-drive) relative result. The base itself counts as contained
// (relative() returns "" for equal paths).
//
// On win32, relative() returns `target` itself (still absolute, unchanged) when
// `base` and `target` are on different drives -- there is no relative path
// across drives -- which would otherwise slip past the ".." checks undetected,
// so the isAbsolute(rel) arm is load-bearing there, not redundant.
export function isContainedLexical(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel === "" || rel === "." ||
    (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}

// CANONICAL containment: realpath() both sides, then require the canonical
// target to remain under the canonical base. This is the check that closes
// symlink escapes a lexical guard cannot see (a repo-internal symlink whose
// TARGET points outside the root resolves inside lexically but escapes
// canonically). Returns the canonical target path when it exists and is
// contained; returns null when the canonical target escapes the canonical
// base, or when the target cannot be canonicalized at all (missing, dangling
// or looping symlink, over-long name, unresolvable component -- all the same
// benign "not a readable candidate" answer the caller's own read failure would
// have produced). A failure to canonicalize the BASE is not benign and throws.
export async function resolveContainedRealpath(base, target) {
  const realBase = await realpath(resolve(base));
  let realTarget;
  try {
    realTarget = await realpath(resolve(realBase, target));
  } catch {
    return null;
  }
  return isContainedLexical(realBase, realTarget) ? realTarget : null;
}

// --- No-follow regular-file reads --------------------------------------------

// Tag the shared-implementation errors so wrappers can translate them back
// into their own historical contracts (kind-tagged returns, musterUnsafeRead
// diagnostics) without string-matching. The MESSAGE is always the original
// init.js wording -- init.js's tests pin it.
function tagFsSafe(error, detail) {
  error.fsSafe = detail;
  return error;
}

// Descriptor-pinned no-follow read (init.js's original, and the run-5 audit
// Med #6 contract). O_NOFOLLOW makes the open itself refuse to traverse a
// symlinked FINAL component (a same-user writer swapping the file for a symlink
// after any prior lstat cannot redirect the read to the link's target), and
// the size/type gate is asserted with fstat on the RETURNED descriptor -- never
// a second lstat(path), which would re-resolve the name and reopen the very
// TOCTOU the descriptor exists to pin. O_NOFOLLOW guards only the final
// component; a symlinked ANCESTOR is still followed (Node has no openat to hold
// each parent by descriptor), which is why callers layer ancestry walks on top.
//
// Contract (exactly init.js's original): throws `unsafe regular file: <label>`
// for a non-regular file, a multi-linked file when requireSingleLink is set, or
// a file over maxBytes; throws `file changed while reading: <label>` when the
// descriptor's identity (ino/dev vs an expectedInfo lstat, or a post-read
// fstat comparison of ino/dev/size/nlink/type) moved mid-read; propagates
// system errors (ENOENT from the open, ELOOP when O_NOFOLLOW refuses a
// symlink) untouched. Returns { bytes, info } with the pre-read fstat.
export async function readNoFollowRegular(path, { maxBytes, label, expectedInfo = null, requireSingleLink = false } = {}) {
  let handle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0),
    );
    const info = await handle.stat();
    if (!info.isFile() || (requireSingleLink && info.nlink !== 1)) {
      throw tagFsSafe(new Error(`unsafe regular file: ${label}`), { reason: "not-regular" });
    }
    if (info.size > maxBytes) {
      throw tagFsSafe(new Error(`unsafe regular file: ${label}`), { reason: "too-large", size: info.size });
    }
    if (expectedInfo && (info.ino !== expectedInfo.ino || info.dev !== expectedInfo.dev)) {
      throw tagFsSafe(new Error(`file changed while reading: ${label}`), { reason: "changed" });
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size ||
        after.nlink !== info.nlink || !after.isFile()) {
      throw tagFsSafe(new Error(`file changed while reading: ${label}`), { reason: "changed" });
    }
    return { bytes, info };
  } finally {
    await handle?.close();
  }
}

// --- Cooperative mutation locks ---------------------------------------------

// Serialize a complete read-transform-publish transaction for one file. The
// sibling lock is itself opened O_EXCL|O_NOFOLLOW, so a planted symlink can
// neither win acquisition nor redirect lock bytes. Every existing ancestor is
// checked before lock creation because O_NOFOLLOW protects only the final
// component. Contention is bounded: a crashed writer leaves a stale lock that
// makes later writers fail after timeoutMs rather than guessing that it is safe
// to steal a lock from a merely slow writer.
//
// The callback MUST perform the read and validation after acquisition and keep
// the lock until publication completes. Locking only atomicWrite's rename would
// leave the validation-to-publication race open.
export async function withFileMutationLock(path, callback, {
  timeoutMs = 5_000,
  retryMs = 10,
} = {}) {
  if (typeof callback !== "function") throw new TypeError("file mutation lock callback must be a function");
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0) throw new TypeError("file mutation lock timeoutMs must be non-negative");
  if (!Number.isFinite(retryMs) || retryMs < 1) throw new TypeError("file mutation lock retryMs must be positive");
  if (!fsConstants.O_NOFOLLOW) throw new Error("file mutation lock requires O_NOFOLLOW");

  const target = resolve(path);
  const parent = dirname(target);
  let component = parent;
  while (true) {
    const info = await lstat(component);
    if (info.isSymbolicLink()) throw new Error(`file mutation lock path must not contain symlinks: ${path}`);
    const next = dirname(component);
    if (next === component) break;
    component = next;
  }

  const lockPath = `${target}.muster-lock`;
  const started = Date.now();
  let handle;
  let lockIdentity;
  while (!handle) {
    let candidate;
    try {
      candidate = await open(
        lockPath,
        fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
        0o600,
      );
      await candidate.writeFile(`${process.pid} ${Date.now()}\n`);
      lockIdentity = await candidate.stat();
      handle = candidate;
    } catch (error) {
      if (candidate) {
        await candidate.close().catch(() => {});
        await unlink(lockPath).catch(() => {});
      }
      if (error.code !== "EEXIST") throw error;
      if (Date.now() - started >= timeoutMs) {
        const timeout = new Error(`timed out waiting for file mutation lock: ${path}`);
        timeout.code = "ELOCKTIMEOUT";
        throw timeout;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, Math.min(retryMs, timeoutMs)));
    }
  }

  try {
    return await callback();
  } finally {
    await handle.close();
    let current;
    try {
      current = await lstat(lockPath);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (current && (current.dev !== lockIdentity.dev || current.ino !== lockIdentity.ino)) {
      throw new Error(`file mutation lock ownership changed before release: ${path}`);
    }
    if (current) await unlink(lockPath);
  }
}

// Synchronous counterpart carrying codex-release.js's exact contract (that
// module is deliberately synchronous -- see its top comment for the WSL2 drvfs
// rationale). Message-for-message the original: ELOOP -> "must not be a
// symlink", ENOENT -> "is missing", non-file -> "must be a regular file",
// oversize -> "must be a bounded regular file"; returns the file's bytes.
export function readNoFollowRegularSync(path, { maxBytes, label } = {}) {
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0)); }
  catch (error) {
    if (error.code === "ELOOP") throw new Error(`${label} must not be a symlink: ${path}`, { cause: error });
    if (error.code === "ENOENT") throw new Error(`${label} is missing: ${path}`, { cause: error });
    throw error;
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) throw new Error(`${label} must be a regular file: ${path}`);
    if (stat.size > maxBytes) throw new Error(`${label} must be a bounded regular file: ${path}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}

// --- Atomic writes -----------------------------------------------------------

// Temp-write-then-rename publish: stage the bytes at a fresh exclusive
// no-follow temp in the target's own directory (same filesystem, so the rename
// is atomic), fsync the temp, optionally run a caller hook AFTER staging but
// BEFORE the rename (init.js's verify-unchanged recheck and codex-install.js's
// ordinary-ancestry/regular-file re-assertions hang here), rename over the
// target, and optionally fsync the parent directory so the rename itself is
// durable. The temp is always swept on the way out. Returns true.
//
// Options:
//   fsync        fsync the staged temp before rename (default true).
//   fsyncDir     fsync the parent directory after rename (default false).
//   mode         creation mode for the temp (default 0o600).
//   tempName     (targetPath) => temp path, to preserve a caller's historical
//                temp naming (init.js's `.muster-init-tmp-` prefix is load-
//                bearing: repositoryFingerprint skips entries with it).
//   beforeRename async (tempPath) hook; throwing aborts before the rename, so
//                the target is left byte-untouched.
export async function atomicWrite(path, bytes, {
  fsync = true,
  fsyncDir = false,
  mode = 0o600,
  tempName = null,
  beforeRename = null,
} = {}) {
  const parent = dirname(path);
  const temp = tempName
    ? tempName(path)
    : join(parent, `.muster-tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  let handle;
  try {
    handle = await open(
      temp,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | (fsConstants.O_NOFOLLOW || 0),
      mode,
    );
    await handle.writeFile(bytes);
    if (fsync) await handle.sync();
    await handle.close();
    handle = null;
    if (beforeRename) await beforeRename(temp);
    await rename(temp, path);
    if (fsyncDir) {
      const dirHandle = await open(parent, fsConstants.O_RDONLY);
      try { await dirHandle.sync(); } finally { await dirHandle.close(); }
    }
    return true;
  } finally {
    await handle?.close();
    await rm(temp, { force: true });
  }
}
