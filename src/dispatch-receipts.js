import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  stat,
  unlink,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { atomicWrite, readNoFollowRegular } from "./fs-safe.js";
import { kimiProcessDispatch } from "./kimi-dispatch.js";

export const DISPATCH_RECEIPT_FORMAT = "muster.dispatch-process";
export const DISPATCH_RECEIPT_SCHEMA = 1;
export const MAX_DISPATCH_RECEIPTS = 256;
export const MAX_DISPATCH_RECEIPT_BYTES = 4096;
const RECEIPT_NAME = /^receipt-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const RECEIPT_KEYS = ["createdAt", "format", "pid", "provider", "schemaVersion", "startIdentity", "token"];
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];

export function dispatchReceiptDirectory() {
  return join(homedir(), ".muster", "dispatch-receipts");
}

export function readKernelStartIdentity(pid) {
  if (process.platform !== "linux") return null;
  try {
    const raw = readFileSyncBounded(`/proc/${Number(pid)}/stat`);
    const close = raw.lastIndexOf(")");
    if (close < 0) return null;
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return /^\d+$/.test(fields[19] || "") ? `linux-proc-stat:${fields[19]}` : null;
  } catch {
    return null;
  }
}

// Kept synchronous because child.pid must be identity-bound immediately after
// spawn, before the supervisor yields control or exposes a durable receipt.
function readFileSyncBounded(path) {
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.size > MAX_DISPATCH_RECEIPT_BYTES) return "";
    return readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
}

function isOwnedPrivate(info, mode) {
  const owned = typeof process.getuid !== "function" || info.uid === process.getuid();
  return owned && (info.mode & 0o777) === mode;
}

async function validatePrivateStore(root) {
  const parent = await lstat(dirname(root));
  const parentOwned = typeof process.getuid !== "function" || parent.uid === process.getuid();
  if (parent.isSymbolicLink() || !parent.isDirectory() || !parentOwned) {
    throw new Error(`unsafe dispatch receipt parent: ${dirname(root)} must be a current-user-owned directory, not a symlink`);
  }
  const info = await lstat(root);
  if (info.isSymbolicLink() || !info.isDirectory() || !isOwnedPrivate(info, 0o700)) {
    throw new Error(`unsafe dispatch receipt directory: ${root} must be a current-user-owned 0700 directory, not a symlink`);
  }
}

async function ensurePrivateStore(root) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await validatePrivateStore(root);
}

function validReceipt(value, token) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (Object.keys(value).sort().join(",") !== RECEIPT_KEYS.slice().sort().join(",")) return false;
  return value.format === DISPATCH_RECEIPT_FORMAT &&
    value.schemaVersion === DISPATCH_RECEIPT_SCHEMA &&
    value.provider === "kimi" &&
    value.token === token &&
    Number.isSafeInteger(value.pid) && value.pid > 0 &&
    typeof value.startIdentity === "string" && /^linux-proc-stat:\d+$/.test(value.startIdentity) &&
    typeof value.createdAt === "string" && Number.isFinite(Date.parse(value.createdAt));
}

async function readReceiptFile(path, token) {
  if (!fsConstants.O_NOFOLLOW) throw new Error("dispatch receipt reads require O_NOFOLLOW");
  const { bytes, info } = await readNoFollowRegular(path, {
    maxBytes: MAX_DISPATCH_RECEIPT_BYTES,
    label: `dispatch receipt ${path}`,
    requireSingleLink: true,
  });
  if (!isOwnedPrivate(info, 0o600)) throw new Error(`unsafe dispatch receipt mode or ownership: ${path}`);
  const value = JSON.parse(bytes.toString("utf8"));
  if (!validReceipt(value, token)) throw new Error(`invalid dispatch receipt: ${path}`);
  return value;
}

async function writeDispatchReceipt(pid, startIdentity, { receiptRoot, now = () => new Date(), token = randomUUID() }) {
  await ensurePrivateStore(receiptRoot);
  if (!RECEIPT_NAME.test(`receipt-${token}.json`)) throw new Error("refusing an invalid dispatch receipt token");
  const path = join(receiptRoot, `receipt-${token}.json`);
  const receipt = {
    format: DISPATCH_RECEIPT_FORMAT,
    schemaVersion: DISPATCH_RECEIPT_SCHEMA,
    provider: "kimi",
    token,
    pid,
    startIdentity,
    createdAt: now().toISOString(),
  };
  if (!validReceipt(receipt, token)) throw new Error("refusing to persist an invalid dispatch receipt");
  await atomicWrite(path, Buffer.from(`${JSON.stringify(receipt)}\n`), {
    mode: 0o600,
    fsync: true,
    fsyncDir: true,
  });
  const persisted = await readReceiptFile(path, token);
  if (persisted.pid !== pid || persisted.startIdentity !== startIdentity) {
    throw new Error("dispatch receipt publication verification failed");
  }
  return { path, token, receipt };
}

async function removeExactReceipt(handle) {
  if (!handle) return false;
  try {
    const current = await readReceiptFile(handle.path, handle.token);
    if (current.pid !== handle.receipt.pid || current.startIdentity !== handle.receipt.startIdentity) return false;
    await unlink(handle.path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    return false; // unsafe replacements are retained for report-only inspection
  }
}

export async function readDispatchReceipts({
  receiptRoot = dispatchReceiptDirectory(),
  processes = [],
  reap = false,
} = {}) {
  try {
    await validatePrivateStore(receiptRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { receipts: [], rejected: [], cleaned: [], truncated: false };
    throw error;
  }
  const entries = (await readdir(receiptRoot)).sort().slice(0, MAX_DISPATCH_RECEIPTS);
  const processRows = Array.isArray(processes) ? processes : [];
  const byPid = new Map(processRows.map((row) => [Number(row?.pid), row]));
  const receipts = [];
  const rejected = [];
  const cleaned = [];
  for (const name of entries) {
    const match = RECEIPT_NAME.exec(name);
    if (!match) {
      rejected.push({ name, reason: "unexpected-name" });
      continue;
    }
    const path = join(receiptRoot, name);
    let receipt;
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error("not a regular no-follow receipt");
      receipt = await readReceiptFile(path, match[1]);
    } catch (error) {
      rejected.push({ name, reason: error.message });
      continue;
    }
    const observed = byPid.get(receipt.pid);
    // An empty snapshot can mean `ps` was unavailable, not that the host has
    // no processes. Absence proves death only in a non-empty snapshot.
    const staleReason = processRows.length > 0 && !observed
      ? "process-dead"
      : (typeof observed.startIdentity === "string" && observed.startIdentity &&
          observed.startIdentity !== receipt.startIdentity)
        ? "process-identity-mismatch"
        : null;
    if (staleReason) {
      if (reap && await removeExactReceipt({ path, token: receipt.token, receipt })) {
        cleaned.push({ pid: receipt.pid, reason: staleReason });
      }
      continue;
    }
    receipts.push({ pid: receipt.pid, startIdentity: receipt.startIdentity });
  }
  return {
    receipts,
    rejected,
    cleaned,
    truncated: (await readdir(receiptRoot)).length > MAX_DISPATCH_RECEIPTS,
  };
}

function terminalPromise(child) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      fn(value);
    };
    child.once("error", (error) => finish(reject, error));
    child.once("exit", (code, signal) => finish(resolve, { code, signal }));
  });
}

export async function runKimiProcess(request, {
  receiptRoot = dispatchReceiptDirectory(),
  spawnProcess = spawn,
  readIdentity = readKernelStartIdentity,
  signalSource = process,
  onReceiptEstablished = async () => {},
  now,
  token,
} = {}) {
  const descriptor = kimiProcessDispatch(request);
  let child;
  try {
    child = spawnProcess("kimi", descriptor.argv, {
      cwd: descriptor.cwd,
      env: { ...process.env, ...descriptor.env },
      stdio: "inherit",
    });
  } catch (error) {
    throw error;
  }
  const terminal = terminalPromise(child);
  // The child can fail while the durable receipt write is still in flight.
  // Mark the rejection observed immediately; awaiting `terminal` below still
  // propagates the same error after receipt establishment/cleanup finishes.
  terminal.catch(() => {});
  const forwarders = new Map(SIGNALS.map((signal) => [
    signal,
    () => {
      try { child.kill(signal); } catch { /* child already exited */ }
    },
  ]));
  for (const [signal, listener] of forwarders) signalSource.on(signal, listener);

  let handle = null;
  let terminatedForSetupFailure = false;
  let established = false;
  try {
    if (!Number.isSafeInteger(child?.pid) || child.pid < 1) {
      try { child?.kill("SIGTERM"); } catch { /* no usable child */ }
      terminatedForSetupFailure = true;
      throw new Error("kimi child did not expose a valid PID");
    }
    const startIdentity = readIdentity(child.pid);
    if (typeof startIdentity !== "string" || !startIdentity) {
      try { child.kill("SIGTERM"); } catch { /* child already exited */ }
      terminatedForSetupFailure = true;
      throw new Error("stable kernel process-start identity is unavailable; refusing an unreceipted kimi process");
    }
    // Node has no spawn-suspended primitive. Stop the freshly identified child
    // before yielding or publishing it as established, then release it only
    // after the receipt file and parent-directory rename are fsynced.
    if (child.kill("SIGSTOP") === false) {
      throw new Error("kimi child exited before its dispatch receipt could be established");
    }
    handle = await writeDispatchReceipt(child.pid, startIdentity, {
      receiptRoot,
      ...(now ? { now } : {}),
      ...(token ? { token } : {}),
    });
    await onReceiptEstablished({ ...handle.receipt });
    if (child.kill("SIGCONT") === false) {
      throw new Error("kimi child could not be released after dispatch receipt establishment");
    }
    established = true;
    return await terminal;
  } catch (error) {
    if (handle) await removeExactReceipt(handle);
    if (!established && !terminatedForSetupFailure) {
      try { child.kill("SIGKILL"); } catch { /* child already exited */ }
    }
    throw error;
  } finally {
    for (const [signal, listener] of forwarders) signalSource.off(signal, listener);
    if (handle) await removeExactReceipt(handle);
  }
}
