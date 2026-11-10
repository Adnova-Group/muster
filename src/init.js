// src/init.js -- deterministic, provider/model-neutral project initialization.
//
// Lifecycle, mapped to the exported entry points:
//   prepare:   initializeProject learns the profile (learnProjectProfile) and
//              writes the owned pair under .muster/ with a `not-requested`
//              native state; rerunning an initialized root reroutes to
//              observeNativeInit. readInitReceipt re-reads and fully
//              revalidates the owned pair.
//   handoff / attempted: transitionNativeInit moves `not-requested` to
//              `handoff` (the runtime must run its own native init) or
//              `attempted` (a proven callable adapter took the attempt),
//              pinning an immutable expected-artifact baseline and attempt id.
//   completed: transitionNativeInit with positive evidence (artifact-delta,
//              preexisting confirmation, or attempt-bound call-result);
//              `completed` is absorbing. acknowledgeNativeInitHandoff is the
//              escape hatch for an unavailable-runtime handoff.
//   finalize:  finalizeInitialization seeds greenfield files and flips the
//              receipt to `finalized` once native init is completed or an
//              unavailable handoff is acknowledged.
// observeNativeInit reports deterministic artifact-delta observations without
// mutating state. canonicalInitJson is the digest-stable serializer every
// profile/receipt hash depends on.
import { createHash, randomBytes } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import {
  lstat, mkdir, mkdtemp, open, opendir, readdir, readlink, realpath,
  rm, stat,
} from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";
import {
  atomicWrite as atomicWriteSafe,
  createContainedFile,
  readNoFollowRegular,
  resolveContainedRealpath,
  safeRelativePath,
  sha256,
  SHA256_HEX_RE,
} from "./fs-safe.js";

const pexecFile = promisify(execFile);
const PROFILE_FORMAT = "muster.project-profile";
const RECEIPT_FORMAT = "muster.init-receipt";
const FINGERPRINT_BASIS = "muster.repository-state.v2";
const LEGACY_FINGERPRINT_BASES = new Set(["muster.repository-state.v1", FINGERPRINT_BASIS]);
const HEX64 = SHA256_HEX_RE;
// Union with the 40-char git SHA shape -- not an exact match of HEX64/
// SHA256_HEX_RE, so it stays as its own declaration.
const GIT_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const CLAUDE_AUTHORITY_POINTER = Buffer.from("# Claude Code\n\n@AGENTS.md\n");
const NATIVE_ARTIFACTS = new Set([
  "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md",
]);

export const INIT_PATHS = Object.freeze({
  directory: ".muster",
  profile: ".muster/project-profile.json",
  receipt: ".muster/init-receipt.json",
});

export const INIT_LIMITS = Object.freeze({
  fingerprintDirectoryBytes: 8_388_608,
  fingerprintDirectoryEntries: 100_000,
  fingerprintDeadlineMs: 3_600_000,
  fingerprintDirectoryNameBytes: 33_554_432,
  fingerprintEntries: 1_000_000,
  fingerprintPathBytes: 262_144,
  fingerprintSnapshotBytes: 33_554_432,
  fingerprintTotalBytes: 1_099_511_627_776,
  learnCaptureBytes: 8_388_608,
  learnDepth: 4,
  learnEvidenceBytes: 350_000,
  learnFileBytes: 1_048_576,
  learnProfileBytes: 524_288,
  symlinkBytes: 4_096,
  evidenceBytes: 65_536,
  nativeArtifacts: 8,
});

// The ceilings in force. Always INIT_LIMITS in production; __withInitLimits
// lowers selected ceilings so tests reach the same limit paths with tiny fixtures.
let activeLimits = INIT_LIMITS;

export async function __withInitLimits(overrides, fn) {
  for (const [key, value] of Object.entries(overrides)) {
    if (!Object.hasOwn(INIT_LIMITS, key)) throw new Error(`unknown init limit: ${key}`);
    if (!Number.isSafeInteger(value) || value < 0) throw new Error(`invalid init limit: ${key}`);
  }
  const previous = activeLimits;
  activeLimits = Object.freeze({ ...previous, ...overrides });
  try { return await fn(); }
  finally { activeLimits = previous; }
}

const utf8Sort = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const envelope = (receipt, observedNativeEvidence = null) => ({ receipt, observedNativeEvidence });

function decodePathBytes(bytes, label) {
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) throw new Error(`invalid UTF-8 repository path: ${label}`);
  return value;
}

// Digest-stability serializer: plain JSON only, safe integers only, keys in
// UTF-8 byte order. Deliberately NOT shared with codex-doctor.js's looser
// `canonical`/`same` snapshot comparator (audit S11, cross-reference) -- the
// doctor's inputs are arbitrary JSON.parse output (non-integer numbers
// included) that this serializer must reject, and its UTF-16 key order would
// change every digest below. See the note at codex-doctor.js's `canonical`.
function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical init JSON accepts integers only");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("canonical init JSON accepts plain JSON objects only");
  }
  if (seen.has(value)) throw new TypeError("canonical init JSON rejects cycles");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort(utf8Sort)) {
    if (!key || typeof value[key] === "undefined") throw new TypeError("canonical init JSON rejects undefined");
    result[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

export function canonicalInitJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function prettyInitJson(value) {
  return JSON.stringify(canonicalValue(value), null, 2) + "\n";
}

// Strict JSON parsing beyond JSON.parse. Every document this parses (owned
// profile/receipt, evidence files) is sha256-hashed through canonicalInitJson,
// so three strictness rules keep digests stable and unambiguous:
// 1. duplicate object keys are rejected -- JSON.parse silently keeps the last
//    value, so two different byte streams would canonicalize to one digest;
// 2. numbers must be safe integers -- canonicalInitJson rejects non-integers,
//    so anything looser would parse here but fail hashing downstream;
// 3. byte input must survive a UTF-8 decode/re-encode round trip -- digests
//    are computed over UTF-8 text, so undecodable bytes must not validate.
function parseStrictJson(bytes, label) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  if (Buffer.isBuffer(bytes) && !Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${label} must be UTF-8 JSON`);
  }
  let index = 0;
  const ws = () => { while (/\s/.test(text[index] || "")) index++; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index++] === '"') {
        try { return JSON.parse(text.slice(start, index)); }
        catch { throw new Error(`${label} contains invalid JSON`); }
      }
    }
    throw new Error(`${label} contains invalid JSON`);
  };
  const value = () => {
    ws();
    if (text[index] === '"') return string();
    if (text[index] === "[") {
      const result = [];
      index++; ws();
      if (text[index] === "]") { index++; return result; }
      while (true) {
        result.push(value()); ws();
        if (text[index] === "]") { index++; return result; }
        if (text[index++] !== ",") throw new Error(`${label} contains invalid JSON`);
      }
    }
    if (text[index] === "{") {
      const result = {};
      const keys = new Set();
      index++; ws();
      if (text[index] === "}") { index++; return result; }
      while (true) {
        ws();
        if (text[index] !== '"') throw new Error(`${label} contains invalid JSON`);
        const key = string();
        if (keys.has(key)) throw new Error(`${label} contains duplicate keys`);
        keys.add(key); ws();
        if (text[index++] !== ":") throw new Error(`${label} contains invalid JSON`);
        result[key] = value(); ws();
        if (text[index] === "}") { index++; return result; }
        if (text[index++] !== ",") throw new Error(`${label} contains invalid JSON`);
      }
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9]\d*)/.exec(text.slice(index));
    if (!match) throw new Error(`${label} contains invalid JSON`);
    index += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${label} accepts safe integers only`);
    return parsed;
  };
  const parsed = value();
  ws();
  if (index !== text.length) throw new Error(`${label} contains invalid JSON`);
  return parsed;
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return true;
    throw error;
  }
}

async function validateRoot(dir) {
  const root = await realpath(resolve(dir));
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("initialization root must resolve to a real directory");
  const stateDir = join(root, INIT_PATHS.directory);
  if (!(await absent(stateDir))) {
    const stateInfo = await lstat(stateDir);
    if (stateInfo.isSymbolicLink()) throw new Error(".muster must not be a symlink");
    if (!stateInfo.isDirectory()) throw new Error(".muster must be a directory");
  }
  return root;
}

// The lexical relative-path validator, the descriptor-pinned no-follow read,
// and the staging rename below now live in src/fs-safe.js (audit S4) -- these
// keep init.js's historical names/signatures so the call sites (and the tests
// pinning their exact error messages) are untouched.
const safeRelative = safeRelativePath;

async function ensureSafeAncestors(root, rel) {
  const parts = safeRelative(rel).split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (await absent(current)) continue;
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe ancestor for ${rel}`);
  }
}

async function readRegular(root, rel, maxBytes) {
  await ensureSafeAncestors(root, rel);
  const path = join(root, ...safeRelative(rel).split("/"));
  try {
    return await readNoFollowRegular(path, { maxBytes, label: rel, requireSingleLink: true });
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// init.js's verify-unchanged variant of the shared atomic write: the current
// owned target is read up front (a byte-identical target short-circuits to
// false), and the beforeRename hook re-reads it after staging so a same-user
// writer racing the publish aborts the rename instead of being clobbered.
async function atomicWrite(root, rel, bytes) {
  await ensureSafeAncestors(root, rel);
  const target = join(root, ...rel.split("/"));
  await mkdir(dirname(target), { recursive: true });
  const current = await readRegular(root, rel, Math.max(bytes.length, activeLimits.learnFileBytes));
  if (current && current.bytes.equals(bytes)) return false;
  if (current && (!current.info.isFile() || current.info.nlink !== 1)) throw new Error(`unsafe owned target: ${rel}`);
  return atomicWriteSafe(target, bytes, {
    fsyncDir: true,
    // The `.muster-init-tmp-` prefix is load-bearing: repositoryFingerprint
    // skips entries with this prefix.
    tempName: (targetPath) => join(dirname(targetPath), `.muster-init-tmp-${randomBytes(8).toString("hex")}`),
    beforeRename: async () => {
      const recheck = await readRegular(root, rel, Math.max(bytes.length, activeLimits.learnFileBytes));
      if (!!current !== !!recheck || (current && (current.info.ino !== recheck.info.ino || current.info.dev !== recheck.info.dev))) {
        throw new Error(`owned target changed while writing: ${rel}`);
      }
    },
  });
}

function gitEnvironment() {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
  });
  return env;
}

async function safeGit(cwd, suffix) {
  const sandbox = await mkdtemp(join(tmpdir(), "muster-git-"));
  const args = [
    "--no-optional-locks", "-c", `core.hooksPath=${sandbox}`, "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false", "-c", "diff.external=", "-c", "pager.branch=false",
    ...suffix,
  ];
  try {
    const { stdout } = await pexecFile("git", args, { cwd, env: gitEnvironment(), encoding: "buffer" });
    let end = stdout.length;
    while (end && (stdout[end - 1] === 0x0a || stdout[end - 1] === 0x0d)) end--;
    try { return decodePathBytes(stdout.subarray(0, end), "git command output"); }
    catch (error) {
      error.invalidGitOutput = true;
      throw error;
    }
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function rootVcs(root) {
  const gitPath = join(root, ".git");
  if (await absent(gitPath)) return { branch: null, head: null, kind: "none", layout: "none" };
  const info = await lstat(gitPath);
  if (!info.isDirectory() && !info.isFile()) throw new Error(".git must be a regular file or directory");
  let head = null;
  let branch = null;
  try {
    const value = await safeGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (GIT_HEAD.test(value)) head = value;
  } catch (error) { if (error.invalidGitOutput) throw error; }
  try { branch = await safeGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null; }
  catch (error) { if (error.invalidGitOutput) throw error; }
  return { branch, head, kind: "git", layout: info.isDirectory() ? "directory" : "worktree-file" };
}

async function initGit(root) {
  const sandbox = await mkdtemp(join(tmpdir(), "muster-git-template-"));
  try { await safeGit(root, ["init", "--quiet", `--template=${sandbox}`]); }
  finally { await rm(sandbox, { recursive: true, force: true }); }
}

async function realGitMarker(dir) {
  const marker = join(dir, ".git");
  if (await absent(marker)) return false;
  const info = await lstat(marker);
  return info.isDirectory() || info.isFile();
}

async function* gitPathStream(root, suffix) {
  const sandbox = await mkdtemp(join(tmpdir(), "muster-git-"));
  const args = [
    "--no-optional-locks", "-c", `core.hooksPath=${sandbox}`, "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false", "-c", "core.quotepath=false",
    "-c", `core.excludesFile=${devNull}`, "ls-files", "-z",
    "--deduplicate", ...suffix,
  ];
  const child = spawn("git", args, {
    cwd: root, env: gitEnvironment(), stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => { if (stderr.length < 16_384) stderr += chunk; });
  const closed = new Promise((resolveClosed, rejectClosed) => {
    child.once("error", rejectClosed);
    child.once("close", (code, signal) => resolveClosed({ code, signal }));
  });
  try {
    let fragments = [];
    let pendingBytes = 0;
    let previous = null;
    for await (const chunk of child.stdout) {
      let start = 0;
      for (let end = chunk.indexOf(0, start); end >= 0; end = chunk.indexOf(0, start)) {
        const fragment = chunk.subarray(start, end);
        pendingBytes += fragment.length;
        if (pendingBytes > activeLimits.fingerprintPathBytes) {
          throw new Error("repository fingerprint path limit exceeded");
        }
        const bytes = fragments.length ? Buffer.concat([...fragments, fragment], pendingBytes) : fragment;
        const rel = decodePathBytes(bytes, "git index");
        if (previous && Buffer.compare(previous, bytes) >= 0) {
          throw new Error("git returned non-canonical repository paths");
        }
        previous = Buffer.from(bytes);
        fragments = [];
        pendingBytes = 0;
        start = end + 1;
        if (rel && rel !== ".muster" && !rel.startsWith(".muster/") &&
            !rel.startsWith(".muster-init-tmp-")) yield rel;
      }
      const fragment = chunk.subarray(start);
      if (fragment.length) {
        pendingBytes += fragment.length;
        if (pendingBytes > activeLimits.fingerprintPathBytes) {
          throw new Error("repository fingerprint path limit exceeded");
        }
        fragments.push(fragment);
      }
    }
    if (pendingBytes) throw new Error("git returned an unterminated repository path");
    const { code, signal } = await closed;
    if (code !== 0) throw new Error(`git ls-files failed${signal ? ` (${signal})` : ""}: ${stderr.trim()}`);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill();
    await closed.catch(() => {});
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function* gitRelevantPaths(root) {
  const cached = gitPathStream(root, ["--cached"]);
  const other = gitPathStream(root, ["--others", "--exclude-standard"]);
  let left;
  let right;
  try {
    left = await cached.next();
    right = await other.next();
    while (!left.done || !right.done) {
      if (right.done || (!left.done && utf8Sort(left.value, right.value) < 0)) {
        yield left.value;
        left = await cached.next();
      } else if (left.done || utf8Sort(right.value, left.value) < 0) {
        yield right.value;
        right = await other.next();
      } else {
        yield left.value;
        left = await cached.next();
        right = await other.next();
      }
    }
  } finally {
    await Promise.all([cached.return(), other.return()]);
  }
}

function sameDirectoryIdentity(current, prior) {
  return current.isDirectory() && prior.isDirectory() && current.ino === prior.ino && current.dev === prior.dev &&
    current.mode === prior.mode && current.nlink === prior.nlink && current.ctimeNs === prior.ctimeNs &&
    current.mtimeNs === prior.mtimeNs;
}

// Bounded parallelism for the read-only repository walks (learnProjectProfile spends most of its
// time waiting on one filesystem call at a time otherwise). Two separate pools so a held pool
// slot never waits on its own pool: DIRECTORY slots cover one pinned directory window (an open
// descriptor plus its listing descriptor), IO slots cover single leaf calls (lstat, readlink, one
// file digest) that never take another slot. A directory window may wait on IO slots; an IO call
// never waits on a directory slot, so the pools cannot deadlock. Both stay far below the
// descriptor ceiling test/init.test.js runs the CLI under (ulimit -n 128).
const WALK_DIRECTORY_CONCURRENCY = 8;
const WALK_IO_CONCURRENCY = 32;
// The fingerprint keeps at most this many relevant paths in flight, hashing rows in path order.
const FINGERPRINT_WINDOW = 64;

function createLimiter(max) {
  let active = 0;
  const waiting = [];
  const release = () => {
    active--;
    if (waiting.length) { active++; waiting.shift()(); }
  };
  return async (fn) => {
    if (active < max) active++;
    else await new Promise((resolveSlot) => waiting.push(resolveSlot));
    try { return await fn(); } finally { release(); }
  };
}

function walkWork(deadline) {
  return {
    aborted: false, deadline, entries: 0, snapshotBytes: 0,
    directories: createLimiter(WALK_DIRECTORY_CONCURRENCY), io: createLimiter(WALK_IO_CONCURRENCY),
  };
}

// A sibling's failure stops new work in the same walk; the stopped calls throw this marker, which
// never wins over a real error (settleInOrder below).
const WALK_ABORTED = new Error("repository walk aborted");

function abortCheck(work) {
  if (work.aborted) throw WALK_ABORTED;
}

// Waits for EVERY promise to settle (no filesystem call outlives the walk that started it), then
// throws the error of the earliest failed item in item order, skipping abort markers. Item order
// is start order under the FIFO limiters, so the error matches the one a sequential loop over the
// same items would have hit first.
async function settleInOrder(work, promises) {
  const results = await Promise.all(promises.map((promise) => promise.then(
    (value) => ({ value }),
    (error) => { work.aborted = true; return { error }; },
  )));
  const failed = results.filter((result) => "error" in result);
  if (failed.length) throw (failed.find(({ error }) => error !== WALK_ABORTED) ?? failed[0]).error;
  return results.map(({ value }) => value);
}

// Promise.all that lets every call settle before rejecting with the first error in item order.
async function allSettledInOrder(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find(({ status }) => status === "rejected");
  if (failed) throw failed.reason;
  return results.map(({ value }) => value);
}

function forEachBounded(work, items, fn) {
  return settleInOrder(work, items.map((item, index) => work.io(async () => {
    abortCheck(work);
    return fn(item, index);
  })));
}

// Pins one directory for the duration of `visit` (every entry name) and the optional `inside`
// step (work that must observe the directory while it is pinned, e.g. lstat of every child): the
// directory, its ancestors and its canonical containment are checked before the descriptor is
// opened and again after `inside` finishes, so a swap anywhere on the path mid-walk fails closed.
// The ancestor set excludes `abs` itself, which the named-path checks already cover.
async function pinnedDirectoryVisit(root, abs, rel, visit, inside) {
  const parts = rel ? rel.split("/") : [];
  const ancestorPaths = parts.map((_, index) => join(root, ...parts.slice(0, index)));
  const unsafe = () => new Error(`unsafe repository directory: ${rel || "."}`);
  const changed = () => new Error(`repository directory changed: ${rel || "."}`);
  const [ancestorsBefore, namedBefore, containedBefore] = await allSettledInOrder([
    allSettledInOrder(ancestorPaths.map((path) => lstat(path, { bigint: true }))),
    lstat(abs, { bigint: true }),
    resolveContainedRealpath(root, abs),
  ]);
  if (ancestorsBefore.some((info) => info.isSymbolicLink() || !info.isDirectory())) throw unsafe();
  if (namedBefore.isSymbolicLink() || !namedBefore.isDirectory() || !containedBefore) throw unsafe();
  let handle;
  try {
    handle = await open(
      abs,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | (fsConstants.O_NOFOLLOW || 0),
    );
    const heldBefore = await handle.stat({ bigint: true });
    if (!sameDirectoryIdentity(heldBefore, namedBefore)) throw changed();
    const descriptorPath = process.platform === "linux" ? `/proc/self/fd/${handle.fd}` :
      process.platform === "win32" ? abs : `/dev/fd/${handle.fd}`;
    for await (const entry of await opendir(descriptorPath, { encoding: "buffer" })) {
      const bytes = Buffer.isBuffer(entry.name) ? entry.name : Buffer.from(entry.name);
      if (await visit(decodePathBytes(bytes, rel || "."), bytes) === false) break;
    }
    await inside?.();
    const [heldAfter, namedAfter, ancestorsAfter, containedAfter] = await allSettledInOrder([
      handle.stat({ bigint: true }),
      lstat(abs, { bigint: true }),
      allSettledInOrder(ancestorPaths.map((path) => lstat(path, { bigint: true }))),
      resolveContainedRealpath(root, abs),
    ]);
    if (!sameDirectoryIdentity(heldAfter, heldBefore) || !sameDirectoryIdentity(namedAfter, heldBefore) ||
        ancestorsAfter.some((info, index) => !sameDirectoryIdentity(info, ancestorsBefore[index])) ||
        !containedAfter) throw changed();
    return heldBefore;
  } finally {
    await handle?.close();
  }
}

async function pinnedDirectoryNames(root, abs, rel) {
  const names = [];
  let totalBytes = 0;
  await pinnedDirectoryVisit(root, abs, rel, (name, bytes) => {
    totalBytes += bytes.length;
    if (totalBytes > activeLimits.fingerprintDirectoryBytes ||
        names.length >= activeLimits.fingerprintDirectoryEntries) {
      const error = new Error(`repository directory entry limit exceeded: ${rel || "."}`);
      error.initReason = "directory-limit";
      throw error;
    }
    names.push(name);
  });
  return names.sort(utf8Sort);
}

async function pinnedFingerprintDirectoryNames(root, abs, rel) {
  const names = [];
  let totalBytes = 0;
  await pinnedDirectoryVisit(root, abs, rel, (name, bytes) => {
    totalBytes += bytes.length;
    if (totalBytes > activeLimits.fingerprintDirectoryNameBytes ||
        names.length >= activeLimits.fingerprintEntries) {
      throw new Error(`repository fingerprint directory limit exceeded: ${rel || "."}`);
    }
    names.push(name);
  });
  return names.sort(utf8Sort);
}

async function* filesystemRelevantPaths(root, abs = root, prefix = "", work = walkWork(Infinity)) {
  const names = (await pinnedFingerprintDirectoryNames(root, abs, prefix)).filter((name) => (
    prefix || (name !== ".git" && name !== ".muster" && !name.startsWith(".muster-init-tmp-"))
  ));
  const children = await forEachBounded(work, names, async (name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    const path = join(abs, name);
    const info = await lstat(path);
    const descend = info.isDirectory() && !(await realGitMarker(path));
    return { descend, key: descend ? `${rel}/` : rel, path, rel };
  });
  children.sort((a, b) => utf8Sort(a.key, b.key));
  for (const child of children) {
    if (child.descend) yield* filesystemRelevantPaths(root, child.path, child.rel, work);
    else yield child.rel;
  }
}

function checkFingerprintDeadline(deadline) {
  if (Date.now() > deadline) throw new Error("repository fingerprint deadline exceeded");
}

// Snapshots every directory's identity (pre-order, children in UTF-8 order) and rejects special
// entries. Sibling subtrees are walked concurrently under the work's pools; the snapshot rows are
// assembled in the order a sequential walk produces, so the digest is unchanged.
async function rejectSpecialEntries(root, work) {
  const tree = await snapshotDirectory(root, root, "", work);
  const hash = createHash("sha256").update("muster.directory-snapshot.v1\0");
  let count = 0;
  const pending = [tree];
  while (pending.length) {
    const { row, children } = pending.pop();
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(row.length));
    hash.update(length).update(row);
    count++;
    for (let index = children.length - 1; index >= 0; index--) pending.push(children[index]);
  }
  return { count, digest: hash.digest("hex") };
}

async function snapshotDirectory(root, abs, prefix, work) {
  abortCheck(work);
  const names = [];
  const directories = [];
  const identity = await work.directories(() => pinnedDirectoryVisit(root, abs, prefix, (name) => {
    checkFingerprintDeadline(work.deadline);
    work.entries++;
    if (work.entries > activeLimits.fingerprintEntries) {
      throw new Error("repository fingerprint entry limit exceeded");
    }
    if (!prefix && (name === ".git" || name === ".muster" || name.startsWith(".muster-init-tmp-"))) return;
    names.push(name);
  }, () => forEachBounded(work, names, async (name) => {
    const rel = prefix ? `${prefix}/${name}` : name;
    const path = join(abs, name);
    const info = await lstat(path);
    if (info.isDirectory()) {
      if (!(await realGitMarker(path))) {
        work.snapshotBytes += Buffer.byteLength(rel) + 128;
        if (work.snapshotBytes > activeLimits.fingerprintSnapshotBytes) {
          throw new Error("repository directory snapshot limit exceeded");
        }
        directories.push({ path, rel });
      }
    } else if (info.isSymbolicLink()) {
      const target = await readlink(path, { encoding: "buffer" });
      if (target.length > activeLimits.symlinkBytes) throw new Error("repository symlink target limit exceeded");
    } else if (!info.isFile()) {
      throw new Error(`unsupported repository entry type: ${rel}`);
    }
  })));
  const row = Buffer.from([
    prefix, identity.dev, identity.ino, identity.mode, identity.nlink,
    identity.ctimeNs, identity.mtimeNs,
  ].join("\0"));
  directories.sort((a, b) => utf8Sort(a.rel, b.rel));
  const children = await settleInOrder(work, directories.map(({ path, rel }) => snapshotDirectory(root, path, rel, work)));
  return { row, children };
}

function sameDirectorySnapshot(current, prior) {
  return current.count === prior.count && current.digest === prior.digest;
}

async function ensureFingerprintAncestors(root, path, rel) {
  if (typeof rel !== "string" || !rel || rel.includes("\0") || rel.includes("\\") ||
      rel.startsWith("/") || rel.startsWith("//") || /^[A-Za-z]:/.test(rel)) {
    throw new Error(`unsafe repository path: ${rel}`);
  }
  const parts = rel.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe repository path: ${rel}`);
  }
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe ancestor for ${rel}`);
  }
  if (!(await resolveContainedRealpath(root, dirname(path)))) {
    throw new Error(`unsafe ancestor for ${rel}`);
  }
}

async function streamedFileDigest(root, path, rel, expectedInfo, deadline = Infinity) {
  let handle;
  try {
    await ensureFingerprintAncestors(root, path, rel);
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0),
    );
    const before = await handle.stat({ bigint: true });
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`unsafe regular file: ${rel}`);
    const size = Number(before.size);
    if (!before.isFile()) throw new Error(`unsafe regular file: ${rel}`);
    if (before.ino !== expectedInfo.ino || before.dev !== expectedInfo.dev) {
      throw new Error(`file changed while reading: ${rel}`);
    }
    const digest = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      checkFingerprintDeadline(deadline);
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
      if (bytesRead === 0) break;
      digest.update(chunk.subarray(0, bytesRead));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (position !== size || after.ino !== before.ino || after.dev !== before.dev ||
        after.size !== before.size || after.nlink !== before.nlink || after.mode !== before.mode ||
        after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs || !after.isFile()) {
      throw new Error(`file changed while reading: ${rel}`);
    }
    await ensureFingerprintAncestors(root, path, rel);
    const named = await lstat(path, { bigint: true });
    if (!named.isFile() || named.ino !== before.ino || named.dev !== before.dev ||
        named.mode !== before.mode || named.size !== before.size || named.nlink !== before.nlink ||
        named.ctimeNs !== before.ctimeNs || named.mtimeNs !== before.mtimeNs) {
      throw new Error(`file changed while reading: ${rel}`);
    }
    return { digest: digest.digest("hex"), mode: Number(before.mode), size };
  } finally {
    await handle?.close();
  }
}

function sameFingerprintIdentity(current, prior) {
  return current.isFile() && prior.isFile() && current.ino === prior.ino && current.dev === prior.dev &&
    current.mode === prior.mode && current.size === prior.size && current.nlink === prior.nlink &&
    current.ctimeNs === prior.ctimeNs && current.mtimeNs === prior.mtimeNs;
}

// One relevant path's fingerprint row, or null for a tracked-but-deleted Git path. `size` is the
// byte count the cumulative ceiling charges; `reserve` charges a file's size before it is read.
async function fingerprintRow(root, rel, learnedDigests, deadline, reserve) {
  const path = join(root, rel);
  let info;
  try { info = await lstat(path, { bigint: true }); }
  catch (error) {
    if (error.code === "ENOENT") return null; // tracked-but-deleted Git path
    throw error;
  }
  const learned = info.isFile() ? learnedDigests.get(rel) : undefined;
  // streamedFileDigest checks the ancestors itself before and after reading, so only the paths
  // that skip it need the standalone check.
  if (!info.isFile() || learned) await ensureFingerprintAncestors(root, path, rel);
  if (info.isDirectory() && await realGitMarker(path)) {
    let head = null;
    try {
      const value = await safeGit(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
      if (GIT_HEAD.test(value)) head = value;
    } catch (error) { if (error.invalidGitOutput) throw error; }
    return { row: Buffer.from(`V\0${rel}\0${head ?? "null"}\n`), size: 0 };
  } else if (info.isFile()) {
    if (learned && !sameFingerprintIdentity(info, learned.identity)) throw learningFileChanged(rel);
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("repository fingerprint byte limit exceeded");
    reserve(Number(info.size));
    const opened = learned || await streamedFileDigest(root, path, rel, info, deadline);
    return {
      row: Buffer.from(`F\0${rel}\0${(opened.mode & 0o111) ? 1 : 0}\0${opened.size}\0${opened.digest}\n`),
      size: opened.size,
    };
  } else if (info.isSymbolicLink()) {
    const target = await readlink(path, { encoding: "buffer" });
    if (target.length > activeLimits.symlinkBytes) throw new Error("repository symlink target limit exceeded");
    const named = await lstat(path, { bigint: true });
    if (!named.isSymbolicLink() || named.ino !== info.ino || named.dev !== info.dev ||
        named.ctimeNs !== info.ctimeNs || named.mtimeNs !== info.mtimeNs) {
      throw new Error(`file changed while reading: ${rel}`);
    }
    return { row: Buffer.from(`L\0${rel}\0${sha256(target)}\n`), size: 0 };
  }
  throw new Error(`unsupported repository entry type: ${rel}`);
}

async function repositoryFingerprintPass(root, learnedDigests = new Map(), deadline = Infinity, expectedSnapshot = null) {
  // Git deliberately omits untrackable special entries from `ls-files`.
  // Preserve the previous fail-closed repository walk before hashing only the
  // relevant paths; ignored/generated ordinary files remain unhashed.
  const directorySnapshot = await rejectSpecialEntries(root, walkWork(deadline));
  if (expectedSnapshot && !sameDirectorySnapshot(directorySnapshot, expectedSnapshot)) {
    throw new Error("repository changed while learning");
  }
  const hash = createHash("sha256").update(Buffer.from(`${FINGERPRINT_BASIS}\0`));
  let rowCount = 0;
  let visitedPaths = 0;
  let totalBytes = 0;
  let reservedBytes = 0;
  const add = (row) => {
    const length = Buffer.allocUnsafe(8);
    length.writeBigUInt64BE(BigInt(row.length));
    hash.update(length).update(row);
    rowCount++;
  };
  // Charged before a file is read, so an over-budget repository fails before the read that would
  // cross the ceiling; the in-order charge below re-checks the sizes actually digested.
  const reserve = (size) => {
    if (size > activeLimits.fingerprintTotalBytes - reservedBytes) {
      throw new Error("repository fingerprint byte limit exceeded");
    }
    reservedBytes += size;
  };
  const charge = (result) => {
    if (!result) return;
    if (!Number.isSafeInteger(result.size) || result.size > activeLimits.fingerprintTotalBytes - totalBytes) {
      throw new Error("repository fingerprint byte limit exceeded");
    }
    totalBytes += result.size;
    add(result.row);
  };
  // Rows are computed up to FINGERPRINT_WINDOW paths ahead and hashed strictly in path order.
  // The first failure stops new work, every started read settles before this pass returns, and
  // the earliest failure in path order is thrown.
  const work = walkWork(deadline);
  const settle = (promise) => promise.then((value) => ({ value }), (error) => {
    work.aborted = true;
    return { error };
  });
  const inflight = [];
  let headFailure = null;
  let loopFailure = null;
  const paths = await realGitMarker(root) ? gitRelevantPaths(root) : filesystemRelevantPaths(root);
  try {
    for await (const rel of paths) {
      if (work.aborted) break;
      checkFingerprintDeadline(deadline);
      visitedPaths++;
      if (visitedPaths > activeLimits.fingerprintEntries) throw new Error("repository fingerprint entry limit exceeded");
      inflight.push(settle(work.io(async () => {
        abortCheck(work);
        return fingerprintRow(root, rel, learnedDigests, deadline, reserve);
      })));
      if (inflight.length < FINGERPRINT_WINDOW) continue;
      const head = await inflight.shift();
      try {
        if ("error" in head) throw head.error;
        charge(head.value);
      } catch (error) {
        headFailure = error;
        break;
      }
    }
  } catch (error) {
    loopFailure = error;
  }
  if (headFailure || loopFailure) work.aborted = true;
  const remaining = await Promise.all(inflight);
  if (headFailure) throw headFailure;
  for (const settled of remaining) {
    if (!("error" in settled)) charge(settled.value);
    else if (settled.error !== WALK_ABORTED) throw settled.error;
  }
  if (loopFailure) throw loopFailure;
  if (work.aborted) throw WALK_ABORTED;
  for (const [rel, learned] of learnedDigests) {
    const path = join(root, rel);
    await ensureLearningAncestors(root, path, rel);
    const current = await lstat(path, { bigint: true }).catch((error) => {
      if (error.code === "ENOENT") throw learningFileChanged(rel);
      throw error;
    });
    if (!sameFingerprintIdentity(current, learned.identity)) throw learningFileChanged(rel);
  }
  const finalDirectorySnapshot = await rejectSpecialEntries(root, walkWork(deadline));
  if (!sameDirectorySnapshot(finalDirectorySnapshot, directorySnapshot)) {
    throw new Error("repository changed while fingerprinting");
  }
  const count = Buffer.allocUnsafe(8);
  count.writeBigUInt64BE(BigInt(rowCount));
  const digest = hash.update(count).digest("hex");
  return { algorithm: "sha256", basis: FINGERPRINT_BASIS, digest };
}

async function repositoryFingerprint(root, learnedDigests = new Map(), deadline = null, expectedSnapshot = null) {
  deadline ||= Date.now() + activeLimits.fingerprintDeadlineMs;
  const first = await repositoryFingerprintPass(root, learnedDigests, deadline, expectedSnapshot);
  const second = await repositoryFingerprintPass(root, learnedDigests, deadline);
  if (first.digest !== second.digest) throw new Error("repository changed while fingerprinting");
  return second;
}

async function classify(root) {
  let classification = "greenfield";
  await pinnedDirectoryVisit(root, root, "", async (name) => {
    if (name === ".git") return;
    if (name === ".muster") {
      let occupied = false;
      await pinnedDirectoryVisit(root, join(root, name), name, () => {
        occupied = true;
        return false;
      });
      if (!occupied) return;
    }
    classification = "brownfield";
    return false;
  });
  return classification;
}

const MANIFEST_NAMES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "Cargo.toml", "Cargo.lock", "pyproject.toml", "requirements.txt", "go.mod", "Gemfile",
]);
const INSTRUCTION_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "copilot-instructions.md"]);
const SOURCE_NAMES = new Set(["src", "lib", "app", "apps", "packages"]);
const TEST_NAMES = new Set(["test", "tests", "__tests__", "spec"]);
const LANGUAGE_SUFFIXES = new Set([".js", ".mjs", ".cjs", ".jsx", ".ts", ".tsx", ".py", ".rs", ".go", ".rb"]);

function safeLearnedPath(path) {
  if (typeof path !== "string" || !path || path.includes("\0") || path.includes("\\") ||
      isAbsolute(path) || /^[A-Za-z]:/.test(path) || path.startsWith("//")) {
    throw new Error(`unsafe learned path: ${path}`);
  }
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) {
    throw new Error(`unsafe learned path: ${path}`);
  }
  return path;
}

function learningFileChanged(rel) {
  const error = new Error(`file changed while reading: ${rel}`);
  error.fsSafe = { reason: "changed" };
  return error;
}

async function ensureLearningAncestors(root, path, rel) {
  const parts = safeLearnedPath(rel).split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe ancestor for ${rel}`);
  }
  if (!(await resolveContainedRealpath(root, dirname(path)))) throw new Error(`unsafe ancestor for ${rel}`);
}

async function readLearningMetadata(root, path, rel, expectedInfo, capture, deadline = Infinity, afterOpen) {
  let handle;
  try {
    await ensureLearningAncestors(root, path, rel);
    handle = await open(
      path,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0) | (fsConstants.O_NONBLOCK || 0),
    );
    const before = await handle.stat({ bigint: true });
    if (!before.isFile()) throw new Error(`unsafe regular file: ${rel}`);
    if (before.ino !== expectedInfo.ino || before.dev !== expectedInfo.dev) {
      throw learningFileChanged(rel);
    }
    await afterOpen?.({ path, rel });
    if (before.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`unsafe regular file: ${rel}`);
    const size = Number(before.size);
    const digest = createHash("sha256");
    const chunks = capture ? [] : null;
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (position < size) {
      checkFingerprintDeadline(deadline);
      const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, size - position), position);
      if (bytesRead === 0) break;
      const bytes = chunk.subarray(0, bytesRead);
      digest.update(bytes);
      if (chunks) chunks.push(Buffer.from(bytes));
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (position !== size || after.ino !== before.ino || after.dev !== before.dev ||
        after.size !== before.size || after.nlink !== before.nlink || after.mode !== before.mode ||
        after.ctimeNs !== before.ctimeNs || after.mtimeNs !== before.mtimeNs || !after.isFile()) {
      throw learningFileChanged(rel);
    }
    await ensureLearningAncestors(root, path, rel);
    const named = await lstat(path, { bigint: true });
    if (!named.isFile() || named.ino !== before.ino || named.dev !== before.dev ||
        named.size !== before.size || named.nlink !== before.nlink || named.mode !== before.mode ||
        named.ctimeNs !== before.ctimeNs || named.mtimeNs !== before.mtimeNs) {
      throw learningFileChanged(rel);
    }
    return {
      bytes: chunks ? Buffer.concat(chunks) : null,
      digest: digest.digest("hex"),
      identity: before,
      mode: Number(before.mode),
      size,
    };
  } finally {
    await handle?.close();
  }
}

async function learnFacts(root, deadline = Date.now() + activeLimits.fingerprintDeadlineMs, { afterLearningOpen } = {}) {
  const digests = new Map();
  const rows = [];
  const limitations = [];
  const sourceRoots = new Set();
  const testRoots = new Set();
  const extensions = new Set();
  let capturedBytes = 0;
  let learnedBytes = 0;
  let learnedEntries = 0;
  let evidenceBytes = 0;
  let profileLimited = false;
  const markProfileLimited = (path) => {
    if (profileLimited) return;
    profileLimited = true;
    limitations.push({ path: safeLearnedPath(path), reason: "profile-limit" });
  };
  const reserveEvidence = (bytes, path) => {
    if (profileLimited) return false;
    if (evidenceBytes + bytes > activeLimits.learnEvidenceBytes) {
      markProfileLimited(path);
      return false;
    }
    evidenceBytes += bytes;
    return true;
  };
  const addLimitation = (path, reason) => {
    const row = { path: safeLearnedPath(path), reason };
    if (reserveEvidence(Buffer.byteLength(JSON.stringify(row)) + 2, path)) limitations.push(row);
  };
  const addRoot = (set, path) => {
    if (set.has(path) || !reserveEvidence(Buffer.byteLength(JSON.stringify(path)) + 1, path)) return;
    set.add(path);
  };
  // Three steps keep the budgets deterministic while the filesystem calls run concurrently:
  // scan lists and lstats the tree under the walk pools; decide replays it sequentially in the
  // original depth-first UTF-8 order, so every evidence, parse and byte budget is charged exactly
  // as a sequential walk charges it; read then digests the chosen metadata files concurrently,
  // each bound to its scanned identity AND size, so the budgets decided from the scan stay exact.
  const work = walkWork(deadline);
  async function scan(abs, prefix, depth) {
    abortCheck(work);
    if (depth > activeLimits.learnDepth) return { limit: "depth-limit" };
    let names;
    try { names = await work.directories(() => pinnedDirectoryNames(root, abs, prefix)); }
    catch (error) {
      if (error.initReason === "directory-limit") return { limit: "directory-limit" };
      throw error;
    }
    checkFingerprintDeadline(deadline);
    learnedEntries += names.length;
    if (learnedEntries > activeLimits.fingerprintEntries) {
      throw new Error("project learning entry limit exceeded");
    }
    const entries = await forEachBounded(work, names, async (name) => {
      checkFingerprintDeadline(deadline);
      if (!prefix && (name === ".git" || name === ".muster")) return null;
      const path = join(abs, name);
      const info = await lstat(path, { bigint: true });
      const gitMarker = !info.isSymbolicLink() && info.isDirectory() && await realGitMarker(path);
      return { gitMarker, info, name, path, rel: prefix ? `${prefix}/${name}` : name };
    });
    const children = await settleInOrder(work, entries.map((entry) => (
      entry && !entry.info.isSymbolicLink() && entry.info.isDirectory() && !entry.gitMarker ?
        scan(entry.path, entry.rel, depth + 1) : Promise.resolve(null)
    )));
    return { children, entries };
  }
  const reads = [];
  function decide(node, prefix) {
    if (node.limit === "depth-limit") {
      addLimitation(prefix, "depth-limit");
      return;
    }
    if (node.limit === "directory-limit") {
      addLimitation(prefix || "project-root", "directory-limit");
      return;
    }
    node.entries.forEach((entry, index) => {
      if (!entry) return;
      const { info, name, path, rel } = entry;
      if (info.isSymbolicLink()) return;
      if (info.isDirectory()) {
        if (SOURCE_NAMES.has(name)) addRoot(sourceRoots, rel);
        if (TEST_NAMES.has(name)) addRoot(testRoots, rel);
        if (!entry.gitMarker) decide(node.children[index], rel);
      } else if (info.isFile()) {
        const dot = name.lastIndexOf(".");
        const suffix = dot >= 0 ? name.slice(dot).toLowerCase() : null;
        if (LANGUAGE_SUFFIXES.has(suffix)) extensions.add(suffix);
        if (!MANIFEST_NAMES.has(name) && !INSTRUCTION_NAMES.has(name)) return;
        if (info.size > BigInt(Number.MAX_SAFE_INTEGER) ||
            info.size > BigInt(activeLimits.fingerprintTotalBytes - learnedBytes)) {
          throw new Error("project learning byte limit exceeded");
        }
        const factBytes = Buffer.byteLength(JSON.stringify({
          bytes: Number.MAX_SAFE_INTEGER, path: rel, sha256: "0".repeat(64),
        })) + 2;
        if (!reserveEvidence(factBytes, rel)) return;
        const parse = name === "package.json" && info.size <= BigInt(activeLimits.learnFileBytes) &&
          info.size <= BigInt(activeLimits.learnCaptureBytes - capturedBytes);
        learnedBytes += Number(info.size);
        if (parse) capturedBytes += Number(info.size);
        if (name === "package.json" && !parse) addLimitation(rel, "parse-limit");
        reads.push({ info, name, parse, path, rel });
      }
    });
  }
  decide(await scan(root, "", 0), "");
  const opened = await forEachBounded(work, reads, async ({ info, parse, path, rel }) => {
    const result = await readLearningMetadata(root, path, rel, info, parse, deadline, afterLearningOpen);
    if (result.size !== Number(info.size)) throw learningFileChanged(rel);
    return result;
  });
  reads.forEach(({ name, rel }, index) => {
    const result = opened[index];
    digests.set(rel, result);
    rows.push({
      bytes: result.size,
      content: result.bytes,
      instruction: INSTRUCTION_NAMES.has(name),
      path: rel,
      sha256: result.digest,
    });
  });
  limitations.sort((a, b) => utf8Sort(a.path, b.path) || utf8Sort(a.reason, b.reason));
  return { digests, extensions, limitations, rows, sourceRoots, testRoots };
}

function boundSerializedProfile(profile) {
  if (Buffer.byteLength(prettyInitJson(profile)) <= activeLimits.learnProfileBytes) return profile;
  const facts = profile.facts;
  const existing = facts.learning.limitations.find(({ reason }) => reason === "profile-limit");
  const fallbackPath = facts.manifests.at(-1)?.path || facts.instructionFiles.at(-1)?.path ||
    facts.sourceRoots.at(-1) || facts.learning.limitations.at(-1)?.path || "project-profile";
  facts.learning = {
    limitations: [existing || { path: safeLearnedPath(fallbackPath), reason: "profile-limit" }],
    status: "incomplete",
  };
  const dynamic = [facts.manifests, facts.instructionFiles, facts.sourceRoots];
  while (Buffer.byteLength(prettyInitJson(profile)) > activeLimits.learnProfileBytes) {
    let changed = false;
    for (const values of dynamic) {
      if (!values.length) continue;
      values.length = Math.floor(values.length / 2);
      changed = true;
    }
    if (!changed) throw new Error("generated project profile exceeds its serialization limit");
  }
  return profile;
}

export async function learnProjectProfile(dir, { __afterLearningOpen } = {}) {
  const root = await validateRoot(dir);
  const deadline = Date.now() + activeLimits.fingerprintDeadlineMs;
  const learningSnapshot = await rejectSpecialEntries(root, walkWork(deadline));
  const vcs = await rootVcs(root);
  const owned = await readOwned(root);
  const classification = owned?.receipt.classification ?? await classify(root);
  const { digests, extensions, limitations, rows, sourceRoots, testRoots } = await learnFacts(root, deadline, {
    afterLearningOpen: __afterLearningOpen,
  });
  const languages = new Set();
  const frameworks = new Set();
  const managers = new Set();
  const runners = new Set();
  let monorepo = false;
  let library = false;
  for (const [language, suffixes] of Object.entries({
    javascript: [".js", ".mjs", ".cjs", ".jsx"],
    typescript: [".ts", ".tsx"],
    python: [".py"],
    rust: [".rs"],
    go: [".go"],
    ruby: [".rb"],
  })) if (suffixes.some((suffix) => extensions.has(suffix))) languages.add(language);
  for (const row of rows) {
    const name = basename(row.path);
    if (name === "package.json") {
      languages.add("javascript");
      managers.add("npm");
      if (!row.content) continue;
      try {
        const pkg = JSON.parse(row.content.toString("utf8"));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const framework of ["express", "fastify", "next", "react", "vue", "svelte", "nestjs"]) if (deps[framework]) frameworks.add(framework);
        const test = pkg.scripts?.test;
        for (const runner of ["node --test", "vitest", "jest", "mocha"]) if (typeof test === "string" && test.includes(runner)) runners.add(runner);
        monorepo ||= !!pkg.workspaces;
        library ||= !!(pkg.main || pkg.exports);
      } catch {}
    } else if (name === "package-lock.json") managers.add("npm");
    else if (name === "pnpm-lock.yaml") managers.add("pnpm");
    else if (name === "yarn.lock") managers.add("yarn");
    else if (name === "bun.lockb") managers.add("bun");
    else if (name === "Cargo.toml" || name === "Cargo.lock") { languages.add("rust"); managers.add("cargo"); }
    else if (name === "pyproject.toml" || name === "requirements.txt") { languages.add("python"); managers.add("pip"); }
    else if (name === "go.mod") { languages.add("go"); managers.add("go"); }
    else if (name === "Gemfile") { languages.add("ruby"); managers.add("bundler"); }
  }
  const factRows = (instruction) => rows.filter((row) => row.instruction === instruction)
    .map(({ bytes, path, sha256: digest }) => ({ bytes, path, sha256: digest })).sort((a, b) => utf8Sort(a.path, b.path));
  const shape = classification === "greenfield" ? "empty" : monorepo ? "monorepo" :
    sourceRoots.size || frameworks.size ? "application" : library ? "library" : "unknown";
  const profile = {
    format: PROFILE_FORMAT,
    schemaVersion: 1,
    classification,
    facts: {
      frameworks: [...frameworks].sort(utf8Sort),
      instructionFiles: factRows(true),
      learning: { limitations, status: limitations.length ? "incomplete" : "complete" },
      languages: [...languages].sort(utf8Sort),
      manifests: factRows(false),
      packageManagers: [...managers].sort(utf8Sort),
      shape,
      sourceRoots: [...sourceRoots].sort(utf8Sort),
      testRunners: [...runners].sort(utf8Sort),
      vcs,
    },
    repositoryFingerprint: await repositoryFingerprint(root, digests, deadline, learningSnapshot),
  };
  if (JSON.stringify(await rootVcs(root)) !== JSON.stringify(vcs)) {
    throw new Error("repository VCS changed while learning");
  }
  return boundSerializedProfile(profile);
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort(utf8Sort)) === JSON.stringify([...keys].sort(utf8Sort));
}

function invalidInit(kind, field, clause) {
  throw new Error(`invalid ${kind}: ${field} (${clause})`);
}

function checkFileRows(rows, kind, field) {
  if (!Array.isArray(rows)) invalidInit(kind, field, "must be an array of file rows");
  for (const row of rows) {
    if (!exactKeys(row, ["bytes", "path", "sha256"])) {
      invalidInit(kind, field, "each row must have exactly the keys bytes, path, sha256");
    }
    if (!Number.isSafeInteger(row.bytes) || row.bytes < 0) {
      invalidInit(kind, field, "row bytes must be a non-negative safe integer");
    }
    if (!HEX64.test(row.sha256)) invalidInit(kind, field, "row sha256 must be 64 lowercase hex characters");
    try { safeLearnedPath(row.path); } catch { invalidInit(kind, field, "row path must be a safe learned path"); }
  }
  if (new Set(rows.map((row) => row.path)).size !== rows.length) invalidInit(kind, field, "row paths must be unique");
  if (!rowsSortedByPath(rows)) invalidInit(kind, field, "rows must be sorted by UTF-8 path order");
}

function checkSortedPaths(values, kind, field) {
  if (!Array.isArray(values)) invalidInit(kind, field, "must be an array of safe relative paths");
  for (const path of values) {
    try { safeRelative(path); } catch { invalidInit(kind, field, "every entry must be a safe relative path"); }
  }
  if (new Set(values).size !== values.length) invalidInit(kind, field, "entries must be unique");
  if (JSON.stringify(values) !== JSON.stringify([...values].sort(utf8Sort))) {
    invalidInit(kind, field, "entries must be sorted in UTF-8 order");
  }
}

function rowsSortedByPath(rows) {
  return JSON.stringify(rows.map((row) => row.path)) ===
    JSON.stringify(rows.map((row) => row.path).sort(utf8Sort));
}

function validateProfile(profile) {
  const fail = (field, clause) => invalidInit("project profile", field, clause);
  if (!exactKeys(profile, ["format", "schemaVersion", "classification", "facts", "repositoryFingerprint"])) {
    fail("profile", "keys must be exactly classification, facts, format, repositoryFingerprint, schemaVersion");
  }
  if (profile.format !== PROFILE_FORMAT) fail("format", `must be ${PROFILE_FORMAT}`);
  if (profile.schemaVersion !== 1) fail("schemaVersion", "must be 1");
  if (!["greenfield", "brownfield"].includes(profile.classification)) {
    fail("classification", "must be greenfield or brownfield");
  }
  const priorFactKeys = ["frameworks", "instructionFiles", "languages", "manifests", "packageManagers", "shape", "sourceRoots", "testRunners", "vcs"];
  const evidenceFactKeys = [...priorFactKeys, "learning"];
  if (!exactKeys(profile.facts, priorFactKeys) && !exactKeys(profile.facts, evidenceFactKeys)) {
    fail("facts", "keys must be the schema-v1 fact keys, optionally including learning evidence");
  }
  if (!["empty", "library", "application", "monorepo", "unknown"].includes(profile.facts.shape)) {
    fail("facts.shape", "must be empty, library, application, monorepo, or unknown");
  }
  checkFileRows(profile.facts.manifests, "project profile", "facts.manifests");
  checkFileRows(profile.facts.instructionFiles, "project profile", "facts.instructionFiles");
  const learning = profile.facts.learning;
  if (learning !== undefined) {
    if (!exactKeys(learning, ["limitations", "status"]) || !["complete", "incomplete"].includes(learning.status) ||
        !Array.isArray(learning.limitations)) fail("facts.learning", "must carry a complete or incomplete status and limitations array");
    for (const limitation of learning.limitations) {
      if (!exactKeys(limitation, ["path", "reason"]) ||
          !["depth-limit", "directory-limit", "parse-limit", "profile-limit"].includes(limitation.reason)) {
        fail("facts.learning.limitations", "each limitation must name a path and known reason");
      }
      try { safeLearnedPath(limitation.path); } catch { fail("facts.learning.limitations", "paths must be safe learned paths"); }
    }
    if ((learning.status === "complete") !== (learning.limitations.length === 0)) {
      fail("facts.learning", "complete must have no limitations and incomplete must have at least one");
    }
    const limitationKeys = learning.limitations.map(({ path, reason }) => `${path}\0${reason}`);
    if (new Set(limitationKeys).size !== limitationKeys.length ||
        JSON.stringify(limitationKeys) !== JSON.stringify([...limitationKeys].sort(utf8Sort))) {
      fail("facts.learning.limitations", "entries must be unique and sorted in UTF-8 order");
    }
  }
  if (!exactKeys(profile.facts.vcs, ["branch", "head", "kind", "layout"])) {
    fail("facts.vcs", "keys must be exactly branch, head, kind, layout");
  }
  if (!["git", "none"].includes(profile.facts.vcs.kind)) fail("facts.vcs.kind", "must be git or none");
  if (!["directory", "worktree-file", "none"].includes(profile.facts.vcs.layout)) {
    fail("facts.vcs.layout", "must be directory, worktree-file, or none");
  }
  if (!(profile.facts.vcs.branch === null || typeof profile.facts.vcs.branch === "string")) {
    fail("facts.vcs.branch", "must be null or a string");
  }
  if (!(profile.facts.vcs.head === null || GIT_HEAD.test(profile.facts.vcs.head))) {
    fail("facts.vcs.head", "must be null or a 40/64-character lowercase hex commit id");
  }
  if (!exactKeys(profile.repositoryFingerprint, ["algorithm", "basis", "digest"])) {
    fail("repositoryFingerprint", "keys must be exactly algorithm, basis, digest");
  }
  if (profile.repositoryFingerprint.algorithm !== "sha256") fail("repositoryFingerprint.algorithm", "must be sha256");
  if (!LEGACY_FINGERPRINT_BASES.has(profile.repositoryFingerprint.basis)) {
    fail("repositoryFingerprint.basis", `must be a supported repository-state basis`);
  }
  if (!HEX64.test(profile.repositoryFingerprint.digest)) {
    fail("repositoryFingerprint.digest", "must be 64 lowercase hex characters");
  }
  for (const key of ["frameworks", "languages", "packageManagers", "sourceRoots", "testRunners"]) {
    const values = profile.facts[key];
    const field = `facts.${key}`;
    if (!Array.isArray(values) || values.some((x) => typeof x !== "string" || !x)) {
      fail(field, "must be an array of non-empty strings");
    }
    if (new Set(values).size !== values.length) fail(field, "entries must be unique");
    if (JSON.stringify(values) !== JSON.stringify([...values].sort(utf8Sort))) {
      fail(field, "entries must be sorted in UTF-8 order");
    }
  }
  return profile;
}

function validateReceipt(receipt) {
  const fail = (field, clause) => invalidInit("init receipt", field, clause);
  if (!exactKeys(receipt, ["format", "schemaVersion", "classification", "phase", "profileDigest", "artifacts", "nativeInit", "finalStateFingerprint"])) {
    fail("receipt", "keys must be exactly artifacts, classification, finalStateFingerprint, format, nativeInit, phase, profileDigest, schemaVersion");
  }
  if (receipt.format !== RECEIPT_FORMAT) fail("format", `must be ${RECEIPT_FORMAT}`);
  if (receipt.schemaVersion !== 1) fail("schemaVersion", "must be 1");
  if (!["greenfield", "brownfield"].includes(receipt.classification)) {
    fail("classification", "must be greenfield or brownfield");
  }
  if (!["prepared", "finalized"].includes(receipt.phase)) fail("phase", "must be prepared or finalized");
  if (!HEX64.test(receipt.profileDigest)) fail("profileDigest", "must be 64 lowercase hex characters");
  if (!exactKeys(receipt.artifacts, ["created", "preserved", "skipped"])) {
    fail("artifacts", "keys must be exactly created, preserved, skipped");
  }
  checkSortedPaths(receipt.artifacts.created, "init receipt", "artifacts.created");
  checkSortedPaths(receipt.artifacts.preserved, "init receipt", "artifacts.preserved");
  if (!Array.isArray(receipt.artifacts.skipped)) fail("artifacts.skipped", "must be an array");
  for (const row of receipt.artifacts.skipped) {
    if (!exactKeys(row, ["path", "reason"])) {
      fail("artifacts.skipped", "each row must have exactly the keys path, reason");
    }
    if (!["exists", "brownfield", "native-pending", "unsafe"].includes(row.reason)) {
      fail("artifacts.skipped", "row reason must be exists, brownfield, native-pending, or unsafe");
    }
    try { safeRelative(row.path); } catch { fail("artifacts.skipped", "row path must be a safe relative path"); }
  }
  if (new Set(receipt.artifacts.skipped.map((row) => row.path)).size !== receipt.artifacts.skipped.length) {
    fail("artifacts.skipped", "row paths must be unique");
  }
  if (!rowsSortedByPath(receipt.artifacts.skipped)) {
    fail("artifacts.skipped", "rows must be sorted by UTF-8 path order");
  }
  const native = receipt.nativeInit;
  if (!exactKeys(native, ["state", "reason", "expectedArtifacts", "baseline", "attemptId", "handoffAcknowledged", "evidence"])) {
    fail("nativeInit", "keys must be exactly attemptId, baseline, evidence, expectedArtifacts, handoffAcknowledged, reason, state");
  }
  if (!["not-requested", "handoff", "attempted", "completed"].includes(native.state)) {
    fail("nativeInit.state", "must be not-requested, handoff, attempted, or completed");
  }
  if (!(native.reason === null || ["not-callable", "unavailable", "instruction-present"].includes(native.reason))) {
    fail("nativeInit.reason", "must be null, not-callable, unavailable, or instruction-present");
  }
  checkSortedPaths(native.expectedArtifacts, "init receipt", "nativeInit.expectedArtifacts");
  if (native.expectedArtifacts.some((path) => !NATIVE_ARTIFACTS.has(path))) {
    fail("nativeInit.expectedArtifacts", "entries must be known native artifacts");
  }
  if (!Array.isArray(native.baseline)) fail("nativeInit.baseline", "must be an array");
  if (native.baseline.length !== native.expectedArtifacts.length) {
    fail("nativeInit.baseline", "must align with nativeInit.expectedArtifacts");
  }
  native.baseline.forEach((row, index) => {
    if (!exactKeys(row, ["bytes", "path", "sha256"])) {
      fail("nativeInit.baseline", "each row must have exactly the keys bytes, path, sha256");
    }
    if (row.path !== native.expectedArtifacts[index]) {
      fail("nativeInit.baseline", "row path must match the expected artifact at the same index");
    }
    if (!((row.bytes === null && row.sha256 === null) ||
        (Number.isInteger(row.bytes) && row.bytes >= 0 && row.bytes <= activeLimits.learnFileBytes && HEX64.test(row.sha256)))) {
      fail("nativeInit.baseline", "row bytes/sha256 must both be null or a bounded byte count with a 64-hex digest");
    }
  });
  if (!(native.attemptId === null || HEX64.test(native.attemptId))) {
    fail("nativeInit.attemptId", "must be null or 64 lowercase hex characters");
  }
  if (typeof native.handoffAcknowledged !== "boolean") fail("nativeInit.handoffAcknowledged", "must be a boolean");
  if (!exactKeys(receipt.finalStateFingerprint, ["algorithm", "basis", "digest"])) {
    fail("finalStateFingerprint", "keys must be exactly algorithm, basis, digest");
  }
  if (receipt.finalStateFingerprint.algorithm !== "sha256") fail("finalStateFingerprint.algorithm", "must be sha256");
  if (!LEGACY_FINGERPRINT_BASES.has(receipt.finalStateFingerprint.basis)) {
    fail("finalStateFingerprint.basis", `must be a supported repository-state basis`);
  }
  if (!HEX64.test(receipt.finalStateFingerprint.digest)) {
    fail("finalStateFingerprint.digest", "must be 64 lowercase hex characters");
  }
  const evidence = receipt.nativeInit.evidence;
  if (evidence !== null) {
    if (!["approved-pointer-normalization", "artifact-delta", "preexisting-artifact-confirmed", "call-result"].includes(evidence.kind)) {
      fail("nativeInit.evidence.kind", "must be approved-pointer-normalization, artifact-delta, preexisting-artifact-confirmed, or call-result");
    }
    if (!Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0) {
      fail("nativeInit.evidence.artifacts", "must be a non-empty array");
    }
    if (new Set(evidence.artifacts.map((row) => row.path)).size !== evidence.artifacts.length) {
      fail("nativeInit.evidence.artifacts", "paths must be unique");
    }
    if (!rowsSortedByPath(evidence.artifacts)) {
      fail("nativeInit.evidence.artifacts", "must be sorted by UTF-8 path order");
    }
    for (const row of evidence.artifacts) {
      try { safeRelative(row.path); } catch { fail("nativeInit.evidence.artifacts", "row path must be a safe relative path"); }
      if (evidence.kind === "artifact-delta") {
        if (!exactKeys(row, ["after", "before", "path"])) {
          fail("nativeInit.evidence.artifacts", "artifact-delta rows must have exactly the keys after, before, path");
        }
        if (!HEX64.test(row.after)) {
          fail("nativeInit.evidence.artifacts", "row after must be 64 lowercase hex characters");
        }
        if (!(row.before === null || HEX64.test(row.before))) {
          fail("nativeInit.evidence.artifacts", "row before must be null or 64 lowercase hex characters");
        }
      } else if (!exactKeys(row, ["path", "sha256"]) || !HEX64.test(row.sha256)) {
        fail("nativeInit.evidence.artifacts", "rows must have exactly the keys path, sha256 with a 64-hex digest");
      }
    }
    if (evidence.kind === "call-result") {
      if (!exactKeys(evidence, ["kind", "artifacts", "resultDigest"])) {
        fail("nativeInit.evidence", "call-result evidence must have exactly the keys artifacts, kind, resultDigest");
      }
      if (!HEX64.test(evidence.resultDigest)) {
        fail("nativeInit.evidence.resultDigest", "must be 64 lowercase hex characters");
      }
    } else if (!exactKeys(evidence, ["kind", "artifacts"])) {
      fail("nativeInit.evidence", "evidence must have exactly the keys artifacts, kind");
    }
  }
  const computedAttemptId = sha256(canonicalInitJson({
    expectedArtifacts: native.expectedArtifacts,
    profileDigest: receipt.profileDigest,
  }));
  const baselineByPath = new Map(native.baseline.map((row) => [row.path, row]));
  if (evidence?.kind === "approved-pointer-normalization") {
    const artifactsByPath = new Map(evidence.artifacts.map((row) => [row.path, row]));
    const agentsBaseline = baselineByPath.get("AGENTS.md");
    const claudeBaseline = baselineByPath.get("CLAUDE.md");
    if (evidence.artifacts.length !== 2 || !coversInstructionPair([...artifactsByPath.keys()]) ||
        !agentsBaseline || agentsBaseline.sha256 === null || agentsBaseline.bytes === 0 ||
        !claudeBaseline || claudeBaseline.sha256 !== null || native.reason !== "not-callable" ||
        artifactsByPath.get("AGENTS.md")?.sha256 !== agentsBaseline.sha256 ||
        artifactsByPath.get("CLAUDE.md")?.sha256 !== sha256(CLAUDE_AUTHORITY_POINTER)) {
      fail("nativeInit.evidence", "approved pointer must bind AGENTS.md to its non-empty baseline and CLAUDE.md to the canonical pointer");
    }
  }
  const evidenceMatchesBaseline = evidence === null || evidence.artifacts.every((row) => {
    const baseline = baselineByPath.get(row.path);
    if (!baseline) return false;
    if (evidence.kind === "artifact-delta") return row.before === baseline.sha256;
    if (evidence.kind === "preexisting-artifact-confirmed") return baseline.sha256 !== null;
    return true;
  });
  const canonicalPairExpected =
    native.expectedArtifacts.includes("AGENTS.md") &&
    native.expectedArtifacts.includes("CLAUDE.md");
  const fullPairEvidence = !canonicalPairExpected || evidence === null ||
    evidence.kind === "artifact-delta" ||
    coversInstructionPair(evidence.artifacts.map((row) => row.path));
  // Per-state invariants of the native-init state machine, one named
  // predicate per state so a rejected receipt can name the arm it broke.
  // not-requested: native init was never asked for -- no reason, no expected
  // artifacts or baseline, no attempt id, no acknowledgement, no evidence.
  const validNotRequested = () =>
    native.reason === null && native.expectedArtifacts.length === 0 &&
    native.baseline.length === 0 && native.attemptId === null &&
    native.handoffAcknowledged === false && evidence === null;
  // handoff: the runtime owns native init -- a reason is required and the
  // attempt id binds the handoff to the profile; an acknowledgement is only
  // meaningful when the runtime is unavailable.
  const validHandoff = () =>
    native.reason !== null && native.attemptId === computedAttemptId &&
    evidence === null &&
    (!native.handoffAcknowledged || native.reason === "unavailable");
  // attempted: a callable adapter took the attempt -- no handoff reason or
  // acknowledgement, and completion evidence is not attached yet.
  const validAttempted = () =>
    native.reason === null && native.attemptId === computedAttemptId &&
    native.handoffAcknowledged === false && evidence === null;
  // completed: the attempt id still binds and positive evidence is attached;
  // handoffAcknowledged stays false (it only gates handoff finalization).
  const validCompleted = () =>
    native.attemptId === computedAttemptId &&
    native.handoffAcknowledged === false && evidence !== null;
  const statePredicates = {
    "not-requested": validNotRequested,
    handoff: validHandoff,
    attempted: validAttempted,
    completed: validCompleted,
  };
  // native.state is already validated as one of the four states above.
  const stateIsValid = statePredicates[native.state]();
  const phaseIsValid = receipt.phase === "prepared" ||
    native.state === "completed" ||
    (native.state === "handoff" && native.reason === "unavailable" && native.handoffAcknowledged);
  if (!stateIsValid) {
    fail("nativeInit", `state is inconsistent for "${native.state}" with reason, expectedArtifacts, baseline, attemptId, handoffAcknowledged, and evidence`);
  }
  if (!phaseIsValid) {
    fail("phase", "finalized requires a completed native init or an acknowledged unavailable handoff");
  }
  if (!evidenceMatchesBaseline) fail("nativeInit.evidence", "artifacts must match the handoff baseline");
  if (!fullPairEvidence) {
    fail("nativeInit.evidence", "confirmation and call-result must cover the canonical instruction authority pair");
  }
  return receipt;
}

async function readOwned(root) {
  const profileFile = await readRegular(root, INIT_PATHS.profile, activeLimits.learnFileBytes);
  const receiptFile = await readRegular(root, INIT_PATHS.receipt, activeLimits.learnFileBytes);
  if (!!profileFile !== !!receiptFile) throw new Error("owned init files must both be absent or present");
  if (!profileFile) return null;
  let profile;
  let receipt;
  try {
    profile = validateProfile(parseStrictJson(profileFile.bytes, "project profile"));
    receipt = validateReceipt(parseStrictJson(receiptFile.bytes, "init receipt"));
  } catch (error) {
    const detailed = error.message.includes("receipt") || error.message.startsWith("invalid project profile");
    throw new Error(detailed ? error.message : "invalid owned init state");
  }
  if (profile.classification !== receipt.classification ||
      sha256(canonicalInitJson(profile)) !== receipt.profileDigest) throw new Error("owned init state does not match");
  if (receipt.nativeInit.state === "completed") {
    await validateCanonicalInstructionPair(root, receipt.nativeInit.expectedArtifacts);
    const current = await artifactSnapshot(
      root, receipt.nativeInit.evidence.artifacts.map((row) => row.path),
    );
    for (let index = 0; index < current.length; index++) {
      const persisted = receipt.nativeInit.evidence.artifacts[index];
      const expectedHash = receipt.nativeInit.evidence.kind === "artifact-delta"
        ? persisted.after
        : persisted.sha256;
      if (current[index].sha256 !== expectedHash) {
        throw new Error(`completed evidence artifact changed or is missing: ${persisted.path}`);
      }
    }
  }
  return { profile, receipt };
}

export async function readInitReceipt(dir) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  return owned?.receipt ?? null;
}

async function writeReceipt(root, receipt) {
  validateReceipt(receipt);
  await atomicWrite(root, INIT_PATHS.receipt, Buffer.from(prettyInitJson(receipt)));
}

function initialReceipt(profile) {
  return {
    format: RECEIPT_FORMAT,
    schemaVersion: 1,
    classification: profile.classification,
    phase: "prepared",
    profileDigest: sha256(canonicalInitJson(profile)),
    artifacts: { created: [], preserved: [], skipped: [] },
    nativeInit: {
      state: "not-requested", reason: null, expectedArtifacts: [], baseline: [],
      attemptId: null, handoffAcknowledged: false, evidence: null,
    },
    finalStateFingerprint: profile.repositoryFingerprint,
  };
}

export async function initializeProject(dir) {
  const root = await validateRoot(dir);
  const existing = await readOwned(root);
  if (existing) return observeNativeInit(root);
  const classification = await classify(root);
  if (classification === "greenfield" && (await absent(join(root, ".git")))) await initGit(root);
  const profile = await learnProjectProfile(root);
  profile.classification = classification;
  await mkdir(join(root, ".muster"), { recursive: false }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const receipt = initialReceipt(profile);
  await atomicWrite(root, INIT_PATHS.profile, Buffer.from(prettyInitJson(profile)));
  await atomicWrite(root, INIT_PATHS.receipt, Buffer.from(prettyInitJson(receipt)));
  return envelope(receipt);
}

async function artifactSnapshot(root, paths) {
  const result = [];
  for (const path of paths) {
    const file = await readRegular(root, path, activeLimits.learnFileBytes);
    result.push(file
      ? { bytes: file.info.size, path, sha256: sha256(file.bytes) }
      : { bytes: null, path, sha256: null });
  }
  return result;
}

function expectedArtifacts(paths) {
  if (!Array.isArray(paths) || paths.length > activeLimits.nativeArtifacts) throw new Error("invalid expected artifacts");
  const result = [...new Set(paths.map(safeRelative))].sort(utf8Sort);
  if (result.length !== paths.length || result.some((path) => !NATIVE_ARTIFACTS.has(path))) throw new Error("invalid expected artifacts");
  return result;
}

function coversInstructionPair(paths) {
  return paths.includes("AGENTS.md") && paths.includes("CLAUDE.md");
}

function importsClaudeInstruction(markdown, sourcePath, targetPath) {
  const importPattern = /(?:^|[\s([{"'`<])@([^\s<>"'`]+)/gu;
  for (const match of markdown.matchAll(importPattern)) {
    const specifier = match[1].replace(/[),.;:!?\]}>]+$/u, "");
    if (!specifier || specifier.startsWith("~")) continue;
    if (resolve(dirname(sourcePath), specifier) === targetPath) return true;
  }
  return false;
}

async function validateCanonicalInstructionPair(root, expected) {
  if (!expected.includes("AGENTS.md") || !expected.includes("CLAUDE.md")) return;
  const [agents, claude] = await Promise.all([
    readRegular(root, "AGENTS.md", activeLimits.learnFileBytes),
    readRegular(root, "CLAUDE.md", activeLimits.learnFileBytes),
  ]);
  const agentsImportsClaude = agents &&
    importsClaudeInstruction(
      agents.bytes.toString("utf8"),
      join(root, "AGENTS.md"),
      join(root, "CLAUDE.md"),
    );
  if (!agents || agents.bytes.length === 0 || agentsImportsClaude ||
      !claude || !claude.bytes.equals(CLAUDE_AUTHORITY_POINTER)) {
    throw new Error("native completion requires the canonical instruction authority pair");
  }
}

export async function observeNativeInit(dir) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const { receipt } = owned;
  if (!["handoff", "attempted"].includes(receipt.nativeInit.state) || !receipt.nativeInit.baseline.length) return envelope(receipt);
  const current = await artifactSnapshot(root, receipt.nativeInit.expectedArtifacts);
  const artifacts = [];
  for (let i = 0; i < current.length; i++) {
    const before = receipt.nativeInit.baseline[i];
    const after = current[i];
    if (after.sha256 !== before.sha256 && after.sha256 !== null) {
      artifacts.push({ after: after.sha256, before: before.sha256, path: after.path });
    }
  }
  return envelope(receipt, artifacts.length ? { kind: "artifact-delta", artifacts } : null);
}

async function readEvidence(root, rel) {
  if (!rel) throw new Error("evidence file is required");
  const file = await readRegular(root, safeRelative(rel), activeLimits.evidenceBytes);
  if (!file) throw new Error("evidence file does not exist");
  return { value: parseStrictJson(file.bytes, "evidence file"), bytes: file.bytes };
}

async function completionEvidence(root, receipt, kind, evidenceFile) {
  const expected = receipt.nativeInit.expectedArtifacts;
  if (kind === "call-result") {
    if (receipt.nativeInit.state !== "attempted") {
      throw new Error("call-result evidence requires an attempted native init");
    }
    if (!evidenceFile) throw new Error("evidence file is required");
    if (expected.includes(safeRelative(evidenceFile))) {
      throw new Error("call-result evidence file must not be an expected artifact");
    }
  }
  await validateCanonicalInstructionPair(root, expected);
  if (kind === "artifact-delta") {
    const baseline = new Map(receipt.nativeInit.baseline.map((row) => [row.path, row]));
    if (coversInstructionPair(expected) && baseline.get("AGENTS.md")?.sha256 !== null &&
        baseline.get("CLAUDE.md")?.sha256 === null) {
      throw new Error("AGENTS-only baseline requires approved pointer normalization");
    }
    const observed = await observeNativeInit(root);
    if (!observed.observedNativeEvidence) throw new Error("artifact delta evidence is not present");
    return observed.observedNativeEvidence;
  }
  const { value } = await readEvidence(root, evidenceFile);
  const current = await artifactSnapshot(root, expected);
  if (kind === "preexisting-confirmed") {
    // Deliberate spelling alias: the transition API (and the CLI `--evidence`
    // surface, pinned by docs and workflow tests) accepts the short kind
    // "preexisting-confirmed", while the persisted receipt schema names the
    // same evidence "preexisting-artifact-confirmed" (see validateReceipt and
    // the return below). Do not unify the spellings without a receipt schema
    // migration.
    if (!exactKeys(value, ["format", "schemaVersion", "confirmation", "artifacts"]) ||
        value.format !== "muster.native-init-confirmation" || value.schemaVersion !== 1 ||
        value.confirmation !== "already-initialized") throw new Error("invalid pre-existing confirmation");
    const artifacts = expectedArtifacts(value.artifacts);
    if (expected.includes("AGENTS.md") && expected.includes("CLAUDE.md") &&
        !coversInstructionPair(artifacts)) {
      throw new Error("pre-existing confirmation must cover the canonical instruction authority pair");
    }
    const rows = [];
    for (const path of artifacts) {
      const index = expected.indexOf(path);
      if (index < 0 || receipt.nativeInit.baseline[index].sha256 === null ||
          current[index].sha256 !== receipt.nativeInit.baseline[index].sha256) throw new Error("pre-existing artifact confirmation does not match baseline");
      rows.push({ path, sha256: current[index].sha256 });
    }
    if (!rows.length) throw new Error("confirmation requires artifacts");
    return { kind: "preexisting-artifact-confirmed", artifacts: rows };
  }
  if (kind === "call-result") {
    if (!exactKeys(value, ["format", "schemaVersion", "ok", "operation", "attemptId", "artifacts"]) ||
        value.format !== "muster.native-init-result" || value.schemaVersion !== 1 ||
        value.ok !== true || value.operation !== "native-init") throw new Error("invalid native init call result");
    if (value.attemptId !== receipt.nativeInit.attemptId) {
      throw new Error("native init call result attempt id does not match");
    }
    const artifacts = expectedArtifacts(value.artifacts);
    if (expected.includes("AGENTS.md") && expected.includes("CLAUDE.md") &&
        !coversInstructionPair(artifacts)) {
      throw new Error("call result must cover the canonical instruction authority pair");
    }
    if (!artifacts.length) throw new Error("call result requires artifacts");
    const rows = artifacts.map((path) => {
      const index = expected.indexOf(path);
      if (index < 0 || current[index].sha256 === null) throw new Error("call result artifact is missing");
      return { path, sha256: current[index].sha256 };
    });
    return { kind: "call-result", artifacts: rows, resultDigest: sha256(canonicalInitJson(value)) };
  }
  throw new Error("invalid evidence kind");
}

export async function transitionNativeInit(dir, {
  to, reason = null, expectedArtifacts: requested = [], evidenceKind = null, evidenceFile = null,
}) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const receipt = owned.receipt;
  const from = receipt.nativeInit.state;
  if (to === from) return envelope(receipt);
  if (from === "completed") throw new Error("completed native init state is absorbing");
  if (from === "not-requested" && ["handoff", "attempted"].includes(to)) {
    const expected = expectedArtifacts(requested);
    if (to === "handoff" && !["not-callable", "unavailable", "instruction-present"].includes(reason)) {
      throw new Error("handoff requires a valid reason");
    }
    if (to === "attempted" && reason !== null) throw new Error("attempted transition does not accept a reason");
    const baseline = await artifactSnapshot(root, expected);
    const attemptId = sha256(canonicalInitJson({ expectedArtifacts: expected, profileDigest: receipt.profileDigest }));
    receipt.nativeInit = {
      state: to, reason, expectedArtifacts: expected, baseline, attemptId,
      handoffAcknowledged: false, evidence: null,
    };
  } else if (["handoff", "attempted"].includes(from) && to === "completed") {
    receipt.nativeInit.evidence = await completionEvidence(root, receipt, evidenceKind, evidenceFile);
    receipt.nativeInit.state = "completed";
    receipt.nativeInit.handoffAcknowledged = false;
  } else {
    throw new Error(`invalid native init transition: ${from} -> ${to}`);
  }
  await writeReceipt(root, receipt);
  return envelope(receipt);
}

export async function normalizeCodexInstructionPair(dir, { approved = false } = {}) {
  if (approved !== true) throw new Error("Codex pointer normalization requires explicit approval");
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const { receipt } = owned;
  const native = receipt.nativeInit;
  if (native.state !== "handoff" || native.reason !== "not-callable" ||
      JSON.stringify(native.expectedArtifacts) !== JSON.stringify(["AGENTS.md", "CLAUDE.md"])) {
    throw new Error("Codex pointer normalization requires a pending canonical-pair handoff");
  }
  const baseline = new Map(native.baseline.map((row) => [row.path, row]));
  const agentsBaseline = baseline.get("AGENTS.md");
  const claudeBaseline = baseline.get("CLAUDE.md");
  if (!agentsBaseline || agentsBaseline.sha256 === null || agentsBaseline.bytes === 0 ||
      !claudeBaseline || claudeBaseline.sha256 !== null) {
    throw new Error("Codex pointer normalization requires an AGENTS-only baseline");
  }
  const assertUnchangedAuthority = async () => {
    const agents = await readRegular(root, "AGENTS.md", activeLimits.learnFileBytes);
    if (!agents || agents.bytes.length === 0 || sha256(agents.bytes) !== agentsBaseline.sha256 ||
        agents.info.size !== agentsBaseline.bytes) {
      throw new Error("AGENTS.md no longer matches the approved baseline");
    }
    if (importsClaudeInstruction(agents.bytes.toString("utf8"), join(root, "AGENTS.md"), join(root, "CLAUDE.md"))) {
      throw new Error("AGENTS.md baseline must not import CLAUDE.md");
    }
    return agents;
  };
  await assertUnchangedAuthority();
  let created;
  try {
    created = await createContainedFile(root, join(root, "CLAUDE.md"), CLAUDE_AUTHORITY_POINTER);
  } catch (error) {
    throw new Error(`CLAUDE.md must remain absent for approved normalization: ${error.message}`);
  }
  if (!created) throw new Error("CLAUDE.md must remain absent for approved normalization");
  const agents = await assertUnchangedAuthority();
  const claude = await readRegular(root, "CLAUDE.md", activeLimits.learnFileBytes);
  if (!claude || !claude.bytes.equals(CLAUDE_AUTHORITY_POINTER)) {
    throw new Error("CLAUDE.md changed during approved normalization");
  }
  native.evidence = {
    kind: "approved-pointer-normalization",
    artifacts: [
      { path: "AGENTS.md", sha256: sha256(agents.bytes) },
      { path: "CLAUDE.md", sha256: sha256(claude.bytes) },
    ],
  };
  native.state = "completed";
  native.handoffAcknowledged = false;
  await writeReceipt(root, receipt);
  return envelope((await readOwned(root)).receipt);
}

export async function acknowledgeNativeInitHandoff(dir, { reason }) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const receipt = owned.receipt;
  if (receipt.nativeInit.state !== "handoff" || receipt.nativeInit.reason !== "unavailable" || reason !== "unavailable") {
    throw new Error("only an unavailable handoff can be acknowledged");
  }
  if (receipt.nativeInit.handoffAcknowledged) return envelope(receipt);
  receipt.nativeInit.handoffAcknowledged = true;
  await writeReceipt(root, receipt);
  return envelope(receipt);
}

const FINAL_SEEDS = {
  ".gitignore": "node_modules/\n.muster/\n*.log\n",
  "README.md": "# Project\n\nInitialized by muster.\n",
  "docs/design/.gitkeep": "",
  "docs/plan/.gitkeep": "",
};

export async function finalizeInitialization(dir) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const receipt = owned.receipt;
  if (receipt.phase === "finalized") return envelope(receipt);
  if (receipt.nativeInit.state !== "completed" &&
      !(receipt.nativeInit.state === "handoff" && receipt.nativeInit.reason === "unavailable" &&
        receipt.nativeInit.handoffAcknowledged)) throw new Error("native initialization is pending");
  const created = [];
  const preserved = [];
  const skipped = [];
  for (const [path, content] of Object.entries(FINAL_SEEDS).sort(([a], [b]) => utf8Sort(a, b))) {
    if (receipt.classification === "brownfield") {
      skipped.push({ path, reason: "brownfield" });
    } else if (await absent(join(root, ...path.split("/")))) {
      await atomicWrite(root, path, Buffer.from(content));
      created.push(path);
    } else {
      const existing = await readRegular(root, path, activeLimits.learnFileBytes);
      if (!existing) throw new Error(`unsafe finalization target: ${path}`);
      preserved.push(path);
      skipped.push({ path, reason: "exists" });
    }
  }
  receipt.phase = "finalized";
  receipt.artifacts = { created: created.sort(utf8Sort), preserved: preserved.sort(utf8Sort), skipped: skipped.sort((a, b) => utf8Sort(a.path, b.path)) };
  receipt.finalStateFingerprint = await repositoryFingerprint(root);
  await writeReceipt(root, receipt);
  return envelope(receipt);
}
