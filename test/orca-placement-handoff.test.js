import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { normalizeOrcaContext } from "../src/orca-context-adapter.js";
import { probeOrcaAgentCapabilities } from "../src/orca-agent-capability-probe.js";
import { buildOrcaStatusBridge } from "../src/orca-status-bridge.js";
import {
  ORCA_PLACEMENT_HANDOFF_STATES,
  cancelOrcaPlacementHandoff,
  createOrcaPlacementLedger,
  handoffMusterAttemptToOrca,
  prepareOrcaPlacementHandoff,
  recoverOrcaPlacementHandoff,
  validateOrcaPlacementRecord,
  validateOrcaPlacementRequest,
} from "../src/orca-placement-handoff.js";

const FIXTURE_ROOT = join(process.cwd(), "test/fixtures/orca-context");

async function fixture(name = "local") {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, `${name}.json`), "utf8"));
}

async function setup({ name = "local", attemptId = "attempt-1", number = 1, state = "ready", targetKind = "terminal", priorAttemptId = null } = {}) {
  const data = await fixture(name);
  const context = normalizeOrcaContext({ status: data.status, worktree: data.worktree, terminals: data.terminals.terminals, env: data.env, agentContext: data.agentContext });
  if (!context.base_sha) context.base_sha = "1111111111111111111111111111111111111111";
  if (targetKind === "remote") {
    context.host = "ssh:placement-host";
    context.environment_id = "placement-environment";
    context.environment_kind = "ssh";
    context.host_info = { id: context.host, kind: context.environment_kind, runtime_id: context.orca_runtime_id, environment_id: context.environment_id };
  }
  const contextResult = { schemaVersion: 1, available: true, context };
  const capability = await probeOrcaAgentCapabilities({ profile: "codex", contextResult });
  const attempt = {
    id: attemptId,
    task_id: "task-placement",
    number,
    state,
    manifest_version: "manifest-1",
    base_sha: context.base_sha,
  };
  const muster = { item: { id: "task-placement", state: "in_flight" }, attempt };
  const status = buildOrcaStatusBridge({ context: contextResult, capabilityProbe: capability, muster });
  const target = targetKind === "terminal"
    ? { kind: "terminal", worktree_id: context.orca_worktree_id, terminal_handle: context.terminal_handle, remote_selector: context.remote_selector }
    : { kind: "remote", worktree_id: context.orca_worktree_id, host: context.host, environment_id: context.environment_id, remote_selector: context.remote_selector };
  return { context: contextResult, capability, status, attempt, target, optIn: true, priorAttemptId };
}

test("placement is inert by default and never creates an Orca graph mapping", async () => {
  const options = await setup();
  assert.throws(() => prepareOrcaPlacementHandoff({ ...options, optIn: false }), /optIn: true/);
  const ledger = createOrcaPlacementLedger();
  const result = await handoffMusterAttemptToOrca({ request: { ...options, optIn: false }, ledger, startWorker: () => { throw new Error("must not run"); } });
  assert.equal(result.outcome, "rejected");
  assert.deepEqual(ledger.values(), []);
});

test("one terminal placement is exactly-once and a duplicate does not call Orca again", async () => {
  const options = await setup();
  const request = prepareOrcaPlacementHandoff(options);
  const ledger = createOrcaPlacementLedger();
  let starts = 0;
  const startWorker = async ({ request: received, argv }) => {
    starts += 1;
    assert.equal(received.attempt_id, request.attempt_id);
    assert.deepEqual(argv, ["orchestration", "worker-start", "--agent", "codex", "--json"]);
    return { ok: true, worker_id: "worker-1", terminal_handle: "term-local" };
  };
  const first = await handoffMusterAttemptToOrca({ request, ledger, startWorker });
  const second = await handoffMusterAttemptToOrca({ request, ledger, startWorker });
  assert.equal(first.outcome, "created");
  assert.equal(second.outcome, "duplicate");
  assert.equal(starts, 1);
  assert.equal(first.record.state, "placed");
  assert.deepEqual(first.record.orca_mapping, { run_id: null, task_id: null, dispatch_id: null });
});

test("remote placement requires an explicit non-local selector and retains no Run/Task/Dispatch IDs", async () => {
  const options = await setup({ targetKind: "remote" });
  const request = prepareOrcaPlacementHandoff(options);
  const ledger = createOrcaPlacementLedger();
  const result = await handoffMusterAttemptToOrca({ request, ledger, startWorker: async () => ({ ok: true, worker_id: "remote-worker", remote_selector: request.target.remote_selector }) });
  assert.equal(result.outcome, "created");
  assert.equal(result.record.target.kind, "remote");
  assert.match(result.record.remote_selector, /^id:repo-local::\//);
  assert.deepEqual(result.record.orca_mapping, { run_id: null, task_id: null, dispatch_id: null });
});

test("partial worker start is fenced for recovery and cannot be started twice", async () => {
  const options = await setup();
  const request = prepareOrcaPlacementHandoff(options);
  const ledger = createOrcaPlacementLedger();
  let starts = 0;
  const startWorker = async () => { starts += 1; return { ok: false, worker_id: "orphan-worker", error: "response lost" }; };
  const first = await handoffMusterAttemptToOrca({ request, ledger, startWorker });
  const retry = await handoffMusterAttemptToOrca({ request, ledger, startWorker });
  assert.equal(first.outcome, "recovery-required");
  assert.equal(first.record.state, "recovery-required");
  assert.equal(retry.outcome, "duplicate");
  assert.equal(starts, 1);
});

test("a no-effect failure can be retried only as a new Muster attempt", async () => {
  const firstOptions = await setup({ attemptId: "attempt-failed", number: 1 });
  const firstRequest = prepareOrcaPlacementHandoff(firstOptions);
  const secondOptions = await setup({ attemptId: "attempt-retry", number: 2, priorAttemptId: "attempt-failed" });
  const secondRequest = prepareOrcaPlacementHandoff(secondOptions);
  const ledger = createOrcaPlacementLedger();
  const failed = await handoffMusterAttemptToOrca({ request: firstRequest, ledger, startWorker: async () => ({ ok: false, error: "rejected before launch" }) });
  const retried = await handoffMusterAttemptToOrca({ request: secondRequest, ledger, startWorker: async () => ({ ok: true, worker_id: "worker-retry", terminal_handle: "term-local" }) });
  assert.equal(failed.record.state, "failed");
  assert.equal(retried.outcome, "created");
  assert.equal(retried.record.state, "placed");
  assert.equal(retried.record.attempt_id, "attempt-retry");
});

test("retry cannot reference an active prior placement", async () => {
  const firstOptions = await setup({ attemptId: "attempt-active" });
  const secondOptions = await setup({ attemptId: "attempt-invalid-retry", number: 2, priorAttemptId: "attempt-active" });
  const ledger = createOrcaPlacementLedger();
  const first = await handoffMusterAttemptToOrca({ request: prepareOrcaPlacementHandoff(firstOptions), ledger, startWorker: async () => ({ ok: true, worker_id: "worker-active", terminal_handle: "term-local" }) });
  assert.equal(first.record.state, "placed");
  const second = await handoffMusterAttemptToOrca({ request: prepareOrcaPlacementHandoff(secondOptions), ledger, startWorker: async () => ({ ok: true, worker_id: "should-not-start" }) });
  assert.equal(second.outcome, "rejected");
  assert.match(second.errors[0], /prior attempt is not terminal/);
});

test("cancellation is explicit, exactly-once, and preserves the worker identity", async () => {
  const options = await setup();
  const request = prepareOrcaPlacementHandoff(options);
  const ledger = createOrcaPlacementLedger();
  let cancellations = 0;
  const start = await handoffMusterAttemptToOrca({ request, ledger, startWorker: async () => ({ ok: true, worker_id: "worker-cancel", terminal_handle: "term-local" }) });
  const cancelWorker = async ({ worker_id }) => { cancellations += 1; assert.equal(worker_id, "worker-cancel"); return { ok: true }; };
  const cancelled = await cancelOrcaPlacementHandoff({ request, ledger, cancelWorker });
  const duplicate = await cancelOrcaPlacementHandoff({ request, ledger, cancelWorker });
  assert.equal(start.record.state, "placed");
  assert.equal(cancelled.outcome, "cancelled");
  assert.equal(duplicate.outcome, "duplicate");
  assert.equal(cancellations, 1);
  assert.equal(cancelled.record.cancelled_worker_id, "worker-cancel");
});

test("cancellation without a recovered worker remains fenced instead of guessing", async () => {
  const options = await setup();
  const request = prepareOrcaPlacementHandoff(options);
  const ledger = createOrcaPlacementLedger();
  await handoffMusterAttemptToOrca({ request, ledger, startWorker: async () => ({ ok: false, error: "lost response" }) });
  const result = await cancelOrcaPlacementHandoff({ request, ledger, cancelWorker: async () => ({ ok: true }) });
  assert.equal(result.outcome, "rejected");
  assert.match(result.errors[0], /no live placement/);
});

test("recovery accepts one matching worker and rejects a conflicting duplicate identity", async () => {
  const options = await setup();
  const request = prepareOrcaPlacementHandoff(options);
  const ledger = createOrcaPlacementLedger();
  await handoffMusterAttemptToOrca({ request, ledger, startWorker: async () => ({ ok: false, worker_id: "worker-recovered", terminal_handle: "term-local" }) });
  const recovered = await recoverOrcaPlacementHandoff({ request, ledger, observed: { ok: true, worker_id: "worker-recovered", terminal_handle: "term-local" } });
  assert.equal(recovered.outcome, "recovered");
  assert.equal(recovered.record.state, "placed");
  const duplicate = await recoverOrcaPlacementHandoff({ request, ledger, observed: { ok: true, worker_id: "worker-other", terminal_handle: "term-local" } });
  assert.equal(duplicate.outcome, "rejected");
  assert.match(duplicate.errors[0], /not recoverable/);
});

test("context, topology, status, capability, and terminal identity mismatches fail closed", async () => {
  const options = await setup();
  const badTarget = { ...options, target: { ...options.target, terminal_handle: "term-other" } };
  assert.throws(() => prepareOrcaPlacementHandoff(badTarget), /terminal identity/);
  const badStatus = { ...options, status: structuredClone(options.status) };
  badStatus.status.orca.lifecycle.state = "reconnecting";
  assert.throws(() => prepareOrcaPlacementHandoff(badStatus), /lifecycle is not ready/);
  const badCapability = { ...options, capability: structuredClone(options.capability) };
  badCapability.capability.capabilities["working-directory"].status = "UNKNOWN";
  assert.throws(() => prepareOrcaPlacementHandoff(badCapability), /working-directory capability/);
});

test("request and record validators reject forged opt-in, identity, and graph mappings", async () => {
  const options = await setup();
  const request = prepareOrcaPlacementHandoff(options);
  const noOptIn = validateOrcaPlacementRequest({ ...request, opt_in: false });
  assert.equal(noOptIn.ok, false);
  const forged = validateOrcaPlacementRequest({ ...request, orca_mapping: { run_id: "run-1", task_id: null, dispatch_id: null } });
  assert.equal(forged.ok, false);
  const ledger = createOrcaPlacementLedger();
  const result = await handoffMusterAttemptToOrca({ request, ledger, startWorker: async () => ({ ok: true, worker_id: "worker-validator", terminal_handle: "term-local" }) });
  assert.deepEqual(validateOrcaPlacementRecord(result.record), { ok: true, errors: [] });
  const invalid = validateOrcaPlacementRecord({ ...result.record, orca_mapping: { run_id: "run-1", task_id: null, dispatch_id: null } });
  assert.equal(invalid.ok, false);
  assert.match(invalid.errors.join(";"), /Run\/Task\/Dispatch/);
});

test("the handoff contract exposes a bounded state set for recovery consumers", () => {
  assert.ok(ORCA_PLACEMENT_HANDOFF_STATES.includes("starting"));
  assert.ok(ORCA_PLACEMENT_HANDOFF_STATES.includes("recovery-required"));
  assert.ok(ORCA_PLACEMENT_HANDOFF_STATES.includes("cancelled"));
  assert.equal(new Set(ORCA_PLACEMENT_HANDOFF_STATES).size, ORCA_PLACEMENT_HANDOFF_STATES.length);
});
