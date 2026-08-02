#!/usr/bin/env node
import { constants } from "node:fs";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname } from "node:path";
import { startSprintEvidenceBroker } from "../mcp/evidence-broker.mjs";

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
const [receiptPrivateKey, approvalPrivateKey, approvalPublicKey] = await Promise.all([
  readProtectedFile(config.receiptPrivateKeyPath, "receipt private key"),
  readProtectedFile(config.approvalPrivateKeyPath, "approval private key"),
  readProtectedFile(config.approvalPublicKeyPath, "approval public key"),
]);
let acceptedVersion = 0;
let acceptedHash = null;
let acceptedRunId = null;
async function loadState() {
  const text = await readProtectedFile(config.statePath, "trusted assignment state");
  const next = JSON.parse(text);
  if (!Number.isSafeInteger(next.version) || next.version < 1 || typeof next.runId !== "string" || !next.runId
    || !next.items || typeof next.items !== "object" || Array.isArray(next.items)
    || !next.callbackPrincipals || typeof next.callbackPrincipals !== "object" || Array.isArray(next.callbackPrincipals)) {
    throw new Error("trusted assignment state must carry version, runId, items, and callbackPrincipals");
  }
  const allowedPurposes = new Set(["implementation", "review", "integration", "approval"]);
  for (const [digest, principal] of Object.entries(next.callbackPrincipals)) {
    if (!/^[0-9a-f]{64}$/.test(digest) || !principal || typeof principal.actorId !== "string" || !principal.actorId
      || !Array.isArray(principal.purposes) || principal.purposes.length < 1
      || new Set(principal.purposes).size !== principal.purposes.length
      || principal.purposes.some((purpose) => !allowedPurposes.has(purpose))) {
      throw new Error("trusted assignment callback principals are invalid");
    }
  }
  const hash = createHash("sha256").update(text).digest("hex");
  if (acceptedRunId !== null && next.runId !== acceptedRunId) throw new Error("trusted assignment runId cannot change in place");
  if (next.version < acceptedVersion || (next.version === acceptedVersion && hash !== acceptedHash)) {
    throw new Error("trusted assignment state rollback or same-version mutation rejected");
  }
  acceptedVersion = next.version;
  acceptedHash = hash;
  acceptedRunId = next.runId;
  return next;
}
await loadState();
let consumeChain = Promise.resolve();
function consumeApprovalCapability(tokenDigest, expectedVersion) {
  const run = consumeChain.then(async () => {
    const current = await loadState();
    if (current.version !== expectedVersion || !current.callbackPrincipals[tokenDigest]?.oneTimeApproval) {
      throw new Error("approval capability already consumed or state changed");
    }
    const next = structuredClone(current);
    delete next.callbackPrincipals[tokenDigest];
    next.version += 1;
    const tempPath = `${config.statePath}.next-${process.pid}`;
    const handle = await open(tempPath, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(next)}\n`);
      await handle.sync();
    } finally { await handle.close(); }
    try {
      await rename(tempPath, config.statePath);
      const directory = await open(dirname(config.statePath), constants.O_RDONLY);
      try { await directory.sync(); } finally { await directory.close(); }
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      throw error;
    }
  });
  consumeChain = run.catch(() => {});
  return run;
}
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
