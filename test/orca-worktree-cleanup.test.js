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
    args: ["worktree", "rm", "--worktree", "path:/workspace/muster-worker", "--force", "--json"],
    selector: "path:/workspace/muster-worker",
    branch: "feature/muster-worker",
    branchOutcome: "remove-or-preserve",
    requiresExplicitApproval: true,
  });
  assert.deepEqual(result.operations[1], {
    type: "branch-delete-if-preserved",
    command: "git",
    args: ["branch", "-d", "--", "feature/muster-worker"],
    branch: "feature/muster-worker",
    condition: "orca-preserved-branch",
    requiresExplicitApproval: true,
  });
  assert.equal(result.stateMutation, false);
});

test("remote cleanup uses an exact id selector and never invents a local path command", async () => {
  const result = evaluateOrcaWorktreeCleanup(await fixture("remote-approved"));
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.deepEqual(result.operations.map((operation) => operation.args), [[
    "worktree", "rm", "--worktree", "id:repo-001::/srv/worktrees/muster-worker", "--force", "--json",
  ]]);
});

// Orca documents worktree deletion as removing the directory AND the branch, so
// there is no second `git branch -d` to approve -- and no way to keep a branch
// whose worktree is being removed. Both facts have to be visible in the result.
test("local cleanup plans a safe branch fallback when Orca preserves an integrated branch", async () => {
  const result = evaluateOrcaWorktreeCleanup(await fixture("local-approved"));
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.equal(result.operations.length, 2);
  assert.equal(result.operations[0].branchOutcome, "remove-or-preserve");
  assert.deepEqual(result.branchDisposition, {
    branch: "feature/muster-worker",
    expected: "removed-or-reported-preserved",
    fallback: "git branch -d after a verified preservedBranch response",
  });
  assert.equal(result.operations[1].command, "git");
});

test("branch deletion must be acknowledged because the removal cannot avoid it", async () => {
  const input = await fixture("local-approved");
  delete input.approval.branchDeletion;
  const denied = evaluateOrcaWorktreeCleanup(input);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "branch-deletion-not-approved");
  assert.deepEqual(denied.operations, []);
});

test("a request to preserve the branch fails closed rather than being silently ignored", async () => {
  const input = await fixture("local-approved");
  input.preserveBranch = true;
  const denied = evaluateOrcaWorktreeCleanup(input);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "branch-preservation-unsupported");
  assert.deepEqual(denied.operations, []);
});

test("deleting a remote-tracking branch stays outside this contract", async () => {
  const input = await fixture("remote-approved");
  input.deleteRemoteBranch = true;
  const denied = evaluateOrcaWorktreeCleanup(input);
  assert.equal(denied.ok, false);
  assert.equal(denied.reason, "remote-branch-deletion-unsupported");
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

test("worktree ids must identify the supplied path, not merely share a repository prefix", async () => {
  const input = await fixture("local-approved");
  input.identity.worktreeId = "repo-001::/workspace/other";
  input.observedIdentity.worktreeId = input.identity.worktreeId;
  input.receipt.identity.worktreeId = input.identity.worktreeId;
  const result = evaluateOrcaWorktreeCleanup(input);
  assert.equal(result.ok, false);
  assert.match(result.errors.join(";"), /worktreeId.*path/i);
});

test("branch-tip ancestry is required before planning cleanup", async () => {
  const input = await fixture("local-approved");
  input.merge.commitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
  const result = evaluateOrcaWorktreeCleanup(input);
  assert.equal(result.ok, false);
  assert.equal(result.reason, "merged-ancestry-unverified");
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
    runCommand: async (command) => {
      commands.push(command);
      return { removed: true };
    },
  });
  assert.equal(completed.ok, true, completed.errors?.join("; "));
  assert.deepEqual(commands.map((command) => command.args), [plan.operations[0].args]);
});

test("execution deletes a branch safely only when Orca explicitly reports it preserved", async () => {
  const input = await fixture("local-approved");
  const plan = evaluateOrcaWorktreeCleanup(input);
  const commands = [];
  const result = await executeOrcaWorktreeCleanup({
    plan,
    input,
    confirm: true,
    runCommand: async (command) => {
      commands.push(command);
      return command.operation === "worktree-remove"
        ? { ok: true, result: { removed: true, preservedBranch: { branchName: "feature/muster-worker", head: input.identity.headSha } } }
        : { deleted: true };
    },
  });
  assert.equal(result.ok, true, result.errors?.join("; "));
  assert.deepEqual(commands.map((command) => command.args), plan.operations.map((operation) => operation.args));
  assert.equal(result.branchRemoved, true);
});

test("execution fails closed when Orca removal does not prove its postcondition", async () => {
  const input = await fixture("local-approved");
  const result = await executeOrcaWorktreeCleanup({
    input,
    confirm: true,
    runCommand: async () => undefined,
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "cleanup-postcondition-unverified");
  assert.equal(result.stateMutation, true);
});

test("remote cleanup reports a preserved branch instead of claiming completion", async () => {
  const input = await fixture("remote-approved");
  const result = await executeOrcaWorktreeCleanup({
    input,
    confirm: true,
    runCommand: async () => ({ removed: true, preservedBranch: { branchName: input.identity.branch, head: input.identity.headSha } }),
  });
  assert.equal(result.ok, false);
  assert.equal(result.reason, "branch-preserved");
  assert.equal(result.stateMutation, true);
});

test("execution re-evaluates a supplied plan before allowing protected branch deletion", async () => {
  const input = await fixture("local-approved");
  const plan = evaluateOrcaWorktreeCleanup(input);
  const forged = structuredClone(plan);
  forged.identity.branch = "main";
  forged.operations[0].branch = "main";

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
