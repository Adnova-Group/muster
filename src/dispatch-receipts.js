import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fchmodSync,
  mkdtempSync,
  openSync,
  realpathSync,
  readFileSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import {
  lstat,
  mkdir,
  opendir,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { atomicWrite, readNoFollowRegular } from "./fs-safe.js";
import { kimiProcessDispatch } from "./kimi-dispatch.js";

export const DISPATCH_RECEIPT_FORMAT = "muster.dispatch-process";
export const DISPATCH_RECEIPT_SCHEMA = 1;
export const MAX_DISPATCH_RECEIPTS = 256;
export const MAX_DISPATCH_RECEIPT_BYTES = 4096;
const MAX_BOUND_AGENT_BYTES = 1024 * 1024;
const RECEIPT_NAME = /^receipt-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const RECEIPT_KEYS = ["createdAt", "format", "pid", "provider", "schemaVersion", "startIdentity", "token"];
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const BINDING_FDS = Object.freeze({ executable: 3, cwd: 4, agentFile: 5 });

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
  // Node does not expose unlinkat(2) against an already-open O_NOFOLLOW file
  // descriptor. A pathname revalidation followed by unlink would retain a
  // same-UID swap window, so diagnostic receipts are deliberately retained
  // for bounded enumeration instead of risking deletion of a replacement.
  void handle;
  return false;
}

export async function readDispatchReceipts({
  receiptRoot = dispatchReceiptDirectory(),
  processes = [],
  processSnapshotComplete = false,
  reap = false,
} = {}) {
  try {
    await validatePrivateStore(receiptRoot);
  } catch (error) {
    if (error?.code === "ENOENT") return { receipts: [], rejected: [], cleaned: [], truncated: false };
    throw error;
  }
  const allEntries = [];
  let directoryTruncated = false;
  const directory = await opendir(receiptRoot);
  for await (const entry of directory) {
    if (allEntries.length === MAX_DISPATCH_RECEIPTS) {
      directoryTruncated = true;
      break;
    }
    allEntries.push(entry.name);
  }
  allEntries.sort();
  const invalidNames = allEntries.filter((name) => !RECEIPT_NAME.test(name));
  const validNames = allEntries.filter((name) => RECEIPT_NAME.test(name));
  const entries = validNames;
  const processRows = Array.isArray(processes) ? processes : [];
  const byPid = new Map(processRows.map((row) => [Number(row?.pid), row]));
  const receipts = [];
  const rejected = invalidNames.map((name) => ({ name, reason: "unexpected-name" }));
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
    // Absence proves death only when the provider explicitly declares a
    // complete snapshot. A non-empty partial snapshot is still partial.
    const staleReason = processSnapshotComplete === true && !observed
      ? "process-dead"
      : (observed && typeof observed.startIdentity === "string" && observed.startIdentity &&
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
    truncated: directoryTruncated,
    incompleteProvenance: processSnapshotComplete !== true ||
      directoryTruncated ||
      rejected.length > 0,
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

export function resolveKimiExecutable({
  env = process.env,
  executable = "kimi",
} = {}) {
  if (isAbsolute(executable)) {
    const canonical = realpathSync(executable);
    const info = statSync(canonical);
    if (!info.isFile() || (info.mode & 0o111) === 0) throw new Error(`Kimi executable is not executable: ${canonical}`);
    return { path: canonical, dev: info.dev, ino: info.ino };
  }
  for (const directory of String(env.PATH || "").split(delimiter)) {
    if (!directory) continue;
    const candidate = resolve(directory, executable);
    if (!existsSync(candidate)) continue;
    try {
      const canonical = realpathSync(candidate);
      const info = statSync(canonical);
      if (info.isFile() && (info.mode & 0o111) !== 0) {
        return { path: canonical, dev: info.dev, ino: info.ino };
      }
    } catch {
      // Continue to the next PATH entry; final spawn never uses the basename.
    }
  }
  throw new Error("unable to resolve an executable Kimi binary from PATH");
}

function openBoundPath(path, expected, flags, predicate, label) {
  if (!fsConstants.O_NOFOLLOW) throw new Error(`${label} descriptor binding requires O_NOFOLLOW`);
  let fd;
  try {
    fd = openSync(path, flags | fsConstants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!predicate(info) || info.dev !== expected.dev || info.ino !== expected.ino) {
      throw new Error(`${label} identity changed before descriptor binding: ${path}`);
    }
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    if (/descriptor binding/.test(error.message)) throw error;
    throw new Error(`${label} identity changed before descriptor binding: ${path}`);
  }
}

function openLaunchBindings(descriptor, executableBinding) {
  const opened = [];
  try {
    const executableFd = openBoundPath(
      executableBinding.path,
      executableBinding,
      fsConstants.O_RDONLY,
      (info) => info.isFile() && (info.mode & 0o111) !== 0,
      "Kimi executable",
    );
    opened.push(executableFd);
    const cwdFd = openBoundPath(
      descriptor.cwd,
      descriptor.pathBindings.cwd,
      fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0),
      (info) => info.isDirectory(),
      "cwd",
    );
    opened.push(cwdFd);
    const sourceAgentFileFd = openBoundPath(
      descriptor.pathBindings.agentFile.path,
      descriptor.pathBindings.agentFile,
      fsConstants.O_RDONLY,
      (info) => info.isFile(),
      "agent file",
    );
    opened.push(sourceAgentFileFd);
    const sourceInfo = fstatSync(sourceAgentFileFd);
    if (sourceInfo.size > MAX_BOUND_AGENT_BYTES) {
      throw new Error(`agent file exceeds descriptor snapshot cap of ${MAX_BOUND_AGENT_BYTES} bytes`);
    }
    const agentBytes = readFileSync(sourceAgentFileFd);
    const snapshotRoot = mkdtempSync(join(tmpdir(), "muster-agent-binding-"));
    const snapshotPath = join(snapshotRoot, "agent");
    let snapshotWriteFd;
    let agentFileFd;
    try {
      snapshotWriteFd = openSync(
        snapshotPath,
        fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
        0o600,
      );
      writeFileSync(snapshotWriteFd, agentBytes);
      fchmodSync(snapshotWriteFd, 0o400);
      agentFileFd = openSync(snapshotPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
      closeSync(snapshotWriteFd);
      snapshotWriteFd = undefined;
      unlinkSync(snapshotPath);
      rmdirSync(snapshotRoot);
    } catch (error) {
      if (snapshotWriteFd !== undefined) closeSync(snapshotWriteFd);
      if (agentFileFd !== undefined) closeSync(agentFileFd);
      try { unlinkSync(snapshotPath); } catch {}
      try { rmdirSync(snapshotRoot); } catch {}
      throw error;
    }
    closeSync(sourceAgentFileFd);
    opened.pop();
    opened.push(agentFileFd);
    return { executableFd, cwdFd, agentFileFd };
  } catch (error) {
    for (const fd of opened) closeSync(fd);
    throw error;
  }
}

function closeLaunchBindings(bindings) {
  if (!bindings) return;
  for (const fd of [bindings.executableFd, bindings.cwdFd, bindings.agentFileFd]) {
    try { closeSync(fd); } catch {}
  }
}

function descriptorForInheritedBindings(descriptor) {
  const argv = [...descriptor.argv];
  const agentIndex = argv.indexOf("--agent-file");
  if (agentIndex < 0 || agentIndex + 1 >= argv.length) {
    throw new Error("validated Kimi argv has no agent-file slot");
  }
  argv[agentIndex + 1] = `/proc/self/fd/${BINDING_FDS.agentFile}`;
  return {
    argv,
    cwd: `/proc/self/fd/${BINDING_FDS.cwd}`,
    executable: `/proc/self/fd/${BINDING_FDS.executable}`,
    env: descriptor.env,
    lane: descriptor.lane,
  };
}

function createMessageQueue(child) {
  const queued = [];
  const waiters = [];
  let terminalError = null;
  child.on("message", (message) => {
    if (!message?.type) return;
    const index = waiters.findIndex((waiter) => waiter.accepted.includes(message.type));
    if (index >= 0) {
      const [waiter] = waiters.splice(index, 1);
      waiter.resolve(message);
    } else {
      queued.push(message);
    }
  });
  const fail = (error) => {
    terminalError = error;
    for (const waiter of waiters.splice(0)) waiter.reject(error);
  };
  child.once("error", fail);
  child.once("exit", (code, signal) =>
    fail(new Error(`dispatch process exited before its expected message (code=${code}, signal=${signal})`)));
  return {
    next(accepted) {
      const index = queued.findIndex((message) => accepted.includes(message.type));
      if (index >= 0) return Promise.resolve(queued.splice(index, 1)[0]);
      if (terminalError) return Promise.reject(terminalError);
      return new Promise((resolveMessage, reject) => {
        waiters.push({ accepted, resolve: resolveMessage, reject });
      });
    },
  };
}

const MODULE_PATH = fileURLToPath(import.meta.url);

function sendIpc(message) {
  return new Promise((resolveSend, reject) => {
    if (typeof process.send !== "function" || !process.connected) return resolveSend(false);
    process.send(message, (error) => error ? reject(error) : resolveSend(true));
  });
}

export async function runKimiProcess(request, {
  receiptRoot = dispatchReceiptDirectory(),
  spawnProcess = spawn,
  signalSource = process,
  onReceiptEstablished = async () => {},
  beforeFinalSpawn = async () => {},
  executable,
  env = process.env,
  killTimeoutMs = 1_000,
  now,
  token,
} = {}) {
  if (process.platform !== "linux") {
    throw new Error("safe Kimi process containment is unavailable on this platform; dispatch is report-only");
  }
  const descriptor = kimiProcessDispatch(request);
  const executableBinding = resolveKimiExecutable({ env, executable });
  const bindings = openLaunchBindings(descriptor, executableBinding);
  let child;
  try {
    await beforeFinalSpawn();
    child = spawnProcess(process.execPath, [MODULE_PATH, "--broker"], {
      stdio: [
        "ignore",
        "inherit",
        "inherit",
        bindings.executableFd,
        bindings.cwdFd,
        bindings.agentFileFd,
        "ipc",
      ],
      env,
    });
  } finally {
    closeLaunchBindings(bindings);
  }
  const brokerMessages = createMessageQueue(child);
  const terminal = terminalPromise(child);
  terminal.catch(() => {});
  const forwarders = new Map(SIGNALS.map((signal) => [
    signal,
    () => {
      try { child.send({ type: "SIGNAL", signal }); } catch { /* broker already exited */ }
    },
  ]));
  for (const [signal, listener] of forwarders) signalSource.on(signal, listener);

  let handle = null;
  try {
    child.send({
      type: "CONFIGURE",
      descriptor: descriptorForInheritedBindings(descriptor),
      env: { ...env, ...descriptor.env },
      killTimeoutMs,
    });
    const established = await brokerMessages.next(["ESTABLISHED", "FAILURE"]);
    if (established.type === "FAILURE") throw new Error(established.error);
    handle = await writeDispatchReceipt(established.pid, established.startIdentity, {
      receiptRoot,
      ...(now ? { now } : {}),
      ...(token ? { token } : {}),
    });
    await onReceiptEstablished({ ...handle.receipt });
    const outcome = await brokerMessages.next(["RESULT", "FAILURE"]);
    await terminal;
    if (outcome.type === "FAILURE") throw new Error(outcome.error);
    return { code: outcome.code, signal: outcome.signal };
  } catch (error) {
    if (child.connected) {
      try { child.send({ type: "SHUTDOWN", reason: error.message }); } catch { /* broker already exited */ }
    }
    try { await terminal; } catch { /* original setup/runtime error wins */ }
    throw error;
  } finally {
    for (const [signal, listener] of forwarders) signalSource.off(signal, listener);
    if (handle) await removeExactReceipt(handle);
  }
}

function readLinuxProcessGroup(pid) {
  try {
    const raw = readFileSyncBounded(`/proc/${Number(pid)}/stat`);
    const close = raw.lastIndexOf(")");
    const fields = raw.slice(close + 1).trim().split(/\s+/);
    return Number(fields[2]); // field 5 (pgrp), relative to field 3 (state)
  } catch {
    return null;
  }
}

export function signalContainedGroup({ pid, startIdentity, signal }, {
  readIdentity = readKernelStartIdentity,
  readGroup = readLinuxProcessGroup,
  kill = process.kill,
} = {}) {
  const current = readIdentity(pid);
  const group = readGroup(pid);
  if (current !== startIdentity || group !== pid) {
    throw new Error("contained process-group identity/state changed before signal; refusing PID-addressed signaling");
  }
  return kill(-pid, signal);
}

async function terminateContainedGroup(child, identity, timeoutMs, childTerminal = null) {
  if (!child || !identity) return;
  try {
    signalContainedGroup({ pid: child.pid, startIdentity: identity, signal: "SIGTERM" });
  } catch (error) {
    if (error?.code !== "ESRCH") throw error;
  }
  await new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs));
  try {
    signalContainedGroup({ pid: child.pid, startIdentity: identity, signal: "SIGKILL" });
  } catch (error) {
    if (error?.code !== "ESRCH" && !/identity\/state changed/.test(error.message)) throw error;
  }
  await (childTerminal || terminalPromise(child)).then(() => {}, () => {});
}

async function killTrustedDirectChild(child, terminal) {
  if (!child) return;
  try { child.kill("SIGKILL"); } catch {}
  await (terminal || terminalPromise(child)).then(() => {}, () => {});
}

async function brokerMain() {
  let launcher = null;
  let launcherTerminal = null;
  let launcherIdentity = null;
  let killTimeoutMs = 1_000;
  let shuttingDown = false;
  const shutdown = async (reason = "dispatch cancelled") => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (launcherIdentity) {
        await terminateContainedGroup(launcher, launcherIdentity, killTimeoutMs, launcherTerminal);
      } else {
        await killTrustedDirectChild(launcher, launcherTerminal);
      }
      await sendIpc({ type: "FAILURE", error: reason }).catch(() => {});
    } finally {
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  };
  process.on("disconnect", () => { void shutdown("supervisor disconnected"); });
  process.on("message", async (message) => {
    try {
      if (message?.type === "SHUTDOWN") return void shutdown(message.reason || "dispatch shutdown");
      if (message?.type === "SIGNAL") {
        return void shutdown(`dispatch cancelled by ${message.signal}`);
      }
      if (message?.type !== "CONFIGURE" || launcher) return;
      killTimeoutMs = message.killTimeoutMs;
      launcher = spawn(process.execPath, [MODULE_PATH, "--launcher"], {
        detached: true,
        stdio: [
          "ignore",
          "inherit",
          "inherit",
          BINDING_FDS.executable,
          BINDING_FDS.cwd,
          BINDING_FDS.agentFile,
          "ipc",
        ],
        env: process.env,
      });
      launcherTerminal = terminalPromise(launcher);
      launcherTerminal.catch(() => {});
      const launcherMessages = createMessageQueue(launcher);
      const ready = await launcherMessages.next(["READY", "FAILURE"]);
      if (ready.type === "FAILURE") throw new Error(ready.error);
      launcherIdentity = readKernelStartIdentity(launcher.pid);
      if (!launcherIdentity || readLinuxProcessGroup(launcher.pid) !== launcher.pid) {
        throw new Error("trusted launcher did not establish a stable process group");
      }
      launcher.send({ ...message, type: "START" });
      const established = await launcherMessages.next(["ESTABLISHED", "FAILURE"]);
      if (established.type === "FAILURE") throw new Error(established.error);
      await sendIpc(established);
      const result = await launcherMessages.next(["CHILD_RESULT", "FAILURE"]);
      if (result.type === "FAILURE") throw new Error(result.error);
      await terminateContainedGroup(launcher, launcherIdentity, killTimeoutMs, launcherTerminal);
      shuttingDown = true;
      await sendIpc({ type: "RESULT", code: result.code, signal: result.signal });
      if (process.connected) process.disconnect();
    } catch (error) {
      shuttingDown = true;
      try {
        if (launcherIdentity) {
          await terminateContainedGroup(launcher, launcherIdentity, killTimeoutMs, launcherTerminal);
        } else {
          await killTrustedDirectChild(launcher, launcherTerminal);
        }
      } catch { /* fail closed */ }
      await sendIpc({ type: "FAILURE", error: error.message }).catch(() => {});
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  });
}

async function launcherMain() {
  let child = null;
  let disconnecting = false;
  process.on("SIGTERM", () => {}); // broker owns the bounded TERM→KILL interval
  const disconnectCleanup = () => {
    if (disconnecting) return;
    disconnecting = true;
    try { process.kill(-process.pid, "SIGTERM"); } catch { /* group already gone */ }
    setTimeout(() => {
      try { process.kill(-process.pid, "SIGKILL"); } catch { /* group already gone */ }
    }, 1_000);
  };
  process.on("disconnect", disconnectCleanup);
  await sendIpc({ type: "READY" });
  process.on("message", async (message) => {
    if (message?.type !== "START" || child) return;
    try {
      child = spawn(message.descriptor.executable, message.descriptor.argv, {
        cwd: message.descriptor.cwd,
        env: message.env,
        stdio: [
          "inherit",
          "inherit",
          "inherit",
          BINDING_FDS.executable,
          BINDING_FDS.cwd,
          BINDING_FDS.agentFile,
        ],
      });
      const childTerminal = terminalPromise(child);
      childTerminal.catch(() => {});
      const identity = readKernelStartIdentity(child.pid);
      if (!identity) {
        try { process.kill(-process.pid, "SIGTERM"); } catch {}
        setTimeout(() => {
          try { process.kill(-process.pid, "SIGKILL"); } catch {}
        }, 1_000);
        throw new Error("stable Kimi process identity unavailable");
      }
      await sendIpc({ type: "ESTABLISHED", pid: child.pid, startIdentity: identity });
      const result = await childTerminal;
      await sendIpc({ type: "CHILD_RESULT", ...result });
    } catch (error) {
      await sendIpc({ type: "FAILURE", error: error.message }).catch(() => {});
      disconnectCleanup();
    }
  });
}

if (process.argv[1] === MODULE_PATH && process.argv[2] === "--broker") await brokerMain();
if (process.argv[1] === MODULE_PATH && process.argv[2] === "--launcher") await launcherMain();
