#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { createSprintBrokerStateStore } from "../src/sprint-broker-state.js";

async function readProtectedFile(path, label) {
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && parent.uid !== process.getuid())) {
    throw new Error(`${label} parent must be an owner-only service directory`);
  }
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`${label} must be a regular owner-only file`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) {
      throw new Error(`${label} changed during protected open`);
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

const [command, configPath, nextPath, expectedVersionText, expectedHash] = process.argv.slice(2);
if (!configPath || !["read", "publish"].includes(command)
  || (command === "publish" && (!nextPath || !expectedVersionText || !expectedHash))) {
  process.stderr.write("usage: sprint-evidence-state.mjs read <protected-config.json>\n");
  process.stderr.write("   or: sprint-evidence-state.mjs publish <protected-config.json> <protected-next-state.json> <expected-version> <expected-content-hash>\n");
  process.exit(2);
}
if (process.platform === "win32") throw new Error("protected sprint state publication currently requires POSIX owner/mode enforcement");

const config = JSON.parse(await readProtectedFile(configPath, "broker config"));
for (const [path, label] of [
  [config.statePath, "trusted assignment state"],
  [config.checkpointPath, "broker monotonic checkpoint"],
  [config.lockPath ?? `${config.statePath}.lock`, "broker state lock"],
]) {
  if (typeof path !== "string" || !path) throw new Error(`${label} path is required`);
  const parent = await lstat(dirname(path));
  if (!parent.isDirectory() || (parent.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && parent.uid !== process.getuid())) {
    throw new Error(`${label} parent must be an owner-only service directory`);
  }
}
const store = createSprintBrokerStateStore({
  statePath: config.statePath,
  checkpointPath: config.checkpointPath,
  lockPath: config.lockPath,
});

if (command === "read") {
  process.stdout.write(`${JSON.stringify(await store.read())}\n`);
} else {
  const expectedVersion = Number(expectedVersionText);
  if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1 || !/^[0-9a-f]{64}$/.test(expectedHash)) {
    throw new Error("expected version and content hash are invalid");
  }
  const desired = JSON.parse(await readProtectedFile(nextPath, "next assignment state"));
  try {
    const published = await store.mutate({ version: expectedVersion, contentHash: expectedHash }, () => desired);
    process.stdout.write(`${JSON.stringify(published)}\n`);
  } catch (error) {
    if (error.code === "STATE_CONFLICT") {
      process.stderr.write(`${error.message}; run read, reapply the change, and retry\n`);
      process.exit(3);
    }
    throw error;
  }
}
