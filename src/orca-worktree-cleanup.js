import {
  isAcceptedOrcaSelector,
  isCanonicalRuntimePath,
  isProtectedBranchName,
  shortBranchName,
  worktreeIdMatchesPath,
} from "./orca-contract.js";

// Cleanup is deliberately a policy boundary.  It consumes bounded observations
// from Orca's documented CLI/filesystem surfaces and produces commands for an
// Orca caller to approve and execute.  It never talks to Orca's RPC layer or
// database, and planning is always side-effect free.
//
// Orca normally removes the branch with the worktree, but its JSON result may
// instead report `preservedBranch` when it cannot prove the branch integrated.
// A local cleanup may then use `git branch -d` (never `-D`) after binding the
// preserved branch name and head to the reviewed, merged worktree tip.
export const ORCA_WORKTREE_CLEANUP_SCHEMA_VERSION = 3;
export const ORCA_CLEANUP_OPERATIONS = Object.freeze([
  "worktree-remove",
  "branch-delete-if-preserved",
]);
export const ORCA_CLEANUP_REASONS = Object.freeze([
  "malformed-input",
  "approval-required",
  "terminal-not-released",
  "terminal-active",
  "terminal-release-uncertain",
  "dirty-tree",
  "clean-tree-unproven",
  "identity-mismatch",
  "receipt-incomplete",
  "receipt-not-durable",
  "receipt-identity-mismatch",
  "review-not-passed",
  "ship-not-approved",
  "merged-ancestry-unverified",
  "unmerged",
  "remote-selector-invalid",
  "race-detected",
  "protected-branch",
  "primary-worktree",
  "branch-deletion-not-approved",
  "branch-preservation-unsupported",
  "remote-branch-deletion-unsupported",
  "branch-preserved",
  "cleanup-postcondition-unverified",
  "cleanup-operation-failed",
]);

const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_TEXT = 1024;
const MAX_PATH = 4096;
const RELEASED_STATES = new Set(["released", "closed", "terminated", "detached"]);
const COMPLETED_STATES = new Set(["completed", "complete", "passed", "success", "succeeded"]);
const SHIPPED_STATES = new Set(["approved", "merged", "shipped", "complete", "completed", "passed"]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function text(value, label, { optional = false, max = MAX_TEXT } = {}) {
  if (value === undefined || value === null) {
    if (optional) return null;
    throw new TypeError(`${label} is required`);
  }
  if (typeof value !== "string" || !value.trim() || value.length > max
    || /[\u0000-\u001f\u007f-\u009f]/.test(value)) {
    throw new TypeError(`${label} must be a bounded string`);
  }
  return value.trim();
}

function optionalText(value, label, options = {}) {
  return text(value, label, { ...options, optional: true });
}

function bool(value) {
  return typeof value === "boolean" ? value : null;
}

function first(value, ...keys) {
  if (!isObject(value)) return null;
  for (const key of keys) if (value[key] !== undefined && value[key] !== null) return value[key];
  return null;
}

function lower(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function sha(value, label, { optional = false } = {}) {
  const result = optionalText(value, label, { max: 40 });
  if (result === null) {
    if (optional) return null;
    throw new TypeError(`${label} must be a Git SHA`);
  }
  if (!SHA_RE.test(result)) throw new TypeError(`${label} must be a lowercase 40-character Git SHA`);
  return result;
}

function normalizeBranch(value) {
  const branch = text(value, "branch");
  if (branch.length > 512 || branch.startsWith("-") || branch.includes("..")
    || branch.includes("//") || branch.endsWith("/") || branch.endsWith(".")
    || /[\s~^:?*\\[\]\\]/.test(branch)) {
    throw new TypeError("branch is not a safe Git branch name");
  }
  return branch;
}

function normalizeIdentity(value, label = "identity") {
  if (!isObject(value)) throw new TypeError(`${label} must be an object`);
  const worktreeId = text(first(value, "worktreeId", "worktree_id", "id"), `${label}.worktreeId`);
  const repositoryId = text(first(value, "repositoryId", "repository_id", "repoId", "repo_id"), `${label}.repositoryId`);
  const path = text(first(value, "worktreePath", "worktree_path", "path"), `${label}.path`, { max: MAX_PATH });
  if (!isCanonicalRuntimePath(path)) throw new TypeError(`${label}.path must be absolute and normalized`);
  const branch = normalizeBranch(first(value, "branch", "branchName", "branch_name"));
  const baseSha = sha(first(value, "baseSha", "base_sha", "baseRevisionSha", "base_revision_sha"), `${label}.baseSha`);
  const headSha = sha(first(value, "headSha", "head_sha", "worktreeHeadSha", "worktree_head_sha"), `${label}.headSha`);
  const baseRef = optionalText(first(value, "baseRef", "base_ref", "baseBranch", "base_branch"), `${label}.baseRef`);
  const host = text(first(value, "host", "hostId", "host_id") ?? "local", `${label}.host`);
  const environmentId = text(first(value, "environmentId", "environment_id") ?? (host === "local" ? "local" : null), `${label}.environmentId`);
  // Orca marks the repository's primary checkout with `isMainWorktree`. It is
  // not a worker worktree and must never be a cleanup target, independently of
  // what branch it happens to be on.
  const isPrimary = first(value, "isMainWorktree", "is_main_worktree", "isPrimaryWorktree") === true;
  const remoteSelector = text(first(value, "remoteSelector", "remote_selector", "selector"), `${label}.remoteSelector`);
  if (!worktreeIdMatchesPath(worktreeId, repositoryId, path)) {
    throw new TypeError(`${label}.worktreeId does not identify its exact path`);
  }
  if (!isAcceptedOrcaSelector(remoteSelector, { worktreeId, path, host })) {
    throw new TypeError("remote selector does not identify the exact worktree");
  }
  if ((host === "local") !== (environmentId === "local")) throw new TypeError("host and environment identity disagree");
  return Object.freeze({
    worktreeId,
    repositoryId,
    path,
    branch,
    baseRef,
    baseSha,
    headSha,
    host,
    environmentId,
    remoteSelector,
    isPrimaryWorktree: isPrimary,
  });
}

function identityMismatches(expected, observed) {
  return [
    ["worktreeId", expected.worktreeId, observed.worktreeId],
    ["repositoryId", expected.repositoryId, observed.repositoryId],
    ["path", expected.path, observed.path],
    ["branch", expected.branch, observed.branch],
    ["baseRef", expected.baseRef, observed.baseRef],
    ["baseSha", expected.baseSha, observed.baseSha],
    ["headSha", expected.headSha, observed.headSha],
    ["host", expected.host, observed.host],
    ["environmentId", expected.environmentId, observed.environmentId],
    ["remoteSelector", expected.remoteSelector, observed.remoteSelector],
  ].filter(([, left, right]) => left !== right).map(([key]) => key);
}

function identityFrom(input, ...keys) {
  for (const key of keys) if (isObject(input?.[key])) return input[key];
  return input;
}

function releaseEvidence(input) {
  const source = first(input, "terminalRelease", "terminal_release", "releaseEvidence", "release_evidence")
    ?? (isObject(input?.terminal) ? input.terminal : input);
  if (!isObject(source)) return { state: "malformed" };
  const active = bool(first(source, "active", "isActive"));
  const released = bool(first(source, "released", "releasedEvidence", "releaseObserved"));
  const state = lower(first(source, "state", "status", "lifecycle"));
  const observed = bool(first(source, "observed", "verified", "evidence"));
  return { active, released, state, observed };
}

function treeEvidence(input) {
  const source = first(input, "tree", "cleanTree", "clean_tree", "treeProof") ?? {};
  if (!isObject(source)) return { clean: null };
  const porcelain = first(source, "statusPorcelain", "status_porcelain", "porcelain", "gitStatus");
  const clean = bool(source.clean);
  return {
    clean,
    porcelain: typeof porcelain === "string" ? porcelain : null,
    observed: bool(first(source, "observed", "verified", "proof")),
    untracked: bool(first(source, "untracked", "hasUntracked")),
    changed: bool(first(source, "changed", "hasChanges")),
    race: source.race === true || source.replaced === true,
  };
}

function receiptIdentity(receipt) {
  return first(receipt, "identity", "orca", "worktree", "topology");
}

function receiptEvidence(input) {
  const receipt = first(input, "receipt", "musterReceipt", "muster_receipt");
  if (!isObject(receipt)) return { receipt: null, status: "", durable: null, id: null };
  return {
    receipt,
    status: lower(first(receipt, "status", "state", "result")),
    durable: receipt.durable === true || lower(first(receipt, "durability", "persistence")) === "durable",
    id: optionalText(first(receipt, "id", "receiptId", "receipt_id"), "receipt.id"),
  };
}

function reviewEvidence(input) {
  const review = first(input, "review", "reviewEvidence", "review_evidence") ?? {};
  const ship = first(input, "ship", "shipEvidence", "ship_evidence", "handoff") ?? review.ship ?? {};
  return {
    review,
    ship,
    verdict: lower(first(review, "verdict", "reviewVerdict", "review_verdict", "result"))
      || lower(first(input, "reviewVerdict", "review_verdict")),
    shipApproved: ship.approved === true || ship.authorized === true,
    shipStatus: lower(first(ship, "status", "state", "result")),
  };
}

function mergeEvidence(input) {
  const source = first(input, "merge", "mergedCommit", "merged_commit", "ancestry") ?? {};
  const ancestry = isObject(source.ancestry) ? source.ancestry : source;
  const commitSha = first(ancestry, "commitSha", "commit_sha", "mergedCommitSha", "merged_commit_sha", "sha");
  const targetSha = first(ancestry, "targetSha", "target_sha", "baseHeadSha", "base_head_sha", "intoSha", "into_sha", "target", "base");
  return {
    source,
    merged: source.merged === true || source.status === "merged" || source.state === "merged",
    commitSha: commitSha === null ? null : sha(commitSha, "merge.commitSha"),
    targetSha: targetSha === null ? null : sha(targetSha, "merge.targetSha"),
    verified: ancestry.verified === true || ancestry.ancestryVerified === true || ancestry.ancestry_verified === true,
    isAncestor: ancestry.isAncestor === true || ancestry.is_ancestor === true,
    race: source.race === true || ancestry.race === true,
  };
}

// Orca reports `refs/heads/main`, so this must compare short names. A live
// worktree record proved the previous exact-string check failed open on the
// primary branch of the repository it was asked to clean up.
function protectedBranch(input, branch) {
  if (input.protectedBranch === true || input.protected_branch === true) return true;
  const extra = Array.isArray(input.protectedBranches) ? input.protectedBranches : [];
  return isProtectedBranchName(branch, extra);
}

function approvalEvidence(input) {
  const approval = isObject(input.approval) ? input.approval : {};
  return {
    approval,
    approved: approval.approved === true || approval.authorized === true || input.explicitApproval === true,
    // Orca's removal takes the branch with the worktree, so this is an
    // acknowledgement of an unavoidable effect, not an opt-in to a second one.
    branchDeleteApproved: approval.deleteBranch === true || approval.delete_branch === true
      || approval.branchDeletion === true || approval.branch_deletion === true,
    branchPreservationRequested: input.deleteBranch === false || input.delete_branch === false
      || input.preserveBranch === true || input.preserve_branch === true
      || approval.deleteBranch === false || approval.branchDeletion === false,
    remoteBranchDeletionRequested: input.deleteRemoteBranch === true || input.delete_remote_branch === true
      || input.deleteOriginBranch === true || input.deleteUpstreamBranch === true,
  };
}

function deny(reason, errors = [reason], details = {}) {
  return {
    ok: false,
    authorized: false,
    reason,
    errors: errors.filter(Boolean),
    operations: [],
    readOnly: true,
    stateMutation: false,
    ...details,
  };
}

/**
 * The single cleanup operation.
 *
 * `--force` is part of every removal example in Orca's own CLI reference and
 * overview, and deletion is documented as prompting for confirmation. This
 * command is executed non-interactively behind a caller-supplied `runCommand`,
 * so omitting `--force` risked a prompt that no one can answer.
 */
function buildRemoveOperation(identity) {
  return {
    type: "worktree-remove",
    command: "orca",
    args: ["worktree", "rm", "--worktree", identity.remoteSelector, "--force", "--json"],
    selector: identity.remoteSelector,
    branch: identity.branch,
    branchOutcome: "remove-or-preserve",
    requiresExplicitApproval: true,
  };
}

function buildBranchFallbackOperation(identity) {
  const branch = shortBranchName(identity.branch);
  return {
    type: "branch-delete-if-preserved",
    command: "git",
    args: ["branch", "-d", "--", branch],
    branch,
    condition: "orca-preserved-branch",
    requiresExplicitApproval: true,
  };
}

export function computeOrcaCleanupFingerprint(identity, evidence = {}) {
  const normalized = normalizeIdentity(identity, "fingerprint.identity");
  const stable = {
    identity: normalized,
    terminalReleaseId: optionalText(evidence.terminalReleaseId, "fingerprint.terminalReleaseId"),
    receiptId: optionalText(evidence.receiptId, "fingerprint.receiptId"),
    mergedCommitSha: evidence.mergedCommitSha ?? null,
    targetSha: evidence.targetSha ?? null,
  };
  return JSON.stringify(stable);
}

/**
 * Evaluate cleanup authorization and return deterministic, non-mutating
 * operations. Every required observation is explicit; missing or uncertain
 * evidence is a denial rather than a best effort.
 */
export function evaluateOrcaWorktreeCleanup(input = {}) {
  if (!isObject(input)) return deny("malformed-input", ["cleanup request must be an object"]);
  let identity;
  let observed;
  try {
    identity = normalizeIdentity(identityFrom(input, "identity", "expectedIdentity", "expected_identity", "worktree"));
    observed = normalizeIdentity(identityFrom(input, "observedIdentity", "observed_identity", "currentIdentity", "current_identity", "observed"), "observed identity");
  } catch (error) {
    const reason = error.message.includes("remote selector") ? "remote-selector-invalid" : "malformed-input";
    return deny(reason, [error.message]);
  }
  const mismatches = identityMismatches(identity, observed);
  if (mismatches.length) return deny("identity-mismatch", [`identity mismatch: ${mismatches.join(", ")}`], { mismatches });

  const approval = approvalEvidence(input);
  if (!approval.approved) return deny("approval-required", ["cleanup requires explicit approval"]);
  if (identity.isPrimaryWorktree || observed.isPrimaryWorktree || input.isMainWorktree === true) {
    return deny("primary-worktree", ["the repository's primary worktree is never a cleanup target"]);
  }
  if (protectedBranch(input, identity.branch)) return deny("protected-branch", ["protected branches cannot be cleaned up"]);

  if (input.raceDetected === true || input.race_detected === true || input.stateChanged === true
    || input.concurrentlyModified === true || input.precondition?.stable === false) {
    return deny("race-detected", ["cleanup observations changed during preflight"]);
  }

  const terminal = releaseEvidence(input);
  if (terminal.active === true) return deny("terminal-active", ["terminal is still active"]);
  if (terminal.released !== true && !RELEASED_STATES.has(terminal.state)) {
    return deny("terminal-not-released", ["terminal release evidence is required"]);
  }
  if (terminal.active !== false) return deny("terminal-release-uncertain", ["terminal active state is unknown"]);
  if (terminal.observed === false) return deny("terminal-release-uncertain", ["terminal release was not observed"]);

  const tree = treeEvidence(input);
  if (tree.race) return deny("race-detected", ["tree proof was replaced during preflight"]);
  if (tree.porcelain !== null && tree.porcelain !== "") return deny("dirty-tree", ["git status reports changes"]);
  if (tree.untracked === true || tree.changed === true || tree.clean === false) return deny("dirty-tree", ["worktree is dirty"]);
  if (tree.clean !== true && !(tree.porcelain === "" && tree.observed === true)) {
    return deny("clean-tree-unproven", ["clean-tree proof is required"]);
  }

  const receipt = receiptEvidence(input);
  if (!receipt.receipt || !COMPLETED_STATES.has(receipt.status)) return deny("receipt-incomplete", ["a completed Muster receipt is required"]);
  if (!receipt.durable) return deny("receipt-not-durable", ["Muster receipt durability was not proven"]);
  if (!receipt.id) return deny("receipt-incomplete", ["Muster receipt id is required"]);
  if (receipt.receipt.owner !== undefined && lower(receipt.receipt.owner) !== "muster") {
    return deny("receipt-incomplete", ["receipt owner must be Muster"]);
  }
  if (receiptIdentity(receipt.receipt) !== null) {
    try {
      const receiptWorktree = normalizeIdentity(receiptIdentity(receipt.receipt), "receipt.identity");
      const receiptMismatches = identityMismatches(identity, receiptWorktree);
      if (receiptMismatches.length) return deny("receipt-identity-mismatch", [`receipt identity mismatch: ${receiptMismatches.join(", ")}`], { mismatches: receiptMismatches });
    } catch (error) {
      return deny("receipt-identity-mismatch", [error.message]);
    }
  }

  const review = reviewEvidence(input);
  if (!isObject(review.review) || review.verdict !== "pass") return deny("review-not-passed", ["Muster review evidence must be PASS"]);
  if (!review.shipApproved && !SHIPPED_STATES.has(review.shipStatus)) return deny("ship-not-approved", ["ship evidence must be explicitly approved"]);

  let merge;
  try {
    merge = mergeEvidence(input);
  } catch (error) {
    return deny("merged-ancestry-unverified", [error.message]);
  }
  if (merge.race) return deny("race-detected", ["merge evidence changed during preflight"]);
  if (!merge.merged) return deny("unmerged", ["merged state is required"]);
  if (!merge.commitSha || !merge.targetSha || !merge.verified || !merge.isAncestor) {
    return deny("merged-ancestry-unverified", ["merged commit ancestry must be verified"]);
  }
  if (merge.commitSha !== identity.headSha) {
    return deny("merged-ancestry-unverified", ["merged commit must equal the observed worktree branch tip"]);
  }

  const expectedFingerprint = optionalText(input.precondition?.fingerprint, "precondition.fingerprint");
  const fingerprint = computeOrcaCleanupFingerprint(identity, {
    terminalReleaseId: first(input.terminalRelease ?? input.releaseEvidence, "id", "releaseId", "release_id"),
    receiptId: receipt.id,
    mergedCommitSha: merge.commitSha,
    targetSha: merge.targetSha,
  });
  if (expectedFingerprint !== null && expectedFingerprint !== fingerprint) {
    return deny("race-detected", ["cleanup precondition fingerprint does not match current evidence"]);
  }

  if (approval.remoteBranchDeletionRequested) {
    return deny("remote-branch-deletion-unsupported", ["deleting a remote-tracking branch is outside this contract"]);
  }
  if (approval.branchPreservationRequested) {
    return deny("branch-preservation-unsupported", [
      "Orca decides whether removal deletes or preserves the branch; this contract cannot guarantee preservation",
    ]);
  }
  if (!approval.branchDeleteApproved) {
    return deny("branch-deletion-not-approved", [
      "Orca worktree removal may delete the branch and requires explicit branch-deletion approval",
    ]);
  }

  const operations = [buildRemoveOperation(identity)];
  if (identity.host === "local") operations.push(buildBranchFallbackOperation(identity));
  return {
    ok: true,
    authorized: true,
    reason: null,
    errors: [],
    schemaVersion: ORCA_WORKTREE_CLEANUP_SCHEMA_VERSION,
    identity,
    operations,
    branchDisposition: {
      branch: identity.branch,
      expected: "removed-or-reported-preserved",
      ...(identity.host === "local"
        ? { fallback: "git branch -d after a verified preservedBranch response" }
        : { fallback: null }),
    },
    precondition: { fingerprint, identity, receiptId: receipt.id, mergedCommitSha: merge.commitSha, targetSha: merge.targetSha },
    readOnly: true,
    stateMutation: false,
  };
}

export const authorizeOrcaWorktreeCleanup = evaluateOrcaWorktreeCleanup;
export const planOrcaWorktreeCleanup = evaluateOrcaWorktreeCleanup;

function samePlanFingerprint(plan, decision) {
  return isObject(plan?.precondition) && plan.precondition.fingerprint === decision.precondition?.fingerprint;
}

function sameExecutionPlan(plan, decision) {
  let planIdentity;
  try {
    planIdentity = normalizeIdentity(plan.identity, "plan.identity");
  } catch {
    return false;
  }
  return samePlanFingerprint(plan, decision)
    && JSON.stringify(planIdentity) === JSON.stringify(decision.identity)
    && JSON.stringify(plan.operations) === JSON.stringify(decision.operations);
}

function isSafeExecutionPlan(plan) {
  if (!isObject(plan) || plan.authorized !== true || !isObject(plan.identity)
    || !isObject(plan.precondition) || typeof plan.precondition.fingerprint !== "string") return false;
  let identity;
  try {
    identity = normalizeIdentity(plan.identity, "plan.identity");
  } catch {
    return false;
  }
  const expected = [buildRemoveOperation(identity)];
  if (identity.host === "local") expected.push(buildBranchFallbackOperation(identity));
  if (!Array.isArray(plan.operations) || plan.operations.length !== expected.length) return false;
  return plan.operations.every((operation, index) => JSON.stringify(operation) === JSON.stringify(expected[index]));
}

function commandResult(value) {
  return isObject(value?.result) ? value.result : value;
}

/**
 * Execute only a previously authorized plan after explicit confirmation. The
 * optional readState callback is a public-CLI recheck seam; if supplied, its
 * normalized observation must produce the exact same fingerprint before any
 * mutating command is invoked.
 */
export async function executeOrcaWorktreeCleanup({ input, plan, confirm = false, readState, runCommand } = {}) {
  const decision = evaluateOrcaWorktreeCleanup(input);
  if (!decision?.authorized) return decision?.reason ? decision : deny("approval-required", ["cleanup plan is not authorized"]);
  if (plan && (!isSafeExecutionPlan(plan) || !sameExecutionPlan(plan, decision))) {
    return deny("malformed-input", ["cleanup plan is not the evaluator-authorized plan"]);
  }
  if (confirm !== true) return deny("approval-required", ["cleanup execution requires explicit confirmation"]);
  if (typeof runCommand !== "function") return deny("malformed-input", ["runCommand callback is required for execution"]);
  if (typeof readState === "function") {
    let current;
    try {
      current = await readState({ selector: decision.identity.remoteSelector, identity: decision.identity });
    } catch (error) {
      return deny("race-detected", [`cleanup recheck failed: ${error.message}`]);
    }
    const currentInput = isObject(current)
      ? { ...(isObject(input) ? input : {}), ...current,
        observedIdentity: current.observedIdentity ?? current.observed_identity ?? current.identity ?? current }
      : input;
    const fresh = evaluateOrcaWorktreeCleanup(currentInput);
    if (!fresh.authorized || !samePlanFingerprint(decision, fresh)) {
      return deny("race-detected", ["cleanup recheck did not match the authorized precondition"]);
    }
  }
  const completed = [];
  let mutationAttempted = false;
  try {
    const remove = decision.operations[0];
    mutationAttempted = true;
    const response = commandResult(await runCommand({
      command: remove.command,
      args: [...remove.args],
      operation: remove.type,
      selector: remove.selector,
      branch: remove.branch,
    }));
    if (!isObject(response) || response.removed !== true) {
      return {
        ok: false,
        authorized: true,
        reason: "cleanup-postcondition-unverified",
        errors: ["Orca removal did not return a verified removed=true postcondition"],
        completed,
        operations: decision.operations,
        readOnly: false,
        stateMutation: true,
      };
    }
    completed.push(remove.type);

    if (response.preservedBranch !== undefined && !isObject(response.preservedBranch)) {
      return {
        ok: false,
        authorized: true,
        reason: "cleanup-postcondition-unverified",
        errors: ["Orca returned malformed preservedBranch evidence"],
        completed,
        operations: decision.operations,
        readOnly: false,
        stateMutation: true,
      };
    }
    const preserved = response.preservedBranch;
    if (preserved) {
      const branch = optionalText(first(preserved, "branchName", "branch_name", "branch"), "preservedBranch.branchName");
      const head = sha(first(preserved, "head", "headSha", "head_sha"), "preservedBranch.head");
      if (shortBranchName(branch) !== shortBranchName(decision.identity.branch) || head !== decision.identity.headSha) {
        return deny("race-detected", ["preserved branch identity does not match the authorized worktree tip"], {
          authorized: true,
          completed,
          operations: decision.operations,
          readOnly: false,
          stateMutation: true,
        });
      }
      const fallback = decision.operations[1];
      if (!fallback) {
        return deny("branch-preserved", ["Orca preserved the remote branch; cleanup requires host-side branch disposition"], {
          authorized: true,
          completed,
          operations: decision.operations,
          preservedBranch: preserved,
          readOnly: false,
          stateMutation: true,
        });
      }
      await runCommand({
        command: fallback.command,
        args: [...fallback.args],
        operation: fallback.type,
        branch: fallback.branch,
      });
      completed.push(fallback.type);
      return {
        ok: true,
        authorized: true,
        reason: null,
        errors: [],
        completed,
        operations: decision.operations,
        branchRemoved: true,
        branchRemovedBy: "git-safe-delete",
        readOnly: false,
        stateMutation: true,
      };
    }
    return {
      ok: true,
      authorized: true,
      reason: null,
      errors: [],
      completed,
      operations: decision.operations,
      branchRemoved: true,
      branchRemovedBy: "orca",
      readOnly: false,
      stateMutation: true,
    };
  } catch (error) {
    return {
      ok: false,
      authorized: true,
      reason: "cleanup-operation-failed",
      errors: [error?.message || "cleanup operation failed"],
      completed,
      operations: decision.operations,
      readOnly: false,
      stateMutation: mutationAttempted,
    };
  }
}

export const applyOrcaWorktreeCleanup = executeOrcaWorktreeCleanup;
