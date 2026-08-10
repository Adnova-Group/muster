import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  buildOrcaMusterShipHandoff,
  classifyOrcaShipAction,
  evaluateOrcaShipAction,
  ORCA_SHIP_ACTIONS,
  validateOrcaMusterShipHandoff,
} from "../src/orca-ship-gate.js";
import { buildOrcaStatusBridge } from "../src/orca-status-bridge.js";

const FIXTURE_ROOT = join(process.cwd(), "test/fixtures/orca-topology");

async function fixture(name) {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, `${name}.json`), "utf8"));
}

async function validEvidence() {
  const orca = await fixture("local");
  const muster = {
    item: { id: "item-ship", state: "reviewed" },
    attempt: { id: "attempt-ship-1", number: 1, state: "completed", phase: "review" },
    gate: { id: "gate-ship-1", state: "passed", verdict: "PASS" },
    receipt: { id: "receipt-ship-1", attempt: 1, status: "completed" },
  };
  const status = buildOrcaStatusBridge({ context: { available: true, context: orca }, muster });
  const receipt = {
    id: "receipt-ship-1",
    itemId: "item-ship",
    attemptId: "attempt-ship-1",
    phase: "review",
    status: "completed",
    reviewVerdict: "PASS",
    orca,
  };
  const handoff = buildOrcaMusterShipHandoff({
    action: "commit",
    attemptId: "attempt-ship-1",
    receiptId: "receipt-ship-1",
    branch: orca.branch,
  });
  assert.equal(handoff.ok, true);
  return { orca, status, receipt, handoff: handoff.handoff };
}

test("the five Orca ship paths have stable classifications", () => {
  assert.deepEqual(ORCA_SHIP_ACTIONS, ["commit", "push", "pull-request", "check", "direct-git"]);
  assert.equal(classifyOrcaShipAction("commit"), "commit");
  assert.equal(classifyOrcaShipAction({ command: "git push origin feature" }), "push");
  assert.equal(classifyOrcaShipAction({ command: "gh pr create --title ship" }), "pull-request");
  assert.equal(classifyOrcaShipAction({ command: "gh pr checks 42" }), "check");
  assert.equal(classifyOrcaShipAction({ command: "git status --short" }), "direct-git");
  assert.equal(classifyOrcaShipAction("unrecognized"), null);
});

test("every direct Orca path fails closed when Muster evidence is absent", () => {
  for (const action of ORCA_SHIP_ACTIONS) {
    const result = evaluateOrcaShipAction({ action, workflowOwner: "muster" });
    assert.equal(result.allowed, false, action);
    assert.equal(result.readOnly, true, action);
    assert.equal(result.stateMutation, false, action);
    assert.match(result.reason, /gate|handoff/i, action);
  }
});

test("all five paths pass only with matching status, receipt, review, and explicit handoff", async () => {
  const evidence = await validEvidence();
  for (const action of ORCA_SHIP_ACTIONS) {
    const handoff = buildOrcaMusterShipHandoff({
      action,
      attemptId: "attempt-ship-1",
      receiptId: "receipt-ship-1",
      branch: evidence.orca.branch,
    });
    const result = evaluateOrcaShipAction({
      action,
      workflowOwner: "muster",
      statusBridge: evidence.status,
      receipt: evidence.receipt,
      handoff: handoff.handoff,
    });
    assert.equal(result.allowed, true, action);
    assert.equal(result.reason, "muster-handoff-verified", action);
    assert.equal(result.stateMutation, false, action);
  }
});

test("receipt, review, identity, and handoff mismatches deny without mutating the inputs", async () => {
  const evidence = await validEvidence();
  const before = structuredClone(evidence);
  const failedGate = structuredClone(evidence.status);
  failedGate.muster.gate.verdict = "FAIL";
  assert.equal(evaluateOrcaShipAction({
    action: "push", workflowOwner: "muster", statusBridge: failedGate,
    receipt: evidence.receipt, handoff: evidence.handoff,
  }).allowed, false);

  const badReceipt = structuredClone(evidence.receipt);
  badReceipt.status = "in_flight";
  assert.equal(evaluateOrcaShipAction({
    action: "commit", workflowOwner: "muster", statusBridge: evidence.status,
    receipt: badReceipt, handoff: evidence.handoff,
  }).allowed, false);

  const badHandoff = structuredClone(evidence.handoff);
  badHandoff.attemptId = "attempt-old";
  assert.equal(evaluateOrcaShipAction({
    action: "pull-request", workflowOwner: "muster", statusBridge: evidence.status,
    receipt: evidence.receipt, handoff: badHandoff,
  }).allowed, false);
  assert.deepEqual(evidence, before);
});

test("handoff validation requires explicit Muster approval and a PASS verdict", () => {
  assert.equal(validateOrcaMusterShipHandoff(null).ok, false);
  assert.equal(validateOrcaMusterShipHandoff({
    owner: "muster", approved: true, action: "commit", attemptId: "a", receiptId: "r", branch: "b", reviewVerdict: "FAIL",
  }).ok, false);
});

test("Orca-owned work remains outside this Muster gate", () => {
  const result = evaluateOrcaShipAction({ action: "direct-git", workflowOwner: "orca" });
  assert.deepEqual(result, {
    ok: true,
    allowed: true,
    action: "direct-git",
    reason: "orca-owned-workflow",
    errors: [],
    readOnly: true,
    stateMutation: false,
  });
});
