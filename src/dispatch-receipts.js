import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import {
  closeSync,
  constants as fsConstants,
  existsSync,
  fstatSync,
  fchmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readSync,
  realpathSync,
  readFileSync,
  rmdirSync,
  statfsSync,
  statSync,
  unlinkSync,
  writeFileSync,
  writeSync,
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
const MAX_BOUND_EXECUTABLE_BYTES = 512 * 1024 * 1024;
const MAX_RETAINED_DISPATCH_RECEIPTS = 128;
const RECEIPT_NAME = /^receipt-([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.json$/;
const RECEIPT_KEYS = ["createdAt", "format", "pid", "provider", "schemaVersion", "startIdentity", "token"];
const SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"];
const BINDING_FDS = Object.freeze({
  executable: 20,
  cwd: 21,
  agentFile: 22,
  interpreter: 23,
  ipc: 24,
  sandboxInfo: 25,
});
const CGROUP2_SUPER_MAGIC = 0x63677270;
const HELPER_ENV_KEYS = Object.freeze([
  "DBUS_SESSION_BUS_ADDRESS",
  "LANG",
  "LC_ALL",
  "XDG_RUNTIME_DIR",
]);

export function sanitizeDispatchHelperEnv(env = process.env) {
  const sanitized = {};
  for (const key of HELPER_ENV_KEYS) {
    if (typeof env?.[key] === "string" && env[key]) sanitized[key] = env[key];
  }
  return sanitized;
}

const UNSAFE_PROVIDER_ENV = /^(?:LD_|DYLD_|NODE_OPTIONS$|NODE_PATH$|BASH_ENV$|ENV$|PYTHONPATH$|RUBYOPT$|PERL5OPT$)/;

export function sanitizeContainedProviderEnv(env = process.env) {
  const sanitized = {};
  for (const [key, value] of Object.entries(env || {})) {
    if (UNSAFE_PROVIDER_ENV.test(key)) {
      throw new Error(`unsafe provider environment key ${key} could alter the pinned executable/dependency chain`);
    }
    if (typeof value === "string") sanitized[key] = value;
  }
  return sanitized;
}

export function validateTrustedExecutable(path, { requiredUid = 0 } = {}) {
  const canonical = realpathSync(path);
  const parts = canonical.split("/").filter(Boolean);
  let component = "/";
  for (const part of parts) {
    component = join(component, part);
    const info = lstatSync(component);
    const currentUserWritable = typeof process.getuid === "function" &&
      info.uid === process.getuid() && (info.mode & 0o200) !== 0;
    if (info.isSymbolicLink() || (info.mode & 0o022) !== 0 || currentUserWritable) {
      throw new Error(`writable trusted executable path component: ${component}`);
    }
  }
  const info = statSync(canonical);
  if (!info.isFile() || info.uid !== requiredUid || (info.mode & 0o111) === 0) {
    throw new Error(`trusted executable must be a uid-${requiredUid} executable regular file: ${canonical}`);
  }
  return canonical;
}

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

function removeDiagnosticEntry(rootFd, name) {
  if (typeof name !== "string" || !name || name === "." || name === ".." ||
      name.includes("/") || name.includes("\0")) return false;
  const path = `/proc/self/fd/${rootFd}/${name}`;
  try {
    const info = lstatSync(path, { throwIfNoEntry: false });
    if (!info) return false;
    if (info.isDirectory()) rmdirSync(path);
    else unlinkSync(path);
    return true;
  } catch {
    return false;
  }
}

export async function compactDispatchReceipts({
  receiptRoot = dispatchReceiptDirectory(),
  protectedName = null,
} = {}) {
  await validatePrivateStore(receiptRoot);
  const rootFd = openSync(
    receiptRoot,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | fsConstants.O_NOFOLLOW,
  );
  const scanned = [];
  let truncated = false;
  try {
    const directory = await opendir(`/proc/self/fd/${rootFd}`);
    for await (const entry of directory) {
      if (scanned.length === MAX_DISPATCH_RECEIPTS) {
        truncated = true;
        break;
      }
      const path = `/proc/self/fd/${rootFd}/${entry.name}`;
      let mtimeMs = 0;
      try { mtimeMs = lstatSync(path).mtimeMs; } catch {}
      scanned.push({ name: entry.name, mtimeMs });
    }
    const valid = scanned
      .filter(({ name }) => RECEIPT_NAME.test(name))
      .sort((a, b) => b.mtimeMs - a.mtimeMs || a.name.localeCompare(b.name));
    const keep = new Set(valid.slice(0, MAX_RETAINED_DISPATCH_RECEIPTS).map(({ name }) => name));
    if (protectedName) keep.add(protectedName);
    const removed = [];
    for (const { name } of scanned) {
      if (keep.has(name)) continue;
      if (removeDiagnosticEntry(rootFd, name)) removed.push(name);
    }
    return { removed, truncated, retained: keep.size };
  } finally {
    closeSync(rootFd);
  }
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
  await compactDispatchReceipts({ receiptRoot, protectedName: `receipt-${token}.json` });
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

function immutableSnapshot(sourceFd, { label, maxBytes, mode }) {
  const before = fstatSync(sourceFd);
  if (before.size > maxBytes) throw new Error(`${label} exceeds immutable snapshot cap of ${maxBytes} bytes`);
  const snapshotRoot = mkdtempSync(join(tmpdir(), "muster-binding-"));
  const snapshotPath = join(snapshotRoot, "object");
  let snapshotWriteFd;
  let snapshotReadFd;
  try {
    snapshotWriteFd = openSync(
      snapshotPath,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW,
      0o600,
    );
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < before.size) {
      const bytesRead = readSync(sourceFd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (bytesRead <= 0) throw new Error(`${label} changed while its immutable snapshot was created`);
      let written = 0;
      while (written < bytesRead) {
        written += writeSync(snapshotWriteFd, buffer, written, bytesRead - written);
      }
      offset += bytesRead;
    }
    const after = fstatSync(sourceFd);
    if (after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error(`${label} changed while its immutable snapshot was created`);
    }
    fchmodSync(snapshotWriteFd, mode);
    snapshotReadFd = openSync(snapshotPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    closeSync(snapshotWriteFd);
    snapshotWriteFd = undefined;
    unlinkSync(snapshotPath);
    rmdirSync(snapshotRoot);
    return snapshotReadFd;
  } catch (error) {
    if (snapshotWriteFd !== undefined) closeSync(snapshotWriteFd);
    if (snapshotReadFd !== undefined) closeSync(snapshotReadFd);
    try { unlinkSync(snapshotPath); } catch {}
    try { rmdirSync(snapshotRoot); } catch {}
    throw error;
  }
}

function executableFormat(fd) {
  const header = Buffer.alloc(512);
  const length = readSync(fd, header, 0, header.length, 0);
  if (length >= 4 && header[0] === 0x7f && header.subarray(1, 4).toString("ascii") === "ELF") {
    return { kind: "elf" };
  }
  if (length >= 3 && header.subarray(0, 2).toString("ascii") === "#!") {
    const line = header.subarray(2, length).toString("utf8").split(/\r?\n/, 1)[0].trim();
    if (!isAbsolute(line) || /\s/.test(line)) {
      throw new Error("Kimi script executable must use one absolute shebang interpreter with no arguments");
    }
    return { kind: "script", interpreterPath: realpathSync(line) };
  }
  throw new Error("Kimi executable must be a native ELF binary or use a pinned absolute native shebang interpreter");
}

function openLaunchBindings(descriptor, executableBinding) {
  const opened = [];
  try {
    const sourceExecutableFd = openBoundPath(
      executableBinding.path,
      executableBinding,
      fsConstants.O_RDONLY,
      (info) => info.isFile() && (info.mode & 0o111) !== 0,
      "Kimi executable",
    );
    opened.push(sourceExecutableFd);
    const executableFd = immutableSnapshot(sourceExecutableFd, {
      label: "Kimi executable",
      maxBytes: MAX_BOUND_EXECUTABLE_BYTES,
      mode: 0o500,
    });
    closeSync(sourceExecutableFd);
    opened.pop();
    opened.push(executableFd);
    const format = executableFormat(executableFd);
    let interpreterFd = null;
    if (format.kind === "script") {
      const interpreterInfo = statSync(format.interpreterPath);
      if (!interpreterInfo.isFile() || (interpreterInfo.mode & 0o111) === 0) {
        throw new Error(`Kimi shebang interpreter is not executable: ${format.interpreterPath}`);
      }
      const sourceInterpreterFd = openBoundPath(
        format.interpreterPath,
        { dev: interpreterInfo.dev, ino: interpreterInfo.ino },
        fsConstants.O_RDONLY,
        (info) => info.isFile() && (info.mode & 0o111) !== 0,
        "Kimi shebang interpreter",
      );
      opened.push(sourceInterpreterFd);
      interpreterFd = immutableSnapshot(sourceInterpreterFd, {
        label: "Kimi shebang interpreter",
        maxBytes: MAX_BOUND_EXECUTABLE_BYTES,
        mode: 0o500,
      });
      opened.push(interpreterFd);
      if (executableFormat(interpreterFd).kind !== "elf") {
        throw new Error("Kimi shebang interpreter must resolve directly to a native ELF binary");
      }
      closeSync(sourceInterpreterFd);
      opened.splice(opened.indexOf(sourceInterpreterFd), 1);
    }
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
    const agentFileFd = immutableSnapshot(sourceAgentFileFd, {
      label: "agent file",
      maxBytes: MAX_BOUND_AGENT_BYTES,
      mode: 0o400,
    });
    closeSync(sourceAgentFileFd);
    opened.pop();
    opened.push(agentFileFd);
    return { executableFd, cwdFd, agentFileFd, interpreterFd, executableKind: format.kind };
  } catch (error) {
    for (const fd of opened) closeSync(fd);
    throw error;
  }
}

function closeLaunchBindings(bindings) {
  if (!bindings) return;
  for (const fd of [bindings.executableFd, bindings.cwdFd, bindings.agentFileFd, bindings.interpreterFd]) {
    if (fd === null || fd === undefined) continue;
    try { closeSync(fd); } catch {}
  }
}

function descriptorForInheritedBindings(descriptor, bindings) {
  const argv = [...descriptor.argv];
  const agentIndex = argv.indexOf("--agent-file");
  if (agentIndex < 0 || agentIndex + 1 >= argv.length) {
    throw new Error("validated Kimi argv has no agent-file slot");
  }
  argv[agentIndex + 1] = "/muster-agent";
  if (bindings.executableKind === "script") argv.unshift("/muster-executable");
  return {
    argv,
    cwd: "/muster-cwd",
    executable: bindings.executableKind === "script" ? "/muster-interpreter" : "/muster-executable",
    env: descriptor.env,
    lane: descriptor.lane,
  };
}

function bindingStdio({ executable, cwd, agentFile, interpreter, ipc = false, sandboxInfo = false }) {
  const stdio = Array(BINDING_FDS.sandboxInfo + 1).fill("ignore");
  stdio[1] = "inherit";
  stdio[2] = "inherit";
  if (executable !== undefined) stdio[BINDING_FDS.executable] = executable;
  if (cwd !== undefined) stdio[BINDING_FDS.cwd] = cwd;
  if (agentFile !== undefined) stdio[BINDING_FDS.agentFile] = agentFile;
  stdio[BINDING_FDS.interpreter] = interpreter ?? "ignore";
  if (ipc) stdio[BINDING_FDS.ipc] = "ipc";
  if (sandboxInfo) stdio[BINDING_FDS.sandboxInfo] = "pipe";
  return stdio;
}

function bubblewrapChildPid(child) {
  const stream = child.stdio?.[BINDING_FDS.sandboxInfo];
  if (!stream) return Promise.reject(new Error("bubblewrap did not expose its descriptor-bound info pipe"));
  return new Promise((resolvePid, reject) => {
    let bytes = "";
    let settled = false;
    const parse = (terminal = false) => {
      if (settled) return;
      try {
        const value = JSON.parse(bytes);
        const pid = value?.["child-pid"];
        if (!Number.isSafeInteger(pid) || pid <= 0) {
          throw new Error("bubblewrap info did not identify the sandboxed child host PID");
        }
        settled = true;
        resolvePid(pid);
      } catch (error) {
        if (terminal) {
          settled = true;
          reject(error);
        }
      }
    };
    stream.setEncoding("utf8");
    stream.on("data", (chunk) => {
      bytes += chunk;
      if (bytes.length > MAX_DISPATCH_RECEIPT_BYTES) {
        settled = true;
        stream.destroy();
        reject(new Error("bubblewrap info exceeded its bounded size"));
        return;
      }
      parse(false);
    });
    stream.once("error", reject);
    stream.once("end", () => parse(true));
  });
}

function bindingSource(bindings) {
  const describe = (fd) => {
    if (fd === null || fd === undefined) return null;
    const info = fstatSync(fd);
    return { fd, dev: info.dev, ino: info.ino };
  };
  return {
    pid: process.pid,
    executable: describe(bindings.executableFd),
    cwd: describe(bindings.cwdFd),
    agentFile: describe(bindings.agentFileFd),
    interpreter: describe(bindings.interpreterFd),
  };
}

function adoptBindingSource(source) {
  const adopted = [];
  const openOne = (binding, label, directory = false) => {
    if (!binding) return null;
    const fd = openSync(
      `/proc/${source.pid}/fd/${binding.fd}`,
      fsConstants.O_RDONLY | (directory ? (fsConstants.O_DIRECTORY || 0) : 0),
    );
    const info = fstatSync(fd);
    if (info.dev !== binding.dev || info.ino !== binding.ino ||
        (directory ? !info.isDirectory() : !info.isFile())) {
      closeSync(fd);
      throw new Error(`${label} descriptor transfer identity mismatch`);
    }
    adopted.push(fd);
    return fd;
  };
  try {
    return {
      executableFd: openOne(source.executable, "executable"),
      cwdFd: openOne(source.cwd, "cwd", true),
      agentFileFd: openOne(source.agentFile, "agent file"),
      interpreterFd: openOne(source.interpreter, "interpreter"),
    };
  } catch (error) {
    for (const fd of adopted) closeSync(fd);
    throw error;
  }
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
  const providerEnv = sanitizeContainedProviderEnv({ ...env, ...descriptor.env });
  const executableBinding = resolveKimiExecutable({ env, executable });
  const bindings = openLaunchBindings(descriptor, executableBinding);
  const inheritedDescriptor = descriptorForInheritedBindings(descriptor, bindings);
  const sourceBindings = bindingSource(bindings);
  const brokerUnit = `muster-dispatch-broker-${randomUUID()}`;
  let bindingsOpen = true;
  const closeSourceBindings = () => {
    if (!bindingsOpen) return;
    bindingsOpen = false;
    closeLaunchBindings(bindings);
  };
  let child;
  try {
    await beforeFinalSpawn();
    child = spawnProcess(resolveSystemdRun(), [
      "--user",
      "--scope",
      "--quiet",
      `--unit=${brokerUnit}`,
      "--property=Delegate=yes",
      process.execPath,
      MODULE_PATH,
      "--broker",
    ], {
      stdio: bindingStdio({ ipc: true }),
      env: sanitizeDispatchHelperEnv(env),
    });
  } catch (error) {
    closeSourceBindings();
    throw error;
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
      descriptor: inheritedDescriptor,
      bindingSource: sourceBindings,
      env: providerEnv,
      killTimeoutMs,
    });
    const established = await brokerMessages.next(["ESTABLISHED", "FAILURE"]);
    if (established.type === "FAILURE") throw new Error(established.error);
    closeSourceBindings();
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
    closeSourceBindings();
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

function cgroupPathForPid(pid) {
  try {
    const line = readFileSyncBounded(`/proc/${Number(pid)}/cgroup`).trim();
    const match = /^0::(.+)$/.exec(line);
    return match?.[1] || null;
  } catch {
    return null;
  }
}

function resolveDelegatedCgroupRoot() {
  if (typeof process.getuid !== "function") throw new Error("cgroup containment requires a numeric uid");
  if (statfsSync("/sys/fs/cgroup").type !== CGROUP2_SUPER_MAGIC) {
    throw new Error("safe Kimi containment requires cgroup v2");
  }
  const uid = process.getuid();
  const relative = cgroupPathForPid(process.pid);
  if (!relative || !/\/muster-dispatch-broker-[0-9a-f-]+\.scope$/.test(relative)) {
    throw new Error("safe Kimi containment requires a dedicated delegated broker scope");
  }
  const path = `/sys/fs/cgroup${relative}`;
  const canonical = realpathSync(path);
  const info = statSync(canonical);
  if (canonical !== path || !info.isDirectory() || info.uid !== uid) {
    throw new Error("safe Kimi containment requires a current-user delegated cgroup-v2 subtree");
  }
  return path;
}

function resolveBubblewrap() {
  return validateTrustedExecutable("/usr/bin/bwrap");
}

function resolveSystemdRun() {
  return validateTrustedExecutable("/usr/bin/systemd-run");
}

function createDispatchCgroup(pid) {
  const parentPath = resolveDelegatedCgroupRoot();
  const parentFd = openSync(
    parentPath,
    fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | fsConstants.O_NOFOLLOW,
  );
  const name = `muster-dispatch-${pid}-${randomUUID()}`;
  const path = join(parentPath, name);
  let fd;
  try {
    mkdirSync(path, { mode: 0o700 });
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | fsConstants.O_NOFOLLOW);
    const info = fstatSync(fd);
    if (!info.isDirectory() || statfsSync(`/proc/self/fd/${fd}`).type !== CGROUP2_SUPER_MAGIC) {
      throw new Error("dispatch containment directory is not a descriptor-bound cgroup-v2 node");
    }
    writeFileSync(`/proc/self/fd/${fd}/cgroup.procs`, `${pid}\n`);
    const expected = cgroupPathForPid(pid);
    if (!expected || !expected.endsWith(`/${name}`)) {
      throw new Error("trusted launcher did not enter the delegated dispatch cgroup");
    }
    closeSync(openSync(`/proc/self/fd/${fd}/cgroup.kill`, fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW));
    return { fd, parentFd, name };
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    try { rmdirSync(`/proc/self/fd/${parentFd}/${name}`); } catch {}
    closeSync(parentFd);
    throw new Error(`safe Kimi cgroup containment unavailable: ${error.message}`);
  }
}

async function destroyDispatchCgroup(containment, timeoutMs = 1_000) {
  if (!containment) return;
  closeSync(containment.fd);
  const path = `/proc/self/fd/${containment.parentFd}/${containment.name}`;
  const deadline = Date.now() + Math.max(100, timeoutMs);
  let lastError;
  try {
    do {
      try {
        rmdirSync(path);
        if (lstatSync(path, { throwIfNoEntry: false })) {
          throw new Error("removed cgroup remained visible");
        }
        return;
      } catch (error) {
        if (error?.code === "ENOENT") return;
        lastError = error;
      }
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    } while (Date.now() < deadline);
    throw new Error(`dispatch cgroup removal failed: ${lastError?.message || "still present"}`);
  } finally {
    closeSync(containment.parentFd);
  }
}

async function killDispatchCgroup(containment, timeoutMs) {
  if (!containment) throw new Error("refusing cleanup without a descriptor-bound dispatch cgroup");
  writeFileSync(`/proc/self/fd/${containment.fd}/cgroup.kill`, "1\n");
  const deadline = Date.now() + Math.max(100, timeoutMs);
  while (Date.now() < deadline) {
    const members = readFileSync(`/proc/self/fd/${containment.fd}/cgroup.procs`, "utf8").trim();
    if (!members) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  throw new Error("dispatch cgroup remained populated after cgroup.kill");
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

async function terminateContainedGroup(
  child,
  identity,
  timeoutMs,
  childTerminal = null,
  containment = null,
  target = null,
) {
  if (!child || !identity || !containment) {
    throw new Error("refusing contained cleanup without launcher identity and delegated cgroup");
  }
  void target;
  let gracefulError = null;
  try {
    signalContainedGroup({ pid: child.pid, startIdentity: identity, signal: "SIGTERM" });
    await new Promise((resolveTimeout) => setTimeout(resolveTimeout, timeoutMs));
  } catch (error) {
    if (error?.code !== "ESRCH") gracefulError = error;
  } finally {
    await killDispatchCgroup(containment, timeoutMs);
  }
  await (childTerminal || terminalPromise(child)).then(() => {}, () => {});
  if (gracefulError) throw gracefulError;
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
  let containment = null;
  let containedTarget = null;
  let killTimeoutMs = 1_000;
  let shuttingDown = false;
  const shutdown = async (reason = "dispatch cancelled") => {
    if (shuttingDown) return;
    shuttingDown = true;
    try {
      if (launcherIdentity && containment) {
        await terminateContainedGroup(
          launcher, launcherIdentity, killTimeoutMs, launcherTerminal, containment, containedTarget,
        );
      } else {
        await killTrustedDirectChild(launcher, launcherTerminal);
      }
      await sendIpc({ type: "FAILURE", error: reason }).catch(() => {});
    } finally {
      await destroyDispatchCgroup(containment, killTimeoutMs);
      containment = null;
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
      const launchBindings = adoptBindingSource(message.bindingSource);
      try {
        launcher = spawn(process.execPath, [MODULE_PATH, "--launcher"], {
          detached: true,
          stdio: bindingStdio({
            executable: launchBindings.executableFd,
            cwd: launchBindings.cwdFd,
            agentFile: launchBindings.agentFileFd,
            interpreter: launchBindings.interpreterFd,
            ipc: true,
          }),
          env: sanitizeDispatchHelperEnv(process.env),
        });
      } finally {
        closeLaunchBindings(launchBindings);
      }
      launcherTerminal = terminalPromise(launcher);
      launcherTerminal.catch(() => {});
      const launcherMessages = createMessageQueue(launcher);
      const ready = await launcherMessages.next(["READY", "FAILURE"]);
      if (ready.type === "FAILURE") throw new Error(ready.error);
      launcherIdentity = readKernelStartIdentity(launcher.pid);
      if (!launcherIdentity || readLinuxProcessGroup(launcher.pid) !== launcher.pid) {
        throw new Error("trusted launcher did not establish a stable process group");
      }
      containment = createDispatchCgroup(launcher.pid);
      launcher.send({ ...message, type: "START", sandboxExecutable: resolveBubblewrap() });
      const established = await launcherMessages.next(["ESTABLISHED", "FAILURE"]);
      if (established.type === "FAILURE") throw new Error(established.error);
      containedTarget = { pid: established.pid, startIdentity: established.startIdentity };
      await sendIpc(established);
      const result = await launcherMessages.next(["CHILD_RESULT", "FAILURE"]);
      if (shuttingDown) return;
      if (result.type === "FAILURE") throw new Error(result.error);
      await terminateContainedGroup(
        launcher, launcherIdentity, killTimeoutMs, launcherTerminal, containment, containedTarget,
      );
      await destroyDispatchCgroup(containment, killTimeoutMs);
      containment = null;
      shuttingDown = true;
      await sendIpc({ type: "RESULT", code: result.code, signal: result.signal });
      if (process.connected) process.disconnect();
    } catch (error) {
      if (shuttingDown) return;
      shuttingDown = true;
      try {
        if (launcherIdentity && containment) {
          await terminateContainedGroup(
            launcher, launcherIdentity, killTimeoutMs, launcherTerminal, containment, containedTarget,
          );
        } else {
          await killTrustedDirectChild(launcher, launcherTerminal);
        }
      } catch (cleanupError) {
        error = new Error(`${error.message}; containment cleanup failed: ${cleanupError.message}`);
      }
      try {
        await destroyDispatchCgroup(containment, killTimeoutMs);
      } catch (cleanupError) {
        error = new Error(`${error.message}; cgroup removal failed: ${cleanupError.message}`);
      }
      containment = null;
      await sendIpc({ type: "FAILURE", error: error.message }).catch(() => {});
      process.exitCode = 1;
      if (process.connected) process.disconnect();
    }
  });
}

async function launcherMain() {
  let child = null;
  let sandboxRoot = null;
  let launcherContainmentFd = null;
  let disconnecting = false;
  process.on("SIGTERM", () => {}); // broker owns the bounded TERM→KILL interval
  const disconnectCleanup = () => {
    if (disconnecting) return;
    disconnecting = true;
    try { process.kill(-process.pid, "SIGTERM"); } catch { /* group already gone */ }
    setTimeout(() => {
      if (launcherContainmentFd !== null) {
        try { writeFileSync(`/proc/self/fd/${launcherContainmentFd}/cgroup.kill`, "1\n"); } catch {}
      } else {
        try { process.kill(-process.pid, "SIGKILL"); } catch { /* group already gone */ }
      }
    }, 1_000);
  };
  process.on("disconnect", disconnectCleanup);
  await sendIpc({ type: "READY" });
  process.on("message", async (message) => {
    if (message?.type !== "START" || child) return;
    try {
      const ownCgroup = cgroupPathForPid(process.pid);
      if (!ownCgroup || !/\/muster-dispatch-[^/]+$/.test(ownCgroup)) {
        throw new Error("trusted launcher did not receive a dedicated dispatch cgroup");
      }
      launcherContainmentFd = openSync(
        `/sys/fs/cgroup${ownCgroup}`,
        fsConstants.O_RDONLY | (fsConstants.O_DIRECTORY || 0) | fsConstants.O_NOFOLLOW,
      );
      if (statfsSync(`/proc/self/fd/${launcherContainmentFd}`).type !== CGROUP2_SUPER_MAGIC) {
        throw new Error("trusted launcher cleanup descriptor is not cgroup v2");
      }
      closeSync(openSync(
        `/proc/self/fd/${launcherContainmentFd}/cgroup.kill`,
        fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      ));
      sandboxRoot = mkdtempSync(join(tmpdir(), "muster-sandbox-"));
      const sandboxPath = (name) => join(sandboxRoot, name);
      const sandboxArgv = [
        "--unshare-user",
        "--unshare-pid",
        "--as-pid-1",
        "--unshare-cgroup",
        "--unshare-ipc",
        "--unshare-uts",
        "--die-with-parent",
        "--new-session",
        "--ro-bind", "/", "/",
        "--proc", "/proc",
        "--ro-bind", "/sys/fs/cgroup", "/sys/fs/cgroup",
        "--tmpfs", "/tmp",
        "--tmpfs", sandboxRoot,
      ];
      const runtimeDirectory = typeof process.getuid === "function" ? `/run/user/${process.getuid()}` : null;
      if (runtimeDirectory && existsSync(runtimeDirectory)) {
        sandboxArgv.push("--tmpfs", runtimeDirectory);
      }
      sandboxArgv.push(
        "--perms", "0500", "--ro-bind-data", String(BINDING_FDS.executable), sandboxPath("executable"),
        "--bind-fd", String(BINDING_FDS.cwd), sandboxPath("cwd"),
        "--perms", "0400", "--ro-bind-data", String(BINDING_FDS.agentFile), sandboxPath("agent"),
      );
      if (message.descriptor.executable === "/muster-interpreter") {
        sandboxArgv.push(
          "--perms", "0500", "--ro-bind-data", String(BINDING_FDS.interpreter), sandboxPath("interpreter"),
        );
      }
      const executable = message.descriptor.executable === "/muster-interpreter"
        ? sandboxPath("interpreter")
        : sandboxPath("executable");
      const argv = message.descriptor.argv.map((argument) => {
        if (argument === "/muster-executable") return sandboxPath("executable");
        if (argument === "/muster-agent") return sandboxPath("agent");
        return argument;
      });
      sandboxArgv.push(
        "--info-fd", String(BINDING_FDS.sandboxInfo),
        "--chdir", sandboxPath("cwd"), "--", executable, ...argv,
      );
      child = spawn(message.sandboxExecutable, sandboxArgv, {
        env: message.env,
        stdio: bindingStdio({
          executable: BINDING_FDS.executable,
          cwd: BINDING_FDS.cwd,
          agentFile: BINDING_FDS.agentFile,
          interpreter: BINDING_FDS.interpreter,
          sandboxInfo: true,
        }),
      });
      const childTerminal = terminalPromise(child);
      childTerminal.catch(() => {});
      const sandboxedPid = await bubblewrapChildPid(child);
      const identity = readKernelStartIdentity(sandboxedPid);
      if (!identity) {
        try { process.kill(-process.pid, "SIGTERM"); } catch {}
        setTimeout(() => {
          try { process.kill(-process.pid, "SIGKILL"); } catch {}
        }, 1_000);
        throw new Error("stable Kimi process identity unavailable");
      }
      await sendIpc({ type: "ESTABLISHED", pid: sandboxedPid, startIdentity: identity });
      const result = await childTerminal;
      try { rmdirSync(sandboxRoot); } catch {}
      sandboxRoot = null;
      await sendIpc({ type: "CHILD_RESULT", ...result });
    } catch (error) {
      if (sandboxRoot) {
        try { rmdirSync(sandboxRoot); } catch {}
        sandboxRoot = null;
      }
      await sendIpc({ type: "FAILURE", error: error.message }).catch(() => {});
      disconnectCleanup();
    }
  });
}

if (process.argv[1] === MODULE_PATH && process.argv[2] === "--broker") await brokerMain();
if (process.argv[1] === MODULE_PATH && process.argv[2] === "--launcher") await launcherMain();
