/**
 * src/fs-safe.js: the shared filesystem-safety primitives (audit S4).
 *
 * Each primitive's contract is pinned here against temp-dir fixtures, including
 * the past-TOCTOU cases the original per-module implementations documented:
 * the descriptor-pinned fstat gate (never a second path re-resolution), the
 * post-read identity recheck, O_NOFOLLOW's symlink refusal, and the canonical
 * (post-realpath) containment that closes symlink escapes -- the finding-5
 * hole, where a repo-internal symlink backlog -> outside-the-root target used
 * to classify as kind:"file" and get read verbatim.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { link, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
  atomicWrite,
  isAbsolutePathToken,
  isContainedLexical,
  isUnsafePathToken,
  ordinaryDirectoryPath,
  readNoFollowRegular,
  readNoFollowRegularSync,
  resolveContainedRealpath,
  safeRelativePath,
} from "../src/fs-safe.js";
import { parseBacklogRef, resolveBacklogFileRef } from "../src/batch-plan.js";
import { detectScope } from "../src/scope.js";

async function withTempDir(fn) {
  const dir = await mkdtemp(join(tmpdir(), "muster-fs-safe-"));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

// --- isAbsolutePathToken / isUnsafePathToken --------------------------------

test("isAbsolutePathToken: POSIX-absolute, drive-letter, UNC, and single-backslash shapes are all absolute", () => {
  for (const token of ["/etc/passwd", "C:\\x.md", "c:/x.md", "\\\\server\\x.md", "\\x.md"]) {
    assert.equal(isAbsolutePathToken(token), true, token);
  }
  for (const token of ["backlog.md", "docs/plan/x.md", ".muster/backlog.md"]) {
    assert.equal(isAbsolutePathToken(token), false, token);
  }
  assert.equal(isAbsolutePathToken(undefined), true);
  assert.equal(isAbsolutePathToken(null), true);
});

test("isUnsafePathToken: any '..' substring trips the guard, even inside a filename", () => {
  assert.equal(isUnsafePathToken("../secrets.md"), true);
  assert.equal(isUnsafePathToken("docs/../../etc/passwd.md"), true);
  assert.equal(isUnsafePathToken("notes..txt"), true);
  assert.equal(isUnsafePathToken("/absolute/without/dots.md"), true);
  assert.equal(isUnsafePathToken("C:\\x.md"), true);
  assert.equal(isUnsafePathToken("notes.txt"), false);
  assert.equal(isUnsafePathToken(".muster/backlog.md"), false);
  assert.equal(isUnsafePathToken(42), true);
});

// --- safeRelativePath (init.js's original lexical validator) -----------------

test("safeRelativePath: ordinary nested relative paths pass through unchanged", () => {
  assert.equal(safeRelativePath("AGENTS.md"), "AGENTS.md");
  assert.equal(safeRelativePath("docs/design/.gitkeep"), "docs/design/.gitkeep");
  assert.equal(safeRelativePath(".muster/project-profile.json"), ".muster/project-profile.json");
});

test("safeRelativePath: rejects absolute, traversal, backslash, NUL, empty-segment, and oversized paths", () => {
  for (const bad of [
    "", "/abs/path", "../up", "a/../b", "a//b", "a/./b", ".", "..",
    "a\\b", "C:\\x", "C:/x", "//unc/share", "nul\0byte", "x".repeat(257),
  ]) {
    assert.throws(() => safeRelativePath(bad), /^Error: unsafe relative path: /, JSON.stringify(bad));
  }
  assert.throws(() => safeRelativePath(undefined), /unsafe relative path/);
});

// --- isContainedLexical -------------------------------------------------------

test("isContainedLexical: inside and equal are contained; '..' escapes and sibling prefixes are not", () => {
  assert.equal(isContainedLexical("/a/b", "/a/b"), true);
  assert.equal(isContainedLexical("/a/b", "/a/b/c/d"), true);
  assert.equal(isContainedLexical("/a/b", "/a"), false);
  assert.equal(isContainedLexical("/a/b", "/a/b/../c"), false);
  // The startsWith(base + sep) trap: a sibling whose name SHARES a prefix with
  // the base is not inside it.
  assert.equal(isContainedLexical("/a/b", "/a/b2/c"), false);
  assert.equal(isContainedLexical("/a/b", "/etc/passwd"), false);
});

// --- resolveContainedRealpath (canonical containment; finding 5) --------------

test("resolveContainedRealpath: a real file inside the root resolves to its canonical path", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, "docs"), { recursive: true });
    await writeFile(join(dir, "docs", "backlog.md"), "- [ ] item\n");
    const resolved = await resolveContainedRealpath(dir, join(dir, "docs", "backlog.md"));
    assert.equal(resolved, await realpath(join(dir, "docs", "backlog.md")));
  });
});

test("resolveContainedRealpath: a symlink escaping the root resolves to null (finding 5)", async () => {
  await withTempDir(async (dir) => {
    const outside = join(tmpdir(), `muster-fs-safe-outside-${process.pid}.md`);
    await writeFile(outside, "- [ ] secret\n");
    try {
      await symlink(outside, join(dir, "backlog.md"));
      assert.equal(await resolveContainedRealpath(dir, join(dir, "backlog.md")), null);
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("resolveContainedRealpath: a symlink whose target stays inside the root is allowed", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "real.md"), "- [ ] item\n");
    await symlink(join(dir, "real.md"), join(dir, "alias.md"));
    const resolved = await resolveContainedRealpath(dir, join(dir, "alias.md"));
    assert.equal(resolved, await realpath(join(dir, "real.md")));
  });
});

test("resolveContainedRealpath: a symlinked ANCESTOR escaping the root resolves to null", async () => {
  await withTempDir(async (dir) => {
    await withTempDir(async (outside) => {
      await writeFile(join(outside, "backlog.md"), "- [ ] secret\n");
      await symlink(outside, join(dir, "linked-dir"));
      assert.equal(await resolveContainedRealpath(dir, join(dir, "linked-dir", "backlog.md")), null);
    });
  });
});

test("resolveContainedRealpath: a missing target resolves to null (benign absence), a missing base throws", async () => {
  await withTempDir(async (dir) => {
    assert.equal(await resolveContainedRealpath(dir, join(dir, "nope.md")), null);
    await assert.rejects(() => resolveContainedRealpath(join(dir, "no-such-base"), join(dir, "x.md")));
  });
});

// --- ordinaryDirectoryPath (shared no-follow ancestry walker) ----------------

test("ordinaryDirectoryPath: one return contract covers existing, missing, and created ancestry", async () => {
  await withTempDir(async (dir) => {
    const existing = join(dir, "existing", "nested");
    await mkdir(existing, { recursive: true });
    assert.equal(await ordinaryDirectoryPath(existing), resolve(existing));

    const missing = join(dir, "missing", "nested");
    assert.equal(await ordinaryDirectoryPath(missing), false);
    assert.equal(await ordinaryDirectoryPath(missing, { create: true }), resolve(missing));
    assert.equal((await stat(join(dir, "missing"))).isDirectory(), true);
    assert.equal((await stat(missing)).isDirectory(), true);
    if (process.platform !== "win32") {
      assert.equal((await stat(join(dir, "missing"))).mode & 0o777, 0o700);
      assert.equal((await stat(missing)).mode & 0o777, 0o700);
    }
  });
});

test("ordinaryDirectoryPath: rejects a symlinked or non-directory component and names the offender", async () => {
  await withTempDir(async (dir) => {
    const target = join(dir, "target");
    await mkdir(target);
    const linked = join(dir, "linked");
    await symlink(target, linked);
    await assert.rejects(
      () => ordinaryDirectoryPath(join(linked, "child")),
      new RegExp(`ordinary directory: ${linked.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );

    const file = join(dir, "file");
    await writeFile(file, "not a directory");
    await assert.rejects(
      () => ordinaryDirectoryPath(join(file, "child")),
      new RegExp(`ordinary directory: ${file.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
    );
  });
});

test("ordinaryDirectoryPath: all four consumers import the shared walker instead of declaring their own", async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const consumers = [
    ["src/codex-install.js", /ordinaryDirectoryPath/],
    ["src/codex-doctor.js", /ordinaryDirectoryPath/],
    ["src/chatgpt-work-install.js", /ordinaryDirectoryPath/],
    ["mcp/chatgpt-work-server.mjs", /ordinaryDirectoryPath/],
  ];
  for (const [relative, call] of consumers) {
    const source = await readFile(join(root, relative), "utf8");
    assert.match(source, /from ["'][^"']*fs-safe\.js["']/, `${relative} imports fs-safe.js`);
    assert.match(source, call, `${relative} calls the shared walker`);
    assert.doesNotMatch(source, /(?:async\s+)?function ordinaryDirectory(?:Path)?\s*\(/, `${relative} has no local walker`);
  }
});

// --- readNoFollowRegular (async, descriptor-pinned) ---------------------------

test("readNoFollowRegular: reads a regular file and returns { bytes, info }", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "f.txt");
    await writeFile(path, "hello");
    const { bytes, info } = await readNoFollowRegular(path, { maxBytes: 1024, label: "f.txt" });
    assert.equal(bytes.toString("utf8"), "hello");
    assert.equal(info.size, 5);
  });
});

test("readNoFollowRegular: the size cap is enforced on the descriptor before any read", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "big.txt");
    await writeFile(path, "x".repeat(100));
    // Exactly at the cap passes; one over is rejected with init.js's exact message.
    const ok = await readNoFollowRegular(path, { maxBytes: 100, label: "big.txt" });
    assert.equal(ok.bytes.length, 100);
    await assert.rejects(
      () => readNoFollowRegular(path, { maxBytes: 99, label: "big.txt" }),
      (error) => {
        assert.equal(error.message, "unsafe regular file: big.txt");
        assert.equal(error.fsSafe?.reason, "too-large");
        assert.equal(error.fsSafe?.size, 100);
        return true;
      },
    );
  });
});

test("readNoFollowRegular: a non-regular final component (directory, FIFO-free) is rejected", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => readNoFollowRegular(dir, { maxBytes: 1024, label: "a-dir" }),
      (error) => {
        assert.equal(error.message, "unsafe regular file: a-dir");
        assert.equal(error.fsSafe?.reason, "not-regular");
        return true;
      },
    );
  });
});

test("readNoFollowRegular: O_NOFOLLOW refuses a symlinked final component at open (no lstat re-resolution)", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "target.txt"), "x");
    await symlink(join(dir, "target.txt"), join(dir, "link.txt"));
    await assert.rejects(
      () => readNoFollowRegular(join(dir, "link.txt"), { maxBytes: 1024, label: "link.txt" }),
      (error) => error.code === "ELOOP",
    );
  });
});

test("readNoFollowRegular: expectedInfo pins the lstat identity -- a swapped file is 'file changed while reading'", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "f.txt");
    await writeFile(path, "hello");
    const before = await lstat(path);
    // The real lstat passes the identity check...
    const ok = await readNoFollowRegular(path, { maxBytes: 1024, label: "f.txt", expectedInfo: before });
    assert.equal(ok.bytes.toString("utf8"), "hello");
    // ...and a stale/foreign identity (e.g. the file was replaced between the
    // caller's lstat and this open) is rejected with the exact TOCTOU message.
    await writeFile(join(dir, "other.txt"), "other");
    const foreign = await lstat(join(dir, "other.txt"));
    await assert.rejects(
      () => readNoFollowRegular(path, { maxBytes: 1024, label: "f.txt", expectedInfo: foreign }),
      (error) => {
        assert.equal(error.message, "file changed while reading: f.txt");
        assert.equal(error.fsSafe?.reason, "changed");
        return true;
      },
    );
  });
});

test("readNoFollowRegular: requireSingleLink rejects a hard-linked (nlink > 1) file", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "f.txt");
    await writeFile(path, "x");
    await link(path, join(dir, "hardlink.txt"));
    await assert.rejects(
      () => readNoFollowRegular(path, { maxBytes: 1024, label: "f.txt", requireSingleLink: true }),
      (error) => {
        assert.equal(error.message, "unsafe regular file: f.txt");
        assert.equal(error.fsSafe?.reason, "not-regular");
        return true;
      },
    );
  });
});

test("readNoFollowRegular: a missing file propagates ENOENT untouched", async () => {
  await withTempDir(async (dir) => {
    await assert.rejects(
      () => readNoFollowRegular(join(dir, "nope.txt"), { maxBytes: 1024, label: "nope.txt" }),
      (error) => error.code === "ENOENT",
    );
  });
});

// --- readNoFollowRegularSync (codex-release.js's exact message contract) ------

test("readNoFollowRegularSync: reads a regular file and enforces the bounded-size gate", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "f.txt");
    await writeFile(path, "hello");
    assert.equal(readNoFollowRegularSync(path, { maxBytes: 1024, label: "L" }).toString("utf8"), "hello");
    assert.throws(() => readNoFollowRegularSync(path, { maxBytes: 4, label: "L" }), /^Error: L must be a bounded regular file: /);
  });
});

test("readNoFollowRegularSync: symlink, missing, and non-regular targets keep the historical messages", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "target.txt"), "x");
    await symlink(join(dir, "target.txt"), join(dir, "link.txt"));
    assert.throws(() => readNoFollowRegularSync(join(dir, "link.txt"), { maxBytes: 1, label: "L" }), /^Error: L must not be a symlink: /);
    assert.throws(() => readNoFollowRegularSync(join(dir, "nope.txt"), { maxBytes: 1, label: "L" }), /^Error: L is missing: /);
    assert.throws(() => readNoFollowRegularSync(dir, { maxBytes: 1, label: "L" }), /^Error: L must be a regular file: /);
  });
});

// --- atomicWrite ---------------------------------------------------------------

test("atomicWrite: publishes bytes and string content, replaces an existing target, mode 0o600", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "out.json");
    assert.equal(await atomicWrite(path, Buffer.from("one")), true);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
    assert.equal(await atomicWrite(path, "two"), true);
    assert.equal(await readFile(path, "utf8"), "two");
  });
});

test("atomicWrite: a throwing beforeRename hook aborts the publish -- target untouched, temp swept", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "out.txt");
    await writeFile(path, "original");
    let staged = null;
    await assert.rejects(() => atomicWrite(path, "replacement", {
      beforeRename: (temp) => { staged = temp; throw new Error("owned target changed while writing: out.txt"); },
    }), /owned target changed while writing/);
    assert.equal(await readFile(path, "utf8"), "original");
    assert.ok(staged && !(await readdir(dir)).some((name) => name === staged.split("/").pop()), "temp swept");
  });
});

test("atomicWrite: honors a caller's historical tempName and fsyncDir", async () => {
  await withTempDir(async (dir) => {
    const path = join(dir, "out.txt");
    let seen = null;
    await atomicWrite(path, "x", {
      fsyncDir: true,
      tempName: (targetPath) => { seen = join(dir, `.muster-init-tmp-deadbeef`); return seen; },
      beforeRename: (temp) => { assert.equal(temp, seen); },
    });
    assert.ok(seen);
  });
});

// --- finding 5: the file-ref symlink escape (TDD) ------------------------------

test("resolveBacklogFileRef: a real contained backlog resolves canonically; non-file refs and escapes resolve null", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "backlog.md"), "- [ ] item\n");
    const ref = parseBacklogRef("backlog.md");
    assert.equal(ref.kind, "file");
    assert.equal(await resolveBacklogFileRef(dir, ref), await realpath(join(dir, "backlog.md")));

    // Non-file refs have nothing to resolve.
    assert.equal(await resolveBacklogFileRef(dir, parseBacklogRef("issues:x")), null);
    assert.equal(await resolveBacklogFileRef(dir, parseBacklogRef("an outcome")), null);

    // The finding-5 hole: a repo-internal symlink backlog -> outside the run
    // root classifies as kind:"file" but must never be read.
    const outside = join(tmpdir(), `muster-fs-safe-ref-${process.pid}.md`);
    await writeFile(outside, "- [ ] secret\n");
    try {
      await symlink(outside, join(dir, "evil.md"));
      const evilRef = parseBacklogRef("evil.md");
      assert.equal(evilRef.kind, "file", "sanity: the lexical guard cannot see where a symlink points");
      assert.equal(await resolveBacklogFileRef(dir, evilRef), null);
    } finally {
      await rm(outside, { force: true });
    }

    // A missing backlog is a benign null too.
    assert.equal(await resolveBacklogFileRef(dir, parseBacklogRef("missing.md")), null);
  });
});

test("detectScope: a symlink backlog candidate escaping cwd contributes no readable-file signal", async () => {
  await withTempDir(async (dir) => {
    const outside = join(tmpdir(), `muster-fs-safe-scope-${process.pid}`);
    await writeFile(outside, "- [ ] secret item\n");
    try {
      // Extensionless name: only scope rule 2 (existing readable checklist
      // file) could fire -- exactly the read path the guard now protects.
      await symlink(outside, join(dir, "backlog"));
      const r = await detectScope({ cwd: dir, text: "backlog" });
      assert.equal(r.scope, "item");
      assert.ok(!r.signals.some((s) => s.includes("readable file")), r.signals.join(" | "));
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("detectScope: a symlinked .muster/backlog.md escaping cwd does not count as a live default backlog", async () => {
  await withTempDir(async (dir) => {
    const outside = join(tmpdir(), `muster-fs-safe-scope3-${process.pid}`);
    await writeFile(outside, "- [ ] secret item\n");
    try {
      await mkdir(join(dir, ".muster"));
      await symlink(outside, join(dir, ".muster", "backlog.md"));
      const r = await detectScope({ cwd: dir, text: "" });
      assert.equal(r.scope, "ambiguous", JSON.stringify(r));
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("detectScope: a real .muster/backlog.md inside cwd still counts as a live default backlog", async () => {
  await withTempDir(async (dir) => {
    await mkdir(join(dir, ".muster"));
    await writeFile(join(dir, ".muster", "backlog.md"), "- [ ] real item\n");
    const r = await detectScope({ cwd: dir, text: "" });
    assert.equal(r.scope, "backlog");
    assert.ok(r.signals.some((s) => s.includes(".muster/backlog.md")));
  });
});

// --- audit 2 slice B: the sprint-waves CLI read path (TDD) --------------------
// Finding-5's canonical containment covered only src/scope.js's
// readBacklogCandidate; the backlog file the orchestrator actually reads and
// passes to sprint-waves (src/cli.js's sprint-waves branch) was still read raw
// via readFile(file), so a planted symlink backlog (.muster/backlog.md ->
// ~/.ssh/id_rsa) was followed and its target's contents entered the run. The
// branch now applies the same resolveContainedRealpath check against the run
// root (process.cwd()) before reading: a canonical escape fails with a named
// error, never a read.

const pexecFile = promisify(execFile);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

test("sprint-waves CLI: a symlink backlog escaping the run root is refused with a named error, never read", async () => {
  await withTempDir(async (dir) => {
    const outside = join(tmpdir(), `muster-fs-safe-sprint-${process.pid}.md`);
    await writeFile(outside, "- [ ] TOPSECRET-target-contents\n");
    try {
      await mkdir(join(dir, ".muster"));
      await symlink(outside, join(dir, ".muster", "backlog.md"));
      await assert.rejects(
        pexecFile(process.execPath, [CLI, "sprint-waves", ".muster/backlog.md"], { cwd: dir }),
        (error) => {
          assert.match(String(error.stderr), /contained under the run root/, error.stderr);
          assert.ok(
            !String(error.stdout).includes("TOPSECRET"),
            "the symlink target's contents must never enter the run",
          );
          return true;
        },
      );
    } finally {
      await rm(outside, { force: true });
    }
  });
});

test("sprint-waves CLI: a real backlog inside the run root still computes waves", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "backlog.md"), "- [ ] Do first\n- [ ] Do second\n");
    const { stdout } = await pexecFile(process.execPath, [CLI, "sprint-waves", "backlog.md"], { cwd: dir });
    const r = JSON.parse(stdout);
    assert.equal(r.ok, true);
    assert.deepEqual(r.waves, [["item-1"], ["item-2"]]);
  });
});

test("sprint-waves CLI: a symlink backlog whose target stays inside the run root is allowed", async () => {
  await withTempDir(async (dir) => {
    await writeFile(join(dir, "real.md"), "- [ ] Only item\n");
    await symlink(join(dir, "real.md"), join(dir, "alias.md"));
    const { stdout } = await pexecFile(process.execPath, [CLI, "sprint-waves", "alias.md"], { cwd: dir });
    assert.equal(JSON.parse(stdout).ok, true);
  });
});
