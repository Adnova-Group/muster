import { constants } from "node:fs";
import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rename, rmdir, unlink } from "node:fs/promises";
import { dirname } from "node:path";
import { sha256, SHA256_HEX_RE } from "./fs-safe.js";

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
export const sprintStateHash = sha256;

async function protectedRead(path, label, { optional = false } = {}) {
  let stat;
  try { stat = await lstat(path); } catch (error) {
    if (optional && error.code === "ENOENT") return null;
    throw error;
  }
  if (!stat.isFile() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === "function" && stat.uid !== process.getuid())) {
    throw new Error(`${label} must be an owner-only file owned by the broker uid`);
  }
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || !opened.isFile()) throw new Error(`${label} changed during open`);
    return await handle.readFile("utf8");
  } finally { await handle.close(); }
}

async function atomicWrite(path, text) {
  const temp = `${path}.next-${process.pid}-${randomUUID()}`;
  const handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await handle.writeFile(text); await handle.sync(); } finally { await handle.close(); }
  try {
    await rename(temp, path);
    const directory = await open(dirname(path), constants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
  } catch (error) { await unlink(temp).catch(() => {}); throw error; }
}

function validateState(state) {
  if (!Number.isSafeInteger(state?.version) || state.version < 1 || typeof state.runId !== "string" || !state.runId
    || !state.items || typeof state.items !== "object" || Array.isArray(state.items)
    || !state.callbackPrincipals || typeof state.callbackPrincipals !== "object" || Array.isArray(state.callbackPrincipals)) {
    throw new Error("trusted assignment state must carry version, runId, items, and callbackPrincipals");
  }
  const allowed = new Set(["implementation", "review", "integration", "approval"]);
  for (const [digest, principal] of Object.entries(state.callbackPrincipals)) {
    if (!SHA256_HEX_RE.test(digest) || typeof principal?.actorId !== "string" || !principal.actorId
      || !Array.isArray(principal.purposes) || principal.purposes.length < 1
      || new Set(principal.purposes).size !== principal.purposes.length
      || principal.purposes.some((purpose) => !allowed.has(purpose))) throw new Error("trusted assignment callback principals are invalid");
  }
}

export function createSprintBrokerStateStore({ statePath, checkpointPath, lockPath = `${statePath}.lock` }) {
  async function withLock(fn) {
    const deadline = Date.now() + 5_000;
    while (true) {
      try { await mkdir(lockPath, { mode: 0o700 }); break; }
      catch (error) { if (error.code !== "EEXIST" || Date.now() >= deadline) throw new Error("broker state lock unavailable"); await delay(10); }
    }
    try { return await fn(); } finally { await rmdir(lockPath); }
  }
  async function readLocked() {
    const text = await protectedRead(statePath, "trusted assignment state");
    const state = JSON.parse(text); validateState(state);
    const contentHash = sprintStateHash(text);
    const checkpointText = await protectedRead(checkpointPath, "broker monotonic checkpoint", { optional: true });
    if (checkpointText === null) {
      await atomicWrite(checkpointPath, `${JSON.stringify({ runId: state.runId, version: state.version, contentHash })}\n`);
    } else {
      const checkpoint = JSON.parse(checkpointText);
      if (typeof checkpoint.runId !== "string" || !checkpoint.runId
        || !Number.isSafeInteger(checkpoint.version) || checkpoint.version < 1
        || !SHA256_HEX_RE.test(checkpoint.contentHash)) {
        throw new Error("broker monotonic checkpoint is invalid");
      }
      if (checkpoint.runId !== state.runId || state.version < checkpoint.version
        || (state.version === checkpoint.version && contentHash !== checkpoint.contentHash)) {
        throw new Error("broker state violates durable monotonic checkpoint");
      }
      if (state.version > checkpoint.version) {
        await atomicWrite(checkpointPath, `${JSON.stringify({ runId: state.runId, version: state.version, contentHash })}\n`);
      }
    }
    return { state, version: state.version, contentHash };
  }
  return {
    read: () => withLock(readLocked),
    mutate: (expected, transform) => withLock(async () => {
      const current = await readLocked();
      if (current.version !== expected.version || current.contentHash !== expected.contentHash) {
        const error = new Error("broker state conflict; reread and retry"); error.code = "STATE_CONFLICT"; throw error;
      }
      const next = await transform(structuredClone(current.state));
      next.version = current.version + 1; validateState(next);
      if (next.runId !== current.state.runId) throw new Error("broker state runId cannot change in place");
      const text = `${JSON.stringify(next)}\n`;
      const contentHash = sprintStateHash(text);
      await atomicWrite(checkpointPath, `${JSON.stringify({ runId: next.runId, version: next.version, contentHash })}\n`);
      await atomicWrite(statePath, text);
      return { state: next, version: next.version, contentHash };
    }),
  };
}
