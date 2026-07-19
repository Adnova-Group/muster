// `muster doctor --codex`'s stale PATH-level muster detection (backlog item
// `run4-polish-pair`, part a; security-hardened by run-5 audit High #3
// `doctor-path-shadow-no-exec`): 2026-07-19's run 4 found a shadow `muster`
// on PATH (an old global npm install, /home/linuxbrew/.linuxbrew/bin/muster)
// that lacked the codex-conformance verb -- a bare `muster` invocation would
// silently serve that stale behavior.
//
// The FIRST version of this check shelled out (`sh -c command -v muster`) and
// then EXECUTED the resolved candidate (`<candidate> help`) to diff verbs --
// i.e. it ran an attacker-plantable PATH binary just to inspect it. This
// suite pins the hardened contract: PATH/PATHEXT is resolved IN-PROCESS and
// the candidate's identity is compared WITHOUT ever executing it (realpath +
// sibling package.json), via an injectable `env`/`platform` instead of an
// injectable shell. The `malicious` fixture proves the candidate is never
// run: it would write a sentinel IF executed, and we assert the sentinel is
// never created.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, symlink, chmod, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

// Never shell out from these tests: any real execFile call would defeat the
// point. `absent` throws on every invocation, exactly like every other
// codex-doctor test uses to keep the other checks offline.
const absent = async () => { throw new Error("not found"); };

async function scratch() {
  return mkdtemp(join(tmpdir(), "muster-path-shadow-"));
}

function shadowCheck(report) {
  const check = report.checks.find(c => c.name === "codex-path-shadow");
  assert.ok(check, "codex-path-shadow check must always be present");
  return check;
}

test("codex-path-shadow: no `muster` anywhere on PATH is ok:true", async () => {
  const dir = await scratch();
  try {
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const report = await runCodexDoctor({ root: repoRoot, execFile: absent, env: { PATH: binDir }, platform: "linux" });
    const check = shadowCheck(report);
    assert.equal(check.ok, true);
    assert.match(check.detail, /no `muster` found on PATH/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("codex-path-shadow: a PATH `muster` that resolves to THIS running package is ok:true", async () => {
  const dir = await scratch();
  try {
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    // A bare `muster` here symlinks straight at this package's own bin --
    // realpath equality proves it IS us, no execution needed.
    await symlink(join(repoRoot, "src", "cli.js"), join(binDir, "muster"));
    const report = await runCodexDoctor({ root: repoRoot, execFile: absent, env: { PATH: binDir }, platform: "linux" });
    const check = shadowCheck(report);
    assert.equal(check.ok, true, check.detail);
    assert.match(check.detail, /resolves to this running package|is this running package|matches this package/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("codex-path-shadow: a stale different-version PATH `muster` is ok:false and names the path + remediation", async () => {
  const dir = await scratch();
  try {
    // A whole foreign install at a different version -- identity is read from
    // its package.json, never by running its bin.
    const install = join(dir, "stale-install");
    await mkdir(install);
    await writeFile(join(install, "package.json"), JSON.stringify({ name: "@adnova-group/muster", version: "0.4.1", bin: { muster: "cli.js" } }));
    await writeFile(join(install, "cli.js"), "console.log('stale');\n");
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const shadow = join(binDir, "muster");
    await symlink(join(install, "cli.js"), shadow);

    const report = await runCodexDoctor({ root: repoRoot, execFile: absent, env: { PATH: binDir }, platform: "linux" });
    const check = shadowCheck(report);
    assert.equal(check.ok, false);
    assert.equal(report.ok, false, "an incoherent PATH shadow must fail the overall doctor report");
    assert.match(check.detail, new RegExp(shadow.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(check.detail, /0\.4\.1/);
    assert.match(check.detail, /npm uninstall -g/);
    assert.match(check.detail, /npm i -g @adnova-group\/muster@latest/);
    assert.match(check.detail, /remove the shadow/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("codex-path-shadow: a MALICIOUS planted PATH `muster` is inspected but NEVER executed (sentinel proof)", async () => {
  const dir = await scratch();
  try {
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    const sentinel = join(dir, "PWNED");
    // If this candidate is ever executed, it writes the sentinel. The
    // hardened check must resolve+inspect it WITHOUT running it.
    const planted = join(binDir, "muster");
    await writeFile(planted, `#!/bin/sh\necho pwned > ${JSON.stringify(sentinel)}\n`);
    await chmod(planted, 0o755);

    const report = await runCodexDoctor({ root: repoRoot, execFile: absent, env: { PATH: binDir }, platform: "linux" });
    const check = shadowCheck(report);

    // THE security invariant: the candidate was never run.
    await assert.rejects(stat(sentinel), /ENOENT/, "the planted `muster` must NEVER be executed by the doctor check");

    // And it is still surfaced as a foreign shadow the user should remove.
    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, new RegExp(planted.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("codex-path-shadow: win32-shaped PATH/PATHEXT resolution finds `muster.CMD` without executing it", async () => {
  const dir = await scratch();
  try {
    // On win32 the executable is `muster<ext>` for an ext in PATHEXT, and PATH
    // is `;`-delimited. Resolution must honor both, still without exec.
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    await writeFile(join(binDir, "package.json"), JSON.stringify({ name: "@adnova-group/muster", version: "0.3.9", bin: { muster: "muster.CMD" } }));
    const shim = join(binDir, "muster.CMD");
    await writeFile(shim, "@echo off\r\nnode cli.js %*\r\n");

    const report = await runCodexDoctor({
      root: repoRoot,
      execFile: absent,
      env: { PATH: `${join(dir, "empty")};${binDir}`, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      platform: "win32"
    });
    const check = shadowCheck(report);
    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, new RegExp(shim.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(check.detail, /0\.3\.9/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("codex-path-shadow: fails OPEN (ok:true, named) when the identity probe itself errors", async () => {
  const dir = await scratch();
  try {
    const binDir = join(dir, "bin");
    await mkdir(binDir);
    // A dangling symlink: the PATH entry exists (lstat succeeds -> found),
    // but realpath throws -> the probe can't resolve identity -> fail OPEN.
    const shadow = join(binDir, "muster");
    await symlink(join(dir, "does-not-exist"), shadow);

    const report = await runCodexDoctor({ root: repoRoot, execFile: absent, env: { PATH: binDir }, platform: "linux" });
    const check = shadowCheck(report);
    assert.equal(check.ok, true, "a broken PATH binary must not fail doctor incoherently");
    assert.match(check.detail, new RegExp(shadow.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(check.detail, /could not probe/);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("codex-path-shadow: an execFile fixture with no PATH awareness (the shared `absent` fixture) fails open safely", async () => {
  // No env injected -> reads the real process.env.PATH; whatever it finds, the
  // check must always be present and must never throw out of runCodexDoctor.
  const report = await runCodexDoctor({ root: repoRoot, execFile: absent });
  const check = shadowCheck(report);
  assert.equal(typeof check.ok, "boolean");
});
