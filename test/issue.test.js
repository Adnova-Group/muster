import { test } from "node:test";
import assert from "node:assert/strict";
import { parseIssueRef, resolveIssue } from "../src/issue.js";

test("parseIssueRef: bare positive integer", () => {
  assert.deepEqual(parseIssueRef("123"), { kind: "issue", number: 123 });
});

test("parseIssueRef: bare integer with surrounding whitespace", () => {
  assert.deepEqual(parseIssueRef("  42 "), { kind: "issue", number: 42 });
});

test("parseIssueRef: #-prefixed number", () => {
  assert.deepEqual(parseIssueRef("#123"), { kind: "issue", number: 123 });
});

test("parseIssueRef: GitHub issues URL", () => {
  assert.deepEqual(parseIssueRef("https://github.com/o/r/issues/45"), {
    kind: "issue",
    number: 45,
  });
});

test("parseIssueRef: GitHub issues URL with trailing slash", () => {
  assert.deepEqual(parseIssueRef("https://github.com/o/r/issues/45/"), {
    kind: "issue",
    number: 45,
  });
});

test("parseIssueRef: GitHub issues URL with query string", () => {
  assert.deepEqual(parseIssueRef("https://github.com/o/r/issues/45?foo=bar"), {
    kind: "issue",
    number: 45,
  });
});

test("parseIssueRef: plain outcome text is text", () => {
  assert.deepEqual(parseIssueRef("build a login feature"), { kind: "text" });
});

test("parseIssueRef: sentence containing a number is text", () => {
  assert.deepEqual(parseIssueRef("fix bug 12 in the parser"), { kind: "text" });
});

test("parseIssueRef: non-string is text", () => {
  assert.deepEqual(parseIssueRef(123), { kind: "text" });
});

test("parseIssueRef: empty string is text", () => {
  assert.deepEqual(parseIssueRef(""), { kind: "text" });
});

test("parseIssueRef: zero and negatives are text", () => {
  assert.deepEqual(parseIssueRef("0"), { kind: "text" });
  assert.deepEqual(parseIssueRef("-5"), { kind: "text" });
  assert.deepEqual(parseIssueRef("#0"), { kind: "text" });
});

test("resolveIssue: resolves via injected fake exec", async () => {
  const calls = [];
  const fakeExec = async (cmd, args) => {
    calls.push({ cmd, args });
    return { stdout: JSON.stringify({ number: 7, title: "T", body: "B" }) };
  };
  const result = await resolveIssue("#7", { exec: fakeExec });
  assert.deepEqual(result, {
    number: 7,
    title: "T",
    body: "B",
    outcome: "T\n\nB",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "gh");
  assert.deepEqual(calls[0].args, [
    "issue",
    "view",
    "7",
    "--json",
    "number,title,body",
  ]);
});

test("resolveIssue: rejecting exec (gh missing) yields a clear error", async () => {
  const fakeExec = async () => {
    throw new Error("spawn gh ENOENT");
  };
  await assert.rejects(
    () => resolveIssue("123", { exec: fakeExec }),
    (err) => {
      assert.match(err.message, /failed to resolve issue #123 via gh/);
      assert.match(err.message, /ENOENT/);
      return true;
    }
  );
});

test("resolveIssue: bad JSON yields a clear error", async () => {
  const fakeExec = async () => ({ stdout: "not json" });
  await assert.rejects(
    () => resolveIssue("5", { exec: fakeExec }),
    (err) => {
      assert.match(err.message, /failed to resolve issue #5 via gh/);
      return true;
    }
  );
});

test("resolveIssue: non-issue ref throws", async () => {
  await assert.rejects(
    () => resolveIssue("build a thing", { exec: async () => ({ stdout: "{}" }) }),
    (err) => {
      assert.match(err.message, /not a GitHub issue reference/);
      return true;
    }
  );
});
