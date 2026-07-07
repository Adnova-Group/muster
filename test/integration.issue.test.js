import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parseIssueRef, resolveIssue } from "../src/issue.js";

test("issue-ref classification table", () => {
  assert.equal(parseIssueRef("123").kind, "issue");
  assert.equal(parseIssueRef("#123").number, 123);
  assert.equal(parseIssueRef("https://github.com/o/r/issues/45").number, 45);
  assert.equal(parseIssueRef("build a login feature").kind, "text");
  assert.equal(parseIssueRef("fix bug 12 in the parser").kind, "text");
  assert.equal(parseIssueRef("").kind, "text");
});

test("resolveIssue composes the outcome from a (faked) gh response", async () => {
  const fakeExec = async (cmd, args) => {
    assert.equal(cmd, "gh");
    assert.deepEqual(args.slice(0, 3), ["issue", "view", "7"]);
    return { stdout: JSON.stringify({ number: 7, title: "Add export", body: "Users want CSV." }) };
  };
  const r = await resolveIssue("#7", { exec: fakeExec });
  assert.equal(r.number, 7);
  assert.equal(r.outcome, "Add export\n\nUsers want CSV.");
});

test("resolveIssue surfaces a clear error when gh fails", async () => {
  const failExec = async () => { throw new Error("gh: command not found"); };
  await assert.rejects(() => resolveIssue("1", { exec: failExec }), /issue|gh/i);
});

test("plan + go resolve an issue ref before routing", async () => {
  // plan.md/go.md are the canonical homes now (run.md/autopilot.md are legacy alias
  // stubs — see the alias-shape/alias-guidance checks in test/mode-evals.test.js).
  const plan = await readFile(new URL("../plugin/commands/plan.md", import.meta.url), "utf8");
  assert.match(plan, /muster issue/, "plan must resolve issue refs");
  const go = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  assert.match(go, /muster issue/, "go must resolve issue refs");
});
