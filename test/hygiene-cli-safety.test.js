import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { chmod, mkdir, readFile, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

const pexec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const STALE_BACKLOG = [
  "# Backlog",
  "",
  "- [ ] item {id: item} {claimed: runner@2020-01-01T00:00:00.000Z}",
  "",
].join("\n");

async function runHygiene(cwd, args = [], options = {}) {
  return pexec(process.execPath, [CLI, "hygiene", ...args], {
    cwd,
    timeout: 10_000,
    maxBuffer: 2 * 1024 * 1024,
    ...options,
  });
}

for (const flag of ["--worktree-threshold", "--zombie-stale-min", "--claim-stale-min"]) {
  for (const value of ["-1", "NaN", "Infinity"]) {
    test(`hygiene rejects ${flag} ${value} before releasing claims`, async () => {
      const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-number-"));
      const backlog = join(cwd, "backlog.md");
      await writeFile(backlog, STALE_BACKLOG);

      await assert.rejects(
        () => runHygiene(cwd, ["--reap", "--backlog", backlog, flag, value]),
        /must be a non-negative finite number/,
      );
      assert.equal(await readFile(backlog, "utf8"), STALE_BACKLOG);
    });
  }
}

for (const value of ["", " ", "0x10", "+1", "1_000"]) {
  test(`hygiene rejects non-strict threshold syntax ${JSON.stringify(value)} before mutation`, async () => {
    const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-syntax-"));
    const backlog = join(cwd, "backlog.md");
    await writeFile(backlog, STALE_BACKLOG);

    await assert.rejects(
      () => runHygiene(cwd, ["--reap", "--backlog", backlog, "--claim-stale-min", value]),
      /must be a non-negative finite number/,
    );
    assert.equal(await readFile(backlog, "utf8"), STALE_BACKLOG);
  });
}

test("hygiene accepts zero thresholds and preserves its JSON contract", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-zero-"));
  const backlog = join(cwd, "backlog.md");
  await writeFile(backlog, "# Backlog\n");
  const { stdout } = await runHygiene(cwd, [
    "--json",
    "--backlog", backlog,
    "--worktree-threshold", "0",
    "--zombie-stale-min", "0",
    "--claim-stale-min", "0",
  ]);
  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.worktrees.threshold, 0);
  assert.ok(Array.isArray(result.claims.releases));
});

test("hygiene reaps an ordinary regular-file backlog atomically and preserves its mode", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-regular-"));
  const backlog = join(cwd, "backlog.md");
  await writeFile(backlog, STALE_BACKLOG, { mode: 0o640 });
  await chmod(backlog, 0o640);

  const { stdout } = await runHygiene(cwd, ["--json", "--reap", "--backlog", backlog]);
  const result = JSON.parse(stdout);
  assert.equal(result.claims.releases.length, 1);
  assert.doesNotMatch(await readFile(backlog, "utf8"), /\{claimed:/);
  assert.equal((await stat(backlog)).mode & 0o777, 0o640);
});

test("hygiene refuses a symlink backlog without reading or reaping its target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-link-"));
  const external = join(cwd, "external.md");
  const backlog = join(cwd, "backlog.md");
  await writeFile(external, STALE_BACKLOG);
  await symlink(external, backlog);

  await assert.rejects(
    () => runHygiene(cwd, ["--reap", "--backlog", backlog]),
    /symlink|ELOOP|unsafe regular file/i,
  );
  assert.equal(await readFile(external, "utf8"), STALE_BACKLOG);
});

test("hygiene refuses a backlog reached through a symlinked parent directory", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-parent-link-"));
  const externalDir = join(cwd, "external");
  const linkedDir = join(cwd, "linked");
  await mkdir(externalDir);
  await writeFile(join(externalDir, "backlog.md"), STALE_BACKLOG);
  await symlink(externalDir, linkedDir);

  await assert.rejects(
    () => runHygiene(cwd, ["--reap", "--backlog", join(linkedDir, "backlog.md")]),
    /path must not contain symlinks/i,
  );
  assert.equal(await readFile(join(externalDir, "backlog.md"), "utf8"), STALE_BACKLOG);
});

test("hygiene refuses a FIFO backlog without blocking", async (t) => {
  if (process.platform === "win32") return t.skip("FIFO is POSIX-only");
  const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-fifo-"));
  const backlog = join(cwd, "backlog.fifo");
  await new Promise((resolve, reject) => {
    const child = execFile("mkfifo", [backlog], (error) => error ? reject(error) : resolve());
    child.on("error", reject);
  });

  await assert.rejects(
    () => runHygiene(cwd, ["--backlog", backlog]),
    /unsafe regular file/i,
  );
});

test("hygiene fails closed when the runtime cannot provide O_NOFOLLOW", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-no-nofollow-"));
  const backlog = join(cwd, "backlog.md");
  await writeFile(backlog, STALE_BACKLOG);

  await assert.rejects(
    () => runHygiene(cwd, ["--reap", "--backlog", backlog], {
      env: { ...process.env, MUSTER_TEST_FORCE_NO_NOFOLLOW: "1" },
    }),
    /O_NOFOLLOW is unavailable/,
  );
  assert.equal(await readFile(backlog, "utf8"), STALE_BACKLOG);
});

test("hygiene detects a same-inode equal-length backlog refresh before publication", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-content-swap-"));
  const backlog = join(cwd, "backlog.md");
  const preload = join(cwd, "refresh-after-read.mjs");
  const refreshed = "R".repeat(Buffer.byteLength(STALE_BACKLOG));
  await writeFile(backlog, STALE_BACKLOG);
  await writeFile(preload, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const target = process.env.MUSTER_REFRESH_BACKLOG;
    const refreshed = process.env.MUSTER_REFRESH_CONTENT;
    let refreshedOnce = false;
    const originalOpen = fs.promises.open;
    fs.promises.open = async function(path, ...args) {
      const handle = await originalOpen.call(this, path, ...args);
      if (String(path) === target && !refreshedOnce) {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          const result = await originalClose();
          fs.writeFileSync(target, refreshed);
          refreshedOnce = true;
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
  `);

  await assert.rejects(
    () => runHygiene(cwd, ["--reap", "--backlog", backlog], {
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${preload}`.trim(),
        MUSTER_REFRESH_BACKLOG: backlog,
        MUSTER_REFRESH_CONTENT: refreshed,
      },
    }),
    /content changed before publication/,
  );
  assert.equal(await readFile(backlog, "utf8"), refreshed);
});

test("hygiene detects a read-to-write identity swap and never changes the symlink target", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-hygiene-swap-"));
  const backlog = join(cwd, "backlog.md");
  const displaced = join(cwd, "backlog.original.md");
  const external = join(cwd, "external.md");
  const preload = join(cwd, "swap-after-read.mjs");
  await writeFile(backlog, STALE_BACKLOG);
  await writeFile(external, "EXTERNAL MUST NOT CHANGE\n");
  await writeFile(preload, `
    import fs from "node:fs";
    import { syncBuiltinESMExports } from "node:module";
    const target = process.env.MUSTER_SWAP_BACKLOG;
    const displaced = process.env.MUSTER_SWAP_DISPLACED;
    const external = process.env.MUSTER_SWAP_EXTERNAL;
    let swapped = false;
    const swap = () => {
      if (swapped) return;
      swapped = true;
      fs.renameSync(target, displaced);
      fs.symlinkSync(external, target);
    };
    const originalReadFile = fs.promises.readFile;
    fs.promises.readFile = async function(path, ...args) {
      const result = await originalReadFile.call(this, path, ...args);
      if (String(path) === target) swap();
      return result;
    };
    const originalOpen = fs.promises.open;
    fs.promises.open = async function(path, ...args) {
      const handle = await originalOpen.call(this, path, ...args);
      if (String(path) === target && !swapped) {
        const originalClose = handle.close.bind(handle);
        handle.close = async () => {
          const result = await originalClose();
          swap();
          return result;
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
  `);
  await chmod(preload, 0o600);

  await assert.rejects(
    () => runHygiene(cwd, ["--reap", "--backlog", backlog], {
      env: {
        ...process.env,
        NODE_OPTIONS: `${process.env.NODE_OPTIONS || ""} --import=${preload}`.trim(),
        MUSTER_SWAP_BACKLOG: backlog,
        MUSTER_SWAP_DISPLACED: displaced,
        MUSTER_SWAP_EXTERNAL: external,
      },
    }),
    /changed while reading|symlink|ELOOP|unsafe regular file/i,
  );
  assert.equal(await readFile(external, "utf8"), "EXTERNAL MUST NOT CHANGE\n");
  assert.equal(await readFile(displaced, "utf8"), STALE_BACKLOG);
});
