import { discoverOrcaContext } from "./orca-context-adapter.js";
import {
  ORCA_SHARED_CLASSIFICATIONS,
  isAcceptedOrcaSelector,
  isCanonicalRuntimePath,
  worktreeIdBelongsToRepository,
} from "./orca-contract.js";

// Public, versioned metadata carried by a Muster manifest or lifecycle receipt.
// This module deliberately accepts only the normalized output of the read-only
// Orca adapter (or a record with the same public JSON shape). It never invokes
// Orca and never reads Orca's internal state.
export const ORCA_WORKTREE_METADATA_SCHEMA_VERSION = 1;
export const ORCA_WORKTREE_RECEIPT_SCHEMA_VERSION = 1;
export const ORCA_IDENTITY_MISMATCH_REASON = "identity-mismatch";

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_STRING = 1024;
const MAX_PATH = 4096;
const SHARED_CLASSIFICATIONS = new Set(ORCA_SHARED_CLASSIFICATIONS);
const SETUP_STATUSES = new Set(["ready", "completed", "partial", "failed", "unavailable", "unknown"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function string(value, label, { optional = false, max = MAX_STRING } = {}) {
  if (value === null || value === undefined) {
    if (optional) return null;
    throw new TypeError(`${label} must be a non-empty string`);
  }
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError(`${label} must be a bounded string without control characters`);
  }
  return value.trim();
}

function optionalString(value, label, options = {}) {
  return string(value, label, { ...options, optional: true });
}

function sourceContext(input) {
  if (!isObject(input)) throw new TypeError("Orca context must be an object");
  if (input.available === false) {
    const reason = input.reason || "unavailable";
    throw new Error(`Orca context unavailable: ${reason}`);
  }
  const context = isObject(input.context) ? input.context : input;
  if (!isObject(context)) throw new TypeError("Orca context payload must be an object");
  return context;
}

function rawField(context, ...names) {
  for (const name of names) {
    if (context[name] !== undefined && context[name] !== null) return context[name];
  }
  return null;
}

function normalizeLineage(context) {
  const raw = rawField(context, "worktree_lineage", "lineage", "worktreeLineage");
  if (raw === null) return {};
  if (!isObject(raw)) throw new TypeError("orca worktree lineage must be an object");
  const result = {};
  const parent = rawField(raw, "parent_worktree_id", "parentWorktreeId", "parent_id");
  const instance = rawField(raw, "parent_instance_id", "parentWorktreeInstanceId", "parent_worktree_instance_id");
  const origin = rawField(raw, "origin");
  const relation = rawField(raw, "relation");
  if (parent !== null) result.parent_worktree_id = string(parent, "orca lineage parent_worktree_id");
  if (instance !== null) result.parent_instance_id = string(instance, "orca lineage parent_instance_id");
  if (origin !== null) result.origin = string(origin, "orca lineage origin");
  if (relation !== null) result.relation = string(relation, "orca lineage relation");
  return result;
}

function normalizeSharedPaths(context) {
  const raw = rawField(context, "shared_paths", "sharedPaths");
  if (raw === null) return [];
  if (!Array.isArray(raw) || raw.length > 256) throw new TypeError("orca shared_paths must be an array of at most 256 entries");
  return raw.map((entry, index) => {
    if (typeof entry === "string") {
      return { path: string(entry, `orca shared_paths[${index}].path`, { max: MAX_PATH }), classification: "shared" };
    }
    if (!isObject(entry)) throw new TypeError(`orca shared_paths[${index}] must be an object`);
    const path = string(rawField(entry, "path", "absolute_path", "absolutePath"), `orca shared_paths[${index}].path`, { max: MAX_PATH });
    const classification = string(rawField(entry, "classification", "kind", "type"), `orca shared_paths[${index}].classification`);
    if (!SHARED_CLASSIFICATIONS.has(classification)) {
      throw new TypeError(`orca shared_paths[${index}].classification must be a supported classification`);
    }
    const result = { path, classification };
    const owner = rawField(entry, "owner", "owner_system");
    const source = rawField(entry, "source");
    if (owner !== null) result.owner = string(owner, `orca shared_paths[${index}].owner`);
    if (source !== null) result.source = string(source, `orca shared_paths[${index}].source`);
    return result;
  });
}

function normalizeSetup(context) {
  const raw = rawField(context, "setup_provenance", "setupProvenance", "setup");
  if (raw === null) return { source: "unknown", status: "unavailable" };
  if (!isObject(raw)) throw new TypeError("orca setup_provenance must be an object");
  const source = string(rawField(raw, "source", "owner", "provider", "by"), "orca setup_provenance.source");
  const status = string(rawField(raw, "status", "result"), "orca setup_provenance.status");
  if (!SETUP_STATUSES.has(status)) throw new TypeError("orca setup_provenance.status is not supported");
  const result = { source, status };
  const id = rawField(raw, "id", "setup_id", "setupId");
  const version = rawField(raw, "version", "recipe_version", "recipeVersion");
  if (id !== null) result.id = string(id, "orca setup_provenance.id");
  if (version !== null) result.version = string(version, "orca setup_provenance.version");
  if (raw.steps !== undefined) {
    if (!Array.isArray(raw.steps) || raw.steps.length > 128) throw new TypeError("orca setup_provenance.steps is invalid");
    result.steps = raw.steps.map((step, index) => string(step, `orca setup_provenance.steps[${index}]`, { max: 256 }));
  }
  return result;
}

function normalizeTerminal(context) {
  const raw = rawField(context, "terminal");
  const handle = optionalString(rawField(context, "terminal_handle") ?? (isObject(raw) ? rawField(raw, "handle") : null), "orca terminal_handle");
  const pane = optionalString(rawField(context, "pane_key") ?? (isObject(raw) ? rawField(raw, "pane_key", "paneKey") : null), "orca pane_key");
  const session = optionalString(rawField(context, "session_id") ?? (isObject(raw) ? rawField(raw, "session_id", "sessionId") : null), "orca session_id");
  const connected = isObject(raw) && typeof raw.connected === "boolean" ? raw.connected : handle !== null;
  const state = optionalString(rawField(context, "terminal_state") ?? (isObject(raw) ? rawField(raw, "state") : null), "orca terminal state");
  const result = { handle, pane_key: pane, session_id: session, connected };
  if (state !== null) result.state = state;
  if (isObject(raw) && typeof raw.resumable === "boolean") result.resumable = raw.resumable;
  const restoredFrom = isObject(raw) ? rawField(raw, "restored_from", "restoredFrom") : null;
  if (restoredFrom !== null) result.restored_from = string(restoredFrom, "orca terminal restored_from");
  return result;
}

function normalizeTopology(context) {
  const worktree = isObject(context.worktree) ? context.worktree : {};
  const repository = isObject(context.repository) ? context.repository : {};
  const runtime = isObject(context.runtime) ? context.runtime : {};
  const hostInfo = isObject(context.host_info) ? context.host_info : {};
  const selector = isObject(context.selector) ? context.selector : {};
  const baseRevision = isObject(context.base_revision) ? context.base_revision : {};
  const host = isObject(context.host) ? context.host : {};
  const environment = isObject(context.environment) ? context.environment : {};
  const worktreeId = string(rawField(context, "orca_worktree_id", "worktree_id") ?? rawField(worktree, "id", "worktree_id"), "orca_worktree_id");
  const repoId = string(rawField(context, "orca_repo_id", "repo_id", "repository_id") ?? rawField(repository, "id", "repository_id") ?? rawField(worktree, "repository_id"), "orca_repo_id");
  const path = string(rawField(context, "worktree_path", "path") ?? rawField(worktree, "path"), "worktree_path", { max: MAX_PATH });
  if (!isCanonicalRuntimePath(path)) throw new TypeError("worktree_path must be an absolute normalized path");
  const branch = string(rawField(context, "branch", "branch_name") ?? rawField(worktree, "branch", "branch_name"), "branch");
  const baseRef = optionalString(rawField(context, "base_ref", "base_branch", "start_from") ?? rawField(baseRevision, "ref", "base_ref") ?? rawField(worktree, "base_ref"), "base_ref");
  // Orca's start-from picker accepts a branch, a remote branch, or a specific
  // commit SHA, so a worktree need not expose a base SHA at all. Recording the
  // identity must not depend on one; the merge-gate cleanup evaluator requires
  // it separately, because a merge disposition genuinely cannot do without it.
  const baseSha = optionalString(rawField(context, "base_sha", "base_revision_sha", "start_sha") ?? rawField(baseRevision, "sha", "base_sha") ?? rawField(worktree, "base_sha"), "base_sha");
  if (baseSha !== null && !SHA_RE.test(baseSha)) throw new TypeError("base_sha must be a lowercase 40-character Git SHA");
  const runtimeId = string(rawField(context, "orca_runtime_id", "runtime_id") ?? rawField(runtime, "id", "runtime_id"), "orca_runtime_id");
  const hostValue = typeof context.host === "string" ? context.host : null;
  const hostId = string(rawField(context, "host_id") ?? hostValue ?? rawField(host, "id", "host_id") ?? rawField(hostInfo, "id", "host_id"), "host");
  const environmentId = string(rawField(context, "environment_id") ?? rawField(environment, "id", "environment_id") ?? rawField(hostInfo, "environment_id"), "environment_id");
  const environmentKind = string(rawField(context, "environment_kind", "host_kind") ?? rawField(host, "kind", "environment_kind") ?? rawField(hostInfo, "kind", "environment_kind"), "environment_kind");
  const remoteSelector = string(rawField(context, "remote_selector") ?? rawField(selector, "worktree"), "remote_selector");
  const headSha = optionalString(rawField(context, "head_sha", "worktree_head_sha") ?? rawField(worktree, "head_sha"), "head_sha");
  const repositoryPath = optionalString(rawField(context, "repository_path") ?? rawField(repository, "path"), "repository_path", { max: MAX_PATH });
  const topology = {
    schema_version: ORCA_WORKTREE_METADATA_SCHEMA_VERSION,
    runtime_id: runtimeId,
    runtime: { id: runtimeId },
    repo_id: repoId,
    repository: { id: repoId, path: repositoryPath },
    worktree_id: worktreeId,
    worktree_path: path,
    branch,
    base_ref: baseRef,
    base_sha: baseSha,
    base_revision: { ref: baseRef, sha: baseSha },
    head_sha: headSha,
    is_main_worktree: rawField(context, "is_main_worktree", "isMainWorktree") === true
      || rawField(worktree, "is_main_worktree", "isMainWorktree") === true,
    host: hostId,
    environment_id: environmentId,
    environment_kind: environmentKind,
    remote_selector: remoteSelector,
    lineage: normalizeLineage({ ...context, ...(Object.keys(worktree).length ? worktree : {}) }),
    terminal: normalizeTerminal(context),
    shared_paths: normalizeSharedPaths({ ...context, ...(Object.keys(worktree).length ? worktree : {}) }),
    setup_provenance: normalizeSetup({ ...context, ...(Object.keys(worktree).length ? worktree : {}) }),
  };
  topology.worktree = {
    id: worktreeId,
    repository_id: repoId,
    path,
    branch,
    base_ref: baseRef,
    base_sha: baseSha,
    lineage: topology.lineage,
  };
  topology.worktree_lineage = topology.lineage;
  topology.host_info = { id: hostId, kind: environmentKind, environment_id: environmentId, runtime_id: runtimeId };
  if (hostId === "local" && environmentId !== "local") throw new Error("local Orca host requires environment_id local");
  if (hostId !== "local" && environmentId === "local") throw new Error("remote Orca host cannot use local environment_id");
  if (!worktreeIdBelongsToRepository(worktreeId, repoId)) {
    throw new Error("orca_worktree_id does not contain its repository id");
  }
  if (!isAcceptedOrcaSelector(remoteSelector, { worktreeId, path, host: hostId })) {
    throw new Error("remote_selector does not identify the exact Orca worktree");
  }
  return topology;
}

export function normalizeOrcaWorktreeMetadata(input) {
  try {
    return { ok: true, reason: null, metadata: normalizeTopology(sourceContext(input)) };
  } catch (error) {
    return { ok: false, reason: error?.message?.includes("identity") ? ORCA_IDENTITY_MISMATCH_REASON : "malformed-context", error: error.message, metadata: null };
  }
}

export const normalizeOrcaTopology = normalizeOrcaWorktreeMetadata;

export function validateOrcaWorktreeMetadata(metadata) {
  const result = normalizeOrcaWorktreeMetadata(metadata);
  return result.ok ? { ok: true, errors: [] } : { ok: false, errors: [result.error] };
}

export const validateOrcaTopology = validateOrcaWorktreeMetadata;

function identityFields(metadata) {
  return ["runtime_id", "repo_id", "worktree_id", "worktree_path", "branch", "base_ref", "base_sha", "host", "environment_id", "environment_kind", "remote_selector"]
    .map((key) => [key, metadata[key]]);
}

export function compareOrcaWorktreeIdentity(left, right) {
  const a = normalizeOrcaWorktreeMetadata(left);
  const b = normalizeOrcaWorktreeMetadata(right);
  if (!a.ok || !b.ok) return { ok: false, reason: "malformed-context", mismatches: [] };
  const mismatches = identityFields(a.metadata).filter(([key, value]) => b.metadata[key] !== value).map(([key]) => key);
  return mismatches.length ? { ok: false, reason: ORCA_IDENTITY_MISMATCH_REASON, mismatches } : { ok: true, reason: null, mismatches: [] };
}

function attach(target, input, field) {
  if (!isObject(target)) throw new TypeError(`${field === "orca" ? "manifest" : "receipt"} must be an object`);
  const normalized = normalizeOrcaWorktreeMetadata(input);
  if (!normalized.ok) return { ok: false, reason: normalized.reason, error: normalized.error, value: null };
  if (target[field] !== undefined) {
    const existing = normalizeOrcaWorktreeMetadata(target[field]);
    if (!existing.ok) return { ok: false, reason: "malformed-metadata", error: existing.error, value: null };
    const comparison = compareOrcaWorktreeIdentity(existing.metadata, normalized.metadata);
    if (!comparison.ok) {
      return { ok: false, reason: ORCA_IDENTITY_MISMATCH_REASON, mismatches: comparison.mismatches, value: null };
    }
  }
  return { ok: true, reason: null, value: { ...target, [field]: normalized.metadata } };
}

export function attachOrcaContextToManifest(manifest, context) {
  return attach(manifest, context, "orca");
}

export const addOrcaContextToManifest = attachOrcaContextToManifest;
export const attachOrcaTopologyToManifest = attachOrcaContextToManifest;

// Integrated read-only entry point: discovery remains entirely in the adapter;
// this layer only decides whether the resulting identity can be recorded.
export async function discoverAndAttachOrcaContextToManifest(manifest, options = {}) {
  const discovered = await discoverOrcaContext(options);
  if (!discovered.available) return { ok: false, reason: discovered.reason, error: discovered.detail, value: null };
  return attachOrcaContextToManifest(manifest, discovered);
}

export const discoverOrcaManifest = discoverAndAttachOrcaContextToManifest;

export function attachOrcaContextToReceipt(receipt, context) {
  return attach(receipt, context, "orca");
}

export const addOrcaContextToReceipt = attachOrcaContextToReceipt;
export const attachOrcaTopologyToReceipt = attachOrcaContextToReceipt;

export async function discoverAndAttachOrcaContextToReceipt(receipt, options = {}) {
  const discovered = await discoverOrcaContext(options);
  if (!discovered.available) return { ok: false, reason: discovered.reason, error: discovered.detail, value: null };
  return attachOrcaContextToReceipt(receipt, discovered);
}

export function buildOrcaReceipt({ receipt, context } = {}) {
  const result = attachOrcaContextToReceipt(receipt, context);
  if (!result.ok) return result;
  return { ok: true, receipt: { ...result.value, schema_version: ORCA_WORKTREE_RECEIPT_SCHEMA_VERSION } };
}

export function validateOrcaReceipt(receipt, expectedContext = undefined) {
  if (!isObject(receipt)) return { ok: false, errors: ["receipt must be an object"] };
  if (receipt.orca === undefined) return { ok: false, errors: ["receipt.orca is required"] };
  const result = validateOrcaWorktreeMetadata(receipt.orca);
  if (!result.ok || expectedContext === undefined) return result;
  const comparison = compareOrcaWorktreeIdentity(receipt.orca, expectedContext);
  return comparison.ok
    ? result
    : { ok: false, reason: comparison.reason, errors: [`receipt Orca identity mismatch: ${comparison.mismatches.join(", ")}`] };
}

export function validateOrcaManifest(manifest, expectedContext = undefined) {
  if (!isObject(manifest)) return { ok: false, errors: ["manifest must be an object"] };
  if (manifest.orca === undefined) return { ok: false, errors: ["manifest.orca is required"] };
  const result = validateOrcaWorktreeMetadata(manifest.orca);
  if (!result.ok || expectedContext === undefined) return result;
  const comparison = compareOrcaWorktreeIdentity(manifest.orca, expectedContext);
  return comparison.ok
    ? result
    : { ok: false, reason: comparison.reason, errors: [`manifest Orca identity mismatch: ${comparison.mismatches.join(", ")}`] };
}
