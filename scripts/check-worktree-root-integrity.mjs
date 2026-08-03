#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { lstat, readFile, realpath, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

const SNAPSHOT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_GIT_OUTPUT_BYTES = 64 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;

function cleanGitEnvironment() {
  const env = { ...process.env, GIT_NO_REPLACE_OBJECTS: "1" };
  for (const key of Object.keys(env)) {
    if (["GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"].includes(key)
      || /^GIT_CONFIG_(?:COUNT|KEY_|VALUE_)/.test(key)) delete env[key];
  }
  return env;
}

function git(cwd, args, { allowStatusOne = false } = {}) {
  const result = spawnSync("git", args, {
    cwd,
    env: cleanGitEnvironment(),
    encoding: null,
    timeout: GIT_TIMEOUT_MS,
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) throw result.error;
  if (result.stderr?.length) throw new Error(`git ${args[0]} wrote unexpected stderr`);
  if (result.status !== 0 && !(allowStatusOne && result.status === 1)) {
    throw new Error(`git ${args[0]} failed with exit ${result.status ?? "unknown"}`);
  }
  return result.stdout ?? Buffer.alloc(0);
}

function nulPaths(bytes) {
  if (bytes.length === 0) return [];
  if (bytes[bytes.length - 1] !== 0) throw new Error("Git returned unterminated NUL-delimited paths");
  return bytes.subarray(0, -1).toString("utf8").split("\0");
}

async function inspectRepository(invocationCwd) {
  const cwd = await realpath(invocationCwd);
  const redirected = git(cwd, ["config", "--local", "--get-all", "core.worktree"], { allowStatusOne: true });
  if (redirected.length !== 0) throw new Error("repository-local core.worktree redirection is forbidden");

  const topLevel = await realpath(git(cwd, ["rev-parse", "--path-format=absolute", "--show-toplevel"]).toString("utf8").trim());
  if (topLevel !== cwd) {
    throw new Error(`integrity check must run from the exact repository root (got ${cwd}, root ${topLevel})`);
  }

  const deleted = nulPaths(git(cwd, ["ls-files", "--deleted", "-z"]));
  if (deleted.length) throw new Error(`tracked files are missing from the worktree: ${deleted.join(", ")}`);

  const configPath = git(cwd, ["rev-parse", "--path-format=absolute", "--git-path", "config"]).toString("utf8").trim();
  const configBytes = await readFile(configPath);
  const trackedBytes = git(cwd, ["ls-files", "-z"]);
  const worktreeBytes = git(cwd, ["worktree", "list", "--porcelain", "-z"]);
  return {
    schemaVersion: SNAPSHOT_VERSION,
    topLevel,
    configBytes: configBytes.toString("base64"),
    trackedSet: trackedBytes.toString("base64"),
    trackedFiles: nulPaths(trackedBytes),
    linkedWorktreeInventory: worktreeBytes.toString("base64"),
  };
}

async function readSnapshot(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("integrity snapshot must be a regular file");
  if (stat.size > MAX_SNAPSHOT_BYTES) throw new Error(`integrity snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes`);
  const snapshot = JSON.parse(await readFile(path, "utf8"));
  const keys = Object.keys(snapshot).sort();
  const expected = ["configBytes", "linkedWorktreeInventory", "schemaVersion", "topLevel", "trackedFiles", "trackedSet"];
  if (JSON.stringify(keys) !== JSON.stringify(expected) || snapshot.schemaVersion !== SNAPSHOT_VERSION
    || typeof snapshot.topLevel !== "string" || typeof snapshot.configBytes !== "string"
    || typeof snapshot.trackedSet !== "string" || !Array.isArray(snapshot.trackedFiles)
    || typeof snapshot.linkedWorktreeInventory !== "string") {
    throw new Error("integrity snapshot has an invalid schema");
  }
  return snapshot;
}

async function main() {
  const [mode, rawSnapshotPath] = process.argv.slice(2);
  if (!rawSnapshotPath || !["capture", "verify"].includes(mode)) {
    throw new Error("usage: check-worktree-root-integrity.mjs <capture|verify> <snapshot.json>");
  }
  const snapshotPath = resolve(rawSnapshotPath);
  const current = await inspectRepository(process.cwd());
  if (mode === "capture") {
    await writeFile(snapshotPath, `${JSON.stringify(current, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
    process.stdout.write(`${JSON.stringify({ ok: true, mode, topLevel: current.topLevel })}\n`);
    return;
  }

  const expected = await readSnapshot(snapshotPath);
  if (current.topLevel !== expected.topLevel) throw new Error("top-level path changed after the full gate");
  if (current.configBytes !== expected.configBytes) throw new Error("Git config bytes changed after the full gate");
  if (current.trackedSet !== expected.trackedSet) throw new Error("tracked-file set changed after the full gate");
  if (current.linkedWorktreeInventory !== expected.linkedWorktreeInventory) {
    throw new Error("linked-worktree inventory changed after the full gate");
  }
  process.stdout.write(`${JSON.stringify({ ok: true, mode, topLevel: current.topLevel })}\n`);
}

main().catch((error) => {
  process.stderr.write(`worktree root integrity check failed: ${error.message}\n`);
  process.exitCode = 1;
});
