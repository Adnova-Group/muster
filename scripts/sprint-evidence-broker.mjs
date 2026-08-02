#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname } from "node:path";
import { startSprintEvidenceBroker } from "../mcp/evidence-broker.mjs";
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
    if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino || (opened.mode & 0o077) !== 0) {
      throw new Error(`${label} changed during protected open`);
    }
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

const configPath = process.argv[2];
if (!configPath) {
  process.stderr.write("usage: sprint-evidence-broker.mjs <protected-config.json>\n");
  process.exit(2);
}
const config = JSON.parse(await readProtectedFile(configPath, "broker config"));
for (const [path, label] of [
  [config.socketPath, "broker socket"],
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
try {
  await lstat(config.socketPath);
  throw new Error("broker socket path already exists; refusing to replace it");
} catch (error) {
  if (error.code !== "ENOENT") throw error;
}
const [receiptPrivateKey, approvalPrivateKey, approvalPublicKey] = await Promise.all([
  readProtectedFile(config.receiptPrivateKeyPath, "receipt private key"),
  readProtectedFile(config.approvalPrivateKeyPath, "approval private key"),
  readProtectedFile(config.approvalPublicKeyPath, "approval public key"),
]);
const store = createSprintBrokerStateStore({
  statePath: config.statePath,
  checkpointPath: config.checkpointPath,
  lockPath: config.lockPath,
});
const loadState = () => store.read();
await loadState();
const consumeApprovalCapability = (tokenDigest, expected) => store.mutate(expected, (next) => {
  if (!next.callbackPrincipals[tokenDigest]?.oneTimeApproval) {
    throw new Error("approval capability already consumed or state changed");
  }
  delete next.callbackPrincipals[tokenDigest];
  return next;
});
if (process.platform === "win32") throw new Error("privileged evidence broker currently requires POSIX owner/mode enforcement");
const server = startSprintEvidenceBroker({
  socketPath: config.socketPath,
  loadState,
  consumeApprovalCapability,
  receiptPrivateKey,
  approvalPrivateKey,
  approvalPublicKey,
});
server.on("listening", () => process.stdout.write(`${JSON.stringify({ ok: true, socketPath: config.socketPath })}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
