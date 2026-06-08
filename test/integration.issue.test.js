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

test("run + autopilot resolve an issue ref before routing", async () => {
  const run = await readFile(new URL("../plugin/commands/run.md", import.meta.url), "utf8");
  assert.match(run, /muster issue/, "run must resolve issue refs");
  const auto = await readFile(new URL("../plugin/commands/autopilot.md", import.meta.url), "utf8");
  assert.match(auto, /muster issue/, "autopilot must resolve issue refs");
});
