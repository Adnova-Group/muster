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
    const { anns } = stripAnnotations(match[1]);
    const id = anns.id || `item-${lineNo}`;
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
  return (receipt) => spawnSync("git", ["merge-base", "--is-ancestor", receipt, releaseCommit], { cwd, stdio: "ignore" }).status === 0;
}
