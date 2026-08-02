import { spawn } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { lstat, readdir, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve } from "node:path";
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
  // Keep one prompt argv element below portable OS command-line ceilings.
  promptBytes: 16 * 1024,
  outputBytes: 4 * 1024 * 1024,
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

export function parseCodexVersion(text) {
  const match = String(text || "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) throw new Error(`unsupported Codex version: could not parse ${JSON.stringify(String(text || "").trim())}`);
  return match.slice(1).map(Number);
}

function terminateProcess(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform !== "win32" && Number.isInteger(child.pid)) process.kill(-child.pid, "SIGKILL");
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
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    installProcessCleanupHandlers();
    activeCodexChildren.add(child);
    let stdout = "";
    let stderr = "";
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
      outputBytes += Buffer.byteLength(chunk, "utf8");
      if (outputBytes > maxOutputBytes) {
        forceStop(`process output exceeded ${maxOutputBytes} bytes`);
        return;
      }
      if (target === "stdout") stdout += chunk;
      else stderr += chunk;
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
      });
    });
  });
}

async function assertCodexProcessSupport({ command, env, spawnProcess }) {
  const versionResult = await runProcess(command, ["--version"], { env, spawnProcess });
  if (versionResult.code !== 0) throw new Error(`Codex version probe exited ${versionResult.code}: ${versionResult.stderr.trim() || "no stderr"}`);
  const version = parseCodexVersion(versionResult.stdout);
  if (compareVersion(version, MIN_CODEX_WAVE_VERSION) < 0) {
    throw new Error(`unsupported Codex version ${version.join(".")}; hermetic wave dispatch requires ${MIN_CODEX_WAVE_VERSION.join(".")} or newer`);
  }

  const rootHelp = await runProcess(command, ["--help"], { env, spawnProcess });
  if (rootHelp.code !== 0) throw new Error(`Codex root feature probe exited ${rootHelp.code}: ${rootHelp.stderr.trim() || "no stderr"}`);
  for (const feature of REQUIRED_ROOT_FEATURES) {
    if (!rootHelp.stdout.includes(feature)) throw new Error(`unsupported Codex root feature: ${feature} is required for hermetic wave dispatch`);
  }

  const execHelp = await runProcess(command, ["exec", "--help"], { env, spawnProcess });
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
  for (const member of members) {
    if (!member || typeof member.id !== "string" || !member.id.trim()) throw new Error("runCodexWave: every member requires a non-empty id");
    if (member.id.length > 128 || /[\0\r\n]/.test(member.id)) throw new Error("runCodexWave: member id is too long or contains control characters");
    if (ids.has(member.id)) throw new Error(`runCodexWave: duplicate member id ${JSON.stringify(member.id)}`);
    ids.add(member.id);
    if (typeof member.prompt !== "string" || !member.prompt.trim()) throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} requires a prompt`);
    if (member.prompt.includes("\0")) throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} prompt contains a NUL byte`);
    if (Buffer.byteLength(member.prompt, "utf8") > CODEX_WAVE_LIMITS.promptBytes) {
      throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} prompt exceeds ${CODEX_WAVE_LIMITS.promptBytes} bytes`);
    }
    if (member.model !== undefined && (typeof member.model !== "string" || !member.model.trim() || member.model.length > 256 || member.model.includes("\0"))) {
      throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} model must be a non-empty bounded string`);
    }
    if (member.lastMessagePath !== undefined) {
      throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} lastMessagePath is not supported by the hermetic process lane`);
    }
  }
}

function validateExecutionPolicy({ sandbox, approvalPolicy }) {
  if (!["read-only", "workspace-write"].includes(sandbox)) {
    throw new Error(`runCodexWave: sandbox must be read-only or workspace-write; got ${JSON.stringify(sandbox)}`);
  }
  if (approvalPolicy !== "never") {
    throw new Error(`runCodexWave: approvalPolicy must be "never" for unattended hermetic waves; got ${JSON.stringify(approvalPolicy)}`);
  }
}

function effectiveWaveCeiling(maxConcurrentThreadsPerSession, configuredThreadCeiling, availableThreadLimit) {
  const desired = maxConcurrentThreadsPerSession ?? 12;
  if (!Number.isInteger(desired) || desired < 1) {
    throw new Error("runCodexWave: maxConcurrentThreadsPerSession must be a positive integer");
  }
  const configured = configuredThreadCeiling ?? 12;
  if (!Number.isInteger(configured) || configured < 1) {
    throw new Error("runCodexWave: configuredThreadCeiling must be a positive integer");
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

async function gitText(cwd, args) {
  const result = await execFile("git", args, { cwd, encoding: "utf8" });
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

async function prepareTrustedRepository(repositoryRoot, baseSha) {
  if (typeof repositoryRoot !== "string" || !repositoryRoot.trim()) {
    throw new Error("runCodexWave: repositoryRoot is required for the process lane");
  }
  if (typeof baseSha !== "string" || !/^[0-9a-f]{40,64}$/i.test(baseSha)) {
    throw new Error("runCodexWave: baseSha must be a full 40-64 character hexadecimal commit id");
  }
  let canonicalRoot;
  try {
    canonicalRoot = await realpath(repositoryRoot);
    const topLevel = await realpath(await gitText(canonicalRoot, ["rev-parse", "--show-toplevel"]));
    if (topLevel !== canonicalRoot) throw new Error("repositoryRoot must be the exact trusted repository root");
    const commonDir = await realpath(await gitText(canonicalRoot, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const resolvedBase = await gitText(canonicalRoot, ["rev-parse", "--verify", `${baseSha}^{commit}`]);
    if (resolvedBase.toLowerCase() !== baseSha.toLowerCase()) throw new Error("baseSha does not resolve exactly in the trusted repository");
    const registry = await gitText(canonicalRoot, ["worktree", "list", "--porcelain", "-z"]);
    const registered = await registeredWorktreeAuthorities(commonDir, registry);
    return { repositoryRoot: canonicalRoot, commonDir, baseSha: resolvedBase, registered };
  } catch (error) {
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

async function validateRegisteredLinkedWorktree(member, authority, pinned = null) {
  let canonical;
  try {
    canonical = await realpath(member.cwd);
  } catch {
    throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} worktree does not exist: ${JSON.stringify(member.cwd)}`);
  }

  try {
    const topLevel = await realpath(await gitText(canonical, ["rev-parse", "--show-toplevel"]));
    if (topLevel !== canonical) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} cwd must be the exact worktree root (got ${JSON.stringify(canonical)}, root ${JSON.stringify(topLevel)})`);
    }
    const commonDir = await realpath(await gitText(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
    const gitDir = await realpath(await gitText(canonical, ["rev-parse", "--path-format=absolute", "--git-dir"]));
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
    const head = await gitText(canonical, ["rev-parse", "HEAD"]);
    if (head.toLowerCase() !== authority.baseSha.toLowerCase()) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} HEAD ${head} does not match trusted base ${authority.baseSha}`);
    }
    await assertNoExecutableProjectConfig(canonical, member.id);
    let schemaPath;
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
      if (pinned?.schemaIdentity && (!sameIdentity(currentIdentity.schemaIdentity, pinned.schemaIdentity)
        || currentIdentity.schemaIdentity.size !== pinned.schemaIdentity.size)) {
        throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} schema changed before launch`);
      }
    }
    return { ...member, cwd: canonical, gitDir, ...currentIdentity, ...(schemaPath ? { schemaPath } : {}) };
  } catch (error) {
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
  authority,
}) {
  // All path checks complete before the first Codex support probe or worker process.
  authority ||= await prepareTrustedRepository(repositoryRoot, baseSha);
  const canonicalMembers = await Promise.all(members.map(member => validateRegisteredLinkedWorktree(member, authority)));
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
  const support = await assertCodexProcessSupport({ command: codexCommand, env: childEnv, spawnProcess });
  const controller = new AbortController();
  const settled = await mapBounded(canonicalMembers, effectiveCeiling, async member => {
    try {
      if (controller.signal.aborted) {
        const error = new Error("Codex wave cancelled after another member failed");
        error.cancelled = true;
        return { error };
      }
      const refreshedAuthority = await prepareTrustedRepository(authority.repositoryRoot, authority.baseSha);
      if (refreshedAuthority.commonDir !== authority.commonDir) {
        throw new Error("runCodexWave: trusted repository common directory changed before spawn");
      }
      const revalidated = await validateRegisteredLinkedWorktree(member, refreshedAuthority, member);
      if (revalidated.cwd !== member.cwd) {
        throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} changed canonical cwd before spawn`);
      }
      const call = codexExecCall({
        prompt: member.prompt,
        cwd: member.cwd,
        model: member.model,
        schemaPath: member.schemaPath,
        sandbox,
        approvalPolicy,
      });
      const result = await runProcess(codexCommand, call.argv, {
        cwd: member.cwd,
        env: childEnv,
        spawnProcess,
        timeoutMs: workerTimeoutMs,
        maxOutputBytes: CODEX_WAVE_LIMITS.outputBytes,
        signal: controller.signal,
      });
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
      return { value: { id: member.id, usage: terminal.usage, stdout: result.stdout, stderr: result.stderr } };
    } catch (error) {
      if (controller.signal.aborted) error.cancelled = true;
      controller.abort();
      return { error };
    }
  });
  const failure = settled.find(row => row.error && !row.error.cancelled) || settled.find(row => row.error);
  if (failure) throw failure.error;
  return {
    mode: CODEX_EXEC_MODES.EXEC_PROCESS,
    isolation: "registered-linked-worktree",
    codexVersion: support.version,
    effectiveCeiling,
    results: settled.map(row => row.value),
  };
}

export async function runCodexWave({
  members,
  codexCommand = "codex",
  env = process.env,
  spawnProcess,
  sandbox = "workspace-write",
  approvalPolicy = "never",
  maxConcurrentThreadsPerSession,
  configuredThreadCeiling,
  availableThreadLimit,
  repositoryRoot,
  baseSha,
  workerTimeoutMs = CODEX_WAVE_LIMITS.workerTimeoutMs,
} = {}) {
  validateMembers(members);
  validateExecutionPolicy({ sandbox, approvalPolicy });
  if (typeof codexCommand !== "string" || !codexCommand.trim() || codexCommand.includes("\0")) {
    throw new Error("runCodexWave: codexCommand must be a non-empty NUL-free string");
  }
  if (!Number.isInteger(workerTimeoutMs) || workerTimeoutMs < 1 || workerTimeoutMs > CODEX_WAVE_LIMITS.workerTimeoutMs) {
    throw new Error(`runCodexWave: workerTimeoutMs must be an integer within 1..${CODEX_WAVE_LIMITS.workerTimeoutMs}`);
  }
  const effectiveCeiling = effectiveWaveCeiling(
    maxConcurrentThreadsPerSession,
    configuredThreadCeiling,
    availableThreadLimit,
  );
  // Trusted repository/base provenance is authenticated before lane selection
  // for every production wave. The resolver is process-only because no
  // mechanically authenticated read-only spawn profile exists.
  const authority = await prepareTrustedRepository(repositoryRoot, baseSha);
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
    authority,
  });
}
