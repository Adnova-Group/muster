// Split from the former test/codex.test.js monolith: `muster doctor` Codex
// checks -- hook overlap/drift, managed-scope registry health, legacy-format
// diagnostics, symlinked-scope rejection, and the MCP handshake check.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_COUNTS } from "../src/codex.js";
import { runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";

test("Codex doctor reports project/user hook overlap without claiming cross-copy dedupe", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-overlap-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absent });
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  const overlap = report.checks.find(check => check.name === "codex-hooks-overlap");
  assert.equal(overlap?.ok, true);
  assert.match(overlap?.detail || "", /project and user.*no cross-copy dedupe/i);
});

test("Codex doctor requires exact owned hook groups from source and cache installs", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-doctor-exact-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const absent = async () => { throw new Error("not found"); };
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absent });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot: selectedPluginRoot, execFile: absent });

  const healthy = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absent });
  assert.equal(healthy.checks.find(check => check.name === "codex-hooks")?.ok, true);
  assert.equal(healthy.checks.find(check => check.name === "codex-hooks-overlap")?.ok, true);

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
      return { initialized: true, tools: Array.from({ length: CODEX_COUNTS.mcpTools }, (_, index) => ({ name: `muster_test_${index}` })) };
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
