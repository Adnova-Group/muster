import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpProject } from "../test-support/helpers.js";
import { runWithWorktreeIntegrity } from "../scripts/run-tests-with-worktree-integrity.mjs";

const exec = promisify(execFile);
const script = fileURLToPath(new URL("../scripts/check-worktree-root-integrity.mjs", import.meta.url));
const ci = fileURLToPath(new URL("../.github/workflows/ci.yml", import.meta.url));

async function git(cwd, ...args) {
  return exec("git", args, { cwd, encoding: "utf8" });
}

async function fixture() {
  const cwd = await tmpProject({ "tracked.txt": "tracked\n" });
  await git(cwd, "init", "-b", "main");
  await git(cwd, "add", "tracked.txt");
  await git(cwd, "-c", "user.name=Muster Test", "-c", "user.email=test@example.invalid", "commit", "-m", "seed");
  return { cwd, snapshot: join(cwd, ".integrity-snapshot.json") };
}

async function capture(cwd, snapshot) {
  return exec(process.execPath, [script, "capture", snapshot], { cwd, encoding: "utf8" });
}

async function verify(cwd, snapshot) {
  return exec(process.execPath, [script, "verify", snapshot], { cwd, encoding: "utf8" });
}

test("worktree-root capture and verify preserve the exact repository identity", async () => {
  const { cwd, snapshot } = await fixture();
  await capture(cwd, snapshot);
  const result = JSON.parse((await verify(cwd, snapshot)).stdout);
  assert.equal(result.ok, true);
  assert.equal(result.topLevel, cwd);
  const recorded = JSON.parse(await readFile(snapshot, "utf8"));
  assert.equal(recorded.topLevel, cwd);
  assert.deepEqual(recorded.trackedFiles, [Buffer.from("tracked.txt").toString("base64")]);
});

test("capture fails closed on core.worktree redirection and missing tracked files", async () => {
  const redirected = await fixture();
  await mkdir(join(redirected.cwd, "other"));
  await git(redirected.cwd, "config", "--local", "core.worktree", "../other");
  await assert.rejects(() => capture(redirected.cwd, redirected.snapshot), /core\.worktree/i);

  const deleted = await fixture();
  await unlink(join(deleted.cwd, "tracked.txt"));
  await assert.rejects(() => capture(deleted.cwd, deleted.snapshot), /tracked files.*missing/i);
});

test("verify rejects top-level, config-byte, tracked-set, and linked-worktree drift", async () => {
  const top = await fixture();
  await capture(top.cwd, top.snapshot);
  await mkdir(join(top.cwd, "nested"));
  await assert.rejects(() => verify(join(top.cwd, "nested"), top.snapshot), /exact repository root/i);

  const config = await fixture();
  await capture(config.cwd, config.snapshot);
  await git(config.cwd, "config", "--local", "muster.integrity-test", "changed");
  await assert.rejects(() => verify(config.cwd, config.snapshot), /common Git config bytes.*changed/i);

  const tracked = await fixture();
  await capture(tracked.cwd, tracked.snapshot);
  await writeFile(join(tracked.cwd, "added.txt"), "added\n");
  await git(tracked.cwd, "add", "added.txt");
  await assert.rejects(() => verify(tracked.cwd, tracked.snapshot), /tracked-file set changed/i);

  const linked = await fixture();
  await capture(linked.cwd, linked.snapshot);
  const linkedPath = join(linked.cwd, "..", `linked-${process.pid}-${Date.now()}`);
  try {
    await git(linked.cwd, "worktree", "add", "--detach", linkedPath, "HEAD");
    await assert.rejects(() => verify(linked.cwd, linked.snapshot), /linked-worktree inventory changed/i);
  } finally {
    await git(linked.cwd, "worktree", "remove", "--force", linkedPath).catch(() => {});
    await rm(linkedPath, { recursive: true, force: true });
  }
});

test("worktree-scoped config is bound and core.worktree is rejected", async () => {
  const scoped = await fixture();
  await git(scoped.cwd, "config", "extensions.worktreeConfig", "true");
  await capture(scoped.cwd, scoped.snapshot);
  await git(scoped.cwd, "config", "--worktree", "muster.integrity-test", "changed");
  await assert.rejects(() => verify(scoped.cwd, scoped.snapshot), /worktree Git config bytes.*changed/i);

  const redirected = await fixture();
  await git(redirected.cwd, "config", "extensions.worktreeConfig", "true");
  await git(redirected.cwd, "config", "--worktree", "core.worktree", "..");
  await assert.rejects(() => capture(redirected.cwd, redirected.snapshot), /core\.worktree/i);
});

test("the full-gate wrapper retains its baseline in memory against recapture attempts", async () => {
  const { cwd } = await fixture();
  await assert.rejects(
    () => runWithWorktreeIntegrity({
      cwd,
      runGate: async () => {
        await git(cwd, "config", "--local", "muster.integrity-test", "changed");
        await writeFile(join(cwd, "attacker-snapshot.json"), "{}\n");
        return { status: 0, signal: null };
      },
    }),
    /common Git config bytes.*changed/i,
  );
});

test("CI runs the complete npm test gate inside one in-memory integrity wrapper", async () => {
  const workflow = await readFile(ci, "utf8");
  assert.match(workflow, /node scripts\/run-tests-with-worktree-integrity\.mjs/);
  assert.equal(workflow.includes("check-worktree-root-integrity.mjs capture"), false);
  assert.equal(workflow.includes("check-worktree-root-integrity.mjs verify"), false);
});
