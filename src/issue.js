import { execFile } from "node:child_process";
import { promisify } from "node:util";

// Three exact shapes count as an issue reference; everything else is plain outcome text.
// Conservative by design: a sentence that merely contains a number stays text.
const BARE = /^[1-9]\d*$/;
const HASH = /^#[1-9]\d*$/;
const URL = /^https?:\/\/github\.com\/[^/]+\/[^/]+\/issues\/([1-9]\d*)\/?(\?.*)?$/;

export function parseIssueRef(arg) {
  if (typeof arg !== "string") return { kind: "text" };
  const s = arg.trim();
  if (BARE.test(s)) return { kind: "issue", number: Number(s) };
  if (HASH.test(s)) return { kind: "issue", number: Number(s.slice(1)) };
  const m = URL.exec(s);
  if (m) return { kind: "issue", number: Number(m[1]) };
  return { kind: "text" };
}

export async function resolveIssue(ref, { exec } = {}) {
  const run = exec || promisify(execFile);
  const parsed = parseIssueRef(ref);
  if (parsed.kind !== "issue") {
    throw new Error("not a GitHub issue reference: " + ref);
  }
  const { number } = parsed;
  try {
    const { stdout } = await run("gh", [
      "issue",
      "view",
      String(number),
      "--json",
      "number,title,body",
    ]);
    const { number: n, title, body } = JSON.parse(stdout);
    return { number: n, title, body, outcome: `${title}\n\n${body}` };
  } catch (e) {
    throw new Error(`failed to resolve issue #${number} via gh: ${e.message}`);
  }
}
