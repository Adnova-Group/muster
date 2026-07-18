// Split from the former test/codex.test.js monolith: `muster doctor` Codex
// checks -- hook overlap/drift, managed-scope registry health, legacy-format
// diagnostics, symlinked-scope rejection, and the MCP handshake check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CODEX_COUNTS } from "../src/codex.js";
import { runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor, runMcpHandshake } from "../src/codex-doctor.js";
import { repoRoot, selectedPlugin, selectedPluginRoot } from "../test-support/codex-helpers.js";

function fakeMcpChild() {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killed = false;
  child.killCalls = 0;
  child.stdinEndCalls = 0;
  child.stdinWriteCalls = 0;
  const end = child.stdin.end.bind(child.stdin), write = child.stdin.write.bind(child.stdin);
  child.stdin.end = (...args) => { child.stdinEndCalls += 1; return end(...args); };
  child.stdin.write = (...args) => { child.stdinWriteCalls += 1; return write(...args); };
  child.kill = () => { child.killed = true; child.killCalls += 1; };
  return child;
}

test("Codex doctor reports project/user hook overlap without claiming cross-copy dedupe", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-overlap-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const overlap = report.checks.find(check => check.name === "codex-hooks-overlap");
  // Canonical-scope decision (2026-07-18): dual live scopes double-fire every
  // advisory, so coherent overlap is now an actionable finding, not accepted.
  assert.equal(overlap?.ok, false);
  // Remediation now points at reinstall (codex-hook-scope-collapse): a
  // project-scope REINSTALL under a healthy user scope auto-collapses the
  // duplicate, so the fix is no longer only a manual uninstall.
  assert.match(overlap?.detail || "", /fire from 2 scopes.*user scope is canonical.*rerun `muster install codex --scope project`/i);
});

test("Codex doctor: a canonical-scope-skipped project scope is coherent and excluded from the firing count (user-then-project collapses to one)", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-collapse-doctor-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  const projectInstall = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  assert.equal(projectInstall.hooksSkipped, "user-scope-canonical");

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const hooks = report.checks.find(check => check.name === "codex-hooks");
  const overlap = report.checks.find(check => check.name === "codex-hooks-overlap");
  assert.equal(hooks?.ok, true, hooks?.detail);
  assert.equal(overlap?.ok, true, overlap?.detail);
  assert.doesNotMatch(overlap?.detail || "", /fire from \d+ scopes/);
});

test("Codex doctor: a canonical-scope-skipped manifest whose hooks.json still carries a stray Muster group is reported stale, not silently coherent", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-collapse-doctor-corrupt-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  const projectHooksPath = join(cwd, ".codex", "hooks.json");
  const userHooksPath = join(codexHome, "hooks.json");
  const userHooks = JSON.parse(await readFile(userHooksPath, "utf8"));
  // Corrupt the skipped project scope's hooks.json by hand-copying in a real
  // muster-owned group its (empty) manifest no longer declares.
  await writeFile(projectHooksPath, JSON.stringify({ hooks: { Stop: userHooks.hooks.Stop } }, null, 2));
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const hooks = report.checks.find(check => check.name === "codex-hooks");
  // A corrupted skip scope makes the aggregate hook-health check fail (same
  // any-stale-scope-fails-the-whole-check severity as every other drift this
  // check already reports) -- it must NOT be silently treated as coherent.
  assert.equal(hooks?.ok, false, "a corrupted skip scope must not be silently treated as coherent");
  const overlap = report.checks.find(check => check.name === "codex-hooks-overlap");
  assert.equal(overlap?.ok, false, "a corrupted skip scope must not be silently treated as non-firing either");
});

test("Codex doctor flags an installed plugin cache that ships firing lifecycle hooks", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-cache-hooks-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  const cacheHooksDir = join(codexHome, "plugins", "cache", "muster", "muster", selectedPlugin.packageVersion, "hooks");
  await mkdir(cacheHooksDir, { recursive: true });
  // The with-hooks (Claude) flavor: any firing hook in the cache double-fires
  // on top of the scoped hooks.json install (the hook-bombardment regression).
  await writeFile(join(cacheHooksDir, "hooks.json"), JSON.stringify({
    hooks: { SessionStart: [{ hooks: [{ type: "command", command: "node x.js" }] }] }
  }));
  const flagged = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const withHooks = flagged.checks.find(check => check.name === "codex-plugin-cache-hooks");
  assert.equal(withHooks?.ok, false);
  assert.match(withHooks?.detail || "", /ships 1 firing lifecycle hook.*rerun muster install codex/i);
  await writeFile(join(cacheHooksDir, "hooks.json"), JSON.stringify({ hooks: {} }));
  const clean = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  assert.equal(clean.checks.find(check => check.name === "codex-plugin-cache-hooks")?.ok, true);
});

test("Codex doctor requires exact owned hook groups from source and cache installs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-doctor-exact-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot: selectedPluginRoot, execFile: absent });

  const healthy = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  assert.equal(healthy.checks.find(check => check.name === "codex-hooks")?.ok, true);
  // Dual coherent scopes are now the actionable canonical-scope finding, not a pass.
  const healthyOverlap = healthy.checks.find(check => check.name === "codex-hooks-overlap");
  assert.equal(healthyOverlap?.ok, false);
  assert.match(healthyOverlap?.detail || "", /user scope is canonical/i);

  const hooksPath = join(cwd, ".codex", "hooks.json");
  const original = JSON.parse(await readFile(hooksPath, "utf8"));
  for (const [label, mutate] of [
    ["matcher", hooks => { hooks.hooks.SessionStart.find(group => group.hooks?.some(hook => hook.command.includes("/muster/hooks/muster-hook.mjs"))).matcher = "resume"; }],
    ["timeout", hooks => { hooks.hooks.PreToolUse.find(group => group.hooks?.some(hook => hook.command.includes("/muster/hooks/muster-hook.mjs"))).hooks[0].timeout = 11; }]
  ]) {
    const drifted = structuredClone(original);
    mutate(drifted);
    await writeFile(hooksPath, JSON.stringify(drifted, null, 2));
    const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
    assert.equal(report.checks.find(check => check.name === "codex-hooks")?.ok, false, `${label} drift must fail hook health`);
    assert.equal(report.checks.find(check => check.name === "codex-hooks-overlap")?.ok, false, `${label} drift must make dedupe reporting uncertain`);
  }
  await writeFile(hooksPath, JSON.stringify(original, null, 2));
  await unlink(join(codexHome, "hooks.json"));
  const missingUserConfig = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  assert.equal(missingUserConfig.checks.find(check => check.name === "codex-hooks")?.ok, false, "a managed scope missing hooks.json must fail hook health");
  assert.equal(missingUserConfig.checks.find(check => check.name === "codex-hooks-overlap")?.ok, false, "a missing managed scope must make dedupe reporting uncertain");
});

test("Codex doctor inspects stale registered project scopes outside the current project", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-doctor-managed-scopes-"));
  const home = join(tmp, "home"), cwd = join(tmp, "current-project"), codexHome = join(home, ".codex");
  const profilesScope = join(tmp, "legacy-profiles"), hooksScope = join(tmp, "legacy-hooks");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ cwd: profilesScope, home, repoRoot, execFile: absent });
  await runCodexInstall({ cwd: hooksScope, home, repoRoot, execFile: absent });

  const profileManifestPath = join(profilesScope, ".codex", "agents", ".muster-managed.json");
  const profileManifest = JSON.parse(await readFile(profileManifestPath, "utf8"));
  profileManifest.packageVersion = "0.0.0-stale";
  await writeFile(profileManifestPath, JSON.stringify(profileManifest));
  const hookManifestPath = join(hooksScope, ".codex", "muster", ".muster-managed.json");
  const hookManifest = JSON.parse(await readFile(hookManifestPath, "utf8"));
  hookManifest.packageVersion = "0.0.0-stale";
  await writeFile(hookManifestPath, JSON.stringify(hookManifest));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const generation = report.checks.find(check => check.name === "codex-install-generation");
  const hooks = report.checks.find(check => check.name === "codex-hooks");
  assert.equal(generation?.ok, false);
  assert.match(generation?.detail || "", new RegExp(profilesScope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.equal(hooks?.ok, false);
  assert.match(hooks?.detail || "", new RegExp(hooksScope.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("Codex doctor gives an actionable legacy pre-0.5.x diagnostic instead of an opaque generation/hooks mismatch", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-doctor-legacy-format-"));
  const home = join(tmp, "home"), cwd = join(tmp, "current-project"), codexHome = join(home, ".codex");
  const profilesScope = join(tmp, "old-format-profiles"), hooksScope = join(tmp, "old-format-hooks");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ cwd: profilesScope, home, repoRoot, execFile: absent });
  await runCodexInstall({ cwd: hooksScope, home, repoRoot, execFile: absent });

  // Pre-0.5.x installs keyed coherence on generation/bootstrapDigest instead
  // of packageVersion (see the real committed .codex/agents/.muster-managed.json
  // and .codex/muster/.muster-managed.json in this repo, frozen this wave).
  const profileManifestPath = join(profilesScope, ".codex", "agents", ".muster-managed.json");
  const profileManifest = JSON.parse(await readFile(profileManifestPath, "utf8"));
  delete profileManifest.packageVersion;
  profileManifest.generation = "a".repeat(64);
  profileManifest.bootstrapDigest = "b".repeat(64);
  await writeFile(profileManifestPath, JSON.stringify(profileManifest));

  const hookManifestPath = join(hooksScope, ".codex", "muster", ".muster-managed.json");
  const hookManifest = JSON.parse(await readFile(hookManifestPath, "utf8"));
  delete hookManifest.packageVersion;
  hookManifest.generation = "a".repeat(64);
  hookManifest.bootstrapDigest = "b".repeat(64);
  await writeFile(hookManifestPath, JSON.stringify(hookManifest));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const generation = report.checks.find(check => check.name === "codex-install-generation");
  const hooks = report.checks.find(check => check.name === "codex-hooks");
  const overlap = report.checks.find(check => check.name === "codex-hooks-overlap");
  assert.equal(generation?.ok, false);
  assert.match(generation?.detail || "", /legacy pre-0\.5\.x install/i);
  assert.match(generation?.detail || "", /muster install codex --scope/);
  assert.equal(hooks?.ok, false);
  assert.match(hooks?.detail || "", /legacy pre-0\.5\.x install/i);
  assert.match(hooks?.detail || "", /muster install codex --scope/);
  assert.equal(overlap?.ok, false);
  assert.match(overlap?.detail || "", /legacy pre-0\.5\.x install/i);
});

test("Codex doctor rejects symlinked content in a registered managed scope", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-doctor-symlinked-scope-"));
  const home = join(tmp, "home"), cwd = join(tmp, "current-project"), legacyCwd = join(tmp, "legacy-project");
  const absent = async () => { throw new Error("not found"); };
  const configDir = join(legacyCwd, ".codex"), agents = join(configDir, "agents"), victim = join(tmp, "outside-agents");
  await mkdir(victim, { recursive: true });
  await mkdir(join(home, ".codex", "muster"), { recursive: true });
  await mkdir(configDir, { recursive: true });
  await symlink(victim, agents, "dir");
  await writeFile(join(home, ".codex", "muster", "install-scopes.json"), JSON.stringify({
    format: 1,
    owner: "muster",
    entries: [{ scope: "project", configDir }]
  }));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absent });
  const scopes = report.checks.find(check => check.name === "codex-managed-scopes");
  assert.equal(scopes?.ok, false);
  assert.match(scopes?.detail || "", /unsafe.*agents|agents.*unsafe/i);
});

test("Codex doctor verifies the bundled MCP initialize and tools/list handshake", async () => {
  const calls = [];
  const absent = async () => { throw new Error("not found"); };
  const report = await runCodexDoctor({
    root: repoRoot,
    cwd: repoRoot,
    codexHome: join(await mkdtemp(join(tmpdir(), "muster-codex-doctor-mcp-")), ".codex"),
    execFile: absent,
    mcpRunner: async options => {
      calls.push(options);
      return { initialized: true, tools: Array.from({ length: CODEX_COUNTS.mcpTools }, (_, index) => ({ name: `muster_test_${index}` })), toolCallOk: true };
    }
  });
  const handshake = report.checks.find(check => check.name === "codex-mcp-handshake");
  assert.equal(handshake?.ok, true);
  assert.match(handshake?.detail || "", /21\/21.*Codex may defer MCP tool visibility until lookup or a new session/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entrypoint, join(selectedPluginRoot, "runtime", "muster-mcp.mjs"));
});

test("Codex doctor reports MCP launch and tool-count handshake failures", async () => {
  const absent = async () => { throw new Error("not found"); };
  for (const [label, mcpRunner, expected] of [
    ["launch", async () => { throw new Error("spawn ENOENT"); }, /spawn ENOENT/],
    ["tool-count", async () => ({ initialized: true, tools: Array.from({ length: CODEX_COUNTS.mcpTools - 1 }, () => ({})) }), /20\/21/]
  ]) {
    const report = await runCodexDoctor({
      root: repoRoot,
      cwd: repoRoot,
      codexHome: join(await mkdtemp(join(tmpdir(), `muster-codex-doctor-mcp-${label}-`)), ".codex"),
      execFile: absent,
      mcpRunner
    });
    const handshake = report.checks.find(check => check.name === "codex-mcp-handshake");
    assert.equal(handshake?.ok, false, label);
    assert.match(handshake?.detail || "", expected, label);
  }
});

test("Codex MCP handshake directly cleans up every terminal protocol path", async () => {
  const cases = [
    ["missing stdio", child => { child.stderr = null; }, child => {}, /did not expose stdio/],
    ["invalid JSON", child => {}, child => child.stdout.write("not-json\n"), /invalid JSON-RPC/],
    ["initialize RPC error", child => {}, child => child.stdout.write('{"id":1,"error":{"message":"no init"}}\n'), /initialize failed: no init/],
    ["initialize missing result", child => {}, child => child.stdout.write('{"id":1}\n'), /initialize failed: missing result/],
    ["tools RPC error", child => {}, child => child.stdout.write('{"id":1,"result":{}}\n{"id":2,"error":{"message":"no tools"}}\n'), /tools\/list failed: no tools/],
    ["tools missing array", child => {}, child => child.stdout.write('{"id":1,"result":{}}\n{"id":2,"result":{}}\n'), /returned no tools array/],
    ["tool call RPC error", child => {}, child => child.stdout.write('{"id":1,"result":{}}\n{"id":2,"result":{"tools":[{"name":"one"}]}}\n{"id":3,"error":{"message":"call boom"}}\n'), /tools\/call muster_detect failed: call boom/],
    ["tool call error payload", child => {}, child => child.stdout.write('{"id":1,"result":{}}\n{"id":2,"result":{"tools":[{"name":"one"}]}}\n{"id":3,"result":{"isError":true,"content":[{"type":"text","text":"Cannot find module x"}]}}\n'), /returned an error payload: Cannot find module x/],
    ["tool call non-JSON payload", child => {}, child => child.stdout.write('{"id":1,"result":{}}\n{"id":2,"result":{"tools":[{"name":"one"}]}}\n{"id":3,"result":{"content":[{"type":"text","text":"stack trace, not JSON"}]}}\n'), /returned an error payload/],
    ["child error", child => {}, child => child.emit("error", new Error("child broke")), /child broke/],
    ["stdout error", child => {}, child => child.stdout.emit("error", new Error("stdout broke")), /stdout broke/],
    ["stderr error", child => {}, child => child.stderr.emit("error", new Error("stderr broke")), /stderr broke/],
    ["stdin error", child => {}, child => child.stdin.emit("error", new Error("stdin broke")), /stdin broke/],
    ["early exit", child => {}, child => { child.stderr.write("server exploded"); child.emit("exit", 7, null); }, /exited before the handshake completed \(7\): server exploded/]
  ];
  for (const [label, configure, terminate, expected] of cases) {
    const child = fakeMcpChild();
    configure(child);
    const result = runMcpHandshake({ entrypoint: "fake.mjs", cwd: repoRoot, timeoutMs: 1_000, spawnProcess: () => {
      queueMicrotask(() => terminate(child));
      return child;
    }});
    await assert.rejects(result, expected, label);
    assert.equal(child.killCalls, 1, `${label} must kill exactly once`);
    if (child.stdin) {
      assert.equal(child.stdin.writableEnded, true, `${label} must close stdin`);
      assert.equal(child.stdinEndCalls, 1, `${label} must close stdin exactly once`);
    }
  }

  const timedOut = fakeMcpChild();
  await assert.rejects(runMcpHandshake({ entrypoint: "fake.mjs", cwd: repoRoot, timeoutMs: 1, spawnProcess: () => timedOut }), /timed out after 1ms/);
  assert.equal(timedOut.killCalls, 1);
  assert.equal(timedOut.stdin.writableEnded, true);
  assert.equal(timedOut.stdinEndCalls, 1);

  const noChild = new Error("spawn failed");
  await assert.rejects(runMcpHandshake({ entrypoint: "fake.mjs", cwd: repoRoot, spawnProcess: () => { throw noChild; } }), error => error === noChild);
});

test("Codex MCP handshake handles synchronous stdin failure with cleanup and settles only once", async () => {
  const writeFailure = fakeMcpChild();
  writeFailure.stdin.write = () => { throw new Error("write failed"); };
  await assert.rejects(runMcpHandshake({ entrypoint: "fake.mjs", cwd: repoRoot, spawnProcess: () => writeFailure }), /write failed/);
  assert.equal(writeFailure.killCalls, 1);
  assert.equal(writeFailure.stdin.writableEnded, true);
  assert.equal(writeFailure.stdinEndCalls, 1);

  const child = fakeMcpChild();
  const result = runMcpHandshake({ entrypoint: "fake.mjs", cwd: repoRoot, spawnProcess: () => {
    queueMicrotask(() => {
      child.stdout.write('{"id":1,"result":{}}\n{"id":2,"result":{"tools":[{"name":"one"}]}}\n{"id":3,"result":{"content":[{"type":"text","text":"{\\"greenfield\\":true}"}]}}\n{"id":1,"result":{}}\n');
      child.stderr.write("late stderr");
      child.emit("exit", 9, null);
      child.emit("error", new Error("late child error"));
      child.stdin.emit("error", new Error("late stdin error"));
    });
    return child;
  }});
  assert.deepEqual(await result, { initialized: true, tools: [{ name: "one" }], toolCallOk: true });
  assert.equal(child.killCalls, 1);
  assert.equal(child.stdin.writableEnded, true);
  assert.equal(child.stdinEndCalls, 1);
  assert.equal(child.stdinWriteCalls, 4);
});
