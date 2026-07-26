import { spawn } from "node:child_process";
import { realpath } from "node:fs/promises";
import { readCodexMultiAgentVersion } from "./codex-inventory.js";
import {
  CODEX_EXEC_MODES,
  codexExecCall,
  codexSpawnAgentCall,
  interpretCodexExecExit,
  resolveCodexDispatchLane,
  resolveCodexMultiAgentVersion,
} from "./wave-dispatch.js";

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
  return new Promise((resolve, reject) => {
    const child = spawnProcess(command, argv, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", chunk => { stdout += chunk; });
    child.stderr?.on("data", chunk => { stderr += chunk; });
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code: Number.isInteger(code) ? code : 1,
      signal,
      stdout,
      stderr,
    }));
  });
}

async function assertCodexProcessSupport({ command, env, spawnProcess }) {
  const versionResult = await runProcess(command, ["--version"], { env, spawnProcess });
  if (versionResult.code !== 0) {
    const error = new Error(`Codex version probe exited ${versionResult.code}: ${versionResult.stderr.trim() || "no stderr"}`);
    error.code = versionResult.code;
    throw error;
  }
  const version = parseCodexVersion(versionResult.stdout);
  if (compareVersion(version, MIN_CODEX_WAVE_VERSION) < 0) {
    throw new Error(
      `unsupported Codex version ${version.join(".")}; hermetic wave dispatch requires ${MIN_CODEX_WAVE_VERSION.join(".")} or newer`,
    );
  }

  const rootHelpResult = await runProcess(command, ["--help"], { env, spawnProcess });
  if (rootHelpResult.code !== 0) {
    const error = new Error(`Codex root feature probe exited ${rootHelpResult.code}: ${rootHelpResult.stderr.trim() || "no stderr"}`);
    error.code = rootHelpResult.code;
    throw error;
  }
  for (const feature of REQUIRED_ROOT_FEATURES) {
    if (!rootHelpResult.stdout.includes(feature)) {
      throw new Error(`unsupported Codex root feature: ${feature} is required for hermetic wave dispatch`);
    }
  }

  const helpResult = await runProcess(command, ["exec", "--help"], { env, spawnProcess });
  if (helpResult.code !== 0) {
    const error = new Error(`Codex exec feature probe exited ${helpResult.code}: ${helpResult.stderr.trim() || "no stderr"}`);
    error.code = helpResult.code;
    throw error;
  }
  for (const feature of REQUIRED_EXEC_FEATURES) {
    if (!helpResult.stdout.includes(feature)) {
      throw new Error(`unsupported Codex exec feature: ${feature} is required for hermetic wave dispatch`);
    }
  }
  return { version: version.join(".") };
}

export function parseCodexTurnUsage(stdout) {
  let completed = false;
  for (const line of String(stdout || "").split(/\r?\n/).filter(Boolean)) {
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    if (event?.type !== "turn.completed") continue;
    completed = true;
    if (event.usage && typeof event.usage === "object") return event.usage;
  }
  return completed ? UNKNOWN_CODEX_USAGE : UNKNOWN_CODEX_USAGE;
}

function validateMembers(members) {
  if (!Array.isArray(members) || members.length === 0) {
    throw new Error("runCodexWave: members must be a non-empty array");
  }
  const ids = new Set();
  for (const member of members) {
    if (!member || typeof member.id !== "string" || !member.id.trim()) {
      throw new Error("runCodexWave: every member requires a non-empty id");
    }
    if (ids.has(member.id)) throw new Error(`runCodexWave: duplicate member id "${member.id}"`);
    ids.add(member.id);
    if (typeof member.prompt !== "string" || !member.prompt.trim()) {
      throw new Error(`runCodexWave: member "${member.id}" requires a prompt`);
    }
  }
}

async function runProcessWave({
  members,
  codexCommand,
  env,
  spawnProcess,
  sandbox,
  approvalPolicy,
}) {
  const canonicalMembers = await Promise.all(members.map(async member => {
    if (typeof member.cwd !== "string" || !member.cwd) {
      throw new Error(`runCodexWave: process member "${member.id}" requires an isolated cwd`);
    }
    return { ...member, cwd: await realpath(member.cwd) };
  }));
  const seenCwds = new Map();
  for (const member of canonicalMembers) {
    const prior = seenCwds.get(member.cwd);
    if (prior) {
      throw new Error(
        `runCodexWave: process members "${prior}" and "${member.id}" resolve to the same canonical cwd ${JSON.stringify(member.cwd)}`,
      );
    }
    seenCwds.set(member.cwd, member.id);
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
      const processResult = await runProcess(call.command === "codex" ? codexCommand : call.command, call.argv, {
        cwd: member.cwd,
        env,
        spawnProcess,
      });
      const verdict = interpretCodexExecExit(processResult.code);
      if (!verdict.ok) {
        const error = new Error(
          `Codex process for wave member "${member.id}" exited ${processResult.code}: ` +
          `${processResult.stderr.trim() || verdict.reason}`,
        );
        error.code = processResult.code;
        error.memberId = member.id;
        return { member, error };
      }
      return {
        member,
        value: {
          id: member.id,
          usage: parseCodexTurnUsage(processResult.stdout),
          stdout: processResult.stdout,
          stderr: processResult.stderr,
        },
      };
    } catch (error) {
      return { member, error };
    }
  }));
  const failure = settled.find(row => row.error);
  if (failure) throw failure.error;
  return {
    mode: CODEX_EXEC_MODES.EXEC_PROCESS,
    isolation: "process-cwd",
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
  if (typeof dispatchAgent !== "function") {
    throw new Error("runCodexWave: dispatchAgent is required for the spawn_agent lane");
  }
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
  return {
    mode: CODEX_EXEC_MODES.SPAWN_AGENT,
    isolation: "context-only",
    results,
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
} = {}) {
  validateMembers(members);
  const lane = resolveCodexDispatchLane({ members, forceProcess });
  if (lane.mode === CODEX_EXEC_MODES.EXEC_PROCESS) {
    return runProcessWave({
      members,
      codexCommand,
      env,
      spawnProcess,
      sandbox,
      approvalPolicy,
    });
  }
  return runAgentWave({ members, catalogVersions, codexHome, dispatchAgent });
}
