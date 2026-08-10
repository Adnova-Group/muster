import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  computeOrcaCleanupFingerprint,
  evaluateOrcaWorktreeCleanup,
  executeOrcaWorktreeCleanup,
} from "../src/orca-worktree-cleanup.js";

const FIXTURES = join(process.cwd(), "test/fixtures/orca-cleanup");

async function fixture(name) {
  return JSON.parse(await readFile(join(FIXTURES, `${name}.json`), "utf8"));
}

test("local cleanup requires all terminal, tree, receipt, review, ship, and ancestry evidence", async () => {
  const input = await fixture("local-approved");
  const result = evaluateOrcaWorktreeCleanup(input);
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.equal(result.authorized, true);
  assert.deepEqual(result.operations[0], {
    type: "worktree-remove",
    command: "orca",
    args: ["worktree", "rm", "--worktree", "path:/workspace/muster-worker", "--json"],
    selector: "path:/workspace/muster-worker",
    requiresExplicitApproval: true,
  });
  assert.equal(result.operations.length, 1);
  assert.equal(result.stateMutation, false);
});

test("remote cleanup uses an exact id selector and never invents a local path command", async () => {
  const result = evaluateOrcaWorktreeCleanup(await fixture("remote-approved"));
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.deepEqual(result.operations.map((operation) => operation.args), [[
    "worktree", "rm", "--worktree", "id:repo-001::/srv/worktrees/muster-worker", "--json",
  ]]);
});

test("branch deletion is optional and separately approved", async () => {
  const input = await fixture("local-approved");
  input.deleteBranch = true;
  let denied = evaluateOrcaWorktreeCleanup(input);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "branch-deletion-not-approved");
  input.approval.branchDeletion = true;
  const result = evaluateOrcaWorktreeCleanup(input);
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.deepEqual(result.operations.at(-1).args, ["branch", "-d", "--", "feature/muster-worker"]);
});

for (const [label, mutate, reason] of [
  ["dirty", (input) => { input.tree.clean = false; input.tree.statusPorcelain = " M file"; }, "dirty-tree"],
  ["active terminal", (input) => { input.terminalRelease.active = true; }, "terminal-active"],
  ["unmerged", (input) => { input.merge.merged = false; }, "unmerged"],
  ["identity mismatch", (input) => { input.observedIdentity.branch = "feature/other"; }, "identity-mismatch"],
  ["protected branch", (input) => { input.identity.branch = "main"; input.observedIdentity.branch = "main"; }, "protected-branch"],
  ["race", (input) => { input.raceDetected = true; }, "race-detected"],
]) {
  test(`denies ${label} state before producing an operation`, async () => {
    const input = await fixture("local-approved");
    mutate(input);
    const result = evaluateOrcaWorktreeCleanup(input);
    assert.equal(result.ok, false);
    assert.equal(result.authorized, false);
    assert.equal(result.reason, reason);
    assert.deepEqual(result.operations, []);
  });
}

test("malformed or unsafe remote selectors fail closed", async () => {
  const input = await fixture("remote-approved");
  input.identity.remoteSelector = "path:/srv/worktrees/muster-worker";
  input.observedIdentity.remoteSelector = input.identity.remoteSelector;
  const result = evaluateOrcaWorktreeCleanup(input);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "remote-selector-invalid");
});

test("denied cleanup never invokes the mutating command seam", async () => {
  const input = await fixture("local-approved");
  input.tree.statusPorcelain = "?? untracked";
  let calls = 0;
  const result = await executeOrcaWorktreeCleanup({
    input,
    confirm: true,
    runCommand: async () => { calls += 1; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "dirty-tree");
  assert.equal(calls, 0);
});

test("execution requires confirmation and rechecks the exact precondition before mutation", async () => {
  const input = await fixture("local-approved");
  const plan = evaluateOrcaWorktreeCleanup(input);
  let calls = 0;
  const unconfirmed = await executeOrcaWorktreeCleanup({ plan, input, runCommand: async () => { calls += 1; } });
  assert.equal(unconfirmed.reason, "approval-required");
  assert.equal(calls, 0);

  const raced = await executeOrcaWorktreeCleanup({
    plan,
    input,
    confirm: true,
    readState: async () => ({ ...input, observedIdentity: { ...input.observedIdentity, branch: "feature/replaced" } }),
    runCommand: async () => { calls += 1; },
  });
  assert.equal(raced.reason, "race-detected");
  assert.equal(calls, 0);

  const commands = [];
  const completed = await executeOrcaWorktreeCleanup({
    plan,
    input,
    confirm: true,
    readState: async () => input,
    runCommand: async (command) => { commands.push(command); },
  });
  assert.equal(completed.ok, true, completed.errors?.join("; "));
  assert.deepEqual(commands.map((command) => command.args), [plan.operations[0].args]);
});

test("execution re-evaluates a supplied plan before allowing protected branch deletion", async () => {
  const input = await fixture("local-approved");
  input.deleteBranch = true;
  input.approval.branchDeletion = true;
  const plan = evaluateOrcaWorktreeCleanup(input);
  const forged = structuredClone(plan);
  forged.identity.branch = "main";
  forged.operations[1].branch = "main";
  forged.operations[1].args = ["branch", "-d", "--", "main"];

  let calls = 0;
  const result = await executeOrcaWorktreeCleanup({
    input,
    plan: forged,
    confirm: true,
    runCommand: async () => { calls += 1; },
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "malformed-input");
  assert.equal(calls, 0);
});

test("fingerprints are stable and bind identity plus merge evidence", async () => {
  const input = await fixture("local-approved");
  const plan = evaluateOrcaWorktreeCleanup(input);
  assert.equal(plan.precondition.fingerprint, computeOrcaCleanupFingerprint(input.identity, {
    terminalReleaseId: "release-local-1",
    receiptId: "receipt-local-1",
    mergedCommitSha: input.merge.commitSha,
    targetSha: input.merge.targetSha,
  }));
});
