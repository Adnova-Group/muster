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

test("malformed observer collections fail closed without throwing", () => {
  for (const observers of [null, {}, "muster", ["muster", "orca"], ["muster", 7]]) {
    const malformed = clone(ORCA_AUTHORITY_CONTRACT);
    malformed.concerns[0].authorities[0].observers = observers;
    assert.doesNotThrow(() => validateOrcaAuthorityContract(malformed));
    const result = validateOrcaAuthorityContract(malformed);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /observers.*exactly/i);
  }
});

test("schema-v1 policy, boundaries, authority notes, and nested shapes are canonical", () => {
  const mutations = [
    ["correlation policy", (value) => { value.correlation.policy = "Metadata grants mutation."; }],
    ["concern boundary", (value) => { value.concerns[0].boundary = "Either system may remove it."; }],
    ["authority note", (value) => { value.concerns[0].authorities[0].note = "May mutate after observation."; }],
    ["authority state", (value) => { value.concerns[0].authorities[0].state = "renamed-state"; }],
    ["concern id", (value) => { value.concerns[0].id = "renamed-concern"; }],
    ["mutators array", (value) => { value.concerns[0].authorities[0].mutators = "orca"; }],
    ["observers array", (value) => { value.concerns[0].authorities[0].observers = "muster"; }],
    ["correlationFields array", (value) => { value.concerns[0].correlationFields = "worktree_path"; }],
  ];

  for (const [label, mutate] of mutations) {
    const value = clone(ORCA_AUTHORITY_CONTRACT);
    mutate(value);
    const result = validateOrcaAuthorityContract(value);
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), /canonical|exactly|array|remain/i, label);
  }
});

test("unknown and secret-bearing metadata is rejected at every contract layer", () => {
  const mutations = [
    ["contract", (value) => { value.auth_token = "secret"; }],
    ["correlation", (value) => { value.correlation.private_key = "secret"; }],
    ["concern", (value) => { value.concerns[0].password = "secret"; }],
    ["authority state", (value) => { value.concerns[0].authorities[0].credential = "secret"; }],
    ["fixture wrapper", (value) => { value.correlation.fixtures[0].access_token = "secret"; }],
    ["fixture record", (value) => { value.correlation.fixtures[0].record.api_key = "secret"; }],
  ];

  for (const [label, mutate] of mutations) {
    const value = clone(ORCA_AUTHORITY_CONTRACT);
    mutate(value);
    const result = validateOrcaAuthorityContract(value);
    assert.equal(result.ok, false, label);
    assert.match(result.errors.join("\n"), /unknown (?:field|key)/i, label);
  }
});

test("fixture wrappers and records require their exact plain-object shapes", () => {
  const missingRecord = clone(ORCA_AUTHORITY_CONTRACT);
  delete missingRecord.correlation.fixtures[0].record;
  assert.match(validateOrcaAuthorityContract(missingRecord).errors.join("\n"), /fixture.*record/i);

  const inheritedWrapper = clone(ORCA_AUTHORITY_CONTRACT);
  inheritedWrapper.correlation.fixtures[0] = Object.assign(
    Object.create({ auth_token: "secret" }),
    inheritedWrapper.correlation.fixtures[0],
  );
  assert.match(validateOrcaAuthorityContract(inheritedWrapper).errors.join("\n"), /plain object/i);

  const arrayRecord = clone(ORCA_AUTHORITY_CONTRACT);
  arrayRecord.correlation.fixtures[0].record = [];
  assert.match(validateOrcaAuthorityContract(arrayRecord).errors.join("\n"), /record must be an object/i);
});

test("normalized absolute worktree paths reject control characters", () => {
  for (const control of ["\0", "\n", "\r", "\t", "\u001f", "\u007f", "\u0080", "\u0085", "\u009f"]) {
    const record = clone(ORCA_AUTHORITY_CONTRACT.correlation.fixtures[1].record);
    record.worktree_path = `/srv/worktrees/valid${control}suffix`;
    record.remote_selector = `id:${record.orca_repo_id}::${record.worktree_path}`;
    const result = validateOrcaCorrelationRecord(record);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), /control characters/i);
  }
});

test("hidden, symbol-keyed, and array-attached metadata cannot cross the contract boundary", () => {
  const hiddenContract = clone(ORCA_AUTHORITY_CONTRACT);
  Object.defineProperty(hiddenContract, "auth_token", { value: "secret" });
  assert.match(validateOrcaAuthorityContract(hiddenContract).errors.join("\n"), /unknown key auth_token/i);

  const symbolRecord = clone(ORCA_AUTHORITY_CONTRACT);
  symbolRecord.correlation.fixtures[0].record[Symbol("private_key")] = "secret";
  assert.match(validateOrcaAuthorityContract(symbolRecord).errors.join("\n"), /unknown field Symbol\(private_key\)/i);

  const arrayMetadata = clone(ORCA_AUTHORITY_CONTRACT);
  arrayMetadata.concerns[0].authorities[0].observers.auth_token = "secret";
  assert.match(validateOrcaAuthorityContract(arrayMetadata).errors.join("\n"), /observers.*exactly/i);
});

test("sparse canonical arrays fail closed", () => {
  const sparseSystems = clone(ORCA_AUTHORITY_CONTRACT);
  delete sparseSystems.systems[0];
  assert.match(validateOrcaAuthorityContract(sparseSystems).errors.join("\n"), /systems.*exactly/i);

  for (const key of ["mutators", "observers"]) {
    const sparseAuthority = clone(ORCA_AUTHORITY_CONTRACT);
    delete sparseAuthority.concerns[0].authorities[0][key][0];
    const result = validateOrcaAuthorityContract(sparseAuthority);
    assert.equal(result.ok, false);
    assert.match(result.errors.join("\n"), new RegExp(`${key}.*exactly`, "i"));
  }
});

test("accessor-backed and proxy observer shapes fail closed without executing accessors", () => {
  const accessorContract = clone(ORCA_AUTHORITY_CONTRACT);
  let getterCalls = 0;
  Object.defineProperty(accessorContract.concerns[0].authorities[0], "observers", {
    enumerable: true,
    get() {
      getterCalls += 1;
      throw new Error("observer getter executed");
    },
  });
  assert.doesNotThrow(() => validateOrcaAuthorityContract(accessorContract));
  assert.equal(validateOrcaAuthorityContract(accessorContract).ok, false);
  assert.equal(getterCalls, 0);

  const proxyContract = clone(ORCA_AUTHORITY_CONTRACT);
  const { proxy, revoke } = Proxy.revocable(proxyContract.concerns[0].authorities[0].observers, {});
  proxyContract.concerns[0].authorities[0].observers = proxy;
  revoke();
  assert.doesNotThrow(() => validateOrcaAuthorityContract(proxyContract));
  assert.equal(validateOrcaAuthorityContract(proxyContract).ok, false);
});

test("active proxies fail closed without executing traps", () => {
  let trapCalls = 0;
  const handler = {
    get() { trapCalls += 1; },
    getOwnPropertyDescriptor() { trapCalls += 1; },
    getPrototypeOf() { trapCalls += 1; },
    ownKeys() { trapCalls += 1; },
  };

  const contract = clone(ORCA_AUTHORITY_CONTRACT);
  const proxyContract = new Proxy(contract, handler);
  assert.equal(validateOrcaAuthorityContract(proxyContract).ok, false);

  const record = clone(ORCA_AUTHORITY_CONTRACT.correlation.fixtures[0].record);
  const proxyRecord = new Proxy(record, handler);
  assert.equal(validateOrcaCorrelationRecord(proxyRecord).ok, false);

  const nested = clone(ORCA_AUTHORITY_CONTRACT);
  nested.concerns[0].authorities[0].observers = new Proxy(
    nested.concerns[0].authorities[0].observers,
    handler,
  );
  assert.equal(validateOrcaAuthorityContract(nested).ok, false);
  assert.equal(trapCalls, 0);
});

test("canonical arrays reject inherited metadata", () => {
  const inheritedSystems = clone(ORCA_AUTHORITY_CONTRACT);
  Object.setPrototypeOf(inheritedSystems.systems, { auth_token: "secret" });
  assert.equal(validateOrcaAuthorityContract(inheritedSystems).ok, false);

  const inheritedObservers = clone(ORCA_AUTHORITY_CONTRACT);
  Object.setPrototypeOf(
    inheritedObservers.concerns[0].authorities[0].observers,
    { private_key: "secret" },
  );
  assert.equal(validateOrcaAuthorityContract(inheritedObservers).ok, false);
});
