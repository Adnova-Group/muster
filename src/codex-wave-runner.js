import { spawn } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { lstat, open, readdir, realpath } from "node:fs/promises";
import { delimiter, dirname, isAbsolute, relative, resolve } from "node:path";
import { readNoFollowRegular } from "./fs-safe.js";
import {
  CODEX_EXEC_MODES,
  codexExecCall,
  interpretCodexExecExit,
  resolveCodexDispatchLane,
} from "./wave-dispatch.js";

const execFile = promisify(execFileCb);
export const UNKNOWN_CODEX_USAGE = "UNKNOWN";
export const MIN_CODEX_WAVE_VERSION = Object.freeze([0, 145, 0]);
export const CODEX_WAVE_LIMITS = Object.freeze({
  members: 64,
  // Bound prompt input independently of platform pipe and model limits.
  promptBytes: 16 * 1024,
  outputBytes: 4 * 1024 * 1024,
  retainedOutputBytes: 64 * 1024,
  schemaBytes: 1024 * 1024,
  workerTimeoutMs: 10 * 60 * 1000,
  probeTimeoutMs: 30 * 1000,
});

const REQUIRED_EXEC_FEATURES = Object.freeze([
  "--json",
  "--ignore-user-config",
  "--ignore-rules",
  "--strict-config",
  "--ephemeral",
  "--sandbox",
]);
const REQUIRED_ROOT_FEATURES = Object.freeze(["--ask-for-approval"]);
const CONTAINED_CWD = "/mnt";
const TRUSTED_GIT_COMMAND = "/usr/bin/git";
const ACTION_CLASSES = new Set(["send", "sign", "submit", "publish", "purchase", "delete-remote"]);
const RUNNER_POLICY = Object.freeze({
  id: "muster-runner",
  model: "gpt-5.6-sol",
  reasoningEffort: "medium",
  sandbox: "workspace-write",
});

function remainingMs(deadline, label = "Codex wave") {
  const remaining = deadline - Date.now();
  if (remaining < 1) throw new Error(`${label} exceeded aggregate timeout deadline`);
  return remaining;
}

export function posixContainmentCall({ command, argv, descriptorFd = 3, bwrapCommand = "/usr/bin/bwrap" }) {
  return {
    command: bwrapCommand,
    argv: [
      "--die-with-parent", "--unshare-pid", "--new-session", "--proc", "/proc",
      "--dev-bind", "/", "/",
      "--bind", `/proc/self/fd/${descriptorFd}`, CONTAINED_CWD,
      "--chdir", CONTAINED_CWD, "--", command, ...argv,
    ],
  };
}

function compareVersion(left, right) {
  for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
    const delta = (left[i] || 0) - (right[i] || 0);
    if (delta) return delta;
  }
  return 0;
}

function hermeticCodexEnv(env = {}) {
  const allowed = [
    "PATH", "HOME", "CODEX_HOME", "TMPDIR", "TEMP", "TMP", "LANG", "LC_ALL", "TERM",
    "SSL_CERT_FILE", "SSL_CERT_DIR", "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
  ];
  const entries = allowed.filter(key => typeof env[key] === "string").map(key => [key, env[key]]);
  for (const [key, value] of entries) {
    if (value.includes("\0")) throw new Error(`runCodexWave: environment value ${key} contains a NUL byte`);
  }
  return Object.fromEntries(entries);
}

async function loadTrustedRunnerPolicy() {
  const candidates = [
    { url: new URL("../agents/muster-runner.toml", import.meta.url), format: "toml" },
    { url: new URL("../plugin/agents/muster-runner.md", import.meta.url), format: "markdown" },
  ];
  for (const candidate of candidates) {
    try {
      const read = await readNoFollowRegular(fileURLToPath(candidate.url), {
        maxBytes: 128 * 1024,
        label: "trusted muster-runner instructions",
        requireSingleLink: true,
      });
      const source = read.bytes.toString("utf8");
      const instructions = candidate.format === "toml"
        ? JSON.parse(source.match(/^developer_instructions = (.+)$/m)?.[1] || "null")
        : source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
      if (typeof instructions !== "string") continue;
      if (!instructions.includes("single-item lifecycle runner") || !instructions.includes("review gate")) continue;
      return {
        ...RUNNER_POLICY,
        instructions,
        digest: createHash("sha256").update(instructions).digest("hex"),
      };
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  throw new Error("runCodexWave: trusted muster-runner instructions are unavailable");
}

async function assertTrustedGitExecutable() {
  const canonical = await realpath(TRUSTED_GIT_COMMAND);
  const info = await lstat(TRUSTED_GIT_COMMAND);
  if (canonical !== TRUSTED_GIT_COMMAND || !info.isFile() || info.uid !== 0 || (info.mode & 0o022) !== 0) {
    throw new Error(`runCodexWave: trusted Git executable is unavailable at ${TRUSTED_GIT_COMMAND}`);
  }
}

export function parseCodexVersion(text) {
  const match = String(text || "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) throw new Error(`unsupported Codex version: could not parse ${JSON.stringify(String(text || "").trim())}`);
  return match.slice(1).map(Number);
}

export function terminateProcess(child, { platform = process.platform, taskkill = execFileCb } = {}) {
  if (!child || child.killed) return;
  if (platform === "win32" && Number.isInteger(child.pid)) {
    try {
      taskkill("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true }, error => {
        if (error) {
          try { child.kill("SIGKILL"); } catch { /* already gone */ }
        }
      });
      return;
    } catch {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      return;
    }
  }
  try {
    if (Number.isInteger(child.pid)) process.kill(-child.pid, "SIGKILL");
    else child.kill("SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* already gone */ }
  }
}

const activeCodexChildren = new Set();
let cleanupHandlersInstalled = false;
function installProcessCleanupHandlers() {
  if (cleanupHandlersInstalled) return;
  cleanupHandlersInstalled = true;
  const terminateAll = () => {
    for (const child of activeCodexChildren) terminateProcess(child);
  };
  const forwardSignal = signal => {
    terminateAll();
    process.removeListener(signal, signalHandlers[signal]);
    process.kill(process.pid, signal);
  };
  const signalHandlers = {
    SIGINT: () => forwardSignal("SIGINT"),
    SIGTERM: () => forwardSignal("SIGTERM"),
  };
  process.once("exit", terminateAll);
  process.once("SIGINT", signalHandlers.SIGINT);
  process.once("SIGTERM", signalHandlers.SIGTERM);
}

function runProcess(command, argv, {
  cwd,
  env,
  spawnProcess = spawn,
  timeoutMs = CODEX_WAVE_LIMITS.probeTimeoutMs,
  maxOutputBytes = CODEX_WAVE_LIMITS.outputBytes,
  consumeOutputBytes,
  directoryFd,
  stdinText,
  signal,
} = {}) {
  return new Promise((resolveProcess, reject) => {
    if (signal?.aborted) {
      reject(new Error("process cancelled before launch"));
      return;
    }
    const child = spawnProcess(command, argv, {
      cwd,
      env,
      stdio: [stdinText === undefined ? "ignore" : "pipe", "pipe", "pipe", ...(directoryFd === undefined ? [] : [directoryFd])],
      detached: process.platform !== "win32",
    });
    installProcessCleanupHandlers();
    activeCodexChildren.add(child);
    if (stdinText !== undefined) {
      child.stdin?.end(stdinText);
    }
    let stdout = "";
    let stderr = "";
    const stdoutHash = createHash("sha256");
    const stderrHash = createHash("sha256");
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let outputBytes = 0;
    let forcedReason = null;
    let finished = false;
    const forceStop = reason => {
      if (!forcedReason) forcedReason = reason;
      terminateProcess(child);
    };
    const timer = setTimeout(() => forceStop(`process exceeded ${timeoutMs}ms timeout`), timeoutMs);
    timer.unref?.();
    const abort = () => forceStop("process cancelled after another wave member failed");
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    const capture = target => chunk => {
      const chunkBytes = Buffer.byteLength(chunk, "utf8");
      outputBytes += chunkBytes;
      if (outputBytes > maxOutputBytes) {
        forceStop(`process output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      if (consumeOutputBytes && !consumeOutputBytes(chunkBytes)) {
        forceStop(`wave output exceeded ${CODEX_WAVE_LIMITS.outputBytes} bytes`);
        return;
      }
      const appendTail = current => {
        const combined = current + chunk;
        if (Buffer.byteLength(combined, "utf8") <= CODEX_WAVE_LIMITS.retainedOutputBytes) return combined;
        return Buffer.from(combined, "utf8").subarray(-CODEX_WAVE_LIMITS.retainedOutputBytes).toString("utf8");
      };
      if (target === "stdout") {
        stdoutHash.update(chunk);
        const next = appendTail(stdout);
        stdoutTruncated ||= next.length < stdout.length + chunk.length;
        stdout = next;
      } else {
        stderrHash.update(chunk);
        const next = appendTail(stderr);
        stderrTruncated ||= next.length < stderr.length + chunk.length;
        stderr = next;
      }
    };
    child.stdout?.on("data", capture("stdout"));
    child.stderr?.on("data", capture("stderr"));
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      activeCodexChildren.delete(child);
    };
    child.once("error", error => {
      if (finished) return;
      finished = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, closeSignal) => {
      if (finished) return;
      finished = true;
      cleanup();
      resolveProcess({
        code: forcedReason ? 1 : (Number.isInteger(code) ? code : 1),
        signal: closeSignal,
        forcedReason,
        stdout,
        stderr: forcedReason ? `${stderr}${stderr ? "\n" : ""}${forcedReason}` : stderr,
        stdoutSha256: stdoutHash.digest("hex"),
        stderrSha256: stderrHash.digest("hex"),
        stdoutTruncated,
        stderrTruncated,
      });
    });
  });
}

async function assertContainmentSupport({ deadline, env, spawnProcess }) {
  if (process.platform !== "linux") {
    throw new Error(`runCodexWave: non-escapable process containment is unavailable on ${process.platform}; refusing production wave`);
  }
  const result = await runProcess("/usr/bin/bwrap", ["--version"], {
    env,
    spawnProcess,
    timeoutMs: Math.min(CODEX_WAVE_LIMITS.probeTimeoutMs, remainingMs(deadline)),
  });
  if (result.code !== 0 || !/bubblewrap/i.test(result.stdout + result.stderr)) {
    throw new Error(`runCodexWave: bubblewrap PID-namespace containment is required: ${result.stderr.trim() || "version probe failed"}`);
  }
}

function runContainedCodex(command, argv, {
  directoryHandle,
  env,
  spawnProcess,
  timeoutMs,
  maxOutputBytes,
  consumeOutputBytes,
  signal,
  stdinText,
}) {
  const wrapped = posixContainmentCall({ command, argv });
  return runProcess(wrapped.command, wrapped.argv, {
    cwd: "/",
    env,
    spawnProcess,
    timeoutMs,
    maxOutputBytes,
    consumeOutputBytes,
    signal,
    stdinText,
    directoryFd: directoryHandle.fd,
  });
}

async function assertCodexProcessSupport({ runCodexProcess }) {
  const versionResult = await runCodexProcess(["--version"]);
  if (versionResult.code !== 0) throw new Error(`Codex version probe exited ${versionResult.code}: ${versionResult.stderr.trim() || "no stderr"}`);
  const version = parseCodexVersion(versionResult.stdout);
  if (compareVersion(version, MIN_CODEX_WAVE_VERSION) < 0) {
    throw new Error(`unsupported Codex version ${version.join(".")}; hermetic wave dispatch requires ${MIN_CODEX_WAVE_VERSION.join(".")} or newer`);
  }

  const rootHelp = await runCodexProcess(["--help"]);
  if (rootHelp.code !== 0) throw new Error(`Codex root feature probe exited ${rootHelp.code}: ${rootHelp.stderr.trim() || "no stderr"}`);
  for (const feature of REQUIRED_ROOT_FEATURES) {
    if (!rootHelp.stdout.includes(feature)) throw new Error(`unsupported Codex root feature: ${feature} is required for hermetic wave dispatch`);
  }

  const execHelp = await runCodexProcess(["exec", "--help"]);
  if (execHelp.code !== 0) throw new Error(`Codex exec feature probe exited ${execHelp.code}: ${execHelp.stderr.trim() || "no stderr"}`);
  for (const feature of REQUIRED_EXEC_FEATURES) {
    if (!execHelp.stdout.includes(feature)) throw new Error(`unsupported Codex exec feature: ${feature} is required for hermetic wave dispatch`);
  }
  return { version: version.join(".") };
}

function parseCodexTurnResult(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "turn.completed") {
      return {
        completed: true,
        usage: event.usage && typeof event.usage === "object" ? event.usage : UNKNOWN_CODEX_USAGE,
      };
    }
  }
  return { completed: false, usage: UNKNOWN_CODEX_USAGE };
}

export function parseCodexTurnUsage(stdout) {
  return parseCodexTurnResult(stdout).usage;
}

function validateMembers(members) {
  if (!Array.isArray(members) || members.length === 0) throw new Error("runCodexWave: members must be a non-empty array");
  if (members.length > CODEX_WAVE_LIMITS.members) {
    throw new Error(`runCodexWave: members exceeds limit ${CODEX_WAVE_LIMITS.members}`);
  }
  const ids = new Set();
  const allowedKeys = new Set(["id", "cwd", "prompt", "writes", "agentType", "schemaPath"]);
  for (const member of members) {
    if (!member || typeof member.id !== "string" || !member.id.trim()) throw new Error("runCodexWave: every member requires a non-empty id");
    if (member.id.length > 128 || /[\0\r\n]/.test(member.id)) throw new Error("runCodexWave: member id is too long or contains control characters");
    if (ids.has(member.id)) throw new Error(`runCodexWave: duplicate member id ${JSON.stringify(member.id)}`);
    ids.add(member.id);
    const unknownKeys = Object.keys(member).filter(key => !allowedKeys.has(key));
    if (unknownKeys.length) throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} contains untrusted policy fields: ${unknownKeys.join(", ")}`);
    if (member.agentType !== RUNNER_POLICY.id) {
      throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} agentType must be ${JSON.stringify(RUNNER_POLICY.id)}`);
    }
    if (typeof member.prompt !== "string" || !member.prompt.trim()) throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} requires a prompt`);
    if (member.prompt.includes("\0")) throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} prompt contains a NUL byte`);
    if (Buffer.byteLength(member.prompt, "utf8") > CODEX_WAVE_LIMITS.promptBytes) {
      throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} prompt exceeds ${CODEX_WAVE_LIMITS.promptBytes} bytes`);
    }
  }
}

function validateTrustedActionFences(members, trustedActionFences) {
  if (!trustedActionFences || typeof trustedActionFences !== "object" || Array.isArray(trustedActionFences)) {
    throw new Error("runCodexWave: trusted action-fence map is required out of band");
  }
  const memberIds = members.map(member => member.id).sort();
  const fenceIds = Object.keys(trustedActionFences).sort();
  if (JSON.stringify(memberIds) !== JSON.stringify(fenceIds)) {
    throw new Error("runCodexWave: trusted action-fence map must contain exactly every wave member id");
  }
  const normalized = {};
  for (const id of memberIds) {
    const actions = trustedActionFences[id];
    if (!Array.isArray(actions) || actions.some(action => typeof action !== "string" || !ACTION_CLASSES.has(action))) {
      throw new Error(`runCodexWave: trusted action fence for ${JSON.stringify(id)} contains an unknown action class`);
    }
    normalized[id] = [...new Set(actions)].sort();
  }
  const serialized = JSON.stringify(normalized);
  return { members: normalized, digest: createHash("sha256").update(serialized).digest("hex") };
}

function validateExecutionPolicy({ sandbox, approvalPolicy }) {
  if (sandbox !== RUNNER_POLICY.sandbox) {
    throw new Error(`runCodexWave: sandbox is fixed by the trusted ${RUNNER_POLICY.id} policy; got ${JSON.stringify(sandbox)}`);
  }
  if (approvalPolicy !== "never") {
    throw new Error(`runCodexWave: approvalPolicy must be "never" for unattended hermetic waves; got ${JSON.stringify(approvalPolicy)}`);
  }
}

function effectiveWaveCeiling(maxConcurrentThreadsPerSession, configuredThreadCeiling, availableThreadLimit) {
  const configured = configuredThreadCeiling ?? 12;
  if (!Number.isInteger(configured) || configured < 1) {
    throw new Error("runCodexWave: configuredThreadCeiling must be a positive integer");
  }
  const desired = maxConcurrentThreadsPerSession ?? configured;
  if (!Number.isInteger(desired) || desired < 1) {
    throw new Error("runCodexWave: maxConcurrentThreadsPerSession must be a positive integer");
  }
  if (availableThreadLimit !== undefined
    && (!Number.isInteger(availableThreadLimit) || availableThreadLimit < 1)) {
    throw new Error("runCodexWave: availableThreadLimit must be a positive integer when provided");
  }
  return Math.min(desired, configured, availableThreadLimit ?? desired);
}

async function mapBounded(values, ceiling, mapper) {
  const results = new Array(values.length);
  let next = 0;
  const worker = async () => {
    while (next < values.length) {
      const index = next++;
      results[index] = await mapper(values[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(ceiling, values.length) }, worker));
  return results;
}

async function gitText(cwd, args, deadline) {
  const env = {
    PATH: "/usr/bin:/bin",
    ...(typeof process.env.LANG === "string" ? { LANG: process.env.LANG } : {}),
    ...(typeof process.env.LC_ALL === "string" ? { LC_ALL: process.env.LC_ALL } : {}),
    GIT_ATTR_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_OPTIONAL_LOCKS: "0",
  };
  const result = await execFile(TRUSTED_GIT_COMMAND, [
    "-c", "core.fsmonitor=false",
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.attributesFile=/dev/null",
    ...args,
  ], {
    cwd,
    env,
    encoding: "utf8",
    timeout: remainingMs(deadline, "Codex wave admission"),
    killSignal: "SIGKILL",
  });
  return result.stdout.trim();
}

function worktreePaths(porcelain) {
  return String(porcelain)
    .split("\0")
    .filter(field => field.startsWith("worktree "))
    .map(field => field.slice("worktree ".length));
}

function containedPath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

async function resolveTrustedCodexExecutable(env, authority) {
  for (const directory of String(env.PATH || "").split(delimiter).filter(Boolean)) {
    try {
      const executable = await realpath(resolve(directory, "codex"));
      const info = await lstat(executable);
      if (!info.isFile() || (info.mode & 0o022) !== 0) continue;
      if (containedPath(authority.repositoryRoot, executable) || containedPath(authority.commonDir, executable)) continue;
      if (typeof process.getuid === "function" && ![0, process.getuid()].includes(info.uid)) continue;
      let packageRoot = dirname(executable);
      let trustedPackage = false;
      for (let depth = 0; depth < 5; depth += 1) {
        try {
          const packageRead = await readNoFollowRegular(resolve(packageRoot, "package.json"), {
            maxBytes: 64 * 1024,
            label: "Codex installation package",
            requireSingleLink: true,
          });
          trustedPackage = JSON.parse(packageRead.bytes.toString("utf8")).name === "@openai/codex";
          break;
        } catch (error) {
          if (error.code !== "ENOENT") break;
        }
        packageRoot = dirname(packageRoot);
      }
      if (trustedPackage) return executable;
    } catch { /* try the next trusted PATH entry */ }
  }
  throw new Error("runCodexWave: no trusted Codex executable was found outside the repository");
}

function sameIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function pathIdentity(path, kind) {
  const info = await lstat(path);
  if (kind === "directory" && !info.isDirectory()) throw new Error(`${path} is not a directory`);
  if (kind === "file" && !info.isFile()) throw new Error(`${path} is not a regular file`);
  return { dev: info.dev, ino: info.ino };
}

async function boundedText(path, maxBytes, label) {
  return (await readNoFollowRegular(path, {
    maxBytes,
    label,
    requireSingleLink: true,
  })).bytes.toString("utf8");
}

async function registeredWorktreeAuthorities(commonDir, porcelain) {
  const listed = new Set((await Promise.all(worktreePaths(porcelain).map(async path => {
    try { return await realpath(resolve(path)); } catch { return null; }
  }))).filter(Boolean));
  const authorities = new Map();
  const worktreesDir = resolve(commonDir, "worktrees");
  let entries = [];
  try { entries = await readdir(worktreesDir, { withFileTypes: true }); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
    const gitDir = await realpath(resolve(worktreesDir, entry.name));
    const pointerText = (await boundedText(resolve(gitDir, "gitdir"), 16 * 1024, `worktree ${entry.name} gitdir backpointer`)).trim();
    const dotGit = resolve(gitDir, pointerText);
    if (dotGit.split(/[\\/]/).at(-1) !== ".git") continue;
    let worktree;
    try { worktree = await realpath(dirname(dotGit)); } catch { continue; }
    if (!listed.has(worktree)) continue;
    authorities.set(worktree, {
      gitDir,
      cwdIdentity: await pathIdentity(worktree, "directory"),
      gitDirIdentity: await pathIdentity(gitDir, "directory"),
      dotGitIdentity: await pathIdentity(resolve(worktree, ".git"), "file"),
    });
  }
  return authorities;
}

async function prepareTrustedRepository(repositoryRoot, baseSha, deadline) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot.trim()) {
    throw new Error("runCodexWave: repositoryRoot is required for the process lane");
  }
  if (typeof baseSha !== "string" || !/^[0-9a-f]{40,64}$/i.test(baseSha)) {
    throw new Error("runCodexWave: baseSha must be a full 40-64 character hexadecimal commit id");
  }
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(repositoryRoot);
    const topLevel = await realpath(await gitText(canonicalRoot, ["rev-parse", "--show-toplevel"], deadline));
    if (topLevel !== canonicalRoot) throw new Error("repositoryRoot must be the exact trusted repository root");
    const commonDir = await realpath(await gitText(canonicalRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline));
    const resolvedBase = await gitText(canonicalRoot, ["rev-parse", "--verify", `${baseSha}^{commit}`], deadline);
    if (resolvedBase.toLowerCase() !== baseSha.toLowerCase()) throw new Error("baseSha does not resolve exactly in the trusted repository");
    const registry = await gitText(canonicalRoot, ["worktree", "list", "--porcelain", "-z"], deadline);
    const registered = await registeredWorktreeAuthorities(commonDir, registry);
    return { repositoryRoot: canonicalRoot, commonDir, baseSha: resolvedBase, registered };
  } catch (error) {
    if (Date.now() >= deadline || /timed out|timeout|killed/i.test(error.message || "")) {
      throw new Error("runCodexWave: Codex wave admission exceeded aggregate timeout deadline");
    }
    if (error.message?.startsWith("runCodexWave:")) throw error;
    throw new Error(`runCodexWave: trusted repository validation failed: ${error.message}`);
  }
}

async function assertNoExecutableProjectConfig(canonical, memberId) {
  for (const relativePath of [".codex/config.toml", ".codex/hooks.json", ".codex/rules"]) {
    try {
      await lstat(resolve(canonical, relativePath));
      throw new Error(`runCodexWave: process member ${JSON.stringify(memberId)} contains executable project Codex configuration ${JSON.stringify(relativePath)}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
}

async function validateRegisteredLinkedWorktree(member, authority, pinned = null, { deadline, pinDirectory = false } = {}) {
  let canonical;
  try {
    canonical = await realpath(member.cwd);
  } catch {
    throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} worktree does not exist: ${JSON.stringify(member.cwd)}`);
  }

  try {
    const topLevel = await realpath(await gitText(canonical, ["rev-parse", "--show-toplevel"], deadline));
    if (topLevel !== canonical) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} cwd must be the exact worktree root (got ${JSON.stringify(canonical)}, root ${JSON.stringify(topLevel)})`);
    }
    const commonDir = await realpath(await gitText(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"], deadline));
    const gitDir = await realpath(await gitText(canonical, ["rev-parse", "--path-format=absolute", "--git-dir"], deadline));
    if (canonical === authority.repositoryRoot || commonDir === gitDir) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} points at the base checkout, not an isolated linked worktree`);
    }
    if (commonDir !== authority.commonDir) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} does not belong to the trusted repository common git directory`);
    }
    const registration = authority.registered.get(canonical);
    if (!registration) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} is not a registered linked git worktree: ${JSON.stringify(canonical)}`);
    }
    if (gitDir !== registration.gitDir) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} git directory does not match its trusted registry entry`);
    }
    const dotGitText = (await boundedText(resolve(canonical, ".git"), 16 * 1024, `worktree ${member.id} .git pointer`)).trim();
    if (!dotGitText.startsWith("gitdir:")) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} has an invalid .git pointer`);
    }
    const pointedGitDir = await realpath(resolve(canonical, dotGitText.slice("gitdir:".length).trim()));
    if (pointedGitDir !== registration.gitDir) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} .git pointer does not match its trusted registry backpointer`);
    }
    const currentIdentity = {
      cwdIdentity: await pathIdentity(canonical, "directory"),
      gitDirIdentity: await pathIdentity(gitDir, "directory"),
      dotGitIdentity: await pathIdentity(resolve(canonical, ".git"), "file"),
    };
    for (const key of ["cwdIdentity", "gitDirIdentity", "dotGitIdentity"]) {
      if (!sameIdentity(currentIdentity[key], registration[key]) || (pinned && !sameIdentity(currentIdentity[key], pinned[key]))) {
        throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} ${key} changed before launch`);
      }
    }
    const head = await gitText(canonical, ["rev-parse", "HEAD"], deadline);
    if (head.toLowerCase() !== authority.baseSha.toLowerCase()) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} HEAD ${head} does not match trusted base ${authority.baseSha}`);
    }
    await assertNoExecutableProjectConfig(canonical, member.id);
    let schemaPath;
    let schemaRelative;
    if (member.schemaPath !== undefined) {
      if (typeof member.schemaPath !== "string" || !isAbsolute(member.schemaPath)) {
        throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} schemaPath must be absolute and contained in its worktree`);
      }
      schemaPath = await realpath(member.schemaPath);
      if (!containedPath(canonical, schemaPath) || !(await lstat(schemaPath)).isFile()) {
        throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} schemaPath must be a contained regular file`);
      }
      const schemaRead = await readNoFollowRegular(schemaPath, {
        maxBytes: CODEX_WAVE_LIMITS.schemaBytes,
        label: `schema for wave member ${member.id}`,
        requireSingleLink: true,
      });
      currentIdentity.schemaIdentity = { dev: schemaRead.info.dev, ino: schemaRead.info.ino, size: schemaRead.info.size };
      schemaRelative = relative(canonical, schemaPath);
      if (pinned?.schemaIdentity && (!sameIdentity(currentIdentity.schemaIdentity, pinned.schemaIdentity)
        || currentIdentity.schemaIdentity.size !== pinned.schemaIdentity.size)) {
        throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} schema changed before launch`);
      }
    }
    const status = await gitText(canonical, ["status", "--porcelain=v1", "--untracked-files=all", "--ignored=matching"], deadline);
    if (status) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} worktree is not pristine; tracked or untracked changes are forbidden before launch`);
    }
    const flaggedIndex = (await gitText(canonical, ["ls-files", "-v"], deadline))
      .split("\n")
      .filter(line => line && (/^[a-z]/.test(line) || line.startsWith("S ")));
    if (flaggedIndex.length) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} index contains assume-unchanged or skip-worktree entries`);
    }
    const trackedDiff = await gitText(canonical, ["diff", "--name-only", authority.baseSha, "--"], deadline);
    if (trackedDiff) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} tracked contents or index differ from trusted base`);
    }
    let directoryHandle;
    if (pinDirectory) {
      directoryHandle = await open(canonical, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
      const info = await directoryHandle.stat();
      if (!sameIdentity({ dev: info.dev, ino: info.ino }, currentIdentity.cwdIdentity)) {
        await directoryHandle.close();
        throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} worktree changed while pinning launch directory`);
      }
    }
    return { ...member, cwd: canonical, gitDir, ...currentIdentity, ...(schemaPath ? { schemaPath, schemaRelative } : {}), ...(directoryHandle ? { directoryHandle } : {}) };
  } catch (error) {
    if (Date.now() >= deadline || /timed out|timeout|killed/i.test(error.message || "")) {
      throw new Error("runCodexWave: Codex wave admission exceeded aggregate timeout deadline");
    }
    if (error.message?.startsWith("runCodexWave:")) throw error;
    throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} is not a registered linked git worktree: ${JSON.stringify(canonical)}`);
  }
}

async function runProcessWave({
  members,
  codexCommand,
  env,
  spawnProcess,
  sandbox,
  approvalPolicy,
  effectiveCeiling,
  repositoryRoot,
  baseSha,
  workerTimeoutMs,
  deadline,
  authority,
  rolePolicy,
  actionFences,
}) {
  // All path checks complete before the first Codex support probe or worker process.
  authority ||= await prepareTrustedRepository(repositoryRoot, baseSha, deadline);
  const canonicalMembers = await Promise.all(members.map(member => validateRegisteredLinkedWorktree(member, authority, null, { deadline })));
  const seen = new Map();
  const seenGitDirs = new Map();
  for (const member of canonicalMembers) {
    const prior = seen.get(member.cwd);
    if (prior) throw new Error(`runCodexWave: process members ${JSON.stringify(prior)} and ${JSON.stringify(member.id)} resolve to the same canonical cwd ${JSON.stringify(member.cwd)}`);
    seen.set(member.cwd, member.id);
    const gitDirKey = `${member.gitDirIdentity.dev}:${member.gitDirIdentity.ino}`;
    const priorGitDir = seenGitDirs.get(gitDirKey);
    if (priorGitDir) throw new Error(`runCodexWave: process members ${JSON.stringify(priorGitDir)} and ${JSON.stringify(member.id)} resolve to the same git administrative directory`);
    seenGitDirs.set(gitDirKey, member.id);
  }

  const childEnv = hermeticCodexEnv(env);
  await assertContainmentSupport({ deadline, env: childEnv, spawnProcess });
  const repositoryHandle = await open(authority.repositoryRoot, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  let support;
  try {
    support = await assertCodexProcessSupport({
      runCodexProcess: argv => runContainedCodex(codexCommand, argv, {
        directoryHandle: repositoryHandle,
        env: childEnv,
        spawnProcess,
        timeoutMs: Math.min(CODEX_WAVE_LIMITS.probeTimeoutMs, remainingMs(deadline)),
        maxOutputBytes: CODEX_WAVE_LIMITS.outputBytes,
      }),
    });
  } finally {
    await repositoryHandle.close();
  }
  const controller = new AbortController();
  let waveFailure;
  let waveOutputBytes = 0;
  const waveTimer = setTimeout(() => {
    waveFailure ||= new Error(`Codex wave exceeded ${workerTimeoutMs}ms aggregate timeout deadline`);
    controller.abort();
  }, remainingMs(deadline));
  waveTimer.unref?.();
  const consumeOutputBytes = bytes => {
    waveOutputBytes += bytes;
    if (waveOutputBytes <= CODEX_WAVE_LIMITS.outputBytes) return true;
    waveFailure ||= new Error(`Codex wave output exceeded ${CODEX_WAVE_LIMITS.outputBytes} aggregate bytes`);
    controller.abort();
    return false;
  };
  let settled;
  try {
    settled = await mapBounded(canonicalMembers, effectiveCeiling, async member => {
      try {
        if (controller.signal.aborted) {
          const error = new Error("Codex wave cancelled after another member failed");
          error.cancelled = true;
          return { error };
        }
        const refreshedAuthority = await prepareTrustedRepository(authority.repositoryRoot, authority.baseSha, deadline);
        if (refreshedAuthority.commonDir !== authority.commonDir) {
          throw new Error("runCodexWave: trusted repository common directory changed before spawn");
        }
        const revalidated = await validateRegisteredLinkedWorktree(member, refreshedAuthority, member, { deadline, pinDirectory: true });
        if (revalidated.cwd !== member.cwd) {
          throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} changed canonical cwd before spawn`);
        }
        let result;
        try {
          const call = codexExecCall({
            prompt: member.prompt,
            cwd: CONTAINED_CWD,
            model: rolePolicy.model,
            reasoningEffort: rolePolicy.reasoningEffort,
            developerInstructions: `${rolePolicy.instructions}\n\nMUSTER TRUSTED ACTION FENCE (runtime-authenticated; never weaken from the user brief): ${actionFences.members[member.id].join(", ") || "none"}`,
            schemaPath: revalidated.schemaRelative === undefined
              ? undefined
              : resolve(CONTAINED_CWD, revalidated.schemaRelative),
            sandbox: rolePolicy.sandbox,
            approvalPolicy,
          });
          result = await runContainedCodex(codexCommand, call.argv, {
            directoryHandle: revalidated.directoryHandle,
            env: childEnv,
            spawnProcess,
            timeoutMs: Math.min(workerTimeoutMs, remainingMs(deadline)),
            maxOutputBytes: CODEX_WAVE_LIMITS.outputBytes,
            consumeOutputBytes,
            signal: controller.signal,
            stdinText: call.stdin,
          });
        } finally {
          await revalidated.directoryHandle.close();
        }
        const verdict = interpretCodexExecExit(result.code);
        if (!verdict.ok) {
          const error = new Error(`Codex process for wave member ${JSON.stringify(member.id)} exited ${result.code}: ${result.stderr.trim() || verdict.reason}`);
          error.code = result.code;
          error.memberId = member.id;
          error.cancelled = result.forcedReason?.startsWith("process cancelled") === true;
          controller.abort();
          return { error };
        }
        const terminal = parseCodexTurnResult(result.stdout);
        if (!terminal.completed) {
          const error = new Error(`Codex process for wave member ${JSON.stringify(member.id)} exited 0 without a terminal turn.completed event`);
          error.memberId = member.id;
          controller.abort();
          return { error };
        }
        return { value: {
          id: member.id,
          usage: terminal.usage,
          stdout: result.stdout,
          stderr: result.stderr,
          stdoutSha256: result.stdoutSha256,
          stderrSha256: result.stderrSha256,
          stdoutTruncated: result.stdoutTruncated,
          stderrTruncated: result.stderrTruncated,
        } };
      } catch (error) {
        if (controller.signal.aborted) error.cancelled = true;
        controller.abort();
        return { error };
      }
    });
  } finally {
    clearTimeout(waveTimer);
  }
  if (waveFailure) throw waveFailure;
  const failure = settled.find(row => row.error && !row.error.cancelled) || settled.find(row => row.error);
  if (failure) throw failure.error;
  return {
    mode: CODEX_EXEC_MODES.EXEC_PROCESS,
    isolation: "registered-linked-worktree",
    codexVersion: support.version,
    rolePolicy: {
      id: rolePolicy.id,
      model: rolePolicy.model,
      reasoningEffort: rolePolicy.reasoningEffort,
      sandbox: rolePolicy.sandbox,
      instructionsSha256: rolePolicy.digest,
    },
    actionFenceSha256: actionFences.digest,
    effectiveCeiling,
    results: settled.map(row => row.value),
  };
}

export async function runCodexWave({
  members,
  codexCommand,
  env = process.env,
  spawnProcess,
  sandbox = "workspace-write",
  approvalPolicy = "never",
  maxConcurrentThreadsPerSession,
  configuredThreadCeiling,
  availableThreadLimit,
  repositoryRoot,
  baseSha,
  trustedActionFences,
  workerTimeoutMs = CODEX_WAVE_LIMITS.workerTimeoutMs,
} = {}) {
  if (!Number.isInteger(workerTimeoutMs) || workerTimeoutMs < 1 || workerTimeoutMs > CODEX_WAVE_LIMITS.workerTimeoutMs) {
    throw new Error(`runCodexWave: workerTimeoutMs must be an integer within 1..${CODEX_WAVE_LIMITS.workerTimeoutMs}`);
  }
  const deadline = Date.now() + workerTimeoutMs;
  await assertTrustedGitExecutable();
  const rolePolicy = await loadTrustedRunnerPolicy();
  validateMembers(members);
  const actionFences = validateTrustedActionFences(members, trustedActionFences);
  validateExecutionPolicy({ sandbox, approvalPolicy });
  if (codexCommand !== undefined && (typeof codexCommand !== "string" || !codexCommand.trim() || codexCommand.includes("\0"))) {
    throw new Error("runCodexWave: test codexCommand must be a non-empty NUL-free string");
  }
  const effectiveCeiling = effectiveWaveCeiling(
    maxConcurrentThreadsPerSession,
    configuredThreadCeiling,
    availableThreadLimit,
  );
  // Trusted repository/base provenance is authenticated before lane selection
  // for every production wave. The resolver is process-only because no
  // mechanically authenticated read-only spawn profile exists.
  const authority = await prepareTrustedRepository(repositoryRoot, baseSha, deadline);
  codexCommand ||= await resolveTrustedCodexExecutable(env, authority);
  resolveCodexDispatchLane();
  return runProcessWave({
    members,
    codexCommand,
    env,
    spawnProcess,
    sandbox,
    approvalPolicy,
    effectiveCeiling,
    repositoryRoot,
    baseSha,
    workerTimeoutMs,
    deadline,
    authority,
    rolePolicy,
    actionFences,
  });
}
