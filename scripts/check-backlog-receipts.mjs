#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { checkBacklogReceipts, makeGitReachabilityVerifier } from "../src/backlog-receipts.js";

const flagIndex = process.argv.indexOf("--release-ref");
const releaseRef = flagIndex >= 0 ? process.argv[flagIndex + 1] : "origin/main";
if (!releaseRef || releaseRef.startsWith("-") || /[\0-\x20\x7f]/.test(releaseRef)) {
  throw new Error("--release-ref must be a non-option Git ref without control characters or whitespace");
}
const releaseCommit = execFileSync("git", ["rev-parse", "--verify", `${releaseRef}^{commit}`], { encoding: "utf8" }).trim().toLowerCase();
const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" })
  .split("\0")
  .filter((path) => /(^|\/)backlog\.md$/i.test(path))
  .sort();
const isReachable = makeGitReachabilityVerifier({ cwd: process.cwd(), releaseCommit });
const results = [];
for (const path of tracked) {
  results.push({ path, ...checkBacklogReceipts(await readFile(path, "utf8"), { releaseRef, isReachable }) });
}
const rejected = results.reduce((sum, result) => sum + result.summary.rejected, 0);
const report = { ok: rejected === 0, releaseRef, files: results.length, rejected, results };
process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
if (!report.ok) process.exitCode = 2;
