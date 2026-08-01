import { spawnSync } from "node:child_process";
import { stripAnnotations } from "./sprint-waves.js";

const CHECKED_CHECKBOX_RE = /^- \[[xX]\] (.*)$/;
const SHA_RE = /^[0-9a-f]{40}$/;

export function checkBacklogReceipts(content, { releaseRef, isReachable } = {}) {
  if (typeof content !== "string") throw new TypeError("backlog content must be a string");
  if (typeof releaseRef !== "string" || releaseRef.trim() === "") throw new TypeError("releaseRef must be a non-empty string");
  if (typeof isReachable !== "function") throw new TypeError("isReachable must be a function");
  const errors = [];
  let checked = 0, withdrawn = 0, verified = 0;
  content.split(/\r?\n/).forEach((line, index) => {
    const match = CHECKED_CHECKBOX_RE.exec(line.replace(/^\s+/, ""));
    if (!match) return;
    checked += 1;
    const lineNo = index + 1;
    const { anns, annotationCounts } = stripAnnotations(match[1]);
    const id = anns.id || `item-${lineNo}`;
    const duplicatedReceipt = ["merge", "done", "withdrawn"].find((key) => (annotationCounts[key] || 0) > 1);
    if (duplicatedReceipt) {
      errors.push({ id, line: lineNo, reason: `checked item repeats {${duplicatedReceipt}: ...}; receipt annotations must be unique` });
      return;
    }
    if (Object.prototype.hasOwnProperty.call(anns, "withdrawn")) {
      if (anns.withdrawn) withdrawn += 1;
      else errors.push({ id, line: lineNo, reason: "withdrawn exemption requires a non-empty reason" });
      return;
    }
    const receipts = ["merge", "done"].filter((key) => Object.prototype.hasOwnProperty.call(anns, key));
    if (receipts.length === 0) {
      errors.push({ id, line: lineNo, reason: "missing {merge: <SHA>} or {done: <SHA>} receipt" });
      return;
    }
    if (receipts.length !== 1) {
      errors.push({ id, line: lineNo, reason: "checked item must carry exactly one merge or done receipt" });
      return;
    }
    const receiptType = receipts[0];
    const receipt = anns[receiptType];
    if (!SHA_RE.test(receipt)) {
      errors.push({ id, line: lineNo, reason: `${receiptType} receipt must be a lowercase 40-character Git SHA` });
      return;
    }
    if (!isReachable(receipt)) {
      errors.push({ id, line: lineNo, reason: `${receiptType} receipt ${receipt} is not reachable from release ref ${releaseRef}` });
      return;
    }
    verified += 1;
  });
  return { ok: errors.length === 0, releaseRef, summary: { checked, withdrawn, verified, rejected: errors.length }, errors };
}

export function makeGitReachabilityVerifier({ cwd, releaseCommit }) {
  if (!SHA_RE.test(releaseCommit || "")) throw new TypeError("releaseCommit must be a lowercase 40-character Git SHA");
  const repository = spawnSync("git", ["rev-parse", "--git-dir"], { cwd, stdio: "ignore" });
  if (repository.error) throw repository.error;
  if (repository.status !== 0) throw new Error("git reachability verification requires a repository");
  return (receipt) => {
    const object = spawnSync("git", ["cat-file", "-e", `${receipt}^{commit}`], { cwd, stdio: "ignore" });
    if (object.error) throw object.error;
    if (object.status !== 0) return false;
    const result = spawnSync("git", ["merge-base", "--is-ancestor", receipt, releaseCommit], { cwd, stdio: "ignore" });
    if (result.error) throw result.error;
    if (result.status === 0) return true;
    if (result.status === 1) return false;
    throw new Error(`git merge-base --is-ancestor failed with exit ${result.status ?? "unknown"}`);
  };
}
