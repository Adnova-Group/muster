import {
  discoverOrcaContext,
} from "./orca-context-adapter.js";
import {
  CAPABILITY_STATUSES,
  CAPABILITY_SURFACES,
  UNKNOWN,
  orcaHibernationEligibility,
  probeOrcaAgentCapabilities,
} from "./orca-agent-capability-probe.js";
import {
  compareOrcaWorktreeIdentity,
  normalizeOrcaWorktreeMetadata,
} from "./orca-worktree-receipts.js";

// This is a projection boundary, not a second lifecycle authority.  It joins
// already-owned Muster receipts with observations from Orca's public JSON
// surfaces.  No function in this module creates, updates, resumes, closes, or
// sends to an Orca resource, and no function changes a Muster graph or receipt.
export const ORCA_STATUS_BRIDGE_SCHEMA_VERSION = 1;
export const ORCA_BRIDGE_UNKNOWN = UNKNOWN;
export const ORCA_BRIDGE_LIFECYCLE_STATES = Object.freeze([
  "ready", "hibernated", "restoring", "reconnecting", "unavailable", "unknown",
]);
export const ORCA_BRIDGE_AVAILABILITIES = Object.freeze(["available", "unavailable"]);

const MAX_TEXT = 240;
const MAX_DIAGNOSTICS = 8;
const UNKNOWN_STATUS = "UNKNOWN";
const CAPABILITY_UNKNOWN = Object.freeze(Object.fromEntries(
  CAPABILITY_SURFACES.map((surface) => [surface, { status: UNKNOWN_STATUS, evidence: "unverified" }]),
));

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, fallback = null, max = MAX_TEXT) {
  if (typeof value !== "string" || !value.trim() || /[\u0000-\u001f\u007f-\u009f]/.test(value)) return fallback;
  return value.trim().slice(0, max);
}

function value(...values) {
  for (const candidate of values) {
    if (candidate !== undefined && candidate !== null) return candidate;
  }
  return null;
}

function object(...values) {
  return values.find(isObject) ?? {};
}

function statusRecord(status = UNKNOWN_STATUS, evidence = "unverified") {
  const normalized = CAPABILITY_STATUSES.includes(status) ? status : UNKNOWN_STATUS;
  return { status: normalized, evidence: text(evidence, "unverified") };
}

function unknownStatus(evidence = "unverified") {
  return { status: UNKNOWN_STATUS, evidence: text(evidence, "unverified") };
}

function sanitizeStatus(valueToRead, evidence) {
  if (typeof valueToRead === "string") return statusRecord(valueToRead, evidence);
  if (isObject(valueToRead)) return statusRecord(valueToRead.status, valueToRead.evidence ?? evidence);
  return unknownStatus(evidence);
}

function sanitizeCapability(probe) {
  const raw = isObject(probe) ? probe : {};
  const capabilities = {};
  for (const surface of CAPABILITY_SURFACES) {
    capabilities[surface] = sanitizeStatus(raw.capabilities?.[surface], "provider capability was not observed");
  }
  const available = raw.available === true;
  return {
    available,
    availability: available ? "available" : "unavailable",
    reason: text(raw.reason, available ? null : "orca-unavailable"),
    provider: text(raw.provider, "unknown"),
    profile: text(raw.profile, "unknown"),
    capabilities,
    // Hooks are a first-class bridge observation because a missing provider
    // hook must not be mistaken for a passing Muster gate.
    provider_hook: capabilities.hooks,
  };
}

function normalizeMusterState(input) {
  const source = object(input);
  const nested = object(source.muster, source.musterState, source.state);
  const explicitItemId = text(value(source.itemId, nested.itemId));
  const item = object(source.item, nested.item,
    explicitItemId && isObject(source.items) ? source.items[explicitItemId] : null);
  const attempt = object(source.attempt, nested.attempt);
  const gate = object(source.gate, nested.gate, source.reviewGate, nested.reviewGate, source.review, nested.review);
  const receipt = object(source.receipt, nested.receipt, source.lifecycleReceipt, nested.lifecycleReceipt);
  const itemId = text(value(item.id, item.itemId, source.itemId, nested.itemId));
  const attemptId = text(value(attempt.id, attempt.attemptId, source.attemptId, nested.attemptId));
  const receiptId = text(value(receipt.id, receipt.receiptId, source.receiptId, nested.receiptId));
  const phase = text(value(receipt.phase, attempt.phase, source.phase, nested.phase));
  const attemptNumber = value(attempt.number, attempt.attempt, receipt.attempt, source.attempt);
  const normalizedAttemptNumber = Number.isSafeInteger(attemptNumber) && attemptNumber > 0 ? attemptNumber : null;
  const copy = (raw, keys) => {
    const result = {};
    for (const [name, aliases] of Object.entries(keys)) {
      const candidate = text(value(...aliases.map((alias) => raw[alias])));
      if (candidate !== null) result[name] = candidate;
    }
    return result;
  };
  return {
    item: { id: itemId, state: text(value(item.state, item.status, source.itemState, nested.itemState), UNKNOWN_STATUS) },
    attempt: {
      id: attemptId,
      number: normalizedAttemptNumber,
      phase,
      state: text(value(attempt.state, attempt.status, source.attemptState, nested.attemptState), UNKNOWN_STATUS),
    },
    gate: {
      id: text(value(gate.id, gate.gateId)),
      state: text(value(gate.state, gate.status), UNKNOWN_STATUS),
      verdict: text(value(gate.verdict, gate.result, gate.decision), UNKNOWN_STATUS),
    },
    receipt: {
      id: receiptId,
      phase,
      attempt: normalizedAttemptNumber,
      state: text(value(receipt.state, receipt.status), UNKNOWN_STATUS),
      status: text(value(receipt.status, receipt.state), UNKNOWN_STATUS),
      terminalReason: text(value(receipt.terminalReason, receipt.terminal_reason)),
      candidateSha: text(value(receipt.candidateSha, receipt.candidate_sha), null, 128),
    },
    // Preserve only explicitly bounded, useful state fields from the source;
    // arbitrary provider/task payloads must never cross this bridge.
    bindings: {
      ...copy(source, { run_id: ["runId", "run_id"], manifest_version: ["manifestVersion", "manifest_version"] }),
      ...copy(nested, { run_id: ["runId", "run_id"], manifest_version: ["manifestVersion", "manifest_version"] }),
    },
  };
}

function contextEnvelope(input) {
  if (!isObject(input)) return { available: false, reason: "orca-unavailable", detail: "context was not supplied", context: null };
  if (input.available === false) {
    return {
      available: false,
      reason: text(input.reason, "orca-unavailable"),
      detail: text(input.detail),
      context: null,
    };
  }
  const context = isObject(input.context) ? input.context : input;
  return { available: true, reason: null, detail: null, context };
}

function normalizeTopology(context, topologyReceipt) {
  const candidate = context?.available ? context.context : topologyReceipt;
  if (!candidate) return { ok: false, metadata: null, error: "Orca topology was not observed" };
  return normalizeOrcaWorktreeMetadata(candidate);
}

function classifyLifecycle({ context, topology, capabilities }) {
  if (!context.available) {
    if (context.reason === "reconnect") return "reconnecting";
    return "unavailable";
  }
  if (!topology.ok) return "unavailable";
  const terminal = topology.metadata.terminal ?? {};
  const terminalState = text(terminal.state, "").toLowerCase();
  if (["restoring", "restore", "reattaching", "reattach"].includes(terminalState)) return "restoring";
  if (["hibernated", "hibernate", "suspended"].includes(terminalState)) return "hibernated";
  if (terminal.restored_from || ["restored", "resumed", "reconnected"].includes(terminalState)) return "ready";
  // Whether a disconnected terminal is hibernated is Orca's decision, not the
  // provider CLI's. Orca hibernates only the providers it lists as eligible and
  // leaves every other terminal running, so a provider's own resume support
  // says nothing about which of the two happened here.
  if (terminal.connected === false) {
    return orcaHibernationEligibility(capabilities.provider) === "eligible" ? "hibernated" : "unknown";
  }
  return "ready";
}

function lifecycleEvidence(state, context, topology) {
  if (state === "reconnecting") return "Orca public status reports a reconnecting runtime";
  if (state === "unavailable") return context.detail || topology.error || "Orca lifecycle is unavailable";
  if (state === "hibernated") return "Orca terminal is hibernated; no live terminal or session handle is claimed";
  if (state === "restoring") return "Orca terminal restore is in progress";
  if (state === "ready") return "Orca runtime and worktree are available through public JSON CLI surfaces";
  return "Orca lifecycle state was not exposed by the public adapter";
}

function buildOrcaProjection({ context, topology, capabilities, lifecycle }) {
  const metadata = topology.ok ? topology.metadata : null;
  const terminal = metadata?.terminal ?? {};
  const remote = metadata ? {
    status: lifecycle === "reconnecting" ? "reconnecting" : metadata.host === "local" ? "local" : "remote",
    lifecycle,
    runtime_id: metadata.runtime_id,
    host: metadata.host,
    environment_id: metadata.environment_id,
    environment_kind: metadata.environment_kind,
    remote_selector: metadata.remote_selector,
  } : {
    status: lifecycle === "reconnecting" ? "reconnecting" : UNKNOWN_STATUS,
    lifecycle,
    runtime_id: null,
    host: null,
    environment_id: null,
    environment_kind: null,
    remote_selector: null,
  };
  const terminalStatus = lifecycle === "hibernated" ? "hibernated"
    : lifecycle === "reconnecting" ? "reconnecting"
      : lifecycle === "restoring" ? "restoring"
        : metadata?.terminal?.connected === true ? "connected"
          : metadata ? UNKNOWN_STATUS : UNKNOWN_STATUS;
  const sessionStatus = lifecycle === "hibernated" ? "hibernated"
    : lifecycle === "reconnecting" ? "reconnecting"
      : terminalStatus === "connected" ? "attached" : UNKNOWN_STATUS;
  return {
    lifecycle: {
      state: lifecycle,
      availability: context.available && topology.ok ? "available" : "unavailable",
      evidence: lifecycleEvidence(lifecycle, context, topology),
    },
    worktree: metadata ? {
      status: context.available ? "present" : UNKNOWN_STATUS,
      id: metadata.worktree_id,
      repository_id: metadata.repo_id,
      path: metadata.worktree_path,
      branch: metadata.branch,
      base_ref: metadata.base_ref,
      base_sha: metadata.base_sha,
      lineage: metadata.lineage,
    } : {
      status: UNKNOWN_STATUS,
      id: null,
      repository_id: null,
      path: null,
      branch: null,
      base_ref: null,
      base_sha: null,
      lineage: {},
    },
    terminal: {
      status: terminalStatus,
      handle: terminal.handle ?? null,
      pane_key: terminal.pane_key ?? null,
      connected: typeof terminal.connected === "boolean" ? terminal.connected : null,
      state: terminal.state ?? null,
      resumable: typeof terminal.resumable === "boolean" ? terminal.resumable : null,
      restored_from: terminal.restored_from ?? null,
    },
    session: {
      status: sessionStatus,
      id: terminal.session_id ?? null,
      restored_from: terminal.restored_from ?? null,
    },
    remote,
    capabilities: capabilities.capabilities,
    capability_probe: {
      available: capabilities.available,
      availability: capabilities.availability,
      reason: capabilities.reason,
      provider: capabilities.provider,
      profile: capabilities.profile,
    },
    provider_hook: capabilities.provider_hook,
  };
}

/**
 * Build a read-only correlation projection from already-observed records.
 * `context` may be the adapter's result envelope, while `topologyReceipt` is
 * an optional previously recorded Orca topology receipt used during restore.
 */
export function buildOrcaStatusBridge({
  muster,
  musterState,
  status,
  context,
  contextResult,
  topologyReceipt,
  capability,
  capabilityProbe,
} = {}) {
  const musterProjection = normalizeMusterState(musterState ?? muster ?? status ?? {});
  const contextState = contextEnvelope(contextResult ?? context);
  const topology = normalizeTopology(contextState, topologyReceipt);
  const capabilities = sanitizeCapability(capabilityProbe ?? capability);
  const lifecycle = classifyLifecycle({ context: contextState, topology, capabilities });
  const orca = buildOrcaProjection({ context: contextState, topology, capabilities, lifecycle });
  const identity = contextState.available && topologyReceipt && topology.ok
    ? compareOrcaWorktreeIdentity(contextState.context, topologyReceipt)
    : null;
  const correlation = identity
    ? identity.ok ? { status: "matched", mismatches: [] } : { status: "mismatch", mismatches: identity.mismatches }
    : contextState.available || topology.ok ? { status: "observed", mismatches: [] } : { status: UNKNOWN_STATUS, mismatches: [] };
  return {
    schemaVersion: ORCA_STATUS_BRIDGE_SCHEMA_VERSION,
    readOnly: true,
    availability: orca.lifecycle.availability,
    reason: contextState.available ? (topology.ok ? null : "malformed-context") : contextState.reason,
    diagnostics: [
      ...(!contextState.available && contextState.detail ? [contextState.detail] : []),
      ...(!topology.ok && contextState.available ? [topology.error] : []),
    ].filter(Boolean).slice(0, MAX_DIAGNOSTICS),
    muster: musterProjection,
    orca,
    correlation,
  };
}

/** Discover context and capabilities, then return the same pure projection. */
export async function readOrcaStatusBridge({
  profile,
  profileFixture,
  env = process.env,
  contextOptions = {},
  contextResult,
  muster,
  musterState,
  status,
  topologyReceipt,
} = {}) {
  const context = contextResult ?? await discoverOrcaContext({ ...contextOptions, env });
  const capability = await probeOrcaAgentCapabilities({
    profile,
    profileFixture,
    env,
    contextResult: context,
  });
  return buildOrcaStatusBridge({
    muster,
    musterState,
    status,
    context,
    topologyReceipt,
    capabilityProbe: capability,
  });
}

export const discoverOrcaStatusBridge = readOrcaStatusBridge;
export const bridgeOrcaStatus = buildOrcaStatusBridge;

export function validateOrcaStatusBridge(result) {
  const errors = [];
  if (!isObject(result)) return { ok: false, errors: ["bridge result must be an object"] };
  if (result.schemaVersion !== ORCA_STATUS_BRIDGE_SCHEMA_VERSION) errors.push("unsupported bridge schemaVersion");
  if (result.readOnly !== true) errors.push("readOnly must be true");
  if (!ORCA_BRIDGE_AVAILABILITIES.includes(result.availability)) errors.push("availability is invalid");
  if (!isObject(result.muster) || !isObject(result.orca)) errors.push("muster and orca projections are required");
  if (!isObject(result.orca?.lifecycle) || !ORCA_BRIDGE_LIFECYCLE_STATES.includes(result.orca.lifecycle.state)) {
    errors.push("orca.lifecycle.state is invalid");
  }
  if (!isObject(result.orca?.capabilities)) errors.push("orca.capabilities is required");
  else for (const surface of CAPABILITY_SURFACES) {
    if (!isObject(result.orca.capabilities[surface]) || !CAPABILITY_STATUSES.includes(result.orca.capabilities[surface].status)) {
      errors.push(`orca.capabilities.${surface}.status is outside the bounded status set`);
    }
  }
  return { ok: errors.length === 0, errors };
}
