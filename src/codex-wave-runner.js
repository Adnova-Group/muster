import { spawn } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { lstat, realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import { readCodexMultiAgentVersion } from "./codex-inventory.js";
import {
  CODEX_EXEC_MODES,
  codexExecCall,
  codexSpawnAgentCall,
  interpretCodexExecExit,
  resolveCodexDispatchLane,
  resolveCodexMultiAgentVersion,
} from "./wave-dispatch.js";

const execFile = promisify(execFileCb);
export const UNKNOWN_CODEX_USAGE = "UNKNOWN";
export const MIN_CODEX_WAVE_VERSION = Object.freeze([0, 145, 0]);
export const CODEX_WAVE_LIMITS = Object.freeze({
  members: 64,
  promptBytes: 256 * 1024,
  outputBytes: 4 * 1024 * 1024,
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
  return Object.fromEntries(allowed.filter(key => typeof env[key] === "string").map(key => [key, env[key]]));
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

function runProcess(command, argv, {
  cwd,
  env,
  spawnProcess = spawn,
  timeoutMs = CODEX_WAVE_LIMITS.probeTimeoutMs,
  maxOutputBytes = CODEX_WAVE_LIMITS.outputBytes,
  signal,
} = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawnProcess(command, argv, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
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
    if (Buffer.byteLength(member.prompt, "utf8") > CODEX_WAVE_LIMITS.promptBytes) {
      throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} prompt exceeds ${CODEX_WAVE_LIMITS.promptBytes} bytes`);
    }
    if (member.model !== undefined && (typeof member.model !== "string" || !member.model.trim() || member.model.length > 256)) {
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
    const registered = new Set((await Promise.all(worktreePaths(registry).map(async path => {
      try { return await realpath(resolve(path)); } catch { return null; }
    }))).filter(Boolean));
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

async function validateRegisteredLinkedWorktree(member, authority) {
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
    if (!authority.registered.has(canonical)) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} is not a registered linked git worktree: ${JSON.stringify(canonical)}`);
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
    }
    return { ...member, cwd: canonical, ...(schemaPath ? { schemaPath } : {}) };
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
}) {
  // All path checks complete before the first Codex support probe or worker process.
  const authority = await prepareTrustedRepository(repositoryRoot, baseSha);
  const canonicalMembers = await Promise.all(members.map(member => validateRegisteredLinkedWorktree(member, authority)));
  const seen = new Map();
  for (const member of canonicalMembers) {
    const prior = seen.get(member.cwd);
    if (prior) throw new Error(`runCodexWave: process members ${JSON.stringify(prior)} and ${JSON.stringify(member.id)} resolve to the same canonical cwd ${JSON.stringify(member.cwd)}`);
    seen.set(member.cwd, member.id);
  }

  const childEnv = hermeticCodexEnv(env);
  const support = await assertCodexProcessSupport({ command: codexCommand, env: childEnv, spawnProcess });
  const controller = new AbortController();
  const settled = await mapBounded(canonicalMembers, effectiveCeiling, async member => {
    if (controller.signal.aborted) return { error: new Error("Codex wave cancelled after another member failed") };
    const revalidated = await validateRegisteredLinkedWorktree(member, authority);
    if (revalidated.cwd !== member.cwd) {
      controller.abort();
      return { error: new Error(`runCodexWave: process member ${JSON.stringify(member.id)} changed canonical cwd before spawn`) };
    }
    const call = codexExecCall({
      prompt: member.prompt,
      cwd: member.cwd,
      model: member.model,
      schemaPath: member.schemaPath,
      sandbox,
      approvalPolicy,
    });
    try {
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
      controller.abort();
      return { error };
    }
  });
  const failure = settled.find(row => row.error);
  if (failure) throw failure.error;
  return {
    mode: CODEX_EXEC_MODES.EXEC_PROCESS,
    isolation: "registered-linked-worktree",
    codexVersion: support.version,
    effectiveCeiling,
    results: settled.map(row => row.value),
  };
}

async function versionForMember(member, { catalogVersions, codexHome }) {
  const catalogVersion = catalogVersions
    ? catalogVersions[member.model]
    : await readCodexMultiAgentVersion(member.model, codexHome ? { dir: codexHome } : {});
  return resolveCodexMultiAgentVersion({ catalogVersion });
}

async function runAgentWave({
  members,
  catalogVersions,
  codexHome,
  dispatchAgent,
  waitForAgentBatch,
  packetOnly,
  effectiveCeiling,
}) {
  if (!packetOnly && typeof dispatchAgent !== "function") {
    throw new Error("runCodexWave: dispatchAgent is required for the spawn_agent lane");
  }
  const planned = await Promise.all(members.map(async member => {
    const version = await versionForMember(member, { catalogVersions, codexHome });
    const packet = codexSpawnAgentCall({
      taskId: member.id,
      message: member.prompt,
      agentType: member.agentType,
      version,
      ...(version === "v2" ? { forkTurns: member.forkTurns || "none" } : {}),
    });
    return { id: member.id, version, packet, member };
  }));
  const plannedBatches = [];
  for (let index = 0; index < planned.length; index += effectiveCeiling) {
    plannedBatches.push(planned.slice(index, index + effectiveCeiling));
  }
  if (packetOnly) {
    const batches = plannedBatches.map(batch => batch.map(({ member, ...row }) => ({
      ...row,
      result: { dispatchRequired: true },
    })));
    return {
      mode: CODEX_EXEC_MODES.SPAWN_AGENT,
      isolation: "context-only",
      effectiveCeiling,
      batches,
      results: batches.flat(),
    };
  }
  if (plannedBatches.length > 1 && typeof waitForAgentBatch !== "function") {
    throw new Error("runCodexWave: waitForAgentBatch is required when a spawn_agent wave exceeds the effective ceiling");
  }
  const batches = [];
  for (const [batchIndex, batch] of plannedBatches.entries()) {
    const dispatched = await Promise.all(batch.map(async row => ({
      id: row.id,
      version: row.version,
      packet: row.packet,
      result: await dispatchAgent(row.packet, row.member),
    })));
    batches.push(dispatched);
    if (typeof waitForAgentBatch === "function") await waitForAgentBatch(dispatched, batchIndex);
  }
  return {
    mode: CODEX_EXEC_MODES.SPAWN_AGENT,
    isolation: "context-only",
    effectiveCeiling,
    batches,
    results: batches.flat(),
  };
}

export async function runCodexWave({
  members,
  forceProcess = false,
  codexCommand = "codex",
  env = process.env,
  spawnProcess,
  sandbox = "workspace-write",
  approvalPolicy = "never",
  catalogVersions,
  codexHome,
  dispatchAgent,
  waitForAgentBatch,
  packetOnly = false,
  maxConcurrentThreadsPerSession,
  configuredThreadCeiling,
  availableThreadLimit,
  repositoryRoot,
  baseSha,
  workerTimeoutMs = CODEX_WAVE_LIMITS.workerTimeoutMs,
} = {}) {
  validateMembers(members);
  validateExecutionPolicy({ sandbox, approvalPolicy });
  if (!Number.isInteger(workerTimeoutMs) || workerTimeoutMs < 1 || workerTimeoutMs > CODEX_WAVE_LIMITS.workerTimeoutMs) {
    throw new Error(`runCodexWave: workerTimeoutMs must be an integer within 1..${CODEX_WAVE_LIMITS.workerTimeoutMs}`);
  }
  const effectiveCeiling = effectiveWaveCeiling(
    maxConcurrentThreadsPerSession,
    configuredThreadCeiling,
    availableThreadLimit,
  );
  const lane = resolveCodexDispatchLane({ members, forceProcess });
  if (lane.mode === CODEX_EXEC_MODES.EXEC_PROCESS) {
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
    });
  }
  return runAgentWave({
    members,
    catalogVersions,
    codexHome,
    dispatchAgent,
    waitForAgentBatch,
    packetOnly,
    effectiveCeiling,
  });
}
