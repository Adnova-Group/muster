import { execFile as execFileCallback } from "node:child_process";
import { promisify } from "node:util";

import {
  canonicalOrcaSelector,
  isCanonicalRuntimePath,
  isOrcaSharedClassification,
  worktreeIdBelongsToRepository,
} from "./orca-contract.js";

const execFile = promisify(execFileCallback);

/**
 * Read-only Orca context discovery.
 *
 * Contract assumptions are deliberately kept here beside the adapter:
 *
 * - The public CLI JSON boundary is the only Orca integration surface. The
 *   adapter never imports Orca code, opens its database, or speaks runtime RPC.
 * - `orca agent-context --json` is a best-effort schema probe, not a gate. It
 *   is absent from Orca's public CLI reference, so an Orca build without it --
 *   or a future build that renames it -- must not make Muster blind to a
 *   runtime that `status` and `worktree current` can still describe. Those two
 *   are the bootstrap probes the integration strategy actually names. Schema
 *   version 1 is the pinned MINIMUM; a lower or non-integer version is an
 *   incompatibility and fails closed, a higher one is recorded and accepted
 *   because every command used here is read-only.
 * - `orca status --json` reports runtime reachability and runtimeId, while
 *   `orca worktree current --json` reports the current worktree's concrete id,
 *   repository id, path, branch, host, and optional base metadata. Only
 *   `runtime` is treated as required: no public Orca document specifies the
 *   response shape, so any further field is optional evidence rather than a
 *   precondition invented by this adapter.
 * - A worktree path may be POSIX, a Windows drive path, or a UNC path, because
 *   Orca ships macOS, Windows, and Linux builds. The shared contract module
 *   owns that predicate so downstream receipt and cleanup code cannot narrow it.
 * - `orca terminal list --worktree <selector> --json` is observational only.
 *   A missing terminal is valid: a shell can be inside an Orca worktree without
 *   being an Orca-managed terminal.
 * - Worktree ids are the documented `<repo-id>::<absolute-runtime-path>` form.
 *   The resulting `remote_selector` is always explicit, so a local cwd alias
 *   is never sent to a remote runtime or treated as a remote identity.
 * - Environment variables are correlation hints only. CLI identity wins, and a
 *   conflicting Orca worktree env id fails closed instead of merging identities.
 *   The set below was captured from inside a live Orca-launched terminal; names
 *   that were previously guessed and do not exist are gone. Two of the real
 *   variables -- ORCA_AGENT_HOOK_TOKEN and ORCA_AGENT_LAUNCH_TOKEN -- are
 *   secrets and are never read, recorded, or echoed by this module.
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
const READY_RUNTIME_STATES = new Set(["ready"]);
const RECONNECTING_STATES = new Set(["stale_bootstrap", "reloading", "reconnecting", "restoring"]);

/**
 * Verified against a live Orca-launched terminal (1.4.177, WSL host).
 * `observed` names were present; `tolerated` names were not and are read only as
 * optional fallbacks for hosts this capture could not cover. `secret` names are
 * present and must never leave this process.
 */
export const ORCA_ENVIRONMENT = Object.freeze({
  observed: Object.freeze([
    "ORCA_WORKTREE_ID", "ORCA_TERMINAL_HANDLE", "ORCA_PANE_KEY", "ORCA_TAB_ID",
    "ORCA_CLI_COMMAND", "ORCA_USER_DATA_PATH", "ORCA_CODEX_HOME",
    "ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID",
    "ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND",
    "ORCA_ORCHESTRATION_COMPATIBILITY_HOST_INCARNATION",
    "ORCA_AGENT_HOOK_ENDPOINT", "ORCA_AGENT_HOOK_ENV", "ORCA_AGENT_HOOK_PORT",
    "ORCA_AGENT_HOOK_VERSION",
  ]),
  tolerated: Object.freeze([
    "ORCA_RUNTIME_ID", "ORCA_ENVIRONMENT_ID", "ORCA_SESSION_ID",
    "ORCA_AGENT_SESSION_ID", "ORCA_AGENT_PROFILE", "ORCA_AGENT_PROVIDER",
  ]),
  secret: Object.freeze(["ORCA_AGENT_HOOK_TOKEN", "ORCA_AGENT_LAUNCH_TOKEN"]),
});

/** A live ORCA_PANE_KEY is `<tabId>:<leafId>`, matching the visual layout tree. */
function panePartsFromKey(paneKey) {
  if (typeof paneKey !== "string") return null;
  const [tabId, leafId] = paneKey.split(":");
  return tabId && leafId ? { tabId, leafId } : null;
}

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
    const reported = boundedString(firstString(entry.classification, entry.kind, entry.type), 64);
    if (!path || !reported) return null;
    // Orca's own vocabulary is not Muster's. An unrecognized value is recorded
    // as `unknown` -- falling back to the raw term as `source` when Orca did not
    // supply one -- so a future Orca classification cannot make an otherwise
    // valid context unusable downstream.
    const classification = isOrcaSharedClassification(reported) ? reported : "unknown";
    const source = boundedString(firstString(entry.source), 128)
      ?? (classification === "unknown" ? reported : null);
    paths.push({
      path,
      classification,
      ...(boundedString(firstString(entry.owner, entry.ownerSystem), 128) ? {
        owner: boundedString(firstString(entry.owner, entry.ownerSystem), 128),
      } : {}),
      ...(source ? { source } : {}),
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
  if (!isObject(payload.runtime)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "status response is missing runtime");
  }
  if (typeof payload.runtime.reachable !== "boolean" || typeof payload.runtime.state !== "string") {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "status runtime readiness fields are malformed");
  }
  // `graph` is an observed field in some builds, not a documented one. Require
  // its shape only when it is present, and never require its presence.
  if (payload.graph !== undefined && payload.graph !== null && !isObject(payload.graph)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "status graph field is malformed");
  }
  return payload;
}

/** The readiness verdict, kept in one place so the vocabulary is auditable. */
function statusReadiness(status) {
  const runtimeState = status.runtime.state;
  const graphState = isObject(status.graph) && typeof status.graph.state === "string"
    ? status.graph.state
    : null;
  if (status.runtime.reachable && READY_RUNTIME_STATES.has(runtimeState)
    && (graphState === null || READY_RUNTIME_STATES.has(graphState))) {
    return {
      ready: true,
      diagnostics: graphState === null ? ["status response did not report a graph state"] : [],
    };
  }
  const reconnecting = RECONNECTING_STATES.has(runtimeState)
    || (graphState !== null && RECONNECTING_STATES.has(graphState));
  return {
    ready: false,
    reason: reconnecting ? REASON.RECONNECT : REASON.ORCA_UNAVAILABLE,
    detail: `Orca runtime/graph is ${runtimeState}/${graphState ?? "unreported"}`,
    diagnostics: [],
  };
}

function validateAgentContext(payload) {
  const schemaVersion = payload.schemaVersion;
  if (!Number.isInteger(schemaVersion) || schemaVersion < ORCA_AGENT_CONTEXT_SCHEMA_VERSION) {
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
  if (!id || !repoId || !path || !branch || !isCanonicalRuntimePath(path)) {
    throw new AdapterError(REASON.MALFORMED_RESPONSE, "worktree identity is incomplete or not an absolute runtime path");
  }
  if (!worktreeIdBelongsToRepository(id, repoId)) {
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
    // The real variable, verified in a live terminal. `ORCA_HOST_ID` was a guess
    // and does not exist.
    env.ORCA_ORCHESTRATION_COMPATIBILITY_HOST_ID,
  );
  // Orca reports a WSL checkout as host `local` with kind `wsl`: the runtime is
  // the local desktop, but the filesystem is reached over UNC. Treating it as
  // remote would force a server-side selector Orca does not want here.
  const declaredKind = firstString(env.ORCA_ORCHESTRATION_COMPATIBILITY_HOST_KIND);
  if (!raw || /^(local|localhost)$/i.test(raw)) {
    return { host: "local", kind: declaredKind === "wsl" ? "wsl" : "local" };
  }
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
  // Environment identity tracks the HOST, not the kind: a WSL checkout is still
  // hosted locally, so it keeps the `local` environment sentinel that the
  // receipt and cleanup invariants pair with a `local` host.
  const environmentId = firstString(
    worktree.runtimeOwnerEnvironmentId,
    worktree.environmentId,
    env.ORCA_ENVIRONMENT_ID,
    host.host === "local" ? "local" : null,
  );
  const terminalHandle = firstString(env.ORCA_TERMINAL_HANDLE, terminal?.handle);
  // A live terminal record has no `paneKey`. It has `tabId` and `leafId`, and a
  // live ORCA_PANE_KEY is exactly `<tabId>:<leafId>` -- so the pane key is
  // derivable from the record rather than dependent on an environment variable.
  const derivedPaneKey = terminal?.tabId && terminal?.leafId
    ? `${terminal.tabId}:${terminal.leafId}`
    : null;
  const paneKey = firstString(env.ORCA_PANE_KEY, terminal?.paneKey, terminal?.pane_key, derivedPaneKey);
  const paneParts = panePartsFromKey(paneKey);
  const tabId = firstString(env.ORCA_TAB_ID, terminal?.tabId, paneParts?.tabId);
  const leafId = firstString(terminal?.leafId, paneParts?.leafId);
  // No live terminal record exposes a provider session id, and no ORCA_SESSION_ID
  // exists in a launched terminal. This stays null rather than pretending.
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
  const remoteSelector = canonicalOrcaSelector(id);

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
    // Orca marks the repository's primary checkout; downstream guards need it,
    // because a primary checkout is never a disposable worker worktree.
    is_main_worktree: worktree.isMainWorktree === true || worktree.git?.isMainWorktree === true,
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
      agent_context_schema_version: Number.isInteger(agentContext?.schemaVersion) ? agentContext.schemaVersion : null,
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
      // Real fields on a live `terminal list` record. `orphaned` is Orca's
      // actual detached-PTY signal; `incarnationId` changes across a runtime
      // restart and is what a reacquired handle must be compared against.
      ...(firstString(terminal.tabId) ? { tab_id: tabId } : {}),
      ...(firstString(terminal.leafId) ? { leaf_id: leafId } : {}),
      ...(firstString(terminal.ptyId) ? { pty_id: firstString(terminal.ptyId) } : {}),
      ...(firstString(terminal.incarnationId) ? { incarnation_id: firstString(terminal.incarnationId) } : {}),
      ...(typeof terminal.orphaned === "boolean" ? { orphaned: terminal.orphaned } : {}),
      ...(typeof terminal.writable === "boolean" ? { writable: terminal.writable } : {}),
      // Retained as optional: no observed record carries these, but a hibernating
      // or restoring runtime may add them and they must not be silently dropped.
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
  // `agent-context` is a capability probe, not a gate. An Orca build that does
  // not ship it still has a discoverable runtime; only an explicitly
  // INCOMPATIBLE reported schema stops the adapter.
  let agentContext = { schemaVersion: null };
  try {
    const raw = await runCliCommand({ command, args: ORCA_CONTEXT_COMMANDS.schema, cwd, env, timeoutMs, execFile: execFileImpl, runCommand });
    agentContext = validateAgentContext(parseJsonOutput(raw?.stdout ?? raw, "agent-context"));
  } catch (error) {
    const normalized = normalizeCommandError(error, "agent-context");
    if (normalized.reason === REASON.SCHEMA_VERSION) return unavailable(normalized.reason, normalized.message);
    diagnostics.push(`${normalized.reason}: agent-context schema probe unavailable`);
  }

  let status;
  try {
    const raw = await runCliCommand({ command, args: ORCA_CONTEXT_COMMANDS.status, cwd, env, timeoutMs, execFile: execFileImpl, runCommand });
    status = unwrapStatus(parseJsonOutput(raw?.stdout ?? raw, "status"));
  } catch (error) {
    const normalized = normalizeCommandError(error, "status");
    return unavailable(normalized.reason, normalized.message);
  }
  const readiness = statusReadiness(status);
  if (!readiness.ready) return unavailable(readiness.reason, readiness.detail, diagnostics);
  diagnostics.push(...readiness.diagnostics);

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
    const selector = canonicalOrcaSelector(worktreeInfo.id);
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

export function normalizeOrcaContext({ status, worktree, terminals = [], env = process.env, agentContext = { schemaVersion: null } }) {
  const normalizedStatus = unwrapStatus(status);
  const worktreeInfo = unwrapWorktree(worktree);
  const terminal = chooseTerminal(unwrapTerminals({ terminals }), worktreeInfo.id, env);
  return normalizeContext({ status: normalizedStatus, worktreeInfo, terminal, env, agentContext });
}

export function parseOrcaJsonResponse(output, commandName = "orca") {
  return parseJsonOutput(output, commandName);
}
