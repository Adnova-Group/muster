import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  BACKLOG_RECEIPT_MAX_BYTES,
  checkBacklogReceipts,
  makeGitReachabilityVerifier,
} from "../src/backlog-receipts.js";
import { tmpProject } from "../test-support/helpers.js";

const pexecFile = promisify(execFile);
const CLI = new URL("../src/cli.js", import.meta.url).pathname;

const reachable = new Set([
  "1111111111111111111111111111111111111111",
  "2222222222222222222222222222222222222222",
]);
const check = (content) => checkBacklogReceipts(content, {
  releaseRef: "refs/heads/main",
  isReachable: (sha) => reachable.has(sha),
});

test("every non-withdrawn checked item needs a reachable merge or done receipt", () => {
  const result = check([
    "- [x] merged {id: merged} {merge: 1111111111111111111111111111111111111111}",
    "- [x] kept {id: kept} {done: 2222222222222222222222222222222222222222}",
    "- [x] missing {id: missing}",
    "- [x] malformed {id: malformed} {done: HEAD}",
    "- [x] stale {id: stale} {merge: 3333333333333333333333333333333333333333}",
    "- [ ] pending {id: pending}",
  ].join("\n"));

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, { checked: 5, withdrawn: 0, verified: 2, rejected: 3 });
  assert.deepEqual(result.errors.map((error) => error.id), ["missing", "malformed", "stale"]);
  assert.match(result.errors[0].reason, /missing.*merge.*done/i);
  assert.match(result.errors[1].reason, /40-character/i);
  assert.match(result.errors[2].reason, /not reachable.*refs\/heads\/main/i);
});

test("withdrawn is the only explicit exemption and requires a reason", () => {
  const result = check([
    "- [x] deliberately retired {id: retired} {withdrawn: superseded by v2}",
    "- [x] empty exemption {id: empty} {withdrawn: }",
  ].join("\n"));

  assert.equal(result.ok, false);
  assert.deepEqual(result.summary, { checked: 2, withdrawn: 1, verified: 0, rejected: 1 });
  assert.equal(result.errors[0].id, "empty");
  assert.match(result.errors[0].reason, /withdrawn.*reason/i);
});

test("ambiguous merge and done receipts are rejected even when both are reachable", () => {
  const result = check("- [x] ambiguous {id: both} {merge: 1111111111111111111111111111111111111111} {done: 2222222222222222222222222222222222222222}");
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /exactly one/i);
});

test("duplicate same-key receipts are rejected before annotation normalization", () => {
  const result = check("- [x] duplicated {id: twice} {done: 1111111111111111111111111111111111111111} {done: 1111111111111111111111111111111111111111}");
  assert.equal(result.ok, false);
  assert.match(result.errors[0].reason, /repeats.*done.*unique/i);
});

test("receipt syntax is canonical lowercase full SHA, never an abbreviation or uppercase alias", () => {
  const result = check([
    "- [x] abbreviated {id: short} {done: 1111111}",
    "- [x] uppercase {id: upper} {done: 111111111111111111111111111111111111111A}",
  ].join("\n"));
  assert.equal(result.ok, false);
  assert.deepEqual(result.errors.map((error) => error.id), ["short", "upper"]);
});

test("a checked item without an explicit id is identified by its line", () => {
  const result = check("heading\n- [x] stale {done: 3333333333333333333333333333333333333333}");
  assert.equal(result.errors[0].id, "item-2");
  assert.equal(result.errors[0].line, 2);
});

test("CLI verifies against the declared release ref and reports every stale checked item", async () => {
  const cwd = await tmpProject({ "seed.txt": "seed\n" });
  await pexecFile("git", ["init", "-b", "main"], { cwd });
  await pexecFile("git", ["-c", "user.name=Muster Test", "-c", "user.email=test@example.invalid", "add", "seed.txt"], { cwd });
  await pexecFile("git", ["-c", "user.name=Muster Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"], { cwd });
  const releaseSha = (await pexecFile("git", ["rev-parse", "HEAD"], { cwd })).stdout.trim();
  await writeFile(join(cwd, "backlog.md"), [
    `- [x] reachable {id: good} {done: ${releaseSha}}`,
    "- [x] stale one {id: stale-one} {merge: 3333333333333333333333333333333333333333}",
    "- [x] stale two {id: stale-two}",
  ].join("\n"));

  await assert.rejects(
    () => pexecFile(process.execPath, [CLI, "backlog-receipts", "backlog.md", "--release-ref", "main"], { cwd }),
    (error) => {
      assert.equal(error.code, 2);
      const result = JSON.parse(error.stdout);
      assert.deepEqual(result.summary, { checked: 3, withdrawn: 0, verified: 1, rejected: 2 });
      assert.deepEqual(result.errors.map((entry) => entry.id), ["stale-one", "stale-two"]);
      return true;
    },
  );
});

test("CLI validates staged stdin bytes rather than the old on-disk backlog", async () => {
  const cwd = await tmpProject({ "seed.txt": "seed\n", "backlog.md": "- [ ] old unchecked\n" });
  await pexecFile("git", ["init", "-b", "main"], { cwd });
  await pexecFile("git", ["add", "."], { cwd });
  await pexecFile("git", ["-c", "user.name=Muster Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"], { cwd });
  const result = spawnSync(process.execPath, [CLI, "backlog-receipts", "-", "--release-ref", "main"], {
    cwd, encoding: "utf8", input: "- [x] staged but stale {done: 3333333333333333333333333333333333333333}\n",
  });
  assert.equal(result.status, 2);
  assert.equal(JSON.parse(result.stdout).summary.rejected, 1);
});

test("operational git failures throw instead of masquerading as ordinary unreachability", async () => {
  const cwd = await tmpProject();
  assert.throws(
    () => makeGitReachabilityVerifier({ cwd, releaseCommit: "1111111111111111111111111111111111111111" }),
    /requires a repository/i,
  );
});

test("a missing receipt object is ordinary unreachability, while cat-file faults throw", () => {
  const calls = [];
  const verifier = makeGitReachabilityVerifier({
    cwd: "/repo",
    releaseCommit: "1111111111111111111111111111111111111111",
    spawnSyncImpl(command, args) {
      calls.push([command, args]);
      if (args[0] === "rev-parse") return { status: 0, stdout: "", stderr: "" };
      if (args[0] === "cat-file") {
        return { status: 0, stdout: "3333333333333333333333333333333333333333 missing\n", stderr: "" };
      }
      throw new Error("merge-base must not run for a missing object");
    },
  });
  assert.equal(verifier("3333333333333333333333333333333333333333"), false);
  assert.equal(calls.filter(([, args]) => args[0] === "cat-file").length, 1);

  const broken = makeGitReachabilityVerifier({
    cwd: "/repo",
    releaseCommit: "1111111111111111111111111111111111111111",
    spawnSyncImpl(command, args) {
      if (args[0] === "rev-parse") return { status: 0, stdout: "", stderr: "" };
      return { status: 128, stdout: "", stderr: "fatal: object database unavailable\n" };
    },
  });
  assert.throws(
    () => broken("3333333333333333333333333333333333333333"),
    /git cat-file.*exit 128/i,
  );
});

test("CI scanner rejects invalid canonical tracked backlog files", async () => {
  const cwd = await tmpProject({ "seed.txt": "seed\n", "nested/backlog.md": "- [x] stale {id: stale}\n" });
  await pexecFile("git", ["init", "-b", "main"], { cwd });
  await pexecFile("git", ["add", "."], { cwd });
  await pexecFile("git", ["-c", "user.name=Muster Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"], { cwd });
  const script = new URL("../scripts/check-backlog-receipts.mjs", import.meta.url).pathname;
  await assert.rejects(() => pexecFile(process.execPath, [script, "--release-ref", "main"], { cwd }), (error) => {
    assert.equal(error.code, 2);
    assert.equal(JSON.parse(error.stdout).rejected, 1);
    return true;
  });
});

test("CI scanner discovers checked backlog items in any tracked checklist filename", async () => {
  const cwd = await tmpProject({ "seed.txt": "seed\n", "plans/release-checklist.txt": "- [x] stale {id: renamed}\n" });
  await pexecFile("git", ["init", "-b", "main"], { cwd });
  await pexecFile("git", ["add", "."], { cwd });
  await pexecFile("git", ["-c", "user.name=Muster Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"], { cwd });
  const script = new URL("../scripts/check-backlog-receipts.mjs", import.meta.url).pathname;
  await assert.rejects(() => pexecFile(process.execPath, [script, "--release-ref", "main"], { cwd }), (error) => {
    assert.equal(error.code, 2);
    const report = JSON.parse(error.stdout);
    assert.equal(report.rejected, 1);
    assert.equal(report.results[0].path, "plans/release-checklist.txt");
    return true;
  });
});

test("CI scanner fails closed on an oversized tracked checklist instead of reading it unbounded", async () => {
  const cwd = await tmpProject({
    "seed.txt": "seed\n",
    "roadmap.txt": `- [x] stale {id: oversized}\n${"a".repeat(BACKLOG_RECEIPT_MAX_BYTES)}`,
  });
  await pexecFile("git", ["init", "-b", "main"], { cwd });
  await pexecFile("git", ["add", "."], { cwd });
  await pexecFile("git", ["-c", "user.name=Muster Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"], { cwd });
  const script = new URL("../scripts/check-backlog-receipts.mjs", import.meta.url).pathname;
  await assert.rejects(() => pexecFile(process.execPath, [script, "--release-ref", "main"], { cwd }), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(error.stderr, /unsafe regular file: roadmap\.txt/);
    return true;
  });
});

test("CLI refuses a backlog symlink even when its target remains inside the run root", async () => {
  const cwd = await tmpProject({ "seed.txt": "seed\n", "actual.txt": "- [x] stale\n" });
  await pexecFile("git", ["init", "-b", "main"], { cwd });
  await pexecFile("git", ["add", "."], { cwd });
  await pexecFile("git", ["-c", "user.name=Muster Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed"], { cwd });
  await symlink("actual.txt", join(cwd, "backlog-link.txt"));
  await assert.rejects(
    () => pexecFile(process.execPath, [CLI, "backlog-receipts", "backlog-link.txt", "--release-ref", "main"], { cwd }),
    (error) => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /symlink|unsafe regular file/i);
      return true;
    },
  );
});
