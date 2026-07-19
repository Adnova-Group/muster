// run-5 security audit Med #5 (src/codex-install.js): persisted Codex lifecycle
// hook commands must invoke a VALIDATED ABSOLUTE Node interpreter
// (process.execPath), never a bare `node`. A bare `node` is resolved through
// PATH on every hook event, so an attacker who prepends a directory to PATH
// with a malicious `node` would hijack the interpreter on every fire. These
// fixtures prove (1) the generated command -- POSIX `command` AND Windows
// `commandWindows` -- pins the absolute execPath, so a PATH-shadowed `node`
// cannot hijack it, and (2) `muster doctor --codex` flags a managed hook whose
// pinned interpreter no longer exists as a regular file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatCodexWindowsPath, parseHookCommand, runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const absent = async () => { throw new Error("not found"); };

// Rewrite every managed hook command's interpreter token to `ghostNode`,
// applied IDENTICALLY to the live hooks.json groups and the ownership
// manifest's hookGroups so the pair stays byte-for-byte coherent
// (ownsExactHookGroups keeps passing) -- isolating the ONE thing under test:
// the pinned interpreter file having vanished.
function repinInterpreter(groupsByEvent, ghostNode, scriptPath) {
  const command = `'${ghostNode}' '${scriptPath}'`;
  const commandWindows = `"${formatCodexWindowsPath(ghostNode)}" "${formatCodexWindowsPath(scriptPath)}"`;
  for (const groups of Object.values(groupsByEvent)) {
    for (const group of groups) {
      for (const hook of group.hooks || []) { hook.command = command; hook.commandWindows = commandWindows; }
    }
  }
}

test("Codex install pins the absolute execPath (not bare node) in both command and commandWindows", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-pin-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });

  const scriptPath = join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs");
  const hooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  const hook = hooks.hooks.SessionStart[0].hooks[0];

  // POSIX: the interpreter is the quoted absolute execPath, not bare `node`.
  assert.equal(hook.command, `'${process.execPath}' '${scriptPath}'`);
  assert.ok(!/^node\b/.test(hook.command), "POSIX hook command must not start with a PATH-resolvable bare node");
  assert.ok(hook.command.startsWith(`'${process.execPath}' `), "POSIX interpreter must be the absolute execPath");

  // Windows: same pinning, Windows-mapped and double-quoted.
  const expectedNode = formatCodexWindowsPath(process.execPath);
  assert.equal(hook.commandWindows, `"${expectedNode}" "${formatCodexWindowsPath(scriptPath)}"`);
  assert.ok(!/^node\b/.test(hook.commandWindows), "Windows hook command must not start with a bare node");

  // Every emitted event -- both dual-emitted fields -- carries the pinned node.
  for (const groups of Object.values(hooks.hooks)) {
    for (const group of groups) {
      for (const h of group.hooks || []) {
        assert.ok(h.command.startsWith(`'${process.execPath}' `), `POSIX command not pinned: ${h.command}`);
        assert.ok(h.commandWindows.startsWith(`"${expectedNode}" `), `Windows command not pinned: ${h.commandWindows}`);
      }
    }
  }
});

test("parseHookCommand round-trips the pinned two-token shape for both POSIX and Windows, incl. spaces and quotes", () => {
  const node = "/opt/node v20/bin/no'de";
  const script = "/home/x/.codex/muster/hooks/muster-hook.mjs";
  const posix = `'${node.replaceAll("'", `'\\''`)}' '${script}'`;
  assert.deepEqual(parseHookCommand(posix), { interpreter: node, script });

  const winNode = "C:/Program Files/nodejs/node.exe";
  const winScript = "C:/checkout/.codex/muster/hooks/muster-hook.mjs";
  const windows = `"${winNode}" "${winScript}"`;
  assert.deepEqual(parseHookCommand(windows, { windows: true }), { interpreter: winNode, script: winScript });

  // The old bare-`node` shape still parses into two tokens, but its
  // interpreter is the relative word `node` -- NOT an absolute path -- which is
  // exactly what scripts/check-codex.mjs and doctor use to reject/flag it (a
  // relative interpreter is PATH-hijackable). The parser surfaces it rather
  // than hiding it.
  assert.deepEqual(parseHookCommand("node '/x/muster-hook.mjs'"), { interpreter: "node", script: "/x/muster-hook.mjs" });
  // Malformed shapes (wrong token count) parse to null so a consumer can reject.
  assert.equal(parseHookCommand("'/only-one-token'"), null);
  assert.equal(parseHookCommand("'/a' '/b' '/c'"), null);
});

test("Codex doctor flags a managed hook whose pinned Node interpreter no longer exists (POSIX)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-ghostnode-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });

  const scriptPath = join(codexHome, "muster", "hooks", "muster-hook.mjs");
  const ghostNode = join(tmp, "ghost", "node"); // absolute, never created
  const hooksPath = join(codexHome, "hooks.json");
  const manifestPath = join(codexHome, "muster", ".muster-managed.json");
  const config = JSON.parse(await readFile(hooksPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  repinInterpreter(config.hooks, ghostNode, scriptPath);
  repinInterpreter(manifest.hookGroups, ghostNode, scriptPath);
  await writeFile(hooksPath, JSON.stringify(config, null, 2));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  // The scope is still byte-for-byte coherent with its manifest, so codex-hooks
  // passes -- the missing interpreter is invisible to it. The dedicated check
  // is what catches it.
  assert.equal(report.checks.find(c => c.name === "codex-hooks")?.ok, true, "coherent hooks must still pass codex-hooks");
  const interp = report.checks.find(c => c.name === "codex-hook-interpreter");
  assert.equal(interp?.ok, false, "a vanished pinned node must fail codex-hook-interpreter");
  assert.match(interp?.detail || "", new RegExp(`${ghostNode.replaceAll("/", "\\/")}`));
  assert.match(interp?.detail || "", /rerun muster install codex/i);
});

test("Codex doctor flags a vanished pinned interpreter via commandWindows on win32", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-ghostnode-win-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });

  const scriptPath = join(codexHome, "muster", "hooks", "muster-hook.mjs");
  const ghostNode = join(tmp, "ghost", "node.exe");
  const hooksPath = join(codexHome, "hooks.json");
  const manifestPath = join(codexHome, "muster", ".muster-managed.json");
  const config = JSON.parse(await readFile(hooksPath, "utf8"));
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  repinInterpreter(config.hooks, ghostNode, scriptPath);
  repinInterpreter(manifest.hookGroups, ghostNode, scriptPath);
  await writeFile(hooksPath, JSON.stringify(config, null, 2));
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent, platform: "win32" });
  const interp = report.checks.find(c => c.name === "codex-hook-interpreter");
  assert.equal(interp?.ok, false, "the Windows-branch interpreter parse must also flag a vanished node");
  assert.match(interp?.detail || "", /rerun muster install codex/i);
});

test("Codex doctor reports codex-hook-interpreter ok for a real managed install", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-realnode-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const interp = report.checks.find(c => c.name === "codex-hook-interpreter");
  assert.equal(interp?.ok, true, interp?.detail);
  assert.match(interp?.detail || "", /pinned Node interpreter present/i);
});

test("Codex install refuses to pin an interpreter that is not a regular file", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-badnode-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await assert.rejects(
    () => runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent, nodeExecPath: tmp }),
    /Cannot pin the Codex hook Node interpreter.*not a regular file/s
  );
});
