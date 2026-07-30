import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";
import { atomicWrite, readNoFollowRegular, withFileMutationLock } from "../src/fs-safe.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function publish(path, expected, content) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "backlog-publish", path, "--expect", expected], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => { stdout += chunk; });
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(stderr || `backlog-publish exited ${code}`));
    });
    child.stdin.end(content);
  });
}

async function lockedTransform(path, transform, pause = null) {
  return withFileMutationLock(path, async () => {
    const { bytes, info } = await readNoFollowRegular(path, {
      maxBytes: 1024 * 1024,
      label: `test backlog ${path}`,
    });
    if (pause) await pause();
    await atomicWrite(path, transform(bytes.toString("utf8")), {
      mode: info.mode & 0o777,
    });
  });
}

test("a concurrent heartbeat waits for hygiene publication and preserves both mutations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-heartbeat-lock-"));
  const backlog = join(dir, "backlog.md");
  await writeFile(backlog, "- [ ] item {claimed: stale}\n");

  let releaseHygiene;
  const hygienePaused = new Promise((resolve) => { releaseHygiene = resolve; });
  let hygieneHasLock;
  const locked = new Promise((resolve) => { hygieneHasLock = resolve; });

  const hygiene = lockedTransform(backlog, (text) => text.replace(" {claimed: stale}", ""), async () => {
    hygieneHasLock();
    await hygienePaused;
  });
  await locked;
  const heartbeat = lockedTransform(backlog, (text) => `${text.trimEnd()}\n# heartbeat runner-1\n`);
  releaseHygiene();

  await Promise.all([hygiene, heartbeat]);
  assert.equal(await readFile(backlog, "utf8"), "- [ ] item\n# heartbeat runner-1\n");
});

test("competing hygiene writers serialize their read-transform-publish transactions", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-hygiene-lock-"));
  const backlog = join(dir, "backlog.md");
  await writeFile(backlog, "released:");

  let releaseFirst;
  const firstPaused = new Promise((resolve) => { releaseFirst = resolve; });
  let firstHasLock;
  const locked = new Promise((resolve) => { firstHasLock = resolve; });

  const first = lockedTransform(backlog, (text) => `${text} one`, async () => {
    firstHasLock();
    await firstPaused;
  });
  await locked;
  const second = lockedTransform(backlog, (text) => `${text} two`);
  releaseFirst();

  await Promise.all([first, second]);
  assert.equal(await readFile(backlog, "utf8"), "released: one two");
});

test("a timed-out stale lock is bounded and leaves the original backlog intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-stale-lock-"));
  const backlog = join(dir, "backlog.md");
  await writeFile(backlog, "original\n");
  await writeFile(`${backlog}.muster-lock`, "stale owner\n");

  await assert.rejects(
    () => withFileMutationLock(backlog, async () => {
      await writeFile(backlog, "must not run\n");
    }, { timeoutMs: 25, retryMs: 5 }),
    /timed out waiting for file mutation lock/,
  );
  assert.equal(await readFile(backlog, "utf8"), "original\n");
});

test("a failed locked mutation leaves the original backlog intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-failed-lock-"));
  const backlog = join(dir, "backlog.md");
  await writeFile(backlog, "original\n");

  await assert.rejects(
    () => withFileMutationLock(backlog, async () => {
      throw new Error("validation failed");
    }),
    /validation failed/,
  );
  assert.equal(await readFile(backlog, "utf8"), "original\n");
});

test("backlog-publish enforces CAS, preserves mode, and leaves the winner intact", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-publish-cas-"));
  const backlog = join(dir, "backlog.md");
  const original = "original\n";
  await writeFile(backlog, original, { mode: 0o640 });
  await chmod(backlog, 0o640);

  await publish(backlog, sha256(original), "winner\n");
  await assert.rejects(
    () => publish(backlog, sha256(original), "loser\n"),
    /backlog changed before publication/,
  );
  assert.equal(await readFile(backlog, "utf8"), "winner\n");
  assert.equal((await stat(backlog)).mode & 0o777, 0o640);
});

test("backlog-publish refuses a symlink target without changing its referent", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-publish-link-"));
  const external = join(dir, "external.md");
  const backlog = join(dir, "backlog.md");
  await writeFile(external, "external\n");
  await symlink(external, backlog);

  await assert.rejects(
    () => publish(backlog, sha256("external\n"), "overwrite\n"),
    /ELOOP|symlink|unsafe regular file/i,
  );
  assert.equal(await readFile(external, "utf8"), "external\n");
});

test("every instruction-driven production backlog writer requires the shared CAS publisher", async () => {
  const writers = [
    "plugin/commands/audit.md",
    "plugin/commands/capture.md",
    "plugin/commands/go-backlog.md",
    "plugin/commands/plan-backlog.md",
    "plugin/commands/runner.md",
    "plugin/skills/coordination/SKILL.md",
    "plugin/skills/interview/SKILL.md",
    "cowork/sprint-protocol.md",
  ];
  for (const writer of writers) {
    const text = await readFile(new URL(`../${writer}`, import.meta.url), "utf8");
    assert.match(text, /backlog-publish/, `${writer} can mutate backlog.md but does not require the shared CAS publisher`);
  }
});
