#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
  BACKLOG_RECEIPT_MAX_BYTES,
  checkBacklogReceipts,
  makeGitReachabilityVerifier,
} from "../src/backlog-receipts.js";
import { readNoFollowRegular, resolveContainedRealpath } from "../src/fs-safe.js";

const flagIndex = process.argv.indexOf("--release-ref");
const releaseRef = flagIndex >= 0 ? process.argv[flagIndex + 1] : "origin/main";
if (!releaseRef || releaseRef.startsWith("-") || /[\0-\x20\x7f]/.test(releaseRef)) {
  throw new Error("--release-ref must be a non-option Git ref without control characters or whitespace");
}
const releaseCommit = execFileSync("git", ["rev-parse", "--verify", `${releaseRef}^{commit}`], { encoding: "utf8" }).trim().toLowerCase();
// A backlog is defined by checklist content, not its filename: the supported
// backlog grammar accepts any readable checklist path. Search tracked blobs so
// a renamed roadmap/checklist cannot evade the CI gate, then independently read
// each working-tree candidate through the repository's bounded no-follow API.
// Git's POSIX character classes do not cover every Unicode whitespace code
// point consumed by JavaScript's `\s`. Discover a literal superset anywhere in
// each tracked text blob, then let checkBacklogReceipts apply the exact anchored
// parser grammar. False-positive candidate files are harmless; false negatives
// would let a checked item evade the gate.
const discovery = spawnSync("git", [
  "grep", "--cached", "-z", "-l", "-I", "-F",
  "-e", "- [x] ", "-e", "- [X] ", "--",
], {
  cwd: process.cwd(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"],
});
if (discovery.error) throw discovery.error;
if (discovery.status !== 0 && discovery.status !== 1) {
  throw new Error(`git backlog discovery failed with exit ${discovery.status ?? "unknown"}`);
}
const tracked = discovery.status === 1 ? [] : discovery.stdout.split("\0").filter(Boolean).sort();
const isReachable = makeGitReachabilityVerifier({ cwd: process.cwd(), releaseCommit });
const results = [];
for (const path of tracked) {
  const lexical = resolve(process.cwd(), path);
  const canonical = await resolveContainedRealpath(process.cwd(), lexical);
  if (canonical === null) throw new Error(`tracked checklist is not contained under the repository root: ${path}`);
  if (canonical !== lexical) throw new Error(`tracked checklist path must not contain a symlink: ${path}`);
  const { bytes } = await readNoFollowRegular(canonical, { maxBytes: BACKLOG_RECEIPT_MAX_BYTES, label: path });
  results.push({ path, ...checkBacklogReceipts(bytes.toString("utf8"), { releaseRef, isReachable }) });
}
const rejected = results.reduce((sum, result) => sum + result.summary.rejected, 0);
const report = { ok: rejected === 0, releaseRef, files: results.length, rejected, results };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 2;
