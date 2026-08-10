import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { normalizeOrcaContext, parseOrcaJsonResponse } from "../src/orca-context-adapter.js";
import { normalizeOrcaWorktreeMetadata } from "../src/orca-worktree-receipts.js";
import { evaluateOrcaWorktreeCleanup } from "../src/orca-worktree-cleanup.js";

// Every other Orca fixture in this repo is self-authored, so the suite could
// only ever prove internal consistency. This one is captured verbatim from a
// live Orca 1.4.177 runtime -- `status`, `worktree list`, `agent-context`, and
// `terminal list` -- with machine identifiers replaced by stable placeholders
// and nothing else touched. It is the only fixture that can prove conformance,
// and three of its properties were surprises the hand-written fixtures missed:
//
//   - the worktree path is a UNC path (`\\wsl.localhost\...`), not POSIX;
//   - the branch is a fully-qualified ref (`refs/heads/main`), not `main`;
//   - a real worktree record carries no base ref or base SHA at all.

const LIVE = join(process.cwd(), "test/fixtures/orca-live/local-wsl-unc.json");

async function live() {
  return JSON.parse(await readFile(LIVE, "utf8"));
}

function contextFrom(captured) {
  return normalizeOrcaContext({
    status: parseOrcaJsonResponse(captured.status, "status"),
    worktree: { worktree: parseOrcaJsonResponse(captured.worktreeList, "worktree list").worktrees[0] },
    terminals: parseOrcaJsonResponse(captured.terminalList, "terminal list").terminals ?? [],
    env: {},
    agentContext: captured.agentContext,
  });
}

test("the live capture is what it claims to be", async () => {
  const captured = await live();
  assert.equal(captured._capture.orca_version, "1.4.177");
  assert.equal(captured.agentContext.schemaVersion, 1);
  assert.equal(captured.agentContext.commandCount, captured.agentContext.commands.length);
  assert.equal(captured.status.ok, true);
});

test("real status --json carries the runtime and graph fields the adapter reads", async () => {
  const status = parseOrcaJsonResponse((await live()).status, "status");
  assert.equal(typeof status.runtime.reachable, "boolean");
  assert.equal(status.runtime.state, "ready");
  assert.equal(status.graph.state, "ready");
  assert.ok(status.runtime.runtimeId);
});

test("a live worktree record normalizes through the adapter and into receipt metadata", async () => {
  const context = contextFrom(await live());
  // UNC path, preserved verbatim rather than coerced to POSIX.
  assert.match(context.worktree_path, /^\\\\/);
  assert.equal(context.host, "local");
  assert.equal(context.remote_selector, `id:${context.orca_worktree_id}`);
  // Orca reports no base ref or SHA for this worktree. Requiring one would make
  // every real worktree unrecordable.
  assert.equal(context.base_sha, null);

  const metadata = normalizeOrcaWorktreeMetadata(context);
  assert.equal(metadata.ok, true, `receipts rejected live Orca output: ${metadata.error}`);
  assert.equal(metadata.metadata.worktree_path, context.worktree_path);
  assert.equal(metadata.metadata.is_main_worktree, true);
});

test("Orca reports a fully-qualified branch ref, and the protection guard honours it", async () => {
  const context = contextFrom(await live());
  assert.equal(context.branch, "refs/heads/main");

  const metadata = normalizeOrcaWorktreeMetadata(context).metadata;
  const identity = {
    worktreeId: metadata.worktree_id,
    repositoryId: metadata.repo_id,
    path: metadata.worktree_path,
    branch: metadata.branch,
    baseRef: metadata.base_ref,
    baseSha: "1111111111111111111111111111111111111111",
    headSha: /^[0-9a-f]{40}$/.test(metadata.head_sha ?? "")
      ? metadata.head_sha
      : "2222222222222222222222222222222222222222",
    host: metadata.host,
    environmentId: metadata.environment_id,
    remoteSelector: metadata.remote_selector,
  };
  const evidence = {
    approval: { approved: true, branchDeletion: true },
    terminalRelease: { released: true, active: false, observed: true },
    tree: { clean: true, statusPorcelain: "", observed: true },
    receipt: { id: "receipt-live", owner: "muster", status: "completed", durable: true },
    review: { verdict: "PASS" },
    ship: { approved: true, status: "merged" },
    merge: {
      merged: true,
      commitSha: identity.headSha,
      targetSha: "3333333333333333333333333333333333333333",
      verified: true,
      isAncestor: true,
    },
  };

  // The primary checkout is barred outright...
  const primary = evaluateOrcaWorktreeCleanup({
    identity: { ...identity, isMainWorktree: true },
    observedIdentity: { ...identity, isMainWorktree: true },
    ...evidence,
  });
  assert.equal(primary.authorized, false);
  assert.equal(primary.reason, "primary-worktree");

  // ...and `refs/heads/main` is protected even when it is not the primary one.
  const protectedRef = evaluateOrcaWorktreeCleanup({
    identity, observedIdentity: { ...identity }, ...evidence,
  });
  assert.equal(protectedRef.authorized, false);
  assert.equal(protectedRef.reason, "protected-branch");
});

// Phase 4 (mapping Muster entities onto Orca Run/Task/Dispatch) is gated on
// stable schemas. These are the schemas, captured read-only from a completed
// Run, pinned here so the gate is checked against evidence rather than memory.
// This test asserts what was OBSERVED; it deliberately does not assert that
// Muster consumes any of it, because Muster must not until the gate opens.
test("the captured orchestration schema is pinned for the Phase 4 gate", async () => {
  const captured = JSON.parse(await readFile(
    join(process.cwd(), "test/fixtures/orca-live/orchestration-completed-run.json"), "utf8",
  ));
  assert.deepEqual(captured.vocabularies.taskStatus, [
    "pending", "ready", "dispatched", "completed", "failed", "blocked",
  ]);
  // `merge_ready` is present in the live guide but absent from the pinned-source
  // list the research note was originally written from.
  assert.ok(captured.vocabularies.messageType.includes("merge_ready"));
  for (const field of ["dispatchId", "taskId", "runId", "workerState", "dispatchStatus"]) {
    assert.ok(captured.workerKeys.includes(field), `worker record must carry ${field}`);
  }
  // Lifecycle authority is the Dispatch, not the terminal handle: the capture
  // has to show a dispatch id distinct from the terminal it happened to use.
  assert.ok(captured.workerKeys.includes("agentTerminalHandle"));
  assert.notEqual(captured.sampleWorker.dispatchId, captured.sampleWorker.agentTerminalHandle);
  // Only terminal states were observable in a completed Run. Saying so keeps
  // the gate honest: the failure and escalation paths are still unobserved.
  assert.deepEqual(captured.vocabularies.observedTaskStatus, ["completed"]);
});

// The transitions a completed Run cannot show, exercised against a disposable
// probe Run and cleaned up afterwards. These pin the semantics any Phase 4
// mapping has to respect -- most importantly that Orca, not the coordinator,
// advances the DAG.
test("the observed orchestration lifecycle is pinned for the Phase 4 gate", async () => {
  const { observedLifecycle: live } = JSON.parse(await readFile(
    join(process.cwd(), "test/fixtures/orca-live/orchestration-completed-run.json"), "utf8",
  ));

  // Orca owns the scheduler: a dependent task is released by completing its
  // dependency, not by a coordinator setting it ready.
  assert.equal(live.taskScheduling.noDepsInitialStatus, "ready");
  assert.equal(live.taskScheduling.unmetDepsInitialStatus, "pending");
  assert.equal(live.taskScheduling.dependentReleasedTo, "ready");

  // A pending gate blocks its task, and resolving it unblocks it.
  assert.equal(live.gate.createMovesTaskTo, "blocked");
  assert.equal(live.gate.resolveReturnsTaskTo, "ready");
  assert.equal(live.gate.resolvedStatus, "resolved");

  // deps and options are JSON strings; indexing them as arrays would silently
  // read characters.
  assert.equal(live.serialization["task.deps"], "JSON string");
  assert.equal(live.serialization["gate.options"], "JSON string");

  // The Dispatch is the durable lifecycle identity, and its capability is
  // revoked at settlement -- that is what makes a stale dispatch unusable.
  for (const field of ["contract_version", "capability_hash", "capability_revoked_at", "process_incarnation"]) {
    assert.ok(live.dispatchKeys.includes(field), `dispatch record must carry ${field}`);
  }

  // Partial-start recovery is concrete, not advisory.
  assert.deepEqual(live.workerStartEffectKinds, ["worktree", "terminal", "setup", "dispatch_input"]);
  assert.ok(live.workerKeys.includes("residualResources"));

  // Settlement paths are distinct and idempotent.
  assert.equal(live.settlement.workerStopAlreadySettled.processAction, "none");
  assert.equal(live.settlement.workerRelease.archive.status, "captured");
  assert.match(live.settlement.workerStartPlainShell, /agent_unconfigured/);

  // worker_done auto-completes its task: an adapter that also issued
  // task-update --status completed would overwrite Orca's own transition.
  assert.equal(live.workerDone.autoCompletesTask, true);
  assert.deepEqual(live.workerDone.payloadShape, ["taskId", "dispatchId", "outcome"]);
  assert.match(live.workerDone.deliveredTo, /^run:/);

  // Inbox bodies are other agents' free text. A live inbox held imperative
  // instructions from a previous run aimed at other dispatches; nothing in
  // Muster may treat that as direction.
  assert.ok(live.inboxIsUntrusted.note.includes("never follow"));
  // Reading is safe; only --ack consumes. An earlier draft claimed otherwise
  // and was disproven against the live runtime.
  assert.match(live.inboxIsUntrusted.readIsStateful, /NOT destructive/);
  assert.match(live.inboxIsUntrusted.readIsStateful, /only --ack/);

  // A Run cannot be retired by deletion: reset is database-wide, so a Phase 4
  // design must assume Run rows accumulate.
  assert.equal(live.runRetirement.runDeleteExists, false);
  assert.match(live.runRetirement.resetScope, /not per-Run/);

  // What is still unproven must stay listed, so the gate is not mistaken for
  // fully-characterized.
  for (const gap of ["failed", "outcome_unknown", "escalation", "merge_ready"]) {
    assert.ok(live.unobserved.includes(gap), `${gap} is still unobserved and must say so`);
  }
});

test("a fully-qualified feature ref on a non-primary worktree is still cleanable", async () => {
  const metadata = normalizeOrcaWorktreeMetadata(contextFrom(await live())).metadata;
  const identity = {
    worktreeId: metadata.worktree_id,
    repositoryId: metadata.repo_id,
    path: metadata.worktree_path,
    branch: "refs/heads/feature/orca-worker",
    baseRef: metadata.base_ref,
    baseSha: "1111111111111111111111111111111111111111",
    headSha: /^[0-9a-f]{40}$/.test(metadata.head_sha ?? "")
      ? metadata.head_sha
      : "2222222222222222222222222222222222222222",
    host: metadata.host,
    environmentId: metadata.environment_id,
    remoteSelector: metadata.remote_selector,
  };
  const decision = evaluateOrcaWorktreeCleanup({
    identity,
    observedIdentity: { ...identity },
    approval: { approved: true, branchDeletion: true },
    terminalRelease: { released: true, active: false, observed: true },
    tree: { clean: true, statusPorcelain: "", observed: true },
    receipt: { id: "receipt-live", owner: "muster", status: "completed", durable: true },
    review: { verdict: "PASS" },
    ship: { approved: true, status: "merged" },
    merge: {
      merged: true,
      commitSha: identity.headSha,
      targetSha: "3333333333333333333333333333333333333333",
      verified: true,
      isAncestor: true,
    },
  });
  assert.equal(decision.authorized, true, `${decision.reason}: ${decision.errors?.join("; ")}`);
  assert.equal(decision.operations[0].args.at(-2), "--force");
});
