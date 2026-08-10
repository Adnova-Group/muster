import { types } from "node:util";
import {
  isAcceptedOrcaSelector,
  isCanonicalRuntimePath,
  worktreeIdMatchesPath,
} from "./orca-contract.js";

// Versioned, executable metadata for Orca–Muster coexistence. This module is
// deliberately pure: it describes and validates authority; it never calls Orca,
// changes a task graph, or performs a workflow action.

const SYSTEMS = Object.freeze(["orca", "muster"]);
const CONCERN_IDS = Object.freeze([
  "worktrees",
  "terminals",
  "sessions",
  "task-graphs",
  "dispatch",
  "placement",
  "receipts",
  "review-gates",
  "commits",
  "remote-execution",
]);
const CONTRACT_KEYS = Object.freeze(["schemaVersion", "contract", "systems", "concerns", "correlation"]);
const CORRELATION_KEYS = Object.freeze(["policy", "fields", "fixtures"]);
const CONCERN_KEYS = Object.freeze(["id", "boundary", "correlationFields", "authorities"]);
const AUTHORITY_KEYS = Object.freeze(["state", "owner", "mutators", "observers", "note"]);
const FIXTURE_KEYS = Object.freeze(["name", "record"]);
const CORRELATION_POLICY = "Correlation is observational metadata, never a cross-system mutation grant.";
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
const MAX_CORRELATION_ARRAY_LENGTH = 1024;

const field = (name, type, owner, description) => ({
  name,
  type,
  owner,
  required: true,
  description,
});

const CORRELATION_FIELDS = [
  field("muster_task_id", "string", "muster", "Immutable logical Muster task identity."),
  field("muster_attempt_id", "string", "muster", "Immutable identity for one execution attempt."),
  field("manifest_version", "string", "muster", "Version of the governing Muster manifest."),
  field("orca_runtime_id", "string", "orca", "Observed Orca runtime identity."),
  field("orca_repo_id", "string", "orca", "Observed Orca repository identity."),
  field("orca_worktree_id", "string", "orca", "Observed Orca worktree identity."),
  field("worktree_path", "string", "orca", "Absolute path in the executing runtime."),
  field("branch", "string", "orca", "Concrete worktree branch."),
  field("base_sha", "string", "muster", "Verified base commit for the attempt."),
  field("host", "string", "orca", "Local or remote host identity."),
  field("environment_id", "string", "orca", "Runtime environment or local sentinel."),
  field("terminal_handle", "string", "orca", "Observed, runtime-scoped terminal handle."),
  field("pane_key", "string", "orca", "Observed pane placement key."),
  field("session_id", "string", "orca", "Provider session identity observed by Orca."),
  field("changed_files", "array", "muster", "Paths recorded by the Muster receipt."),
  field("verification", "array", "muster", "Commands and verbatim results for the attempt."),
  field("review_verdict", "string", "muster", "Muster review-gate verdict."),
  field("remote_selector", "string", "orca", "Explicit runtime-side selector; never a local cwd alias."),
];

const localRecord = {
  muster_task_id: "task-orca-authority",
  muster_attempt_id: "attempt-local-001",
  manifest_version: "manifest-v1",
  orca_runtime_id: "runtime-local-001",
  orca_repo_id: "repo-001",
  orca_worktree_id: "repo-001::/workspace/muster-authority",
  worktree_path: "/workspace/muster-authority",
  branch: "feature/muster-authority",
  base_sha: "1111111111111111111111111111111111111111",
  host: "local",
  environment_id: "local",
  terminal_handle: "terminal-local-001",
  pane_key: "pane-local-001",
  session_id: "session-local-001",
  changed_files: ["src/orca-authority.js", "test/orca-authority.test.js"],
  verification: ["node --test test/orca-authority.test.js: pass"],
  review_verdict: "PASS",
  remote_selector: "id:repo-001::/workspace/muster-authority",
};

const remoteRecord = {
  muster_task_id: "task-orca-authority",
  muster_attempt_id: "attempt-remote-001",
  manifest_version: "manifest-v1",
  orca_runtime_id: "runtime-remote-001",
  orca_repo_id: "repo-001",
  orca_worktree_id: "repo-001::/srv/worktrees/muster-authority",
  worktree_path: "/srv/worktrees/muster-authority",
  branch: "feature/muster-authority",
  base_sha: "2222222222222222222222222222222222222222",
  host: "ssh:build.example",
  environment_id: "environment-remote-001",
  terminal_handle: "terminal-remote-001",
  pane_key: "pane-remote-001",
  session_id: "session-remote-001",
  changed_files: ["src/orca-authority.js", "test/orca-authority.test.js"],
  verification: ["node --test test/orca-authority.test.js: pass"],
  review_verdict: "PASS",
  remote_selector: "id:repo-001::/srv/worktrees/muster-authority",
};

const authority = (state, owner, observer, note) => ({
  state,
  owner,
  mutators: [owner],
  observers: [observer],
  note,
});

const concern = (id, boundary, correlationFields, authorities) => ({
  id,
  boundary,
  correlationFields,
  authorities,
});

const CONCERNS = [
  concern("worktrees", "The creator owns lifecycle; the other system may import or record identity, never rename or remove.", ["orca_worktree_id", "worktree_path", "branch", "base_sha"], [
    authority("orca-created-worktree", "orca", "muster", "Muster records concrete identity and lineage."),
    authority("muster-created-worktree", "muster", "orca", "Orca may provide UI and terminals after explicit import."),
  ]),
  concern("terminals", "Idle and output are observations, not task completion.", ["orca_runtime_id", "terminal_handle", "pane_key"], [
    authority("terminal-tabs-panes-ptys", "orca", "muster", "Muster uses bounded CLI observations."),
  ]),
  concern("sessions", "Handles are reacquired after restore; provider resume never advances a task graph.", ["orca_runtime_id", "terminal_handle", "session_id"], [
    authority("restore-hibernation-resume", "orca", "muster", "A resumed provider session remains Orca session state."),
  ]),
  concern("task-graphs", "One graph has one owner; mutable status is never mirrored bidirectionally.", ["muster_task_id", "muster_attempt_id", "manifest_version"], [
    authority("muster-task-graph", "muster", "orca", "Orca may display a read-only projection."),
    authority("orca-orchestration-graph", "orca", "muster", "Muster may observe an explicitly selected, separate Orca graph."),
  ]),
  concern("dispatch", "Exactly one system dispatches a logical attempt; placement is a separate explicit handoff.", ["muster_task_id", "muster_attempt_id"], [
    authority("muster-wave-dispatch", "muster", "orca", "Orca cannot launch a duplicate worker for the attempt."),
    authority("orca-orchestration-dispatch", "orca", "muster", "Muster does not separately dispatch the same logical work."),
  ]),
  concern("placement", "Muster may request a target through the public CLI but cannot mutate Orca runtime internals.", ["host", "environment_id", "terminal_handle", "pane_key"], [
    authority("agent-runtime-placement", "orca", "muster", "Muster records the resulting placement."),
  ]),
  concern("receipts", "Orca may publish a bounded pointer or summary; only Muster closes Muster work from its receipt.", ["muster_task_id", "muster_attempt_id", "changed_files", "verification"], [
    authority("muster-receipt-and-provenance", "muster", "orca", "Terminal output and comments are not authoritative receipts."),
  ]),
  concern("review-gates", "Orca diff and decision UI do not substitute for a Muster review verdict.", ["muster_attempt_id", "review_verdict"], [
    authority("muster-review-and-fix-loop", "muster", "orca", "Orca may display diffs, annotations, and status."),
  ]),
  concern("commits", "Commit, push, and PR actions belong to the selected workflow owner and require explicit handoff.", ["muster_attempt_id", "branch", "review_verdict"], [
    authority("muster-gated-workflow", "muster", "orca", "Orca ship actions stay observational until handoff."),
    authority("orca-owned-workflow", "orca", "muster", "Muster does not silently commit or ship Orca-owned work."),
  ]),
  concern("remote-execution", "Use public CLI selectors and runtime-side paths; internal federation state remains Orca-owned.", ["orca_runtime_id", "host", "environment_id", "worktree_path", "remote_selector"], [
    authority("remote-runtime-and-federation", "orca", "muster", "Muster rejects local cwd aliases for remote execution."),
  ]),
];

// These snapshots are the validator's trust root for schema version 1. They are
// intentionally independent of the caller-supplied contract being validated,
// so coordinated edits to a cloned schema and its fixtures cannot validate
// themselves into a new authority policy without a schema-version change.
const CANONICAL_FIELD_DEFINITIONS = CORRELATION_FIELDS.map((entry) => ({ ...entry }));
const CANONICAL_CONCERN_SHAPE = CONCERNS.map((entry) => ({
  id: entry.id,
  boundary: entry.boundary,
  correlationFields: [...entry.correlationFields],
  authorities: entry.authorities.map((authorityEntry) => ({
    ...authorityEntry,
    mutators: [...authorityEntry.mutators],
    observers: [...authorityEntry.observers],
  })),
}));

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

export const ORCA_AUTHORITY_CONTRACT = deepFreeze({
  schemaVersion: 1,
  contract: "orca-muster-authority-and-correlation",
  systems: [...SYSTEMS],
  concerns: CONCERNS,
  correlation: {
    policy: CORRELATION_POLICY,
    fields: CORRELATION_FIELDS,
    fixtures: [
      { name: "local", record: localRecord },
      { name: "remote", record: remoteRecord },
    ],
  },
});

deepFreeze(CANONICAL_FIELD_DEFINITIONS);
deepFreeze(CANONICAL_CONCERN_SHAPE);

function isPlainRecord(value) {
  return Boolean(value && typeof value === "object" && !types.isProxy(value) && !Array.isArray(value)
    && Object.getPrototypeOf(value) === Object.prototype);
}

function exactArrayValues(actual, expectedLength) {
  try {
    if (!Array.isArray(actual) || types.isProxy(actual)
      || Object.getPrototypeOf(actual) !== Array.prototype || actual.length !== expectedLength) return null;
    const expectedKeys = [...Array.from({ length: expectedLength }, (_, index) => String(index)), "length"];
    const keys = Reflect.ownKeys(actual);
    if (keys.length !== expectedKeys.length || !keys.every((key) => expectedKeys.includes(key))) return null;
    const values = [];
    for (let index = 0; index < expectedLength; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(actual, String(index));
      if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) return null;
      values.push(descriptor.value);
    }
    return values;
  } catch {
    return null;
  }
}

function sameScalarArray(actual, expected) {
  const values = exactArrayValues(actual, expected.length);
  return values !== null && values.every((value, index) => value === expected[index]);
}

function matchesCanonicalField(actual, expected) {
  try {
    if (!isPlainRecord(actual)) return false;
    const expectedKeys = Object.keys(expected);
    const keys = Reflect.ownKeys(actual);
    if (keys.length !== expectedKeys.length || !keys.every((key) => expectedKeys.includes(key))) return false;
    return expectedKeys.every((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(actual, key);
      return descriptor && "value" in descriptor && descriptor.enumerable === true
        && descriptor.value === expected[key];
    });
  } catch {
    return false;
  }
}

function validateExactKeys(value, expectedKeys, label, errors) {
  let safeToRead = true;
  let keys;
  try {
    keys = Reflect.ownKeys(value);
  } catch {
    errors.push(`${label}: own keys could not be inspected`);
    return false;
  }
  for (const key of keys) {
    if (typeof key !== "string" || !expectedKeys.includes(key)) {
      errors.push(`${label}: unknown key ${String(key)}`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      errors.push(`${label}: key ${key} must be an enumerable data property`);
      safeToRead = false;
    }
  }
  for (const key of expectedKeys) {
    if (!keys.includes(key)) errors.push(`${label}: missing required key ${key}`);
  }
  return safeToRead;
}

function ownEnumerableDataValue(value, key) {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    return descriptor && "value" in descriptor && descriptor.enumerable === true
      ? descriptor.value
      : undefined;
  } catch {
    return undefined;
  }
}

function validateRecord(record, fields) {
  const errors = [];
  if (!record || typeof record !== "object" || Array.isArray(record)) {
    return { ok: false, errors: ["correlation record must be an object"] };
  }
  if (!isPlainRecord(record)) {
    return { ok: false, errors: ["correlation record must be a plain object with no inherited metadata"] };
  }
  const known = new Map(fields.map((entry) => [entry.name, entry]));
  let safeToRead = true;
  let keys;
  try {
    keys = Reflect.ownKeys(record);
  } catch {
    return { ok: false, errors: ["correlation record own fields could not be inspected"] };
  }
  for (const entry of fields) {
    if (entry.required && !keys.includes(entry.name)) {
      errors.push(`missing required field ${entry.name}`);
    }
  }
  for (const name of keys) {
    const entry = known.get(name);
    if (!entry) {
      errors.push(`unknown field ${String(name)}`);
      continue;
    }
    const descriptor = Object.getOwnPropertyDescriptor(record, name);
    if (!descriptor || !("value" in descriptor) || descriptor.enumerable !== true) {
      errors.push(`${name} must be an enumerable data property`);
      safeToRead = false;
      continue;
    }
    const value = descriptor.value;
    if (entry.type === "array" && !Array.isArray(value)) {
      errors.push(`${name} must be an array`);
    } else if (entry.type === "array" && types.isProxy(value)) {
      errors.push(`${name} must contain only non-empty strings`);
    } else if (entry.type === "array") {
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
      const length = lengthDescriptor && "value" in lengthDescriptor
        ? lengthDescriptor.value
        : undefined;
      if (length > MAX_CORRELATION_ARRAY_LENGTH) {
        errors.push(`${name} must contain at most ${MAX_CORRELATION_ARRAY_LENGTH} entries`);
        continue;
      }
      const values = exactArrayValues(value, length);
      if (values === null) {
        errors.push(`${name} must be a dense array with no attached metadata`);
      } else if (!values.length
        || !values.every((item) => typeof item === "string" && item.length > 0)) {
        errors.push(`${name} must contain only non-empty strings`);
      } else if (values.some((item) => CONTROL_CHARACTERS.test(item))) {
        errors.push(`${name} must not contain control characters`);
      }
    } else if (entry.type === "string" && (typeof value !== "string" || value.length === 0)) {
      errors.push(`${name} must be a non-empty string`);
    } else if (entry.type === "string" && CONTROL_CHARACTERS.test(value)) {
      errors.push(`${name} must not contain control characters`);
    }
  }
  if (!safeToRead) return { ok: false, errors };

  if (typeof record.base_sha === "string" && !/^[0-9a-f]{40}$/.test(record.base_sha)) {
    errors.push("base_sha must be a 40-character lowercase hexadecimal commit id");
  }
  if (typeof record.worktree_path === "string" && !isCanonicalRuntimePath(record.worktree_path)) {
    errors.push("worktree_path must be an absolute normalized worktree_path in the executing runtime");
  }
  if (typeof record.orca_worktree_id === "string" && typeof record.orca_repo_id === "string"
    && typeof record.worktree_path === "string"
    && !worktreeIdMatchesPath(record.orca_worktree_id, record.orca_repo_id, record.worktree_path)) {
    errors.push("orca_worktree_id must identify the exact worktree_path");
  }
  if (record.host === "local") {
    if (record.environment_id !== "local") errors.push("local host requires environment_id local");
    if (!isAcceptedOrcaSelector(record.remote_selector, {
      worktreeId: record.orca_worktree_id,
      path: record.worktree_path,
      host: record.host,
    })) {
      errors.push("local remote_selector must identify the exact worktree_path");
    }
  } else if (typeof record.host === "string") {
    if (record.environment_id === "local") errors.push("remote environment_id must not be local");
    if (typeof record.orca_repo_id === "string" && record.orca_repo_id.includes("::")) {
      errors.push("orca_repo_id must not contain the remote selector delimiter");
    }
    if (!isAcceptedOrcaSelector(record.remote_selector, {
      worktreeId: record.orca_worktree_id,
      path: record.worktree_path,
      host: record.host,
    })) {
      errors.push("remote execution requires a repo-qualified remote_selector for the exact runtime worktree_path");
    }
  }
  return { ok: errors.length === 0, errors };
}

export function validateOrcaCorrelationRecord(record) {
  try {
    return validateRecord(record, ORCA_AUTHORITY_CONTRACT.correlation.fields);
  } catch {
    return { ok: false, errors: ["correlation record validation failed closed on malformed input"] };
  }
}

export function canMutateAuthorityState(concernId, state, system) {
  const authorityState = ORCA_AUTHORITY_CONTRACT.concerns
    ?.find((entry) => entry.id === concernId)
    ?.authorities?.find((entry) => entry.state === state);
  return Boolean(authorityState?.owner === system && authorityState.mutators?.length === 1
    && authorityState.mutators[0] === system);
}

function validateAuthorityContract(contract) {
  const errors = [];
  if (!isPlainRecord(contract)) {
    return { ok: false, errors: ["contract must be a plain object with no inherited metadata"] };
  }
  if (!validateExactKeys(contract, CONTRACT_KEYS, "contract", errors)) {
    return { ok: false, errors };
  }
  if (contract.schemaVersion !== 1) errors.push("schemaVersion must be 1");
  if (contract.contract !== "orca-muster-authority-and-correlation") errors.push("contract name is not canonical");
  if (!sameScalarArray(contract.systems, SYSTEMS)) errors.push("systems must be exactly orca and muster");

  if (!Array.isArray(contract.concerns)) errors.push("concerns must be an array");
  const concerns = exactArrayValues(contract.concerns, CONCERN_IDS.length) || [];
  if (Array.isArray(contract.concerns) && concerns.length === 0) {
    errors.push("concerns must be a dense canonical array with no attached metadata");
  }
  const ids = concerns.map((entry) => {
    if (!isPlainRecord(entry)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(entry, "id");
    return descriptor && "value" in descriptor ? descriptor.value : undefined;
  });
  if (!sameScalarArray(ids, CONCERN_IDS)) {
    errors.push(`concerns must be exactly: ${CONCERN_IDS.join(", ")}`);
  }
  if (!isPlainRecord(contract.correlation)) errors.push("correlation must be a plain object");
  const correlation = isPlainRecord(contract.correlation) ? contract.correlation : {};
  if (!validateExactKeys(correlation, CORRELATION_KEYS, "correlation", errors)) {
    return { ok: false, errors };
  }
  if (correlation.policy !== CORRELATION_POLICY) {
    errors.push("correlation policy must match the canonical schema-v1 policy");
  }
  if (!Array.isArray(correlation.fields)) errors.push("correlation fields must be an array");
  if (!Array.isArray(correlation.fixtures)) errors.push("correlation fixtures must be an array");
  const fields = exactArrayValues(correlation.fields, CANONICAL_FIELD_DEFINITIONS.length) || [];
  const fixtures = exactArrayValues(correlation.fixtures, 2) || [];
  if (Array.isArray(correlation.fields) && fields.length === 0) {
    errors.push("correlation fields must be a dense canonical array with no attached metadata");
  }
  if (Array.isArray(correlation.fixtures) && fixtures.length === 0) {
    errors.push("correlation fixtures must be a dense canonical array with no attached metadata");
  }
  const validFields = fields.filter(isPlainRecord);
  if (validFields.length !== fields.length) errors.push("correlation field definitions must be plain objects");
  const fieldNames = new Set(CANONICAL_FIELD_DEFINITIONS.map((entry) => entry.name));
  for (const [concernIndex, concernEntry] of concerns.entries()) {
    const canonicalConcern = CANONICAL_CONCERN_SHAPE[concernIndex];
    if (!isPlainRecord(concernEntry)) {
      errors.push(`concern at index ${concernIndex} must be a plain object`);
      continue;
    }
    if (!validateExactKeys(concernEntry, CONCERN_KEYS, `concern ${concernIndex}`, errors)) continue;
    if (concernEntry.id !== canonicalConcern?.id) {
      errors.push(`concern at index ${concernIndex}: id must remain ${canonicalConcern?.id}`);
    }
    if (concernEntry.boundary !== canonicalConcern?.boundary) {
      errors.push(`${concernEntry.id}: boundary must match the canonical schema-v1 boundary`);
    }
    if (!sameScalarArray(concernEntry.correlationFields, canonicalConcern?.correlationFields || [])) {
      errors.push(`${concernEntry.id}: correlationFields must match the canonical schema-v1 concern mapping`);
    }
    if (!Array.isArray(concernEntry.authorities) || types.isProxy(concernEntry.authorities)) {
      errors.push(`${concernEntry.id}: at least one authority fixture is required`);
      continue;
    }
    const authorities = exactArrayValues(
      concernEntry.authorities,
      canonicalConcern?.authorities.length || 0,
    );
    if (!authorities) {
      errors.push(`${concernEntry.id}: authority states must match the complete canonical schema-v1 set`);
      continue;
    }
    const concernFieldValues = exactArrayValues(
      concernEntry.correlationFields,
      canonicalConcern?.correlationFields.length || 0,
    ) || [];
    for (const name of concernFieldValues) {
      if (!fieldNames.has(name)) errors.push(`${concernEntry.id}: unknown correlation field ${name}`);
    }
    for (const [authorityIndex, state] of authorities.entries()) {
      const canonicalAuthority = canonicalConcern?.authorities[authorityIndex];
      if (!isPlainRecord(state)) {
        errors.push(`${concernEntry.id}: authority at index ${authorityIndex} must be a plain object`);
        continue;
      }
      if (!validateExactKeys(
        state,
        AUTHORITY_KEYS,
        `${concernEntry.id}/authority-${authorityIndex}`,
        errors,
      )) continue;
      if (state.state !== canonicalAuthority?.state) {
        errors.push(`${concernEntry.id}/${state.state}: authority state must remain ${canonicalAuthority?.state}`);
      }
      if (state.owner !== canonicalAuthority?.owner) {
        errors.push(`${concernEntry.id}/${state.state}: owner must remain ${canonicalAuthority?.owner}`);
      }
      if (!SYSTEMS.includes(state.owner)) errors.push(`${concernEntry.id}/${state.state}: owner must be orca or muster`);
      if (!sameScalarArray(state.mutators, canonicalAuthority?.mutators || [])) {
        errors.push(`${concernEntry.id}/${state.state}: mutators array must be exactly canonical; only its owner may mutate authoritative state`);
      }
      if (!sameScalarArray(state.observers, canonicalAuthority?.observers || [])) {
        errors.push(`${concernEntry.id}/${state.state}: observers must be exactly the canonical schema-v1 observers`);
      }
      if (state.note !== canonicalAuthority?.note) {
        errors.push(`${concernEntry.id}/${state.state}: note must match the canonical schema-v1 authority note`);
      }
    }
  }

  if (fields.length !== CANONICAL_FIELD_DEFINITIONS.length
    || !fields.every((entry, index) => matchesCanonicalField(entry, CANONICAL_FIELD_DEFINITIONS[index]))) {
    errors.push("correlation fields must match the canonical schema-v1 field definitions");
  }
  const requiredNames = CANONICAL_FIELD_DEFINITIONS.filter((entry) => entry.required).map((entry) => entry.name);
  if (new Set(requiredNames).size !== requiredNames.length) errors.push("required correlation field names must be unique");
  for (const [fixtureIndex, fixture] of fixtures.entries()) {
    if (!isPlainRecord(fixture)) {
      errors.push(`correlation fixture at index ${fixtureIndex} must be a plain object`);
      continue;
    }
    if (!validateExactKeys(fixture, FIXTURE_KEYS, `correlation fixture ${fixtureIndex}`, errors)) continue;
    const result = validateRecord(fixture.record, CANONICAL_FIELD_DEFINITIONS);
    for (const error of result.errors) errors.push(`${fixture.name || "unnamed"} fixture: ${error}`);
  }
  const fixtureNames = fixtures.map((fixture) => isPlainRecord(fixture)
    ? ownEnumerableDataValue(fixture, "name")
    : undefined);
  if (!sameScalarArray(fixtureNames, ["local", "remote"])) {
    errors.push("correlation fixtures must be exactly local and remote");
  }

  return { ok: errors.length === 0, errors };
}

export function validateOrcaAuthorityContract(contract) {
  try {
    return validateAuthorityContract(contract);
  } catch {
    return { ok: false, errors: ["contract validation failed closed on malformed input"] };
  }
}
