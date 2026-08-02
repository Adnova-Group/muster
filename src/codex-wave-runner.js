import { spawn } from "node:child_process";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
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

const REQUIRED_EXEC_FEATURES = Object.freeze([
  "--json",
  "--ignore-user-config",
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

export function parseCodexVersion(text) {
  const match = String(text || "").match(/\b(\d+)\.(\d+)\.(\d+)\b/);
  if (!match) throw new Error(`unsupported Codex version: could not parse ${JSON.stringify(String(text || "").trim())}`);
  return match.slice(1).map(Number);
}

function runProcess(command, argv, { cwd, env, spawnProcess = spawn } = {}) {
  return new Promise((resolveProcess, reject) => {
    const child = spawnProcess(command, argv, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolveProcess({
      code: Number.isInteger(code) ? code : 1,
      signal,
      stdout,
      stderr,
    }));
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

export function parseCodexTurnUsage(stdout) {
  for (const line of String(stdout || "").split(/\r?\n/).filter(Boolean)) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event?.type === "turn.completed" && event.usage && typeof event.usage === "object") return event.usage;
  }
  return UNKNOWN_CODEX_USAGE;
}

function validateMembers(members) {
  if (!Array.isArray(members) || members.length === 0) throw new Error("runCodexWave: members must be a non-empty array");
  const ids = new Set();
  for (const member of members) {
    if (!member || typeof member.id !== "string" || !member.id.trim()) throw new Error("runCodexWave: every member requires a non-empty id");
    if (ids.has(member.id)) throw new Error(`runCodexWave: duplicate member id ${JSON.stringify(member.id)}`);
    ids.add(member.id);
    if (typeof member.prompt !== "string" || !member.prompt.trim()) throw new Error(`runCodexWave: member ${JSON.stringify(member.id)} requires a prompt`);
  }
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

async function validateRegisteredLinkedWorktree(member) {
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
    if (commonDir === gitDir) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} points at the base checkout, not an isolated linked worktree`);
    }
    const registry = await gitText(canonical, ["worktree", "list", "--porcelain", "-z"]);
    const registered = await Promise.all(worktreePaths(registry).map(async path => {
      try { return await realpath(resolve(path)); } catch { return null; }
    }));
    if (!registered.includes(canonical)) {
      throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} is not a registered linked git worktree: ${JSON.stringify(canonical)}`);
    }
    return { ...member, cwd: canonical };
  } catch (error) {
    if (error.message?.startsWith("runCodexWave:")) throw error;
    throw new Error(`runCodexWave: process member ${JSON.stringify(member.id)} is not a registered linked git worktree: ${JSON.stringify(canonical)}`);
  }
}

async function runProcessWave({ members, codexCommand, env, spawnProcess, sandbox, approvalPolicy }) {
  // All path checks complete before the first Codex support probe or worker process.
  const canonicalMembers = await Promise.all(members.map(validateRegisteredLinkedWorktree));
  const seen = new Map();
  for (const member of canonicalMembers) {
    const prior = seen.get(member.cwd);
    if (prior) throw new Error(`runCodexWave: process members ${JSON.stringify(prior)} and ${JSON.stringify(member.id)} resolve to the same canonical cwd ${JSON.stringify(member.cwd)}`);
    seen.set(member.cwd, member.id);
  }

  const support = await assertCodexProcessSupport({ command: codexCommand, env, spawnProcess });
  const settled = await Promise.all(canonicalMembers.map(async member => {
    const call = codexExecCall({
      prompt: member.prompt,
      cwd: member.cwd,
      model: member.model,
      schemaPath: member.schemaPath,
      lastMessagePath: member.lastMessagePath,
      sandbox,
      approvalPolicy,
    });
    try {
      const result = await runProcess(codexCommand, call.argv, { cwd: member.cwd, env, spawnProcess });
      const verdict = interpretCodexExecExit(result.code);
      if (!verdict.ok) {
        const error = new Error(`Codex process for wave member ${JSON.stringify(member.id)} exited ${result.code}: ${result.stderr.trim() || verdict.reason}`);
        error.code = result.code;
        error.memberId = member.id;
        return { error };
      }
      return { value: { id: member.id, usage: parseCodexTurnUsage(result.stdout), stdout: result.stdout, stderr: result.stderr } };
    } catch (error) {
      return { error };
    }
  }));
  const failure = settled.find(row => row.error);
  if (failure) throw failure.error;
  return {
    mode: CODEX_EXEC_MODES.EXEC_PROCESS,
    isolation: "registered-linked-worktree",
    codexVersion: support.version,
    results: settled.map(row => row.value),
  };
}

async function versionForMember(member, { catalogVersions, codexHome }) {
  const catalogVersion = catalogVersions
    ? catalogVersions[member.model]
    : await readCodexMultiAgentVersion(member.model, codexHome ? { dir: codexHome } : {});
  return resolveCodexMultiAgentVersion({ catalogVersion });
}

async function runAgentWave({ members, catalogVersions, codexHome, dispatchAgent }) {
  if (typeof dispatchAgent !== "function") throw new Error("runCodexWave: dispatchAgent is required for the spawn_agent lane");
  const results = await Promise.all(members.map(async member => {
    const version = await versionForMember(member, { catalogVersions, codexHome });
    const packet = codexSpawnAgentCall({
      taskId: member.id,
      message: member.prompt,
      agentType: member.agentType,
      version,
      forkTurns: member.forkTurns || "none",
    });
    return { id: member.id, version, packet, result: await dispatchAgent(packet, member) };
  }));
  return { mode: CODEX_EXEC_MODES.SPAWN_AGENT, isolation: "context-only", results };
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
} = {}) {
  validateMembers(members);
  const lane = resolveCodexDispatchLane({ members, forceProcess });
  if (lane.mode === CODEX_EXEC_MODES.EXEC_PROCESS) {
    return runProcessWave({ members, codexCommand, env, spawnProcess, sandbox, approvalPolicy });
  }
  return runAgentWave({ members, catalogVersions, codexHome, dispatchAgent });
}
