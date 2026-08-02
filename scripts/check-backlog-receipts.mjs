#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  BACKLOG_RECEIPT_MAX_BYTES,
  BACKLOG_RECEIPT_MAX_CHECKED_ITEMS,
  BACKLOG_RECEIPT_MAX_TOTAL_BYTES,
  BACKLOG_RECEIPT_MAX_UNIQUE_RECEIPTS,
  checkBacklogReceipts,
  makeGitReachabilityVerifier,
} from "../src/backlog-receipts.js";

const GIT_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function git(args, { input, allowNoMatch = false, maxBuffer = GIT_OUTPUT_MAX_BYTES } = {}) {
  const result = spawnSync("git", args, {
    cwd: process.cwd(),
    env: { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" },
    input,
    maxBuffer,
    stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
  });
  if (result.error || result.status !== 0 || result.stderr.length !== 0) {
    if (allowNoMatch && result.status === 1 && !result.error && result.stderr.length === 0) return result;
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

const flagIndex = process.argv.indexOf("--release-ref");
const releaseRef = flagIndex >= 0 ? process.argv[flagIndex + 1] : "origin/main";
if (!releaseRef || releaseRef.startsWith("-") || /[\0-\x20\x7f]/.test(releaseRef)) {
  throw new Error("--release-ref must be a non-option Git ref without control characters or whitespace");
}
const releaseCommit = utf8.decode(git(["rev-parse", "--verify", `${releaseRef}^{commit}`]).stdout).trim().toLowerCase();

// Freeze one logical index snapshot. Candidate discovery deliberately searches
// a literal superset of the parser grammar, including binary-classified blobs;
// exact parsing happens only after each raw path is mapped to its immutable blob.
const tree = utf8.decode(git(["write-tree"]).stdout).trim();
const entries = new Map();
for (const record of splitNul(git(["ls-tree", "-r", "-z", "--full-tree", tree]).stdout)) {
  const tab = record.indexOf(9);
  if (tab < 0) throw new Error("git ls-files returned an invalid record");
  const header = record.subarray(0, tab).toString("ascii");
  const match = /^(\d{6}) blob ([0-9a-f]{40,64})$/.exec(header);
  if (!match) continue;
  entries.set(record.subarray(tab + 1).toString("hex"), { mode: match[1], oid: match[2], rawPath: record.subarray(tab + 1) });
}
const discovery = git([
  "grep", "-z", "-l", "-a", "-F",
  "-e", "- [x] ", "-e", "- [X] ", tree, "--",
], { allowNoMatch: true });
const candidates = discovery.status === 1 ? [] : splitNul(discovery.stdout).map((rawPath) => {
  const prefix = Buffer.from(`${tree}:`);
  if (!rawPath.subarray(0, prefix.length).equals(prefix)) throw new Error("git grep returned an invalid tree prefix");
  const snapshotPath = rawPath.subarray(prefix.length);
  const entry = entries.get(snapshotPath.toString("hex"));
  if (!entry) throw new Error("git grep returned a path absent from the captured index");
  if (entry.mode !== "100644" && entry.mode !== "100755") throw new Error("tracked checklist must be a regular file");
  let path;
  try { path = utf8.decode(entry.rawPath); }
  catch { throw new Error("tracked checklist path is not valid UTF-8"); }
  return { ...entry, path };
});
if (candidates.length > BACKLOG_RECEIPT_MAX_CHECKED_ITEMS) {
  throw new Error(`repository contains more than ${BACKLOG_RECEIPT_MAX_CHECKED_ITEMS} candidate checklist files`);
}

const uniqueOids = [...new Set(candidates.map(({ oid }) => oid))];
const sizes = new Map();
if (uniqueOids.length > 0) {
  const checked = git(["cat-file", "--batch-check=%(objectname) %(objecttype) %(objectsize)"], {
    input: Buffer.from(`${uniqueOids.join("\n")}\n`),
  });
  for (const line of utf8.decode(checked.stdout).trim().split("\n")) {
    const match = /^([0-9a-f]{40,64}) blob (\d+)$/.exec(line);
    if (!match) throw new Error("git cat-file --batch-check returned an invalid blob response");
    sizes.set(match[1], Number(match[2]));
  }
}
const totalCandidateBytes = candidates.reduce((sum, { oid }) => sum + (sizes.get(oid) || 0), 0);
if (!Number.isSafeInteger(totalCandidateBytes) || totalCandidateBytes > BACKLOG_RECEIPT_MAX_TOTAL_BYTES) {
  throw new Error(`candidate checklist blobs exceed ${BACKLOG_RECEIPT_MAX_TOTAL_BYTES} total bytes`);
}

const isReachable = makeGitReachabilityVerifier({ cwd: process.cwd(), releaseCommit });
const reachabilityCache = new Map();
const results = [];
let checkedItems = 0;
for (const { oid, path } of candidates.sort((a, b) => a.path.localeCompare(b.path))) {
  const size = sizes.get(oid);
  if (!Number.isSafeInteger(size) || size > BACKLOG_RECEIPT_MAX_BYTES) {
    throw new Error(`unsafe regular file: ${path}`);
  }
  const blob = git(["cat-file", "blob", oid], { maxBuffer: BACKLOG_RECEIPT_MAX_BYTES + 1 }).stdout;
  if (blob.length !== size) throw new Error(`git blob size changed while reading: ${path}`);
  const result = checkBacklogReceipts(blob.toString("utf8"), {
    releaseRef,
    isReachable,
    reachabilityCache,
    maxCheckedItems: BACKLOG_RECEIPT_MAX_CHECKED_ITEMS - checkedItems,
    maxUniqueReceipts: BACKLOG_RECEIPT_MAX_UNIQUE_RECEIPTS,
  });
  checkedItems += result.summary.checked;
  results.push({ path, ...result });
}
const rejected = results.reduce((sum, result) => sum + result.summary.rejected, 0);
const report = { ok: rejected === 0, releaseRef, files: results.length, rejected, results };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 2;
