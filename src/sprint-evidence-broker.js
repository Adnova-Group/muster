import { execFileSync } from "node:child_process";
import { createHash, randomUUID, sign, timingSafeEqual, verify } from "node:crypto";
import { resolve } from "node:path";
import { buildSprintReceipt, integrationApprovalDigest } from "./sprint-waves.js";

const RECEIPT_KEYS = ["id", "itemId", "phase", "status", "attempt", "candidateSha", "findings",
  "terminalReason", "implementationAttempt", "approvalDigest", "approval"];
const APPROVAL_KEYS = ["itemId", "workBranch", "workHeadSha", "baseBranch", "baseHeadSha", "operation"];

function exactOwnKeys(value, allowed, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${label} must be an object`);
  const extras = Object.keys(value).filter((key) => !allowed.includes(key));
  if (extras.length > 0) throw new Error(`${label} contains forbidden fields: ${extras.join(", ")}`);
}

function gitText(cwd, args) {
  return execFileSync("git", args, { cwd, encoding: "utf8", timeout: 10_000 }).trim();
}

function assignmentFor(state, itemId, phase, principal) {
  const assignment = state?.items?.[itemId];
  if (!assignment || typeof assignment !== "object" || Array.isArray(assignment)) {
    throw new Error(`no trusted assignment for item ${itemId}`);
  }
  if (!principal?.purposes?.includes(phase) || assignment.actors?.[phase] !== principal.actorId) {
    throw new Error(`authenticated callback is not assigned to ${itemId}:${phase}`);
  }
  if (phase === "review" && assignment.actors.review === assignment.actors.implementation) {
    throw new Error("review receipt requires an independent assigned reviewer");
  }
  const worktreePath = assignment.worktreePath;
  if (typeof worktreePath !== "string" || !worktreePath || typeof assignment.branch !== "string" || !assignment.branch
    || typeof assignment.gitCommonDir !== "string" || !assignment.gitCommonDir) {
    throw new Error(`trusted assignment for ${itemId} is incomplete`);
  }
  const actualBranch = gitText(worktreePath, ["symbolic-ref", "--short", "HEAD"]);
  const commonDirText = gitText(worktreePath, ["rev-parse", "--git-common-dir"]);
  if (actualBranch !== assignment.branch
    || resolve(worktreePath, commonDirText) !== resolve(assignment.gitCommonDir)) {
    throw new Error(`trusted assignment repository or branch mismatch for ${itemId}`);
  }
  return { assignment, worktreePath };
}

function signature(privateKey, digest) {
  if (typeof privateKey !== "string" || !privateKey) throw new Error("broker signing key is unavailable");
  return sign(null, Buffer.from(digest, "hex"), privateKey).toString("base64");
}

function verifyFreshApproval(approval, assignment, receipt, publicKey, runId, now) {
  const approvedAt = Date.parse(approval?.approvedAt);
  const target = assignment.integrationTarget;
  const expected = target && {
    itemId: receipt.itemId, workBranch: assignment.branch, workHeadSha: receipt.candidateSha,
    baseBranch: target.baseBranch, baseHeadSha: target.baseHeadSha, operation: target.operation,
  };
  const digest = integrationApprovalDigest(approval);
  let authentic = false;
  try {
    authentic = typeof publicKey === "string" && verify(null, Buffer.from(digest, "hex"), publicKey,
      Buffer.from(approval?.evidence ?? "", "base64"));
  } catch {}
  if (!expected || Object.entries(expected).some(([key, value]) => approval?.[key] !== value)
    || approval.runId !== runId || approval.digest !== receipt.approvalDigest || approval.digest !== digest
    || !Number.isFinite(approvedAt) || Math.abs(now - approvedAt) > 15 * 60 * 1000 || !authentic) {
    throw new Error("integration completion requires a fresh exact authenticated approval");
  }
}

export function authenticateSprintBrokerCallback(token, state) {
  if (typeof token !== "string" || token.length < 16) throw new Error("broker callback authentication failed");
  const digest = createHash("sha256").update(token).digest("hex");
  const match = Object.entries(state?.callbackPrincipals ?? {}).find(([candidate]) => {
    if (!/^[0-9a-f]{64}$/.test(candidate)) return false;
    return timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(digest, "hex"));
  });
  if (!match || !match[1] || typeof match[1].actorId !== "string" || !Array.isArray(match[1].purposes)) {
    throw new Error("broker callback authentication failed");
  }
  return match[1];
}

export function issueSprintReceipt(request, {
  state, principal, receiptPrivateKey, approvalPublicKey, now = Date.now(),
} = {}) {
  exactOwnKeys(request, RECEIPT_KEYS, "receipt request");
  const { assignment, worktreePath } = assignmentFor(state, request.itemId, request.phase, principal);
  if (request.phase === "integration") {
    verifyFreshApproval(request.approval, assignment, request, approvalPublicKey, state.runId, now);
  } else if (request.approval !== undefined) {
    throw new Error("approval evidence is only valid for integration completion");
  }
  const { approval: _approval, ...receiptFields } = request;
  return buildSprintReceipt({
    ...receiptFields, worktreePath,
    signReceipt: (digest) => signature(receiptPrivateKey, digest),
  });
}

export function issueSprintApproval(request, {
  state, principal, approvalPrivateKey, now = Date.now(),
} = {}) {
  exactOwnKeys(request, APPROVAL_KEYS, "approval request");
  const { assignment, worktreePath } = assignmentFor(state, request.itemId, "approval", principal);
  const target = assignment.integrationTarget;
  const expected = {
    itemId: request.itemId, workBranch: assignment.branch,
    workHeadSha: gitText(worktreePath, ["rev-parse", "HEAD"]),
    baseBranch: target?.baseBranch, baseHeadSha: target?.baseHeadSha, operation: target?.operation,
  };
  if (Object.entries(expected).some(([key, value]) => request[key] !== value)
    || assignment.approvalActionDigest !== integrationApprovalDigest(request)) {
    throw new Error("approval request does not match the prior trusted approval action");
  }
  const approval = {
    ...request, approvedBy: principal.actorId, approvedAt: new Date(now).toISOString(),
    runId: state.runId, nonce: randomUUID(),
  };
  const digest = integrationApprovalDigest(approval);
  return { ...approval, digest, evidence: signature(approvalPrivateKey, digest) };
}
