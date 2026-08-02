#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { startSprintEvidenceBroker } from "../mcp/evidence-broker.mjs";

async function readProtectedFile(path, label) {
  const stat = await lstat(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0) {
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
const [stateText, receiptPrivateKey, approvalPrivateKey, approvalPublicKey] = await Promise.all([
  readProtectedFile(config.statePath, "trusted assignment state"),
  readProtectedFile(config.receiptPrivateKeyPath, "receipt private key"),
  readProtectedFile(config.approvalPrivateKeyPath, "approval private key"),
  readProtectedFile(config.approvalPublicKeyPath, "approval public key"),
]);
const server = startSprintEvidenceBroker({
  socketPath: config.socketPath,
  state: JSON.parse(stateText),
  receiptPrivateKey,
  approvalPrivateKey,
  approvalPublicKey,
});
server.on("listening", () => process.stdout.write(`${JSON.stringify({ ok: true, socketPath: config.socketPath })}\n`));
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
