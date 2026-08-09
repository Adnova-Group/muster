import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ORCA_AUTHORITY_CONTRACT,
  canMutateAuthorityState,
  validateOrcaAuthorityContract,
  validateOrcaCorrelationRecord,
} from "../src/orca-authority.js";

const EXPECTED_CONCERNS = [
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
];

const clone = (value) => structuredClone(value);

test("authority metadata validates and covers all ten Orca–Muster concerns", () => {
  assert.deepEqual(
    ORCA_AUTHORITY_CONTRACT.concerns.map(({ id }) => id),
    EXPECTED_CONCERNS,
  );
  assert.deepEqual(validateOrcaAuthorityContract(ORCA_AUTHORITY_CONTRACT), {
    ok: true,
    errors: [],
  });
  assert.ok(Object.isFrozen(ORCA_AUTHORITY_CONTRACT));
  assert.ok(ORCA_AUTHORITY_CONTRACT.concerns.every(Object.isFrozen));
});

test("every authority slice has exactly one owner and only that owner can mutate it", () => {
  for (const concern of ORCA_AUTHORITY_CONTRACT.concerns) {
    assert.ok(concern.authorities.length > 0, `${concern.id} needs an authority fixture`);
    for (const authority of concern.authorities) {
      assert.deepEqual(authority.mutators, [authority.owner]);
      const observer = authority.owner === "orca" ? "muster" : "orca";
      assert.ok(authority.observers.includes(observer));
      assert.equal(
        canMutateAuthorityState(concern.id, authority.state, observer),
        false,
        `${observer} must not mutate ${authority.owner}-owned ${concern.id}/${authority.state}`,
      );
      assert.equal(canMutateAuthorityState(concern.id, authority.state, authority.owner), true);
    }
  }
});

test("the validator rejects cross-system mutation of either system's authoritative task state", () => {
  const musterOwned = clone(ORCA_AUTHORITY_CONTRACT);
  const musterGraph = musterOwned.concerns
    .find(({ id }) => id === "task-graphs")
    .authorities.find(({ owner }) => owner === "muster");
  musterGraph.mutators.push("orca");
  assert.match(
    validateOrcaAuthorityContract(musterOwned).errors.join("\n"),
    /task-graphs.*muster-task-graph.*only its owner/i,
  );

  const orcaOwned = clone(ORCA_AUTHORITY_CONTRACT);
  const orcaGraph = orcaOwned.concerns
    .find(({ id }) => id === "task-graphs")
    .authorities.find(({ owner }) => owner === "orca");
  orcaGraph.mutators.push("muster");
  assert.match(
    validateOrcaAuthorityContract(orcaOwned).errors.join("\n"),
    /task-graphs.*orca-orchestration-graph.*only its owner/i,
  );
});

test("100% of required correlation fields are populated in local and remote fixtures", () => {
  const required = ORCA_AUTHORITY_CONTRACT.correlation.fields
    .filter(({ required }) => required)
    .map(({ name }) => name);

  assert.ok(required.length > 0);
  assert.equal(new Set(required).size, required.length);
  for (const fixture of ORCA_AUTHORITY_CONTRACT.correlation.fixtures) {
    assert.deepEqual(Object.keys(fixture.record).sort(), [...required].sort());
    assert.deepEqual(validateOrcaCorrelationRecord(fixture.record), { ok: true, errors: [] });
  }
});

test("correlation validation fails closed on missing, unknown, or malformed fields", () => {
  const record = clone(ORCA_AUTHORITY_CONTRACT.correlation.fixtures[0].record);
  delete record.muster_attempt_id;
  record.auth_token = "must-never-be-correlation-metadata";
  record.changed_files = "src/orca-authority.js";

  const result = validateOrcaCorrelationRecord(record);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /missing required field muster_attempt_id/);
  assert.match(result.errors.join("\n"), /unknown field auth_token/);
  assert.match(result.errors.join("\n"), /changed_files must be an array/);
});

test("authority validation catches incomplete fixture coverage", () => {
  const incomplete = clone(ORCA_AUTHORITY_CONTRACT);
  delete incomplete.correlation.fixtures[1].record.review_verdict;
  const result = validateOrcaAuthorityContract(incomplete);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /remote.*review_verdict/i);
});

test("canonical required fields cannot be deleted or replaced along with their fixtures", () => {
  const deleted = clone(ORCA_AUTHORITY_CONTRACT);
  deleted.correlation.fields = deleted.correlation.fields.filter(({ name }) => name !== "review_verdict");
  for (const fixture of deleted.correlation.fixtures) delete fixture.record.review_verdict;
  for (const concern of deleted.concerns) {
    concern.correlationFields = concern.correlationFields.filter((name) => name !== "review_verdict");
  }
  assert.match(validateOrcaAuthorityContract(deleted).errors.join("\n"), /correlation fields must match the canonical/i);

  const replaced = clone(ORCA_AUTHORITY_CONTRACT);
  replaced.correlation.fields = [{
    name: "auth_token",
    type: "secret",
    owner: "orca",
    required: true,
    description: "bad schema",
  }];
  replaced.correlation.fixtures = [
    { name: "local", record: { auth_token: "secret" } },
    { name: "remote", record: { auth_token: "secret" } },
  ];
  for (const concern of replaced.concerns) concern.correlationFields = [];
  assert.match(validateOrcaAuthorityContract(replaced).errors.join("\n"), /correlation fields must match the canonical/i);
});

test("canonical graph ownership cannot be relabeled into a valid-looking mutation policy", () => {
  const relabeled = clone(ORCA_AUTHORITY_CONTRACT);
  const graph = relabeled.concerns
    .find(({ id }) => id === "task-graphs")
    .authorities.find(({ state }) => state === "muster-task-graph");
  graph.owner = "orca";
  graph.mutators = ["orca"];
  graph.observers = ["muster"];
  const result = validateOrcaAuthorityContract(relabeled);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /muster-task-graph.*owner must remain muster/i);

  const omitted = clone(ORCA_AUTHORITY_CONTRACT);
  omitted.concerns.find(({ id }) => id === "task-graphs").authorities.pop();
  assert.match(validateOrcaAuthorityContract(omitted).errors.join("\n"), /complete canonical.*set/i);

  assert.equal(
    canMutateAuthorityState("task-graphs", "muster-task-graph", "orca", relabeled),
    false,
    "a forged caller contract must not grant cross-system mutation authority",
  );
});

test("remote correlation requires a remote environment and repo-qualified runtime selector", () => {
  const record = clone(ORCA_AUTHORITY_CONTRACT.correlation.fixtures[1].record);
  record.environment_id = "local";
  record.remote_selector = "path:/tmp/local-cwd-alias";
  const result = validateOrcaCorrelationRecord(record);
  assert.equal(result.ok, false);
  assert.match(result.errors.join("\n"), /remote environment_id/i);
  assert.match(result.errors.join("\n"), /repo-qualified remote_selector/i);

  for (const worktreePath of ["relative/cwd", "../escape", "/srv/worktrees/../escape"]) {
    const invalidPath = clone(ORCA_AUTHORITY_CONTRACT.correlation.fixtures[1].record);
    invalidPath.worktree_path = worktreePath;
    invalidPath.remote_selector = `id:${invalidPath.orca_repo_id}::${worktreePath}`;
    assert.match(
      validateOrcaCorrelationRecord(invalidPath).errors.join("\n"),
      /absolute normalized worktree_path/i,
    );
  }

  const ambiguousRepo = clone(ORCA_AUTHORITY_CONTRACT.correlation.fixtures[1].record);
  ambiguousRepo.orca_repo_id = "repo::injected";
  ambiguousRepo.remote_selector = `id:${ambiguousRepo.orca_repo_id}::${ambiguousRepo.worktree_path}`;
  assert.match(validateOrcaCorrelationRecord(ambiguousRepo).errors.join("\n"), /orca_repo_id.*selector/i);
});

test("correlation records reject inherited properties and nested unvalidated metadata", () => {
  const fixture = clone(ORCA_AUTHORITY_CONTRACT.correlation.fixtures[0].record);
  const inherited = Object.assign(Object.create({ auth_token: "secret" }), fixture);
  assert.match(validateOrcaCorrelationRecord(inherited).errors.join("\n"), /plain object/i);

  fixture.changed_files = [{ auth_token: "secret" }];
  fixture.verification = [{ private_key: "secret" }];
  const nested = validateOrcaCorrelationRecord(fixture);
  assert.equal(nested.ok, false);
  assert.match(nested.errors.join("\n"), /changed_files.*non-empty strings/i);
  assert.match(nested.errors.join("\n"), /verification.*non-empty strings/i);
});

test("authority validation fails closed for malformed nested schema shapes", () => {
  const malformedContracts = [
    Object.assign(Object.create({ contract: "inherited" }), clone(ORCA_AUTHORITY_CONTRACT)),
    { ...clone(ORCA_AUTHORITY_CONTRACT), concerns: [null] },
    { ...clone(ORCA_AUTHORITY_CONTRACT), correlation: null },
    { ...clone(ORCA_AUTHORITY_CONTRACT), correlation: { fields: {}, fixtures: [] } },
    { ...clone(ORCA_AUTHORITY_CONTRACT), correlation: { fields: [], fixtures: {} } },
    (() => {
      const value = clone(ORCA_AUTHORITY_CONTRACT);
      value.concerns[0].correlationFields = {};
      return value;
    })(),
    (() => {
      const value = clone(ORCA_AUTHORITY_CONTRACT);
      value.concerns[0].authorities = [null];
      return value;
    })(),
    (() => {
      const value = clone(ORCA_AUTHORITY_CONTRACT);
      value.correlation.fields[0] = null;
      return value;
    })(),
    (() => {
      const value = clone(ORCA_AUTHORITY_CONTRACT);
      value.correlation.fixtures[0] = null;
      return value;
    })(),
  ];

  for (const contract of malformedContracts) {
    assert.doesNotThrow(() => validateOrcaAuthorityContract(contract));
    assert.equal(validateOrcaAuthorityContract(contract).ok, false);
  }
});
