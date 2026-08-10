import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);

/**
 * Read-only Orca context discovery.
 *
 * Contract assumptions are deliberately kept here beside the adapter:
 *
 * - The public CLI JSON boundary is the only Orca integration surface. The
 *   adapter never imports Orca code, opens its database, or speaks runtime RPC.
 * - `orca agent-context --json` is the pinned schema gate. Schema version 1 is
 *   the minimum contract for the commands used below; an unknown version is
 *   unavailable rather than guessed.
 * - `orca status --json` reports runtime reachability and runtimeId, while
 *   `orca worktree current --json` reports the current worktree's concrete id,
 *   repository id, path, branch, host, and optional base metadata.
 * - `orca terminal list --worktree <selector> --json` is observational only.
 *   A missing terminal is valid: a shell can be inside an Orca worktree without
 *   being an Orca-managed terminal.
 * - Worktree ids are the documented `<repo-id>::<absolute-runtime-path>` form.
 *   The resulting `remote_selector` is always explicit, so a local cwd alias
 *   is never sent to a remote runtime or treated as a remote identity.
 * - Environment variables are correlation hints only. CLI identity wins, and a
 *   conflicting Orca worktree env id fails closed instead of merging identities.
 *
 * The returned record is intentionally correlation metadata, not authority for
 * either Orca or Muster task state. All fields are bounded and raw CLI output
 * is never copied into the result.
 */

export const ORCA_CONTEXT_SCHEMA_VERSION = 1;
export const ORCA_AGENT_CONTEXT_SCHEMA_VERSION = 1;
export const ORCA_CONTEXT_COMMANDS = Object.freeze({
  schema: Object.freeze(["agent-context", "--json"]),
  status: Object.freeze(["status", "--json"]),
  worktree: Object.freeze(["worktree", "current", "--json"]),
  terminals: Object.freeze(["terminal", "list", "--worktree", "<selector>", "--json"]),
});

const DEFAULT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_BUFFER = 2 * 1024 * 1024;
const ABSOLUTE_PATH = /^(?:[A-Za-z]:[\\/]|\\\\|\/)/;

const REASON = Object.freeze({
  COMMAND_FAILED: "command-failed",
  IDENTITY_MISMATCH: "identity-mismatch",
  MALFORMED_RESPONSE: "malformed-response",
  ORCA_UNAVAILABLE: "orca-unavailable",
  RECONNECT: "reconnect",
  SCHEMA_VERSION: "schema-version",
});

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function firstString(...values) {
  for (const value of values) {
    const result = nonEmptyString(value);
    if (result !== null) return result;
  }
  return null;
}

function firstValue(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null) return value;
  }
  return null;
}

function boundedString(value, max = 512) {
  const result = nonEmptyString(value);
  return result === null ? null : result.slice(0, max);
}

function normalizeSharedPaths(worktree) {
  const raw = firstValue(worktree.sharedPaths, worktree.shared_paths, worktree.pathClasses);
  if (raw === null) return [];
  if (!Array.isArray(raw)) return null;
  const paths = [];
  for (const entry of raw) {
    if (typeof entry === "string") {
      const path = boundedString(entry, 1024);
      if (!path) return null;
      paths.push({ path, classification: "shared" });
      continue;
    }
    if (!isObject(entry)) return null;
    const path = boundedString(firstString(entry.path, entry.absolutePath, entry.name), 1024);
    const classification = boundedString(firstString(entry.classification, entry.kind, entry.type), 64);
    if (!path || !classification) return null;
    paths.push({
      path,
      classification,
      ...(boundedString(firstString(entry.owner, entry.ownerSystem), 128) ? {
        owner: boundedString(firstString(entry.owner, entry.ownerSystem), 128),
      } : {}),
      ...(boundedString(firstString(entry.source), 128) ? { source: boundedString(firstString(entry.source), 128) } : {}),
    });
  }
  return paths;
}

function normalizeSetupProvenance(worktree) {
  const raw = firstValue(worktree.setupProvenance, worktree.setup_provenance, worktree.setup);
  if (raw === null) return { source: "unknown", status: "unavailable" };
  if (!isObject(raw)) return null;
  const source = boundedString(firstString(raw.source, raw.owner, raw.provider, raw.by), 128);
  const status = boundedString(firstString(raw.status, raw.result), 64);
  if (!source || !status) return null;
  const setup = { source, status };
  const setupId = boundedString(firstString(raw.id, raw.setupId, raw.setup_id), 256);
  const version = boundedString(firstString(raw.version, raw.recipeVersion, raw.recipe_version), 128);
  if (setupId) setup.id = setupId;
  if (version) setup.version = version;
  if (Array.isArray(raw.steps)) {
    if (raw.steps.length > 128 || !raw.steps.every((step) => typeof step === "string" && step.trim())) return null;
    setup.steps = raw.steps.map((step) => step.trim().slice(0, 256));
  }
  return setup;
}

function normalizeLineage(worktree) {
  const raw = firstValue(worktree.lineage, worktree.worktreeLineage, worktree.worktree_lineage);
  const parentWorktreeId = firstString(
    raw && raw.parentWorktreeId,
    raw && raw.parent_worktree_id,
    worktree.parentWorktreeId,
    worktree.parent_id,
  );
  const parentInstanceId = firstString(
    raw && raw.parentWorktreeInstanceId,
    raw && raw.parent_instance_id,
    worktree.parentWorktreeInstanceId,
  );
  const origin = firstString(raw && raw.origin, worktree.origin);
  const relation = firstString(raw && raw.relation, worktree.relation);
  if (raw !== null && !isObject(raw)) return null;
  return {
    ...(parentWorktreeId ? { parent_worktree_id: parentWorktreeId } : {}),
    ...(parentInstanceId ? { parent_instance_id: parentInstanceId } : {}),
    ...(origin ? { origin } : {}),
    ...(relation ? { relation } : {}),
  };
}

function unavailable(reason, detail = null, diagnostics = []) {
  return {
    schemaVersion: ORCA_CONTEXT_SCHEMA_VERSION,
    available: false,
    availability: "unavailable",
    reason,
    detail: detail === null ? null : String(detail).slice(0, 240),
    diagnostics: diagnostics.slice(0, 8),
    context: null,
  };
}

function available(context, diagnostics = []) {
  return {
    schemaVersion: ORCA_CONTEXT_SCHEMA_VERSION,
    available: true,
    availability: "available",
    reason: null,
    detail: null,
    diagnostics: diagnostics.slice(0, 8),
    context,
  };
}

function parseJsonOutput(output, commandName) {
  let value = output;
  if (Buffer.isBuffer(value)) value = value.toString("utf8");
  if (typeof value === "string") {
    try {
      value = JSON.parse(value);
    } catch {
      throw new AdapterError(REASON.MALFORMED_RESPONSE, `${commandName} returned invalid JSON`);
    }
  }
  if (!isObject(value)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, `${commandName} returned a non-object JSON value`);
  }
  // Orca's public formatter wraps successful runtime results in { ok, result }.
  // Accepting an unwrapped result keeps the seam compatible with the documented
  // JSON payload when a fixture or future CLI emits the result directly.
  if (value.ok === false) {
    const error = isObject(value.error) ? value.error : {};
    const code = firstString(error.code, value.code);
    const message = firstString(error.message, value.message, `${commandName} failed`);
    throw new AdapterError(classifyCommandFailure(code, message), message);
  }
  if (value.result !== undefined) {
    if (!isObject(value.result)) {
      throw new AdapterError(REASON.MALFORMED_RESPONSE, `${commandName} result is not an object`);
    }
    return value.result;
  }
  return value;
}

class AdapterError extends Error {
  constructor(reason, message) {
    super(message);
    this.name = "OrcaContextAdapterError";
    this.reason = reason;
  }
}

function classifyCommandFailure(code, message) {
  const text = `${code ?? ""} ${message ?? ""}`.toLowerCase();
  if (/reconnect|stale|disconnected|connection|not.?reachable|runtime.?unavailable|not running/.test(text)) {
    return REASON.RECONNECT;
  }
  return REASON.COMMAND_FAILED;
}

function normalizeCommandError(error, commandName) {
  if (error instanceof AdapterError) return error;
  const code = firstString(error?.code, error?.cause?.code);
  const message = firstString(error?.message, `${commandName} failed`);
  return new AdapterError(classifyCommandFailure(code, message), message);
}

function unwrapStatus(payload) {
  if (!isObject(payload.runtime) || !isObject(payload.graph)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "status response is missing runtime or graph");
  }
  if (typeof payload.runtime.reachable !== "boolean" || typeof payload.runtime.state !== "string") {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "status runtime readiness fields are malformed");
  }
  return payload;
}

function validateAgentContext(payload) {
  const schemaVersion = payload.schemaVersion;
  if (schemaVersion !== ORCA_AGENT_CONTEXT_SCHEMA_VERSION) {
    throw new AdapterError(REASON.SCHEMA_VERSION, `unsupported Orca agent-context schema version: ${String(schemaVersion)}`);
  }
  if (!Number.isInteger(payload.commandCount) || !Array.isArray(payload.commands)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "agent-context response is missing command inventory");
  }
  if (payload.commandCount !== payload.commands.length) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "agent-context command count does not match inventory");
  }
  return payload;
}

function unwrapWorktree(payload) {
  const worktree = payload.worktree;
  if (!isObject(worktree)) throw new AdapterError(REASON.MALFORMED_RESPONSE, "worktree response is missing worktree");
  const id = firstString(worktree.id);
  const repoId = firstString(worktree.repoId, worktree.repositoryId, worktree.repo_id);
  const path = firstString(worktree.path, worktree.worktreePath, worktree.git?.path);
  const branch = firstString(worktree.branch, worktree.git?.branch);
  if (!id || !repoId || !path || !branch || !ABSOLUTE_PATH.test(path)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "worktree identity is incomplete or not an absolute runtime path");
  }
  // This is a shape check, not a parser for arbitrary future ids. The public
  // selector contract makes this exact prefix the safe minimum invariant.
  if (!id.startsWith(`${repoId}::`)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "worktree id does not contain its repository id");
  }
  return { worktree, id, repoId, path, branch };
}

function unwrapTerminals(payload) {
  if (!Array.isArray(payload.terminals)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "terminal list response is missing terminals");
  }
  return payload.terminals;
}

function hostIdentity(worktree, env) {
  const raw = firstString(
    worktree.executionHostId,
    worktree.hostId,
    worktree.connectionId,
    worktree.host,
    worktree.environmentId,
    env.ORCA_HOST_ID,
  );
  if (!raw || /^(local|localhost)$/i.test(raw)) return { host: "local", kind: "local" };
  const lower = raw.toLowerCase();
  if (lower.startsWith("ssh:") || lower === "ssh" || lower.includes("ssh")) {
    return { host: raw, kind: "ssh" };
  }
  if (lower.startsWith("runtime:") || lower.includes("server")) {
    return { host: raw, kind: "server" };
  }
  if (lower.startsWith("vm:") || lower.startsWith("cloud:") || lower.includes("vm") || lower.includes("cloud")) {
    return { host: raw, kind: "vm-cloud" };
  }
  return { host: raw, kind: "remote" };
}

function chooseTerminal(terminals, worktreeId, env) {
  const candidates = terminals.filter((terminal) => isObject(terminal)
    && firstString(terminal.worktreeId, terminal.worktree_id) === worktreeId);
  const requested = firstString(env.ORCA_TERMINAL_HANDLE);
  if (requested) return candidates.find((terminal) => terminal.handle === requested) ?? null;
  return candidates.find((terminal) => terminal.connected !== false) ?? candidates[0] ?? null;
}

function normalizeContext({ status, worktreeInfo, terminal, env, agentContext }) {
  const { worktree, id, repoId, path, branch } = worktreeInfo;
  const host = hostIdentity(worktree, env);
  const runtimeId = firstString(status.runtime.runtimeId, env.ORCA_RUNTIME_ID);
  const environmentId = firstString(
    worktree.runtimeOwnerEnvironmentId,
    worktree.environmentId,
    env.ORCA_ENVIRONMENT_ID,
    host.kind === "local" ? "local" : null,
  );
  const terminalHandle = firstString(env.ORCA_TERMINAL_HANDLE, terminal?.handle);
  const paneKey = firstString(env.ORCA_PANE_KEY, terminal?.paneKey, terminal?.pane_key);
  const sessionId = firstString(
    env.ORCA_SESSION_ID,
    env.ORCA_AGENT_SESSION_ID,
    terminal?.sessionId,
    terminal?.session_id,
  );
  const baseRef = firstString(worktree.baseRef, worktree.startFrom, worktree.baseBranch);
  const baseSha = firstString(worktree.baseSha, worktree.startSha, worktree.git?.baseSha);
  const headSha = firstString(worktree.git?.head, worktree.head, worktree.headSha);
  const sharedPaths = normalizeSharedPaths(worktree);
  const setupProvenance = normalizeSetupProvenance(worktree);
  const lineage = normalizeLineage(worktree);
  if (sharedPaths === null || setupProvenance === null || lineage === null) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "worktree topology metadata is malformed");
  }
  const remoteSelector = `id:${id}`;

  return {
    source: "orca-cli",
    orca_runtime_id: runtimeId,
    orca_repo_id: repoId,
    orca_worktree_id: id,
    worktree_path: path,
    branch,
    base_ref: baseRef,
    base_sha: baseSha,
    head_sha: headSha,
    shared_paths: sharedPaths,
    setup_provenance: setupProvenance,
    worktree_lineage: lineage,
    host: host.host,
    environment_id: environmentId,
    environment_kind: host.kind,
    terminal_handle: terminalHandle,
    pane_key: paneKey,
    session_id: sessionId,
    remote_selector: remoteSelector,
    runtime: {
      id: runtimeId,
      state: status.runtime.state,
      reachable: status.runtime.reachable,
      app_version: firstString(status.runtime.appVersion),
      agent_context_schema_version: agentContext.schemaVersion,
    },
    repository: {
      id: repoId,
      path: firstString(worktree.repoPath, worktree.repositoryPath),
    },
    worktree: {
      id,
      repository_id: repoId,
      path,
      branch,
      base_ref: baseRef,
      base_sha: baseSha,
      head_sha: headSha,
      parent_id: firstString(worktree.parentWorktreeId, worktree.parent_id),
      lineage,
      shared_paths: sharedPaths,
      setup_provenance: setupProvenance,
    },
    host_info: {
      id: host.host,
      kind: host.kind,
      runtime_id: runtimeId,
      environment_id: environmentId,
    },
    terminal: terminal ? {
      handle: terminalHandle,
      pane_key: paneKey,
      session_id: sessionId,
      connected: terminal.connected === true,
      ...(firstString(terminal.state, terminal.status) ? { state: firstString(terminal.state, terminal.status) } : {}),
      ...(typeof terminal.resumable === "boolean" ? { resumable: terminal.resumable } : {}),
      ...(firstString(terminal.restoredFrom, terminal.restored_from) ? {
        restored_from: firstString(terminal.restoredFrom, terminal.restored_from),
      } : {}),
      worktree_id: firstString(terminal.worktreeId, terminal.worktree_id),
    } : null,
    selector: {
      worktree: remoteSelector,
      repository: `id:${repoId}`,
    },
  };
}

function checkEnvironmentIdentity(worktreeId, env) {
  const observed = firstString(env.ORCA_WORKTREE_ID, env.ORCA_WORKSPACE_ID);
  if (!observed) return null;
  // ORCA_WORKSPACE_ID is usually the same selector as ORCA_WORKTREE_ID, but
  // some releases use a workspace key prefix. Only reject an explicit full id
  // that contradicts the CLI result; unknown forms remain observational hints.
  if (observed.includes("::") && observed !== worktreeId) {
    return new AdapterError(REASON.IDENTITY_MISMATCH, "Orca worktree environment id disagrees with CLI identity");
  }
  return null;
}

async function runCliCommand({ command, args, cwd, env, timeoutMs, execFile: execFileImpl, runCommand }) {
  if (typeof runCommand === "function") {
    return runCommand({ command, args: [...args], cwd, env });
  }
  return execFileImpl(command, args, {
    cwd,
    env,
    timeout: timeoutMs,
    maxBuffer: DEFAULT_MAX_BUFFER,
    windowsHide: true,
  });
}

/**
 * Discover the enclosing Orca context using only public CLI JSON commands.
 *
 * `runCommand` is an intentionally narrow test seam. It receives a command
 * name and argv, never a shell string, and should return `{ stdout }` or JSON.
 */
export async function discoverOrcaContext({
  command = "orca",
  cwd = process.cwd(),
  env = process.env,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  execFile: execFileImpl = execFile,
  runCommand,
} = {}) {
  const diagnostics = [];
  let agentContext;
  try {
    const raw = await runCliCommand({ command, args: ORCA_CONTEXT_COMMANDS.schema, cwd, env, timeoutMs, execFile: execFileImpl, runCommand });
    agentContext = validateAgentContext(parseJsonOutput(raw?.stdout ?? raw, "agent-context"));
  } catch (error) {
    const normalized = normalizeCommandError(error, "agent-context");
    return unavailable(normalized.reason, normalized.message);
  }

  let status;
  try {
    const raw = await runCliCommand({ command, args: ORCA_CONTEXT_COMMANDS.status, cwd, env, timeoutMs, execFile: execFileImpl, runCommand });
    status = unwrapStatus(parseJsonOutput(raw?.stdout ?? raw, "status"));
  } catch (error) {
    const normalized = normalizeCommandError(error, "status");
    return unavailable(normalized.reason, normalized.message);
  }
  if (!status.runtime.reachable || status.runtime.state !== "ready" || status.graph.state !== "ready") {
    const reconnecting = status.runtime.state === "stale_bootstrap" || status.graph.state === "reloading";
    const reason = reconnecting ? REASON.RECONNECT : REASON.ORCA_UNAVAILABLE;
    return unavailable(reason, `Orca runtime/graph is ${status.runtime.state}/${status.graph.state}`);
  }

  let worktreeInfo;
  try {
    const raw = await runCliCommand({ command, args: ORCA_CONTEXT_COMMANDS.worktree, cwd, env, timeoutMs, execFile: execFileImpl, runCommand });
    worktreeInfo = unwrapWorktree(parseJsonOutput(raw?.stdout ?? raw, "worktree current"));
  } catch (error) {
    const normalized = normalizeCommandError(error, "worktree current");
    return unavailable(normalized.reason, normalized.message);
  }
  const identityError = checkEnvironmentIdentity(worktreeInfo.id, env);
  if (identityError) return unavailable(identityError.reason, identityError.message);

  let terminals = [];
  try {
    const selector = `id:${worktreeInfo.id}`;
    const raw = await runCliCommand({
      command,
      args: ["terminal", "list", "--worktree", selector, "--json"],
      cwd,
      env,
      timeoutMs,
      execFile: execFileImpl,
      runCommand,
    });
    terminals = unwrapTerminals(parseJsonOutput(raw?.stdout ?? raw, "terminal list"));
  } catch (error) {
    const normalized = normalizeCommandError(error, "terminal list");
    // Terminal discovery is optional, but retain a bounded diagnostic. A
    // runtime failure here must not turn a valid worktree into a false identity.
    diagnostics.push(`${normalized.reason}: terminal list unavailable`);
  }

  const terminal = chooseTerminal(terminals, worktreeInfo.id, env);
  try {
    return available(normalizeContext({
      status,
      worktreeInfo,
      terminal,
      env,
      agentContext,
    }), diagnostics);
  } catch (error) {
    const normalized = normalizeCommandError(error, "worktree topology");
    return unavailable(normalized.reason, normalized.message, diagnostics);
  }
}

export const readOrcaContext = discoverOrcaContext;

export function normalizeOrcaContext({ status, worktree, terminals = [], env = process.env, agentContext = { schemaVersion: ORCA_AGENT_CONTEXT_SCHEMA_VERSION } }) {
  const normalizedStatus = unwrapStatus(status);
  const worktreeInfo = unwrapWorktree(worktree);
  const terminal = chooseTerminal(unwrapTerminals({ terminals }), worktreeInfo.id, env);
  return normalizeContext({ status: normalizedStatus, worktreeInfo, terminal, env, agentContext });
}

export function parseOrcaJsonResponse(output, commandName = "orca") {
  return parseJsonOutput(output, commandName);
}
