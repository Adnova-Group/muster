import { spawnSync } from "node:child_process";
import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { stripAnnotations } from "./sprint-waves.js";

const CHECKED_CHECKBOX_RE = /^- \[[xX]\] (.*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;
export const BACKLOG_RECEIPT_MAX_BYTES = 16 * 1024 * 1024;
export const BACKLOG_RECEIPT_MAX_CHECKED_ITEMS = 1_000;
export const BACKLOG_RECEIPT_MAX_UNIQUE_RECEIPTS = 1_000;
export const BACKLOG_RECEIPT_MAX_LINE_BYTES = 64 * 1024;
export const BACKLOG_RECEIPT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const GIT_REACHABILITY_TIMEOUT_MS = 30_000;
const GIT_REACHABILITY_MAX_BUFFER = 1024 * 1024;
export const TRUSTED_GIT_COMMAND = process.platform === "win32"
  ? String.raw`C:\Program Files\Git\cmd\git.exe`
  : "/usr/bin/git";

export function assertTrustedGitCommand() {
  const info = lstatSync(TRUSTED_GIT_COMMAND);
  if (!info.isFile() || info.isSymbolicLink() || realpathSync(TRUSTED_GIT_COMMAND) !== TRUSTED_GIT_COMMAND
    || (info.mode & 0o022) !== 0
    || (typeof process.getuid === "function" && info.uid !== 0)) {
    throw new Error(`trusted Git executable is unavailable at ${TRUSTED_GIT_COMMAND}`);
  }
  return TRUSTED_GIT_COMMAND;
}

export function trustedGitEnvironment(environment = process.env) {
  const clean = Object.fromEntries(Object.entries(environment).filter(([key]) => !/^GIT_/i.test(key)));
  return {
    ...clean,
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_OPTIONAL_LOCKS: "0",
    GIT_TERMINAL_PROMPT: "0",
  };
}

function hasStderr(result) {
  return result.stderr !== undefined && result.stderr !== null && result.stderr.length !== 0;
}

function gitOptions(cwd, extra = {}) {
  return {
    cwd,
    encoding: "utf8",
    env: trustedGitEnvironment(),
    timeout: GIT_REACHABILITY_TIMEOUT_MS,
    maxBuffer: GIT_REACHABILITY_MAX_BUFFER,
    ...extra,
  };
}

function gitFailure(operation, result) {
  if (result.error) throw result.error;
  throw new Error(`${operation} failed with exit ${result.status ?? "unknown"}`);
}

export function checkBacklogReceipts(content, {
  releaseRef,
  isReachable,
  reachabilityCache = new Map(),
  maxCheckedItems = BACKLOG_RECEIPT_MAX_CHECKED_ITEMS,
  maxUniqueReceipts = BACKLOG_RECEIPT_MAX_UNIQUE_RECEIPTS,
} = {}) {
  if (typeof content !== "string") throw new TypeError("backlog content must be a string");
  if (typeof releaseRef !== "string" || releaseRef.trim() === "") throw new TypeError("releaseRef must be a non-empty string");
  if (typeof isReachable !== "function") throw new TypeError("isReachable must be a function");
  const errors = [];
  let checked = 0, withdrawn = 0, verified = 0;
  content.split(/\r\n|\n|\r/).forEach((line, index) => {
    const match = CHECKED_CHECKBOX_RE.exec(line.replace(/^\s+/, ""));
    if (!match) return;
    if (Buffer.byteLength(line) > BACKLOG_RECEIPT_MAX_LINE_BYTES) {
      throw new Error(`checked backlog line exceeds ${BACKLOG_RECEIPT_MAX_LINE_BYTES} bytes`);
    }
    checked += 1;
    if (checked > maxCheckedItems) {
      throw new Error(`backlog contains more than ${maxCheckedItems} permitted checked items`);
    }
    const lineNo = index + 1;
    const { anns, annotationCounts } = stripAnnotations(match[1]);
    const id = anns.id || `item-${lineNo}`;
    const duplicatedReceipt = ["merge", "done", "withdrawn"].find((key) => (annotationCounts[key] || 0) > 1);
    if (duplicatedReceipt) {
      errors.push({ id, line: lineNo, reason: `checked item repeats {${duplicatedReceipt}: ...}; receipt annotations must be unique` });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(anns, "withdrawn")) {
      if (anns.withdrawn) withdrawn += 1;
      else errors.push({ id, line: lineNo, reason: "withdrawn exemption requires a non-empty reason" });
      return;
    }
    const receipts = ["merge", "done"].filter((key) => Object.prototype.hasOwnProperty.call(anns, key));
    if (receipts.length === 0) {
      errors.push({ id, line: lineNo, reason: "missing {merge: <SHA>} or {done: <SHA>} receipt" });
      return;
    }
    if (receipts.length !== 1) {
      errors.push({ id, line: lineNo, reason: "checked item must carry exactly one merge or done receipt" });
      return;
    }
    const receiptType = receipts[0];
    const receipt = anns[receiptType];
    if (!SHA_RE.test(receipt)) {
      errors.push({ id, line: lineNo, reason: `${receiptType} receipt must be a lowercase 40-character Git SHA` });
      return;
    }
    if (!reachabilityCache.has(receipt)) {
      if (reachabilityCache.size >= maxUniqueReceipts) {
        throw new Error(`backlog contains more than ${maxUniqueReceipts} unique receipt SHAs`);
      }
      reachabilityCache.set(receipt, isReachable(receipt));
    }
    if (!reachabilityCache.get(receipt)) {
      errors.push({ id, line: lineNo, reason: `${receiptType} receipt ${receipt} is not reachable from release ref ${releaseRef}` });
      return;
    }
    verified += 1;
  });
  return { ok: errors.length === 0, releaseRef, summary: { checked, withdrawn, verified, rejected: errors.length }, errors };
}

export function makeGitReachabilityVerifier({ cwd, releaseCommit, spawnSyncImpl = spawnSync }) {
  if (!SHA_RE.test(releaseCommit || "")) throw new TypeError("releaseCommit must be a lowercase 40-character Git SHA");
  const gitCommand = assertTrustedGitCommand();
  const graftLocation = spawnSyncImpl(gitCommand, ["rev-parse", "--git-path", "info/grafts"], gitOptions(cwd, { stdio: ["ignore", "pipe", "pipe"] }));
  if (graftLocation.error || graftLocation.status !== 0 || hasStderr(graftLocation)) gitFailure("git rev-parse --git-path info/grafts", graftLocation);
  const graftPath = graftLocation.stdout.trim();
  if (graftPath) {
    try {
      lstatSync(resolve(cwd, graftPath));
      throw new Error("git reachability verification refuses legacy info/grafts metadata");
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  const repository = spawnSyncImpl(gitCommand, ["rev-parse", "--git-dir"], gitOptions(cwd, { stdio: ["ignore", "pipe", "pipe"] }));
  if (repository.error) throw repository.error;
  if (repository.status !== 0 || hasStderr(repository)) throw new Error("git reachability verification requires a repository");
  return (receipt) => {
    // Batch-check reports an unknown object as structured `missing` output while
    // reserving a nonzero process status for an operational Git failure. `cat-file
    // -e` collapses both cases to a nonzero exit (commonly 128), which would let a
    // broken object database masquerade as an ordinary stale receipt.
    const object = spawnSyncImpl(gitCommand, ["cat-file", "--batch-check=%(objectname) %(objecttype)"], {
      ...gitOptions(cwd),
      input: `${receipt}\n`,
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (object.status !== 0 || object.error || hasStderr(object)) gitFailure("git cat-file --batch-check", object);
    const objectLine = object.stdout.trim();
    if (objectLine === `${receipt} missing`) return false;
    if (objectLine !== `${receipt} commit`) {
      if (/^[0-9a-f]{40} \S+$/.test(objectLine)) return false;
      throw new Error("git cat-file --batch-check returned an invalid response");
    }
    const result = spawnSyncImpl(gitCommand, ["merge-base", "--is-ancestor", receipt, releaseCommit], gitOptions(cwd, {
      stdio: ["ignore", "pipe", "pipe"],
    }));
    if (result.error) throw result.error;
    if (hasStderr(result)) gitFailure("git merge-base --is-ancestor", result);
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    gitFailure("git merge-base --is-ancestor", result);
  };
}
