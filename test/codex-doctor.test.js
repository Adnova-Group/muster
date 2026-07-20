// Split from the former test/codex.test.js monolith: `muster doctor` Codex
// checks -- hook overlap/drift, managed-scope registry health, legacy-format
// diagnostics, symlinked-scope rejection, and the MCP handshake check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { CODEX_COUNTS } from "../src/codex.js";
import { runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor, runMcpHandshake, MCP_STDOUT_CAP, MCP_STDERR_CAP, MCP_DIAGNOSTIC_CAP, DOCTOR_READ_MAX_BYTES, DOCTOR_CONFIG_READ_MAX_BYTES } from "../src/codex-doctor.js";
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

test("Codex doctor fails closed when a managed hook runtime file is tampered (hash mismatch)", async () => {
  // The prior "exact owned hook groups" test drifts hooks.json (the config the
  // hash is keyed to). This pins the OTHER half of that coherence gate: the
  // sha256 taken over the two managed runtime files themselves. Mutating either
  // runtime byte-stream must flip codex-hooks AND codex-hooks-overlap closed,
  // with reinstall remediation -- the fail-closed contract for a tampered hook.
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-tamper-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  // A single canonical (user) scope keeps an untouched install green on BOTH
  // checks, so the runtime hash is the only coherence input each iteration
  // moves -- owner, exact-group ownership and packageVersion stay fixed.
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  const runtimeDir = join(codexHome, "muster", "hooks");
  const doctor = () => runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });

  const baseline = await doctor();
  assert.equal(baseline.checks.find(check => check.name === "codex-hooks")?.ok, true, "untouched install: hook health green");
  assert.equal(baseline.checks.find(check => check.name === "codex-hooks-overlap")?.ok, true, "untouched install: overlap green");

  for (const file of ["muster-hook.mjs", "action-guard.mjs"]) {
    const runtimePath = join(runtimeDir, file);
    const pristine = await readFile(runtimePath);
    // Append a byte so the runtime hash diverges from the ownership manifest's
    // recorded hookHash -- the exact tamper the check exists to catch. Nothing
    // else about the install changes.
    await writeFile(runtimePath, Buffer.concat([pristine, Buffer.from("\n// tampered runtime byte\n")]));

    const tampered = await doctor();
    const hooks = tampered.checks.find(check => check.name === "codex-hooks");
    const overlap = tampered.checks.find(check => check.name === "codex-hooks-overlap");
    assert.equal(hooks?.ok, false, `tampering ${file} must fail codex-hooks closed`);
    assert.match(hooks?.detail || "", /stale or differ from their exact ownership manifest.*rerun muster install codex/i,
      `tampering ${file} must surface reinstall remediation on codex-hooks`);
    assert.equal(overlap?.ok, false, `tampering ${file} must fail codex-hooks-overlap closed`);
    assert.match(overlap?.detail || "", /not hash\/exact-group coherent.*refresh every stale scope/i,
      `tampering ${file} must surface reinstall remediation on codex-hooks-overlap`);

    // Restoring pristine bytes returns both checks to green -- proving the
    // failure is the tamper itself, not sticky install state.
    await writeFile(runtimePath, pristine);
    const restored = await doctor();
    assert.equal(restored.checks.find(check => check.name === "codex-hooks")?.ok, true, `restoring ${file}: hook health green again`);
    assert.equal(restored.checks.find(check => check.name === "codex-hooks-overlap")?.ok, true, `restoring ${file}: overlap green again`);
  }
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

test("Codex doctor accepts a custom user CODEX_HOME whose directory is not named .codex", async () => {
  // A user may point CODEX_HOME at any absolute path; Codex honours it
  // verbatim. The installer records the user scope's configDir as that raw
  // CODEX_HOME (realpath), so doctor must accept a user scope regardless of
  // its basename -- the `.codex`-suffix rule is a PROJECT-scope invariant.
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-doctor-custom-home-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  const customCodexHome = join(tmp, "my-codex"); // deliberately NOT ending in `.codex`
  const absent = async () => { throw new Error("not found"); };
  const priorCodexHome = process.env.CODEX_HOME;
  process.env.CODEX_HOME = customCodexHome;
  try {
    await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
    const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: customCodexHome, execFile: absent });
    const scopes = report.checks.find(check => check.name === "codex-managed-scopes");
    assert.equal(scopes?.ok, true, `custom CODEX_HOME must be accepted: ${scopes?.detail}`);
    assert.match(scopes?.detail || "", /safe registered managed scope/i);
    // The user scope was not silently dropped: its managed hooks are recognised.
    assert.equal(report.checks.find(check => check.name === "codex-hooks")?.ok, true,
      "custom user CODEX_HOME hooks must be recognised");
  } finally {
    if (priorCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = priorCodexHome;
  }
});

test("Codex doctor still rejects a project managed scope whose configDir is not a .codex directory", async () => {
  // Guard the other half of the scope-conditioned rule: relaxing the suffix
  // for the user scope must NOT relax it for project scopes. A project entry
  // pointing outside a `<repo>/.codex` directory (an escaped/unsafe scope) is
  // still rejected as unsafe.
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-doctor-escaped-project-"));
  const home = join(tmp, "home"), cwd = join(tmp, "current-project");
  const escaped = join(tmp, "escaped-project-dir"); // absolute + canonical, but not `.codex`
  const absent = async () => { throw new Error("not found"); };
  await mkdir(escaped, { recursive: true });
  await mkdir(join(home, ".codex", "muster"), { recursive: true });
  await writeFile(join(home, ".codex", "muster", "install-scopes.json"), JSON.stringify({
    format: 1,
    owner: "muster",
    entries: [{ scope: "project", configDir: escaped }]
  }));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absent });
  const scopes = report.checks.find(check => check.name === "codex-managed-scopes");
  assert.equal(scopes?.ok, false, "an escaped project scope outside a .codex directory must stay rejected");
  assert.match(scopes?.detail || "", /unsafe entry/i);
});

test("Codex doctor still rejects a user managed scope whose configDir is not the resolved CODEX_HOME", async () => {
  // Now that the `.codex` suffix no longer gates the user scope, exact identity
  // with expectedUserScope (= resolve(CODEX_HOME)) is its SOLE path guard. A
  // user entry pointing anywhere other than the resolved CODEX_HOME -- even at
  // a `.codex`-named directory, so the suffix cannot be what rejects it -- must
  // stay rejected; a mislabeled "user" scope can never smuggle an arbitrary
  // path through.
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-doctor-user-mismatch-"));
  const home = join(tmp, "home"), cwd = join(tmp, "current-project");
  const codexHome = join(home, ".codex");
  const foreign = join(tmp, "elsewhere", ".codex"); // absolute + canonical + `.codex`, but != resolve(codexHome)
  const absent = async () => { throw new Error("not found"); };
  await mkdir(join(codexHome, "muster"), { recursive: true });
  await writeFile(join(codexHome, "muster", "install-scopes.json"), JSON.stringify({
    format: 1,
    owner: "muster",
    entries: [{ scope: "user", configDir: foreign }]
  }));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const scopes = report.checks.find(check => check.name === "codex-managed-scopes");
  assert.equal(scopes?.ok, false, "a user scope not equal to the resolved CODEX_HOME must stay rejected");
  assert.match(scopes?.detail || "", /unsafe entry/i);
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
  assert.match(handshake?.detail || "", /28\/28.*Codex may defer MCP tool visibility until lookup or a new session/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].entrypoint, join(selectedPluginRoot, "runtime", "muster-mcp.mjs"));
});

test("Codex doctor reports MCP launch and tool-count handshake failures", async () => {
  const absent = async () => { throw new Error("not found"); };
  for (const [label, mcpRunner, expected] of [
    ["launch", async () => { throw new Error("spawn ENOENT"); }, /spawn ENOENT/],
    ["tool-count", async () => ({ initialized: true, tools: Array.from({ length: CODEX_COUNTS.mcpTools - 1 }, () => ({})) }), /27\/28/]
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

// --- MCP handshake output bounding (Codex dogfood audit) ------------------
// A misbehaving or compromised MCP child could stream unbounded output into the
// doctor: memory blows up as stdout/stderr accumulate, and raw bytes get echoed
// straight into the check `detail`. runMcpHandshake must BOUND each stream with
// a retention cap, terminate the child EXACTLY once when a cap is hit, and echo
// at most a small, control-byte-sanitized slice into any diagnostic. These two
// chunked-output tests drive a fake child that emits far past each cap.
const controlByteRe = /[\u0000-\u001f\u007f-\u009f]/;

test("Codex MCP handshake bounds unbounded stdout: caps retention, kills once, no oversized/raw diagnostic", async () => {
  const child = fakeMcpChild();
  // 320 KiB of newline-free junk -- a compromised child streaming raw bytes the
  // JSON-RPC line parser can never consume, so the parse buffer would grow
  // without bound. Emitted in chunks that individually stay under, but together
  // blow past, the stdout cap.
  const chunk = "x".repeat(40 * 1024);
  const promise = runMcpHandshake({ entrypoint: "fake.mjs", cwd: repoRoot, timeoutMs: 5_000, spawnProcess: () => {
    queueMicrotask(() => {
      for (let i = 0; i < 8; i++) child.stdout.write(chunk);
      // Fallback so the CURRENT (unbounded) code still settles quickly for the
      // red run; scheduled after the stream data has drained so a bounded child
      // has already capped + killed by the time this fires.
      setTimeout(() => { if (!child.killed) child.emit("exit", 1, null); }, 40);
    });
    return child;
  }});
  await assert.rejects(promise, err => {
    assert.match(err.message, /stdout exceeded/i, "diagnostic names the stdout cap");
    assert.ok(err.mcpRetainedChars <= MCP_STDOUT_CAP, `retained stdout ${err.mcpRetainedChars} must stay within cap ${MCP_STDOUT_CAP}`);
    assert.ok(err.message.length <= 200 + MCP_DIAGNOSTIC_CAP, `stdout diagnostic length ${err.message.length} must stay within echo budget`);
    assert.ok(!controlByteRe.test(err.message), "stdout diagnostic must not dump raw control bytes");
    return true;
  });
  assert.equal(child.killCalls, 1, "stdout cap must terminate the child exactly once");
});

test("Codex MCP handshake bounds unbounded stderr: caps retention, kills once, sanitizes diagnostic", async () => {
  const child = fakeMcpChild();
  // ~196 KiB of control-byte-laden stderr emitted in chunks that cumulatively
  // exceed the stderr cap; sanitization must keep raw control bytes out of the
  // echoed detail even though up to the retention cap is held in memory.
  const ctrl = String.fromCharCode(0) + String.fromCharCode(7) + String.fromCharCode(27); // NUL, BEL, ESC
  const chunk = ("warn" + ctrl + " ").repeat(4 * 1024);
  const promise = runMcpHandshake({ entrypoint: "fake.mjs", cwd: repoRoot, timeoutMs: 5_000, spawnProcess: () => {
    queueMicrotask(() => {
      for (let i = 0; i < 8; i++) child.stderr.write(chunk);
      // Fallback: after stderr drains, emit exit so the CURRENT code echoes its
      // raw unbounded stderr into the exit diagnostic (the red signal).
      setTimeout(() => { if (!child.killed) { child.stderr.write(chunk); child.emit("exit", 1, null); } }, 40);
    });
    return child;
  }});
  await assert.rejects(promise, err => {
    assert.ok(err.mcpRetainedChars <= MCP_STDERR_CAP, `retained stderr ${err.mcpRetainedChars} must stay within cap ${MCP_STDERR_CAP}`);
    assert.ok(err.message.length <= 200 + MCP_DIAGNOSTIC_CAP, `stderr diagnostic length ${err.message.length} must stay within echo budget`);
    assert.ok(!controlByteRe.test(err.message), "stderr diagnostic must not dump raw control bytes");
    return true;
  });
  assert.equal(child.killCalls, 1, "stderr cap must terminate the child exactly once");
});

test("Codex MCP handshake sanitizes control bytes in the tools/call error-payload diagnostic", async () => {
  const child = fakeMcpChild();
  // A well-formed handshake through tools/list, then a tools/call payload that
  // is a plain (non-JSON) string laced with control bytes -- the third
  // sanitizeMcpDiagnostic call site. The failure detail must echo it without
  // dumping raw control bytes.
  const payload = "boom" + String.fromCharCode(0) + String.fromCharCode(7) + String.fromCharCode(27) + " not json";
  const promise = runMcpHandshake({ entrypoint: "fake.mjs", cwd: repoRoot, timeoutMs: 5_000, spawnProcess: () => {
    queueMicrotask(() => child.stdout.write(
      '{"id":1,"result":{}}\n'
      + '{"id":2,"result":{"tools":[{"name":"one"}]}}\n'
      + `{"id":3,"result":{"content":[{"type":"text","text":${JSON.stringify(payload)}}]}}\n`
    ));
    return child;
  }});
  await assert.rejects(promise, err => {
    assert.match(err.message, /returned an error payload/, "names the error-payload path");
    assert.ok(!controlByteRe.test(err.message), "tools/call diagnostic must not dump raw control bytes");
    return true;
  });
  assert.equal(child.killCalls, 1, "tools/call failure must terminate the child exactly once");
});

// --- Live Codex inventory branch (run-5 audit Med #11) --------------------
// runCodexDoctor's `if (available) { ... }` branch shells out to the real
// `codex` CLI (through the injected execFile seam readCodexInventory and
// codexAvailable already consume) to enumerate installed plugins + MCP servers,
// then reports two checks: `codex-plugin-installed` and `codex-inventory`.
// Every OTHER doctor test injects an execFile that throws (`absent`), so
// codexAvailable resolves false and this branch never runs -- leaving the
// installed/absent/malformed/failing live results with no regression coverage.
// These fixtures drive the branch through that SAME seam (no new global mock):
// `codex --version` resolves so codex reads as available and the branch
// executes; `codex plugin list` / `codex mcp list` return -- or reject with --
// the per-state payload. The MCP handshake is stubbed green (it has its own
// coverage above) purely to isolate the live-inventory branch under test.
const liveMcpRunner = async () => ({ initialized: true, tools: Array.from({ length: CODEX_COUNTS.mcpTools }, (_, index) => ({ name: `muster_${index}` })), toolCallOk: true });

// A `plugin`/`mcp` string is handed back as `codex` stdout; a function is
// invoked and may reject (non-zero exit / thrown error). `--version` always
// resolves so runCodexDoctor enters the live-inventory branch.
function liveCodexExec({ plugins, mcp }) {
  return async (_bin, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli 0.0.0-test\n" };
    const payload = args[0] === "plugin" ? plugins : mcp;
    if (typeof payload === "function") return payload();
    return { stdout: payload };
  };
}

async function inventoryDoctor(execFile) {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-inventory-branch-"));
  const report = await runCodexDoctor({ root: repoRoot, cwd: join(tmp, "project"), codexHome: join(tmp, "home", ".codex"), execFile, mcpRunner: liveMcpRunner });
  return {
    report,
    installed: report.checks.find(check => check.name === "codex-plugin-installed"),
    inventory: report.checks.find(check => check.name === "codex-inventory")
  };
}

test("Codex doctor live-inventory: INSTALLED -- well-formed plugin/MCP JSON is reported present and healthy", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-inventory-installed-"));
  const pluginPath = join(tmp, "live-plugin");
  await mkdir(join(pluginPath, "skills", "live-skill"), { recursive: true });
  await mkdir(join(pluginPath, "agents"), { recursive: true });
  await writeFile(join(pluginPath, "skills", "live-skill", "SKILL.md"), "---\nname: live-skill\n---\n");
  await writeFile(join(pluginPath, "agents", "live-agent.toml"), "name = 'live-agent'\n");
  const execFile = liveCodexExec({
    plugins: JSON.stringify({ installed: [{ name: "muster", installed: true, enabled: true, source: { path: pluginPath } }], available: [] }),
    mcp: JSON.stringify([{ name: "muster", enabled: true }])
  });
  const report = await runCodexDoctor({ root: repoRoot, cwd: join(tmp, "project"), codexHome: join(tmp, "home", ".codex"), execFile, mcpRunner: liveMcpRunner });
  const installed = report.checks.find(check => check.name === "codex-plugin-installed");
  const inventory = report.checks.find(check => check.name === "codex-inventory");
  assert.equal(installed?.ok, true, installed?.detail);
  assert.match(installed?.detail || "", /muster plugin is enabled in live Codex state/);
  assert.equal(inventory?.ok, true, inventory?.detail);
  // Plugin source skills/agents thread through to the reported counts.
  assert.match(inventory?.detail || "", /1 plugins, 1 skills, 1 MCP servers, 1 agents from live Codex state/);
});

test("Codex doctor live-inventory: ABSENT -- empty live state reports the plugin missing with a zeroed inventory, no error", async () => {
  const { installed, inventory } = await inventoryDoctor(liveCodexExec({
    plugins: JSON.stringify({ installed: [], available: [] }),
    mcp: "[]"
  }));
  assert.equal(installed?.ok, false, installed?.detail);
  assert.match(installed?.detail || "", /muster plugin is not installed; run muster install codex/);
  // Absent is not an error: the inventory check itself still passes, reporting zeros.
  assert.equal(inventory?.ok, true, inventory?.detail);
  assert.match(inventory?.detail || "", /0 plugins, 0 skills, 0 MCP servers, 0 agents from live Codex state/);
});

test("Codex doctor live-inventory: MALFORMED -- truncated/non-JSON `codex` output fails soft (plugin absent, inventory zeroed, doctor run completes)", async () => {
  // The whole doctor run must resolve: a malformed live payload is advisory and
  // must never reject runCodexDoctor. jsonCommand swallows the JSON.parse throw
  // to null, so the branch degrades to the same zeroed/absent report as ABSENT.
  const { report, installed, inventory } = await inventoryDoctor(liveCodexExec({
    plugins: '{"installed":[{"name":"muster","installed":true,', // truncated JSON
    mcp: "not json at all"
  }));
  assert.equal(installed?.ok, false, installed?.detail);
  assert.match(installed?.detail || "", /not installed/);
  assert.equal(inventory?.ok, true, inventory?.detail);
  assert.match(inventory?.detail || "", /0 plugins, 0 skills, 0 MCP servers, 0 agents from live Codex state/);
  // Still a real, complete doctor run: the non-inventory checks are present.
  assert.ok(report.checks.some(check => check.name === "codex-mcp-handshake"));
  assert.ok(report.checks.every(check => typeof check.ok === "boolean"));
});

test("Codex doctor live-inventory: FAILING -- a non-zero/throwing `codex` command is surfaced as absent and the doctor run continues", async () => {
  // A failing live command must not abort the advisory branch or the overall run.
  const boom = () => Promise.reject(Object.assign(new Error("codex plugin list exited 1"), { code: 1, stderr: "boom" }));
  const { report, installed, inventory } = await inventoryDoctor(liveCodexExec({ plugins: boom, mcp: boom }));
  assert.equal(installed?.ok, false, installed?.detail);
  assert.match(installed?.detail || "", /not installed/);
  assert.equal(inventory?.ok, true, inventory?.detail);
  assert.match(inventory?.detail || "", /0 plugins, 0 skills, 0 MCP servers, 0 agents from live Codex state/);
  // The run still produced the full check set -- the command failure was advisory only.
  assert.ok(report.checks.length > 3 && report.checks.some(check => check.name === "codex-mcp-handshake"));
});

// --- UNREGISTERED-scope read hardening (Codex dogfood audit) --------------
// The doctor inspects the current-project scope (`<cwd>/.codex`) and the user
// scope (CODEX_HOME) EVEN WHEN NEITHER IS REGISTERED in install-scopes.json.
// Those unregistered read paths used to bypass the descriptor-pinned no-follow
// bounded reader registered scopes already go through -- reading manifests /
// hooks.json / hook runtime via a plain follow-capable, unbounded readFile. A
// planted symlink, FIFO/socket, oversized file, or symlinked ancestor could be
// followed / read unbounded. Each fixture below plants one attack on an
// UNREGISTERED scope read path and asserts the check now fails CLOSED with a
// per-scope diagnostic. Each is RED against the pre-fix code (which follows the
// symlink / reads the special or oversized file) and green after.
const reEscape = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

test("Codex doctor: UNREGISTERED user scope whose profile manifest is a SYMLINK is rejected fail-closed, target never adopted", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "m-doctor-unreg-symlink-"));
  const cwd = join(tmp, "p"), codexHome = join(tmp, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await mkdir(join(codexHome, "agents"), { recursive: true });
  // A coherent manifest planted OUTSIDE the scope: were the symlink followed,
  // the doctor would read it and count this scope as a version match (flipping
  // codex-install-generation GREEN). Rejecting the symlink means the target is
  // never read, so the check must NOT adopt it.
  const outside = join(tmp, "outside-manifest.json");
  await writeFile(outside, JSON.stringify({ owner: "muster", packageVersion: selectedPlugin.packageVersion }));
  await symlink(outside, join(codexHome, "agents", ".muster-managed.json"));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const generation = report.checks.find(check => check.name === "codex-install-generation");
  assert.equal(generation?.ok, false, generation?.detail);
  assert.match(generation?.detail || "", /unsafe managed profile scope read rejected/i);
  assert.match(generation?.detail || "", /regular file/i);
  assert.match(generation?.detail || "", new RegExp(reEscape(codexHome)));
  await rm(tmp, { recursive: true, force: true });
});

test("Codex doctor: UNREGISTERED user scope whose hook manifest is a SOCKET (non-regular) is rejected fail-closed", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "m-doctor-unreg-socket-"));
  const cwd = join(tmp, "p"), codexHome = join(tmp, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await mkdir(join(codexHome, "muster"), { recursive: true });
  const manifestPath = join(codexHome, "muster", ".muster-managed.json");
  // Border/platform guard: unix domain sockets (or this path length) may be
  // unsupported -- probe by binding at the real read path, skip if it throws.
  let server;
  try {
    server = await new Promise((resolve, reject) => {
      const s = createServer();
      s.once("error", reject);
      s.listen(manifestPath, () => resolve(s));
    });
  } catch (error) {
    t.skip(`unix domain sockets unsupported here: ${error.message}`);
    await rm(tmp, { recursive: true, force: true });
    return;
  }
  try {
    const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
    const hooks = report.checks.find(check => check.name === "codex-hooks");
    assert.equal(hooks?.ok, false, hooks?.detail);
    assert.match(hooks?.detail || "", /unsafe managed hook scope read rejected/i);
    assert.match(hooks?.detail || "", /regular file/i);
    assert.match(hooks?.detail || "", new RegExp(reEscape(codexHome)));
  } finally {
    await new Promise(resolve => server.close(resolve));
    await rm(tmp, { recursive: true, force: true });
  }
});

test("Codex doctor: UNREGISTERED user scope whose hook manifest EXCEEDS the read cap is rejected on the size bound before an unbounded read", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "m-doctor-unreg-oversized-"));
  const cwd = join(tmp, "p"), codexHome = join(tmp, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await mkdir(join(codexHome, "muster"), { recursive: true });
  const manifestPath = join(codexHome, "muster", ".muster-managed.json");
  // A regular file one byte past the doctor read cap. The safe reader must
  // reject it on the fstat size bound BEFORE allocating/reading its bytes.
  await writeFile(manifestPath, "a".repeat(DOCTOR_READ_MAX_BYTES + 1));

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const hooks = report.checks.find(check => check.name === "codex-hooks");
  assert.equal(hooks?.ok, false, hooks?.detail);
  assert.match(hooks?.detail || "", /unsafe managed hook scope read rejected/i);
  assert.match(hooks?.detail || "", /exceeds the \d+-byte read cap/i);
  assert.match(hooks?.detail || "", new RegExp(reEscape(codexHome)));
  await rm(tmp, { recursive: true, force: true });
});

test("Codex doctor: UNREGISTERED project scope reached through a SYMLINKED ancestor directory is rejected fail-closed", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "m-doctor-unreg-ancestor-"));
  const cwd = join(tmp, "p"), codexHome = join(tmp, ".codex");
  const absent = async () => { throw new Error("not found"); };
  // The project scope's `muster/` directory is a SYMLINK to an attacker dir
  // holding a plausible manifest. A follow-capable read would traverse it; the
  // safe reader must reject the symlinked ancestor.
  await mkdir(join(cwd, ".codex"), { recursive: true });
  const outsideMuster = join(tmp, "outside-muster");
  await mkdir(outsideMuster, { recursive: true });
  await writeFile(join(outsideMuster, ".muster-managed.json"), JSON.stringify({
    owner: "muster", packageVersion: selectedPlugin.packageVersion,
    hookGroups: { SessionStart: [{ hooks: [{ command: "x/muster/hooks/muster-hook.mjs" }] }] }
  }));
  await symlink(outsideMuster, join(cwd, ".codex", "muster"), "dir");

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const hooks = report.checks.find(check => check.name === "codex-hooks");
  assert.equal(hooks?.ok, false, hooks?.detail);
  assert.match(hooks?.detail || "", /unsafe managed hook scope read rejected/i);
  assert.match(hooks?.detail || "", /ordinary directory/i);
  assert.match(hooks?.detail || "", new RegExp(reEscape(join(cwd, ".codex"))));
  await rm(tmp, { recursive: true, force: true });
});

test("Codex doctor: a large-but-well-formed config.toml above the managed-file cap still reads (user-owned file gets the larger config cap, no false size rejection)", async () => {
  // Parity guard for the config.toml read (Codex dogfood review): config.toml
  // is USER/Codex-owned and its trust caches accumulate unpruned, so it can grow
  // past the 1 MiB managed-file cap. It must use the larger DOCTOR_CONFIG_READ_
  // MAX_BYTES cap -- a well-formed config just over the managed cap must still be
  // read and validated identically, not newly rejected as oversized.
  const tmp = await mkdtemp(join(tmpdir(), "m-doctor-large-config-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  const configPath = join(codexHome, "config.toml");
  const base = await readFile(configPath, "utf8");
  // Append valid TOML comment padding to push the file well past the managed cap
  // (1 MiB) while staying far under the config cap (16 MiB).
  const padBytes = DOCTOR_READ_MAX_BYTES + 256 * 1024;
  assert.ok(padBytes < DOCTOR_CONFIG_READ_MAX_BYTES, "test padding must stay under the config cap");
  await writeFile(configPath, `${base}\n${"# padding to exceed the managed-file cap\n".repeat(Math.ceil(padBytes / 41))}`);
  assert.ok((await readFile(configPath)).length > DOCTOR_READ_MAX_BYTES, "fixture config.toml must exceed the managed-file cap");

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const threadLimits = report.checks.find(check => check.name === "codex-thread-limits");
  // The large config is still read and its limits validated -- NOT rejected on a
  // size bound (which would surface a cap-exceeded error and fail this check).
  assert.equal(threadLimits?.ok, true, threadLimits?.detail);
  assert.doesNotMatch(threadLimits?.detail || "", /read cap/i);
  await rm(tmp, { recursive: true, force: true });
});

// --- Plugin SELECTION failure (Codex dogfood audit of src/codex-doctor.js) --
// When the marketplace pointer that authoritatively SELECTS which plugin tree
// Codex uses is invalid/missing/malformed, resolveCodexPlugin throws and the
// doctor cannot determine the selected plugin directory. The pre-fix code fell
// back to diagnosing `<base>/.agents/plugins/plugin` ANYWAY and emitted
// healthy-looking plugin/agent/runtime/version checks about that UNSELECTED
// tree -- masking the selection failure with green checks about a tree Codex
// isn't actually using. The fix fails an explicit codex-plugin-selection check
// and stops green-lighting any fallback tree.
test("Codex doctor fails codex-plugin-selection and refuses to green-light an unselected fallback tree when the marketplace pointer is invalid", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-doctor-bad-pointer-"));
  const base = join(tmp, "dist");
  const pluginsRoot = join(base, ".agents", "plugins");
  const pluginDir = join(pluginsRoot, "plugin");
  const version = selectedPlugin.packageVersion;
  const absent = async () => { throw new Error("not found"); };
  // A COMPLETE, valid-looking plugin tree at the conventional fallback path:
  // its manifest, package version, generated profiles, and bundled runtime all
  // look healthy, so the pre-fix code green-lights plugin/agent/runtime on it.
  await mkdir(join(pluginDir, ".codex-plugin"), { recursive: true });
  await mkdir(join(pluginDir, "agents"), { recursive: true });
  await mkdir(join(pluginDir, "runtime"), { recursive: true });
  await writeFile(join(pluginDir, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "muster", version }));
  await writeFile(join(pluginDir, "package.json"), JSON.stringify({ name: "muster", version }));
  await writeFile(join(pluginDir, "agents", "muster-builder.toml"), "name = 'muster-builder'\n");
  await writeFile(join(pluginDir, "runtime", "muster.mjs"), "");
  await writeFile(join(pluginDir, "runtime", "muster-mcp.mjs"), "");
  await writeFile(join(pluginDir, ".mcp.json"), "{}");
  // ...but an INVALID marketplace pointer: valid JSON naming muster, yet the
  // plugin source.path is the WRONG path (the hook-bombardment `./plugin`
  // mistake -- not `./.agents/plugins/plugin`), so resolveCodexPlugin cannot
  // authoritatively confirm this tree is the selected one and throws.
  await writeFile(join(pluginsRoot, "marketplace.json"), JSON.stringify({
    name: "muster",
    plugins: [{ name: "muster", source: { source: "local", path: "./plugin" } }]
  }));

  // A handshake runner that WOULD pass if consulted, proving the fix stops the
  // runtime claim rather than merely relying on an absent runtime entrypoint.
  const passingMcp = async () => ({ initialized: true, tools: Array.from({ length: CODEX_COUNTS.mcpTools }, (_, index) => ({ name: `muster_${index}` })), toolCallOk: true });

  const report = await runCodexDoctor({
    root: base,
    cwd: join(tmp, "project"),
    codexHome: join(tmp, "home", ".codex"),
    execFile: absent,
    mcpRunner: passingMcp
  });

  // (a) selection failure is surfaced explicitly and names the problem.
  const selection = report.checks.find(check => check.name === "codex-plugin-selection");
  assert.equal(selection?.ok, false, "selection failure must be surfaced as an explicit FAILED check");
  assert.match(selection?.detail || "", /select/i);
  assert.match(selection?.detail || "", new RegExp(reEscape(pluginsRoot)));

  // (b) ZERO healthy (ok:true) plugin/agent/runtime/version claims about the
  // unselected fallback tree -- each downstream tree check is skipped/failed.
  for (const name of ["codex-plugin", "codex-agents", "codex-runtime", "codex-mcp-handshake", "codex-install-generation"]) {
    const check = report.checks.find(item => item.name === name);
    assert.notEqual(check?.ok, true, `${name} must not green-light a tree that was never confirmed as selected`);
  }
  await rm(tmp, { recursive: true, force: true });
});
