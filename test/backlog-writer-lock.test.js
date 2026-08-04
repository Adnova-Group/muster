import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdir, readFile, rename, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";
import { atomicWrite, readNoFollowRegular, withFileMutationLock } from "../src/fs-safe.js";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");

function publish(path, expected, content, { cwd, env, fileArg = path, umask } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "backlog-publish", fileArg, "--expect", expected], {
      cwd,
      env: { ...process.env, ...env },
      ...(umask === undefined ? {} : { umask }),
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

  await publish(backlog, sha256(original), "winner\n", { cwd: dir, fileArg: "backlog.md" });
  await assert.rejects(
    () => publish(backlog, sha256(original), "loser\n", { cwd: dir, fileArg: "backlog.md" }),
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
    () => publish(backlog, sha256("external\n"), "overwrite\n", { cwd: dir, fileArg: "backlog.md" }),
    /ELOOP|symlink|unsafe regular file/i,
  );
  assert.equal(await readFile(external, "utf8"), "external\n");
});

test("backlog-publish rejects lexical and absolute escapes from the run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-backlog-contained-root-"));
  const outside = join(dirname(root), `${root.split("/").at(-1)}-outside.md`);
  await writeFile(outside, "outside\n");

  for (const fileArg of ["../outside.md", outside]) {
    await assert.rejects(
      () => publish(outside, sha256("outside\n"), "overwrite\n", { cwd: root, fileArg }),
      /contained under the run root|relative backlog path/i,
    );
  }
  assert.equal(await readFile(outside, "utf8"), "outside\n");
});

test("backlog-publish rejects a symlinked ancestor inside the run root", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-backlog-ancestor-root-"));
  const outside = await mkdtemp(join(tmpdir(), "muster-backlog-ancestor-outside-"));
  await writeFile(join(outside, "backlog.md"), "outside\n");
  await symlink(outside, join(root, "linked"));

  await assert.rejects(
    () => publish(join(outside, "backlog.md"), sha256("outside\n"), "overwrite\n", {
      cwd: root,
      fileArg: "linked/backlog.md",
    }),
    /symlink|contained under the run root/i,
  );
  assert.equal(await readFile(join(outside, "backlog.md"), "utf8"), "outside\n");
});

test("backlog-publish revalidates ancestry immediately before publication", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-backlog-publication-swap-"));
  const safe = join(root, "safe");
  const displaced = join(root, "safe-original");
  const outside = await mkdtemp(join(tmpdir(), "muster-backlog-publication-outside-"));
  const preload = join(root, "swap-parent.mjs");
  await mkdir(safe);
  await writeFile(join(safe, "backlog.md"), "original\n");
  await writeFile(join(outside, "backlog.md"), "external\n");
  await writeFile(preload, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const safe = process.env.MUSTER_SWAP_SAFE;
    const displaced = process.env.MUSTER_SWAP_DISPLACED;
    const outside = process.env.MUSTER_SWAP_OUTSIDE;
    let swapped = false;
    const originalOpen = fs.promises.open;
    fs.promises.open = async function(path, ...args) {
      const handle = await originalOpen.call(this, path, ...args);
      if (String(path).includes(".muster-tmp-") && !swapped) {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          const result = await originalClose();
          fs.renameSync(safe, displaced);
          fs.symlinkSync(outside, safe);
          swapped = true;
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
  `);

  await assert.rejects(
    () => publish(join(safe, "backlog.md"), sha256("original\n"), "new\n", {
      cwd: root,
      fileArg: "safe/backlog.md",
      env: {
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${preload}`.trim(),
        MUSTER_SWAP_SAFE: safe,
        MUSTER_SWAP_DISPLACED: displaced,
        MUSTER_SWAP_OUTSIDE: outside,
      },
    }),
    // The wave-1 lock hardening (pin-git-receipt-provenance family) pins the transaction lock's
    // parent directory, so an ancestry swap is now rejected at that earlier layer; either
    // rejection message proves the same property — the swapped publication never lands.
    /symlink|contained under the run root|transaction lock parent changed/i,
  );
  assert.equal(await readFile(join(outside, "backlog.md"), "utf8"), "external\n");
  assert.equal(await readFile(join(displaced, "backlog.md"), "utf8"), "original\n");
});

test("backlog-publish preserves mode under a restrictive child umask", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-umask-"));
  const backlog = join(dir, "backlog.md");
  await writeFile(backlog, "original\n");
  await chmod(backlog, 0o666);

  await publish(backlog, sha256("original\n"), "updated\n", {
    cwd: dir,
    fileArg: "backlog.md",
    umask: 0o077,
  });
  assert.equal((await stat(backlog)).mode & 0o777, 0o666);
});

test("backlog-publish fails closed when O_NOFOLLOW is unavailable", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-no-nofollow-"));
  const backlog = join(dir, "backlog.md");
  await writeFile(backlog, "original\n");

  await assert.rejects(
    () => publish(backlog, sha256("original\n"), "updated\n", {
      cwd: dir,
      fileArg: "backlog.md",
      env: { MUSTER_TEST_FORCE_NO_NOFOLLOW: "1" },
    }),
    /O_NOFOLLOW is unavailable/,
  );
  assert.equal(await readFile(backlog, "utf8"), "original\n");
});

test("a dead stale mutation lock is reclaimed without overlapping a live owner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-stale-reclaim-"));
  const backlog = join(dir, "backlog.md");
  const lock = `${backlog}.muster-lock`;
  await writeFile(backlog, "original\n");
  await writeFile(lock, `${JSON.stringify({
    format: 1,
    pid: 999_999_999,
    processIdentity: null,
    createdAt: 1,
    token: "dead-owner",
  })}\n`);
  await utimes(lock, new Date(0), new Date(0));

  await withFileMutationLock(backlog, async () => {
    await writeFile(backlog, "reclaimed\n");
  }, { staleMs: 1, maxStaleMs: 2, timeoutMs: 200 });
  assert.equal(await readFile(backlog, "utf8"), "reclaimed\n");
});

test("two real concurrent backlog-publish processes produce one CAS winner", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-backlog-process-race-"));
  const backlog = join(dir, "backlog.md");
  await writeFile(backlog, "original\n");
  const expected = sha256("original\n");

  const results = await Promise.allSettled([
    publish(backlog, expected, "writer-a\n", { cwd: dir, fileArg: "backlog.md" }),
    publish(backlog, expected, "writer-b\n", { cwd: dir, fileArg: "backlog.md" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(results.filter((result) => result.status === "rejected").length, 1);
  assert.ok(["writer-a\n", "writer-b\n"].includes(await readFile(backlog, "utf8")));
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
    assert.match(text, /backlog[-_]publish/, `${writer} can mutate backlog.md but does not require the shared CAS publisher`);
  }
});
