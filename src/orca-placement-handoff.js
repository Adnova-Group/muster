import {
  CAPABILITY_STATUSES,
  CAPABILITY_SURFACES,
  validateOrcaAgentCapabilityProbe,
} from "./orca-agent-capability-probe.js";
import {
  validateOrcaStatusBridge,
} from "./orca-status-bridge.js";
import {
  normalizeOrcaWorktreeMetadata,
} from "./orca-worktree-receipts.js";

// Placement is deliberately a separate, opt-in boundary.  In particular, this
// module does not create or derive Orca Run/Task/Dispatch IDs.  A host supplies
// the public-CLI worker operation (and an explicit ledger) when it chooses this
// workflow.  Preparation is pure; only start/cancel callbacks can mutate Orca.
export const ORCA_PLACEMENT_HANDOFF_SCHEMA_VERSION = 1;
export const ORCA_PLACEMENT_HANDOFF_STATES = Object.freeze([
  "prepared", "starting", "placed", "partial", "failed", "cancel-requested", "cancelled", "recovery-required",
]);
export const ORCA_PLACEMENT_TARGET_KINDS = Object.freeze(["terminal", "remote"]);
export const ORCA_PLACEMENT_OUTCOMES = Object.freeze([
  "created", "duplicate", "recovered", "cancelled", "recovery-required", "rejected",
]);

const MAX_TEXT = 512;
const MAX_ID = 256;
const SHA_RE = /^[0-9a-f]{40}$/;
const ATTEMPT_STATES = new Set(["pending", "ready", "in_flight", "running", "completed", "failed", "cancelled", "canceled", "blocked"]);
const TERMINAL_STATES = new Set(["connected", "attached", "ready", "running", "idle", "active"]);
const FINAL_STATES = new Set(["placed", "failed", "cancelled"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if (value === null || value === undefined) {
    if (optional) return null;
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError(`${label} must be a bounded string without control characters`);
  }
  return value.trim();
}

function optionalText(value, label, options = {}) {
  return text(value, label, { ...options, optional: true });
}

function clone(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function parseAttempt(attempt) {
  if (!isObject(attempt)) throw new TypeError("Muster attempt must be an object");
  const id = text(attempt.id ?? attempt.attemptId, "attempt.id", { max: MAX_ID });
  const taskId = text(attempt.task_id ?? attempt.taskId ?? attempt.item_id ?? attempt.itemId, "attempt.task_id", { max: MAX_ID });
  const number = attempt.number ?? attempt.attempt;
  if (!Number.isSafeInteger(number) || number < 1) throw new TypeError("attempt.number must be a positive safe integer");
  const state = optionalText(attempt.state ?? attempt.status, "attempt.state", { max: 64 });
  if (state !== null && !ATTEMPT_STATES.has(state)) throw new TypeError(`attempt.state is unsupported: ${state}`);
  const manifestVersion = text(attempt.manifest_version ?? attempt.manifestVersion, "attempt.manifest_version", { max: MAX_ID });
  const baseSha = text(attempt.base_sha ?? attempt.baseSha, "attempt.base_sha", { max: 64 });
  if (!SHA_RE.test(baseSha)) throw new TypeError("attempt.base_sha must be a lowercase 40-character Git SHA");
  return {
    id,
    task_id: taskId,
    number,
    state,
    manifest_version: manifestVersion,
    base_sha: baseSha,
  };
}

function sourceContext(input) {
  if (!isObject(input)) throw new TypeError("Orca context is required");
  if (input.available === false) throw new Error(`Orca context unavailable: ${optionalText(input.reason, "context.reason", { max: 64 }) ?? "unknown"}`);
  const context = isObject(input.context) ? input.context : input;
  const normalized = normalizeOrcaWorktreeMetadata(context);
  if (!normalized.ok) throw new Error(`Orca topology invalid: ${normalized.error}`);
  return normalized.metadata;
}

function parseCapability(capability) {
  const result = validateOrcaAgentCapabilityProbe(capability);
  if (!result.ok) throw new Error(`Orca capability contract invalid: ${result.errors.join("; ")}`);
  if (capability.available !== true) throw new Error(`Orca capability unavailable: ${capability.reason ?? "unknown"}`);
  for (const surface of CAPABILITY_SURFACES) {
    if (!CAPABILITY_STATUSES.includes(capability.capabilities[surface]?.status)) {
      throw new Error(`Orca capability ${surface} is outside the bounded status set`);
    }
  }
  if (capability.capabilities["working-directory"].status !== "SUPPORTED") {
    throw new Error("Orca working-directory capability must be SUPPORTED");
  }
  return {
    provider: optionalText(capability.provider, "capability.provider", { max: 128 }) ?? "unknown",
    profile: optionalText(capability.profile, "capability.profile", { max: 128 }) ?? "unknown",
    capabilities: Object.fromEntries(CAPABILITY_SURFACES.map((surface) => [surface, { ...capability.capabilities[surface] }])),
  };
}

function parseStatus(status, attempt) {
  const result = validateOrcaStatusBridge(status);
  if (!result.ok) throw new Error(`Orca status contract invalid: ${result.errors.join("; ")}`);
  if (status.readOnly !== true || status.availability !== "available") throw new Error("Orca status must be an available read-only observation");
  if (status.orca.lifecycle.state !== "ready") throw new Error(`Orca lifecycle is not ready: ${status.orca.lifecycle.state}`);
  const observedAttempt = status.muster?.attempt;
  if (observedAttempt?.id && observedAttempt.id !== attempt.id) throw new Error("Muster attempt identity does not match status observation");
  return {
    lifecycle: status.orca.lifecycle.state,
    terminal: status.orca.terminal,
    remote: status.orca.remote,
    attempt: observedAttempt ?? null,
  };
}

function parseTarget(target, context, status) {
  if (!isObject(target)) throw new TypeError("placement target is required");
  const kind = text(target.kind, "target.kind", { max: 32 });
  if (!ORCA_PLACEMENT_TARGET_KINDS.includes(kind)) throw new TypeError(`target.kind must be terminal or remote (got ${kind})`);
  const worktreeId = text(target.worktree_id ?? target.worktreeId ?? context.worktree_id, "target.worktree_id", { max: MAX_ID });
  if (worktreeId !== context.worktree_id) throw new Error("target worktree identity does not match Orca context");
  const remoteSelector = text(target.remote_selector ?? target.remoteSelector ?? context.remote_selector, "target.remote_selector", { max: 4096 });
  if (remoteSelector !== context.remote_selector) throw new Error("target remote selector does not match Orca context");
  if (kind === "terminal") {
    const handle = text(target.terminal_handle ?? target.terminalHandle ?? context.terminal?.handle ?? context.terminal_handle, "target.terminal_handle", { max: MAX_ID });
    const observed = status.terminal;
    if (observed?.handle && observed.handle !== handle) throw new Error("target terminal identity does not match status observation");
    if (observed?.connected !== true || (observed?.state && !TERMINAL_STATES.has(String(observed.state).toLowerCase()))) {
      throw new Error("target terminal is not connected and ready");
    }
    return { kind, worktree_id: worktreeId, terminal_handle: handle, remote_selector: remoteSelector };
  }
  if (context.host === "local" || context.environment_id === "local") throw new Error("remote placement requires a non-local Orca environment");
  return {
    kind,
    worktree_id: worktreeId,
    remote_selector: remoteSelector,
    host: text(target.host ?? context.host, "target.host", { max: MAX_ID }),
    environment_id: text(target.environment_id ?? target.environmentId ?? context.environment_id, "target.environment_id", { max: MAX_ID }),
  };
}

function keyFor(attemptId) {
  return `muster-attempt:${attemptId}`;
}

function recordShape(record) {
  if (!isObject(record)) throw new TypeError("placement record must be an object");
  const attemptId = text(record.attempt_id ?? record.attemptId, "record.attempt_id", { max: MAX_ID });
  const idempotencyKey = text(record.idempotency_key ?? record.idempotencyKey, "record.idempotency_key", { max: MAX_ID });
  const state = text(record.state, "record.state", { max: 64 });
  if (!ORCA_PLACEMENT_HANDOFF_STATES.includes(state)) throw new TypeError(`record.state is unsupported: ${state}`);
  return { ...clone(record), attempt_id: attemptId, idempotency_key: idempotencyKey, state };
}

/** An explicit in-memory ledger for tests/hosts; durable hosts can implement the same API. */
export function createOrcaPlacementLedger(initial = []) {
  const records = new Map();
  if (!Array.isArray(initial)) throw new TypeError("placement ledger initial value must be an array");
  for (const entry of initial) {
    const record = recordShape(entry);
    const key = keyFor(record.attempt_id);
    if (records.has(key)) throw new Error(`duplicate placement ledger record for ${record.attempt_id}`);
    records.set(key, record);
  }
  return Object.freeze({
    get(attemptId) {
      const id = text(attemptId, "attempt_id", { max: MAX_ID });
      return clone(records.get(keyFor(id))) ?? null;
    },
    put(record) {
      const normalized = recordShape(record);
      const key = keyFor(normalized.attempt_id);
      const previous = records.get(key);
      if (previous) {
        for (const field of ["attempt_id", "task_id", "idempotency_key", "target", "topology", "orca_mapping"]) {
          if (JSON.stringify(previous[field]) !== JSON.stringify(normalized[field])) {
            throw new Error(`conflicting placement record for ${normalized.attempt_id}`);
          }
        }
        for (const field of ["worker_id", "terminal_handle", "remote_selector"]) {
          if (previous[field] && normalized[field] && previous[field] !== normalized[field]) {
            throw new Error(`conflicting placement identity for ${normalized.attempt_id}`);
          }
        }
      }
      records.set(key, normalized);
      return clone(normalized);
    },
    values() { return [...records.values()].map(clone); },
  });
}

function requireLedger(ledger) {
  if (!ledger || typeof ledger.get !== "function" || typeof ledger.put !== "function") throw new TypeError("explicit placement ledger is required");
  return ledger;
}

function requestShape({ attempt, context, capability, status, target, optIn = false, priorAttemptId = null } = {}) {
  if (optIn !== true) throw new Error("placement handoff requires explicit optIn: true");
  const parsedAttempt = parseAttempt(attempt);
  const parsedContext = sourceContext(context);
  const parsedCapability = parseCapability(capability);
  const parsedStatus = parseStatus(status, parsedAttempt);
  const parsedTarget = parseTarget(target, parsedContext, parsedStatus);
  const prior = optionalText(priorAttemptId, "prior_attempt_id", { max: MAX_ID });
  if (prior === parsedAttempt.id) throw new Error("retry attempt must not reference itself as prior_attempt_id");
  return {
    schema_version: ORCA_PLACEMENT_HANDOFF_SCHEMA_VERSION,
    opt_in: true,
    attempt: parsedAttempt,
    attempt_id: parsedAttempt.id,
    task_id: parsedAttempt.task_id,
    idempotency_key: keyFor(parsedAttempt.id),
    prior_attempt_id: prior,
    target: parsedTarget,
    topology: {
      runtime_id: parsedContext.runtime_id,
      repo_id: parsedContext.repo_id,
      worktree_id: parsedContext.worktree_id,
      worktree_path: parsedContext.worktree_path,
      branch: parsedContext.branch,
      base_sha: parsedContext.base_sha,
      host: parsedContext.host,
      environment_id: parsedContext.environment_id,
      environment_kind: parsedContext.environment_kind,
      remote_selector: parsedContext.remote_selector,
    },
    capability: parsedCapability,
    observation: parsedStatus,
    context: clone(parsedContext),
    status: clone(status),
    capability_probe: clone(capability),
    orca_mapping: { run_id: null, task_id: null, dispatch_id: null },
  };
}

export function prepareOrcaPlacementHandoff(options = {}) {
  return requestShape(options);
}

export function validateOrcaPlacementRequest(request) {
  try {
    if (!isObject(request)) throw new TypeError("placement request must be an object");
    if (request.schema_version === ORCA_PLACEMENT_HANDOFF_SCHEMA_VERSION && request.context && request.status && request.capability_probe) {
      const normalized = requestShape({
        attempt: request.attempt,
        context: request.context,
        capability: request.capability_probe,
        status: request.status,
        target: request.target,
        optIn: request.opt_in,
        priorAttemptId: request.prior_attempt_id,
      });
      if (request.attempt_id !== normalized.attempt_id) throw new Error("request.attempt_id disagrees with attempt.id");
      if (request.idempotency_key !== normalized.idempotency_key) throw new Error("request.idempotency_key is not canonical");
      if (request.task_id !== normalized.task_id) throw new Error("request.task_id disagrees with attempt.task_id");
      if (request.orca_mapping?.run_id !== null || request.orca_mapping?.task_id !== null || request.orca_mapping?.dispatch_id !== null) {
        throw new Error("Orca Run/Task/Dispatch mapping must remain null by default");
      }
      return { ok: true, errors: [], request: normalized };
    }
    const normalized = requestShape({
      attempt: request.attempt,
      context: request.context ?? request.topology,
      capability: request.capability,
      status: request.status ?? request.observation,
      target: request.target,
      optIn: request.opt_in ?? request.optIn,
      priorAttemptId: request.prior_attempt_id ?? request.priorAttemptId,
    });
    if (request.attempt_id && request.attempt_id !== normalized.attempt_id) throw new Error("request.attempt_id disagrees with attempt.id");
    if (request.idempotency_key && request.idempotency_key !== normalized.idempotency_key) throw new Error("request.idempotency_key is not canonical");
    return { ok: true, errors: [], request: normalized };
  } catch (error) {
    return { ok: false, errors: [error.message] };
  }
}

function callbackResult(raw, operation) {
  if (!isObject(raw)) throw new Error(`Orca ${operation} callback must return an object`);
  const ok = raw.ok === true;
  const workerId = optionalText(raw.worker_id ?? raw.workerId ?? raw.placement?.worker_id ?? raw.placement?.workerId, `${operation}.worker_id`, { max: MAX_ID });
  const terminalHandle = optionalText(raw.terminal_handle ?? raw.terminalHandle ?? raw.placement?.terminal_handle ?? raw.placement?.terminalHandle, `${operation}.terminal_handle`, { max: MAX_ID });
  const remoteSelector = optionalText(raw.remote_selector ?? raw.remoteSelector ?? raw.placement?.remote_selector, `${operation}.remote_selector`, { max: 4096 });
  return { ok, worker_id: workerId, terminal_handle: terminalHandle, remote_selector: remoteSelector, error: optionalText(raw.error, `${operation}.error`, { max: MAX_TEXT }) };
}

function placementIdentityMatches(result, request) {
  if (result.terminal_handle && request.target.kind === "terminal" && result.terminal_handle !== request.target.terminal_handle) return false;
  if (result.remote_selector && result.remote_selector !== request.target.remote_selector) return false;
  return true;
}

function baseRecord(request, state, extra = {}) {
  return {
    schema_version: ORCA_PLACEMENT_HANDOFF_SCHEMA_VERSION,
    attempt_id: request.attempt_id,
    task_id: request.task_id,
    idempotency_key: request.idempotency_key,
    state,
    target: clone(request.target),
    topology: clone(request.topology),
    orca_mapping: { run_id: null, task_id: null, dispatch_id: null },
    ...extra,
  };
}

function priorRecordForRetry(request, ledger) {
  if (!request.prior_attempt_id) return null;
  const prior = ledger.get(request.prior_attempt_id);
  if (!prior) throw new Error(`prior attempt placement record is unavailable: ${request.prior_attempt_id}`);
  if (!["failed", "cancelled", "recovery-required"].includes(prior.state)) throw new Error("retry prior attempt is not terminal or recovery-fenced");
  return prior;
}

function recordMatchesRequest(record, request) {
  return record.task_id === request.task_id
    && record.idempotency_key === request.idempotency_key
    && JSON.stringify(record.target) === JSON.stringify(request.target)
    && JSON.stringify(record.topology) === JSON.stringify(request.topology);
}

/**
 * Start exactly one worker for a prepared attempt. `startWorker` is the host's
 * explicit public-CLI operation; it receives no Orca Task/Run/Dispatch ID.
 */
export async function startOrcaPlacementHandoff({ request, ledger, startWorker } = {}) {
  const checked = validateOrcaPlacementRequest(request);
  if (!checked.ok) return { outcome: "rejected", ok: false, errors: checked.errors };
  const normalized = checked.request;
  const store = requireLedger(ledger);
  const previous = store.get(normalized.attempt_id);
  if (previous) {
    if (!recordMatchesRequest(previous, normalized)) return { outcome: "rejected", ok: false, errors: ["placement request identity conflicts with the existing attempt"] };
    return { outcome: "duplicate", ok: true, record: previous };
  }
  try {
    priorRecordForRetry(normalized, store);
  } catch (error) {
    return { outcome: "rejected", ok: false, errors: [error.message] };
  }
  if (typeof startWorker !== "function") return { outcome: "rejected", ok: false, errors: ["explicit startWorker callback is required"] };
  const starting = store.put(baseRecord(normalized, "starting"));
  try {
    const result = callbackResult(await startWorker({
      request: clone(normalized),
      argv: ["orchestration", "worker-start", "--agent", normalized.capability.profile, "--json"],
    }), "startWorker");
    if (!placementIdentityMatches(result, normalized)) {
      const record = store.put(baseRecord(normalized, "recovery-required", { error: "worker placement identity disagrees with the requested target" }));
      return { outcome: "recovery-required", ok: false, record };
    }
    if (result.ok === true) {
      const record = store.put(baseRecord(normalized, "placed", {
        worker_id: result.worker_id,
        terminal_handle: result.terminal_handle ?? normalized.target.terminal_handle ?? null,
        remote_selector: result.remote_selector ?? normalized.target.remote_selector,
      }));
      return { outcome: "created", ok: true, record };
    }
    const partial = Boolean(result.worker_id || result.terminal_handle || result.remote_selector);
    const record = store.put(baseRecord(normalized, partial ? "recovery-required" : "failed", {
      ...(result.worker_id ? { worker_id: result.worker_id } : {}),
      ...(result.terminal_handle ? { terminal_handle: result.terminal_handle } : {}),
      ...(result.remote_selector ? { remote_selector: result.remote_selector } : {}),
      ...(result.error ? { error: result.error } : {}),
    }));
    return { outcome: partial ? "recovery-required" : "recovery-required", ok: false, record, started: partial };
  } catch (error) {
    const record = store.put(baseRecord(normalized, "recovery-required", { error: text(error.message ?? error, "startWorker error") }));
    return { outcome: "recovery-required", ok: false, record, started: true };
  }
}

export const handoffMusterAttemptToOrca = startOrcaPlacementHandoff;
export const requestOrcaPlacementHandoff = prepareOrcaPlacementHandoff;

export async function recoverOrcaPlacementHandoff({ request, ledger, observed } = {}) {
  const checked = validateOrcaPlacementRequest(request);
  if (!checked.ok) return { outcome: "rejected", ok: false, errors: checked.errors };
  const normalized = checked.request;
  const store = requireLedger(ledger);
  const previous = store.get(normalized.attempt_id);
  if (!previous || !["starting", "partial", "recovery-required"].includes(previous.state)) return { outcome: "rejected", ok: false, errors: ["attempt is not recoverable"] };
  if (!recordMatchesRequest(previous, normalized)) return { outcome: "rejected", ok: false, errors: ["recovery request identity conflicts with the existing attempt"] };
  const result = callbackResult(observed, "recovery");
  if (!result.ok || !result.worker_id || !placementIdentityMatches(result, normalized)) {
    return { outcome: "recovery-required", ok: false, record: previous, errors: ["recovery observation is incomplete or has conflicting identity"] };
  }
  const record = { ...previous, state: "placed", worker_id: result.worker_id, terminal_handle: result.terminal_handle ?? previous.terminal_handle ?? null, remote_selector: result.remote_selector ?? previous.remote_selector ?? normalized.target.remote_selector };
  delete record.error;
  const canonical = store.put(record);
  return { outcome: "recovered", ok: true, record: canonical };
}

export async function cancelOrcaPlacementHandoff({ request, ledger, cancelWorker } = {}) {
  const checked = validateOrcaPlacementRequest(request);
  if (!checked.ok) return { outcome: "rejected", ok: false, errors: checked.errors };
  const normalized = checked.request;
  const store = requireLedger(ledger);
  const previous = store.get(normalized.attempt_id);
  if (!previous) return { outcome: "rejected", ok: false, errors: ["attempt has no placement record"] };
  if (!recordMatchesRequest(previous, normalized)) return { outcome: "rejected", ok: false, errors: ["cancellation request identity conflicts with the existing attempt"] };
  if (previous.state === "cancelled") return { outcome: "duplicate", ok: true, record: previous };
  if (previous.state === "cancel-requested") return { outcome: "duplicate", ok: true, record: previous };
  if (previous.state === "failed") return { outcome: "rejected", ok: false, errors: ["failed attempt has no live placement to cancel"], record: previous };
  if (typeof cancelWorker !== "function") return { outcome: "rejected", ok: false, errors: ["explicit cancelWorker callback is required"] };
  const workerId = previous.worker_id;
  if (!workerId) return { outcome: "recovery-required", ok: false, record: store.put({ ...previous, state: "recovery-required", error: "cannot cancel without a worker identity" }) };
  store.put({ ...previous, state: "cancel-requested" });
  try {
    const result = callbackResult(await cancelWorker({ request: clone(normalized), worker_id: workerId }), "cancelWorker");
    if (result.ok !== true) return { outcome: "recovery-required", ok: false, record: store.put({ ...previous, state: "recovery-required", error: result.error ?? "worker cancellation was not confirmed" }) };
    return { outcome: "cancelled", ok: true, record: store.put({ ...previous, state: "cancelled", cancelled_worker_id: workerId }) };
  } catch (error) {
    return { outcome: "recovery-required", ok: false, record: store.put({ ...previous, state: "recovery-required", error: text(error.message ?? error, "cancelWorker error") }) };
  }
}

export function validateOrcaPlacementRecord(record) {
  const errors = [];
  try {
    const normalized = recordShape(record);
    if (normalized.schema_version !== ORCA_PLACEMENT_HANDOFF_SCHEMA_VERSION) errors.push("unsupported placement schema_version");
    if (normalized.task_id === undefined) errors.push("record.task_id is required");
    if (!isObject(normalized.orca_mapping)
      || normalized.orca_mapping.run_id !== null
      || normalized.orca_mapping.task_id !== null
      || normalized.orca_mapping.dispatch_id !== null) {
      errors.push("Orca Run/Task/Dispatch mapping must remain null by default");
    }
    if (!normalized.target || !ORCA_PLACEMENT_TARGET_KINDS.includes(normalized.target.kind)) errors.push("record.target.kind is invalid");
  } catch (error) {
    errors.push(error.message);
  }
  return { ok: errors.length === 0, errors };
}

export function placementHandoffIsFinal(record) {
  return isObject(record) && FINAL_STATES.has(record.state);
}
