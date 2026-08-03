#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  BACKLOG_RECEIPT_MAX_CHECKED_ITEMS,
  BACKLOG_RECEIPT_MAX_TOTAL_BYTES,
  BACKLOG_RECEIPT_MAX_UNIQUE_RECEIPTS,
  TRUSTED_GIT_COMMAND,
  assertTrustedGitCommand,
  checkBacklogReceipts,
  makeGitReachabilityVerifier,
  trustedGitEnvironment,
} from "../src/backlog-receipts.js";

const GIT_TIMEOUT_MS = 30_000;
const GIT_OUTPUT_MAX_BYTES = BACKLOG_RECEIPT_MAX_TOTAL_BYTES + 4 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });
assertTrustedGitCommand();

function git(args, { input, maxBuffer = GIT_OUTPUT_MAX_BYTES } = {}) {
  const result = spawnSync(TRUSTED_GIT_COMMAND, args, {
    cwd: process.cwd(),
    env: trustedGitEnvironment(),
    input,
    maxBuffer,
    timeout: GIT_TIMEOUT_MS,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.stderr.length !== 0) {
    if (result.error) throw result.error;
    throw new Error(`git ${args[0]} failed with exit ${result.status ?? "unknown"}`);
  }
  return result;
}

function splitNul(bytes) {
  const parts = [];
  let start = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0) continue;
    parts.push(bytes.subarray(start, index));
    start = index + 1;
  }
  if (start !== bytes.length) throw new Error("Git returned unterminated NUL-delimited output");
  return parts.filter((part) => part.length > 0);
}

function parseBatchBlobs(output, expectedOids) {
  const blobs = new Map();
  let cursor = 0;
  for (const expectedOid of expectedOids) {
    const newline = output.indexOf(10, cursor);
    if (newline < 0) throw new Error("git cat-file --batch returned a truncated header");
    const header = output.subarray(cursor, newline).toString("ascii");
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(header);
    if (!match || match[1] !== expectedOid) throw new Error("git cat-file --batch returned an invalid blob header");
    const size = Number(match[2]);
    const start = newline + 1;
    const end = start + size;
    if (!Number.isSafeInteger(size) || end >= output.length || output[end] !== 10) {
      throw new Error("git cat-file --batch returned invalid blob framing");
    }
    const bytes = output.subarray(start, end);
    const algorithm = expectedOid.length === 64 ? "sha256" : "sha1";
    const actualOid = createHash(algorithm).update(Buffer.from(`blob ${size}\0`)).update(bytes).digest("hex");
    if (actualOid !== expectedOid) throw new Error(`git object hash mismatch for ${expectedOid}`);
    blobs.set(expectedOid, bytes);
    cursor = end + 1;
  }
  if (cursor !== output.length) throw new Error("git cat-file --batch returned trailing output");
  return blobs;
}

const flagIndex = process.argv.indexOf("--release-ref");
const releaseRef = flagIndex >= 0 ? process.argv[flagIndex + 1] : "origin/main";
if (!releaseRef || releaseRef.startsWith("-") || /[\0-\x20\x7f]/.test(releaseRef)) {
  throw new Error("--release-ref must be a non-option Git ref without control characters or whitespace");
}
const releaseCommit = utf8.decode(git([
  "-c", "core.warnAmbiguousRefs=true", "rev-parse", "--verify", "--end-of-options", `${releaseRef}^{commit}`,
]).stdout).trim().toLowerCase();

// Bind validation to the checked-out commit, not the mutable index. Preflight
// integrity and aggregate sizes before reading content; then independently hash
// every returned blob before the authoritative JavaScript parser sees it.
const headCommit = utf8.decode(git(["rev-parse", "--verify", "HEAD^{commit}"]).stdout).trim();
git(["fsck", "--strict", "--no-dangling", headCommit]);
const tree = utf8.decode(git(["rev-parse", "--verify", `${headCommit}^{tree}`]).stdout).trim();
const entries = [];
for (const record of splitNul(git(["ls-tree", "-r", "-z", "-l", "--full-tree", tree]).stdout)) {
  const tab = record.indexOf(9);
  if (tab < 0) throw new Error("git ls-tree returned an invalid record");
  const header = record.subarray(0, tab).toString("ascii");
  const match = /^(100644|100755) blob ([0-9a-f]{40,64})\s+(\d+)$/.exec(header);
  if (!match) continue;
  const size = Number(match[3]);
  if (!Number.isSafeInteger(size)) throw new Error("git ls-tree returned an invalid blob size");
  entries.push({ mode: match[1], oid: match[2], size, rawPath: record.subarray(tab + 1) });
}
const totalTrackedBytes = entries.reduce((sum, entry) => sum + entry.size, 0);
if (!Number.isSafeInteger(totalTrackedBytes) || totalTrackedBytes > BACKLOG_RECEIPT_MAX_TOTAL_BYTES) {
  throw new Error(`tracked repository blobs exceed ${BACKLOG_RECEIPT_MAX_TOTAL_BYTES} total bytes`);
}

const uniqueOids = [...new Set(entries.map(({ oid }) => oid))];
const batch = uniqueOids.length === 0
  ? Buffer.alloc(0)
  : git(["cat-file", "--batch"], { input: Buffer.from(`${uniqueOids.join("\n")}\n`) }).stdout;
const blobs = parseBatchBlobs(batch, uniqueOids);

const isReachable = makeGitReachabilityVerifier({ cwd: process.cwd(), releaseCommit });
const reachabilityCache = new Map();
const results = [];
let checkedItems = 0;
for (const entry of entries) {
  const blob = blobs.get(entry.oid);
  if (!blob || blob.length !== entry.size) throw new Error("verified blob size does not match its tree entry");
  const result = checkBacklogReceipts(blob.toString("utf8"), {
    releaseRef,
    isReachable,
    reachabilityCache,
    maxCheckedItems: BACKLOG_RECEIPT_MAX_CHECKED_ITEMS - checkedItems,
    maxUniqueReceipts: BACKLOG_RECEIPT_MAX_UNIQUE_RECEIPTS,
  });
  if (result.summary.checked === 0) continue;
  let path;
  try { path = utf8.decode(entry.rawPath); }
  catch { throw new Error("tracked checklist path is not valid UTF-8"); }
  checkedItems += result.summary.checked;
  results.push({ path, ...result });
}
results.sort((a, b) => a.path.localeCompare(b.path));
if (results.length > BACKLOG_RECEIPT_MAX_CHECKED_ITEMS) {
  throw new Error(`repository contains more than ${BACKLOG_RECEIPT_MAX_CHECKED_ITEMS} checklist files`);
}
const rejected = results.reduce((sum, result) => sum + result.summary.rejected, 0);
const report = { ok: rejected === 0, releaseRef, files: results.length, rejected, results };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 2;
