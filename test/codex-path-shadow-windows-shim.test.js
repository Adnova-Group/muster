// `muster doctor --codex`'s PATH-shadow check (`codex-path-shadow`) determines
// the SHADOWING entry's owning-package version to classify it current-vs-stale.
// On Windows, npm installs a command as SHIM SCRIPTS (`muster.cmd`/`muster.ps1`
// /a bare Bourne `muster`) that WRAP the real JS entry under a sibling
// node_modules -- the shim is a script, NOT a symlink, so realpath() returns
// the shim itself and walking up from it lands on the install prefix's
// package.json (absent/unrelated), never the package the shim wraps. Reading
// the version by EXECUTING the shim (or any .cmd/.ps1/script candidate on PATH)
// would run attacker-plantable code just to read a version.
//
// This suite pins the hardened contract (backlog item
// `doctor-windows-shim-identity`): the shim's owning package.json is resolved
// by FILE READ over the npm shim LAYOUT -- global `<prefix>/muster.cmd` ->
// `<prefix>/node_modules/@adnova-group/muster/package.json`; local
// `<nm>/.bin/muster.cmd` -> `<nm>/@adnova-group/muster/package.json` -- with
// ZERO process execution. Each layout fixture asserts (a) the version is
// classified correctly AND (b) the injected child-process spawn seam is NEVER
// invoked for the shim.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, chmod, rm, stat, realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { checkPathShadow } from "../src/codex-doctor.js";

const OWN_VERSION = "7.7.7"; // the "running package" version these fixtures compare against
const OLD_VERSION = "0.4.1"; // a strictly older owning version => a stale shadow
const PKG = join("@adnova-group", "muster");

async function scratch() {
  // realpath so every fixture ancestor is a canonical, symlink-free directory:
  // the doctor reads the owning package.json through the no-follow bounded
  // reader (O_NOFOLLOW + ordinary-ancestor check), which rejects a symlinked
  // ancestor. mkdtemp under /tmp is already canonical, but normalize anyway.
  return realpath(await mkdtemp(join(tmpdir(), "muster-winshim-")));
}

// A running-package identity fixture so "current" means "same version as this
// injected own package", independent of the repo's actual version. checkPathShadow
// walks up from ownModuleUrl's file to the nearest package.json.
async function ownPackage(dir, version = OWN_VERSION) {
  const root = join(dir, "own");
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "package.json"), JSON.stringify({ name: "@adnova-group/muster", version, bin: { muster: "src/cli.js" } }));
  await writeFile(join(root, "src", "cli.js"), "console.log('own');\n");
  return pathToFileURL(join(root, "src", "codex-doctor.js"));
}

// Write an owning package.json at node_modules/@adnova-group/muster under `nm`.
async function owningPackage(nm, version) {
  const pkgDir = join(nm, PKG);
  await mkdir(pkgDir, { recursive: true });
  await writeFile(join(pkgDir, "package.json"), JSON.stringify({ name: "@adnova-group/muster", version, bin: { muster: "bin/muster.js" } }));
  return pkgDir;
}

// A win32 PATHEXT whose entries produce the shim names we plant. The test host
// is case-sensitive (Linux), so include the exact-case `.cmd`/`.ps1` the
// realistic fixtures use in addition to the win32 defaults.
const WIN_PATHEXT = ".COM;.EXE;.BAT;.CMD;.cmd;.ps1";

// A recording spawn seam: proves the check is HANDED a process-execution
// capability and provably never uses it for the shim.
function spawnSpy() {
  const calls = [];
  const fn = (...args) => { calls.push(args); throw new Error("checkPathShadow must NEVER spawn a child process for the shim"); };
  return { fn, calls };
}

const escape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("windows shim: GLOBAL current -- prefix/muster.cmd owning package at THIS version is classified current (file read, no exec)", async () => {
  const dir = await scratch();
  try {
    const ownModuleUrl = await ownPackage(dir);
    const prefix = join(dir, "prefix");
    await mkdir(prefix, { recursive: true });
    await owningPackage(join(prefix, "node_modules"), OWN_VERSION);
    const shim = join(prefix, "muster.cmd");
    await writeFile(shim, "@echo off\r\nnode \"%~dp0\\node_modules\\@adnova-group\\muster\\bin\\muster.js\" %*\r\n");

    const spy = spawnSpy();
    const check = await checkPathShadow({ env: { PATH: prefix, PATHEXT: WIN_PATHEXT }, platform: "win32", ownModuleUrl, spawnProcess: spy.fn });

    assert.equal(check.ok, true, check.detail);
    assert.match(check.detail, /matches this package|resolves to this running package|is this running package/);
    assert.match(check.detail, new RegExp(escape(OWN_VERSION)));
    assert.equal(spy.calls.length, 0, "the shim must never be executed to read its version");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("windows shim: GLOBAL stale -- prefix/muster.cmd owning package at an OLDER version is a stale shadow (file read, no exec)", async () => {
  const dir = await scratch();
  try {
    const ownModuleUrl = await ownPackage(dir);
    const prefix = join(dir, "prefix");
    await mkdir(prefix, { recursive: true });
    await owningPackage(join(prefix, "node_modules"), OLD_VERSION);
    const shim = join(prefix, "muster.cmd");
    await writeFile(shim, "@echo off\r\nnode \"%~dp0\\node_modules\\@adnova-group\\muster\\bin\\muster.js\" %*\r\n");

    const spy = spawnSpy();
    const check = await checkPathShadow({ env: { PATH: prefix, PATHEXT: WIN_PATHEXT }, platform: "win32", ownModuleUrl, spawnProcess: spy.fn });

    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, new RegExp(escape(shim)));
    assert.match(check.detail, new RegExp(escape(OLD_VERSION)));
    assert.match(check.detail, /stale/);
    assert.match(check.detail, /npm i -g @adnova-group\/muster@latest/);
    assert.equal(spy.calls.length, 0, "the stale shim must never be executed to read its version");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("windows shim: LOCAL current -- node_modules/.bin/muster.cmd resolves ../@adnova-group/muster at THIS version (file read, no exec)", async () => {
  const dir = await scratch();
  try {
    const ownModuleUrl = await ownPackage(dir);
    const nm = join(dir, "proj", "node_modules");
    const binDir = join(nm, ".bin");
    await mkdir(binDir, { recursive: true });
    await owningPackage(nm, OWN_VERSION);
    const shim = join(binDir, "muster.cmd");
    await writeFile(shim, "@echo off\r\nnode \"%~dp0\\..\\@adnova-group\\muster\\bin\\muster.js\" %*\r\n");

    const spy = spawnSpy();
    const check = await checkPathShadow({ env: { PATH: binDir, PATHEXT: WIN_PATHEXT }, platform: "win32", ownModuleUrl, spawnProcess: spy.fn });

    assert.equal(check.ok, true, check.detail);
    assert.match(check.detail, /matches this package|resolves to this running package|is this running package/);
    assert.match(check.detail, new RegExp(escape(OWN_VERSION)));
    assert.equal(spy.calls.length, 0, "the local shim must never be executed to read its version");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("windows shim: LOCAL stale -- node_modules/.bin/muster.cmd resolves ../@adnova-group/muster at an OLDER version (file read, no exec)", async () => {
  const dir = await scratch();
  try {
    const ownModuleUrl = await ownPackage(dir);
    const nm = join(dir, "proj", "node_modules");
    const binDir = join(nm, ".bin");
    await mkdir(binDir, { recursive: true });
    await owningPackage(nm, OLD_VERSION);
    const shim = join(binDir, "muster.cmd");
    await writeFile(shim, "@echo off\r\nnode \"%~dp0\\..\\@adnova-group\\muster\\bin\\muster.js\" %*\r\n");

    const spy = spawnSpy();
    const check = await checkPathShadow({ env: { PATH: binDir, PATHEXT: WIN_PATHEXT }, platform: "win32", ownModuleUrl, spawnProcess: spy.fn });

    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, new RegExp(escape(shim)));
    assert.match(check.detail, new RegExp(escape(OLD_VERSION)));
    assert.match(check.detail, /stale/);
    assert.equal(spy.calls.length, 0, "the stale local shim must never be executed to read its version");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("windows shim: unresolvable owner -- shim present but no node_modules package.json is present-but-UNVERIFIED, not executed", async () => {
  const dir = await scratch();
  try {
    const ownModuleUrl = await ownPackage(dir);
    const prefix = join(dir, "prefix");
    await mkdir(join(prefix, "node_modules"), { recursive: true }); // empty: no owning package
    const shim = join(prefix, "muster.cmd");
    await writeFile(shim, "@echo off\r\nnode nowhere %*\r\n");

    const spy = spawnSpy();
    const check = await checkPathShadow({ env: { PATH: prefix, PATHEXT: WIN_PATHEXT }, platform: "win32", ownModuleUrl, spawnProcess: spy.fn });

    assert.equal(check.ok, true, check.detail); // cannot verify => fail OPEN, named
    assert.match(check.detail, new RegExp(escape(shim)));
    assert.match(check.detail, /could not resolve|unverified|NOT executed/i);
    assert.equal(spy.calls.length, 0, "an unverifiable shim must never be executed");
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test("windows shim: a bare executable Bourne `muster` shim is inspected but NEVER executed (sentinel proof)", async () => {
  const dir = await scratch();
  try {
    const ownModuleUrl = await ownPackage(dir);
    const prefix = join(dir, "prefix");
    await mkdir(prefix, { recursive: true });
    await owningPackage(join(prefix, "node_modules"), OLD_VERSION);
    const sentinel = join(dir, "PWNED");
    // npm's bare Bourne shim is an extensionless executable script. If the
    // doctor ever ran it (raw spawn, bypassing any injected seam), it would
    // write the sentinel. On win32 resolution the bare name is the fallback
    // when no PATHEXT variant exists.
    const shim = join(prefix, "muster");
    await writeFile(shim, `#!/bin/sh\necho pwned > ${JSON.stringify(sentinel)}\n`);
    await chmod(shim, 0o755);

    const check = await checkPathShadow({ env: { PATH: prefix, PATHEXT: WIN_PATHEXT }, platform: "win32", ownModuleUrl });

    await assert.rejects(stat(sentinel), /ENOENT/, "the bare `muster` shim must NEVER be executed by the doctor check");
    assert.equal(check.ok, false, check.detail);
    assert.match(check.detail, new RegExp(escape(OLD_VERSION)));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
