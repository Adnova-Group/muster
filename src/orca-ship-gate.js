import {
  canMutateAuthorityState,
  ORCA_AUTHORITY_CONTRACT,
  validateOrcaAuthorityContract,
} from "./orca-authority.js";
import { validateOrcaStatusBridge } from "./orca-status-bridge.js";
import {
  normalizeOrcaWorktreeMetadata,
  validateOrcaReceipt,
} from "./orca-worktree-receipts.js";

// This is a pure boundary decision.  It does not invoke the Orca CLI, write a
// checkpoint, update a Run/Task, or alter a Muster receipt.  A caller can use
// the result to deny an Orca source-control request before handing it to Orca.
export const ORCA_SHIP_GATE_SCHEMA_VERSION = 1;
export const ORCA_SHIP_ACTIONS = Object.freeze([
  "commit",
  "push",
  "pull-request",
  "check",
  "direct-git",
]);

const MUSTER_WORKFLOW_AUTHORITY = Object.freeze({
  concern: "commits",
  state: "muster-gated-workflow",
  owner: "muster",
});

const ACTION_ALIASES = new Map([
  ["commit", "commit"],
  ["commits", "commit"],
  ["git-commit", "commit"],
  ["git_commit", "commit"],
  ["push", "push"],
  ["git-push", "push"],
  ["git_push", "push"],
  ["pull-request", "pull-request"],
  ["pull_request", "pull-request"],
  ["pull request", "pull-request"],
  ["pullrequest", "pull-request"],
  ["pr", "pull-request"],
  ["create-pr", "pull-request"],
  ["check", "check"],
  ["checks", "check"],
  ["status-check", "check"],
  ["direct-git", "direct-git"],
  ["direct_git", "direct-git"],
  ["git", "direct-git"],
]);

const SHIP_COMMANDS = Object.freeze([
  { expression: /\bgit\s+commit\b/i, action: "commit" },
  { expression: /\bgit\s+push\b/i, action: "push" },
  { expression: /\b(?:gh|git)\s+(?:pr\s+create|pull-request\s+create)\b/i, action: "pull-request" },
  { expression: /\b(?:gh\s+pr\s+(?:checks|status)|git\s+diff\s+[^\n]*--check|git\s+fsck)\b/i, action: "check" },
  { expression: /\bgit\b/i, action: "direct-git" },
]);

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function ownString(value, ...keys) {
  if (!isObject(value)) return null;
  for (const key of keys) {
    if (typeof value[key] === "string" && value[key].trim()) return value[key].trim();
  }
  return null;
}

function ownBoolean(value, ...keys) {
  if (!isObject(value)) return null;
  for (const key of keys) if (typeof value[key] === "boolean") return value[key];
  return null;
}

function normalized(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

/**
 * Resolve the small, stable set of Orca source-control paths.  Payload form is
 * accepted as a convenience for adapters: `{tool_name:"Bash", tool_input:{command}}`.
 * Unknown input is intentionally null so an integration cannot accidentally
 * treat an unrecognized operation as a safe ship action.
 */
export function classifyOrcaShipAction(input) {
  const raw = typeof input === "string"
    ? input
    : ownString(input, "action", "operation", "path", "route", "kind");
  const command = typeof input === "object"
    ? ownString(input?.tool_input, "command") ?? ownString(input, "command")
    : null;
  const candidate = normalized(raw);
  if (ACTION_ALIASES.has(candidate)) return ACTION_ALIASES.get(candidate);
  if (command) {
    for (const entry of SHIP_COMMANDS) if (entry.expression.test(command)) return entry.action;
  }
  return null;
}

function receiptId(receipt) {
  return ownString(receipt, "id", "receiptId", "receipt_id");
}

function attemptId(receipt) {
  const attempt = isObject(receipt?.attempt) ? receipt.attempt : {};
  return ownString(receipt, "attemptId", "attempt_id")
    ?? ownString(attempt, "id", "attemptId", "attempt_id");
}

function receiptStatus(receipt) {
  return normalized(ownString(receipt, "status", "state", "result"));
}

function receiptVerdict(receipt) {
  const gate = isObject(receipt?.gate) ? receipt.gate : {};
  return normalized(ownString(receipt, "reviewVerdict", "review_verdict", "verdict")
    ?? ownString(gate, "verdict", "result", "decision"));
}

function statusAttemptId(status) {
  return ownString(status?.muster?.attempt, "id", "attemptId", "attempt_id");
}

function statusReceiptId(status) {
  return ownString(status?.muster?.receipt, "id", "receiptId", "receipt_id");
}

function statusGateVerdict(status) {
  return normalized(ownString(status?.muster?.gate, "verdict", "result", "decision"));
}

function statusReceiptStatus(status) {
  return normalized(ownString(status?.muster?.receipt, "status", "state", "result"));
}

function ownerOf(input) {
  return normalized(
    ownString(input, "workflowOwner", "workflow_owner", "owner")
      ?? ownString(input?.workflow, "owner", "workflowOwner", "workflow_owner")
      ?? ownString(input?.authority, "owner"),
  );
}

function errorsResult(...errors) {
  return { ok: false, errors: errors.filter(Boolean) };
}

function handoffValues(handoff) {
  const source = isObject(handoff) ? handoff : {};
  const authority = isObject(source.authority) ? source.authority : {};
  return {
    approved: ownBoolean(source, "approved", "authorized", "explicit")
      ?? ownBoolean(authority, "approved", "authorized", "explicit"),
    owner: normalized(ownString(source, "owner", "workflowOwner", "workflow_owner")
      ?? ownString(authority, "owner")),
    action: classifyOrcaShipAction(source),
    attemptId: ownString(source, "attemptId", "attempt_id")
      ?? ownString(source.attempt, "id", "attemptId", "attempt_id"),
    receiptId: ownString(source, "receiptId", "receipt_id")
      ?? ownString(source.receipt, "id", "receiptId", "receipt_id"),
    branch: ownString(source, "branch", "branch_name"),
    reviewVerdict: normalized(ownString(source, "reviewVerdict", "review_verdict", "verdict")),
  };
}

/** Build a bounded, serializable handoff record for the caller to persist. */
export function buildOrcaMusterShipHandoff({ action, attemptId: attempt, receiptId: receipt, branch, reviewVerdict = "PASS" } = {}) {
  const normalizedAction = classifyOrcaShipAction(action);
  if (!normalizedAction || !attempt || !receipt || !branch) {
    return { ok: false, errors: ["handoff requires a known action, attemptId, receiptId, and branch"], handoff: null };
  }
  if (typeof attempt !== "string" || typeof receipt !== "string" || typeof branch !== "string") {
    return { ok: false, errors: ["handoff identity fields must be strings"], handoff: null };
  }
  if (normalized(reviewVerdict) !== "pass") {
    return { ok: false, errors: ["handoff requires a PASS review verdict"], handoff: null };
  }
  return {
    ok: true,
    errors: [],
    handoff: {
      schemaVersion: ORCA_SHIP_GATE_SCHEMA_VERSION,
      owner: "muster",
      authority: { concern: "commits", state: "muster-gated-workflow", owner: "muster" },
      approved: true,
      action: normalizedAction,
      attemptId: attempt.trim(),
      receiptId: receipt.trim(),
      branch: branch.trim(),
      reviewVerdict: "PASS",
    },
  };
}

export function validateOrcaMusterShipHandoff(handoff) {
  const values = handoffValues(handoff);
  const errors = [];
  if (!isObject(handoff)) errors.push("handoff must be an object");
  if (values.approved !== true) errors.push("handoff must be explicitly approved");
  if (values.owner !== "muster") errors.push("handoff owner must be muster");
  if (!values.action) errors.push("handoff action is unknown");
  if (!values.attemptId) errors.push("handoff attemptId is required");
  if (!values.receiptId) errors.push("handoff receiptId is required");
  if (!values.branch) errors.push("handoff branch is required");
  if (values.reviewVerdict !== "pass") errors.push("handoff reviewVerdict must be PASS");
  return { ok: errors.length === 0, errors };
}

function validateMusterAuthority() {
  const contract = validateOrcaAuthorityContract(ORCA_AUTHORITY_CONTRACT);
  // The canonical contract is deliberately imported through the authority
  // predicate below.  This guard must fail closed if that predicate ever stops
  // recognizing the canonical Muster-owned commit authority.
  const allowed = canMutateAuthorityState(
    MUSTER_WORKFLOW_AUTHORITY.concern,
    MUSTER_WORKFLOW_AUTHORITY.state,
    MUSTER_WORKFLOW_AUTHORITY.owner,
  );
  return contract.ok && allowed
    ? { ok: true, errors: [] }
    : errorsResult("Muster commit authority contract is unavailable or malformed");
}

function validateEvidence({ status, receipt, expectedContext }) {
  const errors = [];
  const statusResult = validateOrcaStatusBridge(status);
  if (!status || !statusResult.ok) errors.push("Muster status bridge is missing or invalid");
  if (status?.readOnly !== true) errors.push("Muster status bridge must remain read-only");
  if (status?.availability !== "available") errors.push("Orca status is unavailable");
  if (status?.orca?.lifecycle?.state !== "ready") errors.push("Orca worktree is not ready to ship");
  if (status?.correlation?.status === "mismatch") errors.push("Orca worktree identity does not match");

  if (!receipt) {
    errors.push("Muster receipt is required");
  } else {
    const receiptResult = validateOrcaReceipt(receipt, expectedContext);
    if (!receiptResult.ok) errors.push("Muster receipt is invalid");
    if (!["completed", "complete", "passed"].includes(receiptStatus(receipt))) {
      errors.push("Muster receipt is not complete");
    }
    if (receiptVerdict(receipt) && receiptVerdict(receipt) !== "pass") {
      errors.push("Muster receipt review verdict is not PASS");
    }
    const statusWorktree = status?.orca?.worktree;
    const normalizedReceipt = normalizeOrcaWorktreeMetadata(receipt.orca);
    const receiptWorktree = normalizedReceipt.ok ? normalizedReceipt.metadata : null;
    if (statusWorktree && receiptWorktree) {
      const identityPairs = [
        ["worktree id", statusWorktree.id, receiptWorktree.worktree_id],
        ["repository id", statusWorktree.repository_id, receiptWorktree.repo_id],
        ["worktree path", statusWorktree.path, receiptWorktree.worktree_path],
        ["branch", statusWorktree.branch, receiptWorktree.branch],
        ["base SHA", statusWorktree.base_sha, receiptWorktree.base_sha],
      ];
      for (const [label, statusValue, receiptValue] of identityPairs) {
        if (statusValue !== null && statusValue !== undefined && statusValue !== receiptValue) {
          errors.push(`Orca ${label} does not match receipt`);
        }
      }
    }
  }

  const attempt = attemptId(receipt);
  if (status && attempt && statusAttemptId(status) !== attempt) errors.push("Muster attempt does not match receipt");
  const statusReceipt = statusReceiptId(status);
  const id = receiptId(receipt);
  if (status && id && statusReceipt && statusReceipt !== id) errors.push("Muster receipt does not match status");
  if (status && statusGateVerdict(status) !== "pass") errors.push("Muster review gate has not passed");
  if (status && statusReceiptStatus(status) && !["completed", "complete", "passed"].includes(statusReceiptStatus(status))) {
    errors.push("Muster status receipt is not complete");
  }
  return { ok: errors.length === 0, errors };
}

/**
 * Decide whether an Orca source-control request may proceed.  The default is
 * deny: ownership, status, receipt, review, identity, and explicit handoff
 * evidence must all be present and mutually consistent.
 */
export function evaluateOrcaShipAction({
  action,
  operation,
  command,
  workflowOwner,
  workflow,
  authority,
  status,
  statusBridge,
  receipt,
  musterReceipt,
  expectedContext,
  handoff,
} = {}) {
  const normalizedAction = classifyOrcaShipAction({ action, operation, command });
  const deny = (reason, errors = [reason]) => ({
    ok: false,
    allowed: false,
    action: normalizedAction,
    reason,
    errors,
    readOnly: true,
    stateMutation: false,
  });
  if (!normalizedAction) return deny("unknown-ship-action", ["ship action is not recognized"]);
  const owner = ownerOf({ workflowOwner, workflow, authority });
  if (!owner) return deny("workflow-owner-unknown", ["workflow ownership is required"]);
  if (owner !== "muster") {
    return owner === "orca"
      ? { ok: true, allowed: true, action: normalizedAction, reason: "orca-owned-workflow", errors: [], readOnly: true, stateMutation: false }
      : deny("workflow-owner-not-supported", ["workflow owner must be muster or orca"]);
  }
  const authorityResult = validateMusterAuthority();
  if (!authorityResult.ok) return deny("muster-authority-invalid", authorityResult.errors);
  const evidence = validateEvidence({ status: statusBridge ?? status, receipt: musterReceipt ?? receipt, expectedContext });
  if (!evidence.ok) return deny("muster-gate-not-satisfied", evidence.errors);
  const handoffResult = validateOrcaMusterShipHandoff(handoff);
  if (!handoffResult.ok) return deny("muster-handoff-required", handoffResult.errors);
  const values = handoffValues(handoff);
  const currentStatus = statusBridge ?? status;
  const currentReceipt = musterReceipt ?? receipt;
  if (values.action !== normalizedAction) return deny("handoff-action-mismatch", ["handoff action does not match ship action"]);
  if (values.attemptId !== attemptId(currentReceipt) || values.attemptId !== statusAttemptId(currentStatus)) {
    return deny("handoff-attempt-mismatch", ["handoff attemptId does not match current Muster attempt"]);
  }
  if (values.receiptId !== receiptId(currentReceipt) || values.receiptId !== statusReceiptId(currentStatus)) {
    return deny("handoff-receipt-mismatch", ["handoff receiptId does not match current Muster receipt"]);
  }
  const branch = currentReceipt?.orca?.branch;
  if (branch && values.branch !== branch) return deny("handoff-branch-mismatch", ["handoff branch does not match receipt worktree"]);
  return {
    ok: true,
    allowed: true,
    action: normalizedAction,
    reason: "muster-handoff-verified",
    errors: [],
    readOnly: true,
    stateMutation: false,
  };
}

export const guardOrcaShipAction = evaluateOrcaShipAction;
export const checkOrcaShipGate = evaluateOrcaShipAction;
