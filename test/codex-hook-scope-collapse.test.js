// Install-side canonical-scope auto-collapse (backlog item
// codex-hook-scope-collapse, 2026-07-18 decision): the user scope is
// canonical for Codex hooks. `muster install codex --scope project` under a
// healthy user-scope hook install skips/removes the project-scope hook
// merge entirely (agents/profiles still install) -- so REINSTALLING (not
// manually uninstalling) a dual-scope machine converges it to one firing
// hook scope. See prepareHooks' userScopeHooksHealthy in src/codex-install.js.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CODEX_COUNTS } from "../src/codex.js";
import { runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const absentCodex = async () => { throw new Error("codex absent"); };
const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "SubagentStart", "SubagentStop", "Stop"];
const HOOK_STATE_EVENTS = ["session_start", "user_prompt_submit", "pre_tool_use", "post_tool_use", "subagent_start", "subagent_stop", "stop"];
const hookStateBlock = (hooksJsonPath, events = HOOK_STATE_EVENTS) =>
  events.map(event => `[hooks.state."${hooksJsonPath}:${event}:0:0"]\ntrusted_hash = "sha256:${"0".repeat(64)}"\n`).join("\n");
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

function musterGroupCount(hooksConfig, event) {
  const groups = hooksConfig?.hooks?.[event];
  if (!Array.isArray(groups)) return 0;
  return groups.filter(group => (group.hooks || []).some(hook =>
    typeof hook?.command === "string" && hook.command.replaceAll("\\", "/").includes("/muster/hooks/muster-hook.mjs"))).length;
}

test("Codex install: project scope skips writing hooks under a healthy user scope, but agents still install", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-skip-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home");

  const userResult = await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(userResult.hooksSkipped, null);
  assert.equal(userResult.hooks, 7);

  const projectResult = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(projectResult.hooksSkipped, "user-scope-canonical");
  assert.equal(projectResult.hooks, 0);

  // Agents/profiles still install for the project scope.
  const agents = join(cwd, ".codex", "agents");
  const agentFiles = (await readdir(agents)).filter(name => name.endsWith(".toml"));
  assert.equal(agentFiles.length, CODEX_COUNTS.agents);

  // No hook runtime files or owned hook groups for the project scope.
  await assert.rejects(() => readFile(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8"));
  await assert.rejects(() => readFile(join(cwd, ".codex", "muster", "hooks", "action-guard.mjs"), "utf8"));
  const hookManifest = JSON.parse(await readFile(join(cwd, ".codex", "muster", ".muster-managed.json"), "utf8"));
  assert.deepEqual(hookManifest.files, []);
  assert.deepEqual(hookManifest.hookGroups, {});

  for (const event of HOOK_EVENTS) {
    let projectHooks = null;
    try { projectHooks = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8")); } catch { /* absent is fine */ }
    assert.equal(musterGroupCount(projectHooks, event), 0, `project scope must carry no ${event} muster group`);
  }

  // The user scope's own hooks are untouched by the skipped project install.
  const userHooks = JSON.parse(await readFile(join(home, ".codex", "hooks.json"), "utf8"));
  for (const event of HOOK_EVENTS) assert.equal(musterGroupCount(userHooks, event), 1, `user scope must still carry exactly one ${event} muster group`);
});

test("Codex install: project scope installs its own hooks exactly as before when no healthy user scope exists", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-no-user-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  const result = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(result.hooksSkipped, null);
  assert.equal(result.hooks, 7);
  await readFile(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8");
});

test("Codex install: a self-consistent but version-stale user scope manifest is NOT treated as healthy (fails closed, project installs its own current hooks)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-stale-user-version-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  // Hand-edit the user manifest's OWN recorded packageVersion to something
  // stale while leaving it otherwise perfectly self-consistent with its own
  // hooks.json/runtime -- a purely-internal-agreement health check would
  // wrongly call this "healthy" and silently skip the project install.
  const userManifestPath = join(home, ".codex", "muster", ".muster-managed.json");
  const userManifest = JSON.parse(await readFile(userManifestPath, "utf8"));
  userManifest.packageVersion = "0.0.0-stale";
  await writeFile(userManifestPath, JSON.stringify(userManifest, null, 2));

  const projectResult = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(projectResult.hooksSkipped, null, "a version-stale user manifest must fail closed, not report healthy");
  assert.equal(projectResult.hooks, 7, "the project scope installs its own current hooks rather than trusting a stale peer");
  await readFile(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8");
});

test("Codex install: user-scope installs never skip, even run twice in a row", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-user-never-skips-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  const first = await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(first.hooksSkipped, null);
  assert.equal(first.hooks, 7);
  const second = await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(second.hooksSkipped, null);
  assert.equal(second.hooks, 7);
});

test("Codex install: reinstalling project scope over a legacy dual-scope machine migrates to a single firing scope", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-migrate-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");

  // Legacy dual-scope machine: project installed first (no healthy user
  // scope yet, so it installs real hooks), then user installed (always
  // installs). Both scopes now fire every event.
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  const projectHooksPathBefore = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8"));
  for (const event of HOOK_EVENTS) assert.equal(musterGroupCount(projectHooksPathBefore, event), 1, `pre-migration: project must fire ${event}`);
  await readFile(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8"); // exists pre-migration

  // Reinstall project: this is the migration -- user scope is now healthy,
  // so project's previously-owned hook groups/runtime are removed.
  const migrated = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(migrated.hooksSkipped, "user-scope-canonical");
  assert.equal(migrated.hooks, 0);
  assert.ok(migrated.files.some(item => item.op === "remove" && item.path.endsWith(join("muster", "hooks", "muster-hook.mjs"))));
  assert.ok(migrated.files.some(item => item.op === "remove" && item.path.endsWith(join("muster", "hooks", "action-guard.mjs"))));

  await assert.rejects(() => readFile(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8"));
  await assert.rejects(() => readFile(join(cwd, ".codex", "muster", "hooks", "action-guard.mjs"), "utf8"));

  const hookManifest = JSON.parse(await readFile(join(cwd, ".codex", "muster", ".muster-managed.json"), "utf8"));
  assert.deepEqual(hookManifest.files, []);
  assert.deepEqual(hookManifest.hookGroups, {});

  // Success criterion (3): exactly one muster hook group per event across
  // BOTH scopes' hooks.json combined.
  let projectHooksAfter = null;
  try { projectHooksAfter = JSON.parse(await readFile(join(cwd, ".codex", "hooks.json"), "utf8")); } catch { /* absent is fine */ }
  const userHooksAfter = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
  for (const event of HOOK_EVENTS) {
    const total = musterGroupCount(projectHooksAfter, event) + musterGroupCount(userHooksAfter, event);
    assert.equal(total, 1, `post-migration: exactly one firing ${event} group across both scopes, got ${total}`);
  }

  // Success criterion (1)/(2): doctor stays green, exactly one firing scope.
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absentCodex });
  const hooks = report.checks.find(check => check.name === "codex-hooks");
  const overlap = report.checks.find(check => check.name === "codex-hooks-overlap");
  assert.equal(hooks?.ok, true, hooks?.detail);
  assert.equal(overlap?.ok, true, overlap?.detail);
  assert.doesNotMatch(overlap?.detail || "", /fire from \d+ scopes/);
});

test("Codex install: reinstall migration prunes only the collapsing scope's config.toml [hooks.state] trust entries", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-hookstate-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });

  const configTomlPath = join(codexHome, "config.toml");
  const projectHooksJson = join(cwd, ".codex", "hooks.json");
  const userHooksJson = join(codexHome, "hooks.json");
  const before = await readFile(configTomlPath, "utf8");
  await writeFile(configTomlPath, `${before}\n${hookStateBlock(projectHooksJson)}\n${hookStateBlock(userHooksJson)}\n`);

  const migrated = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(migrated.hooksSkipped, "user-scope-canonical");
  assert.equal(migrated.prunedHookState.length, 7, "one pruned hooks.state entry per event for the collapsing scope");
  assert.ok(migrated.prunedHookState.every(item => item.configDir === join(cwd, ".codex")));

  const after = await readFile(configTomlPath, "utf8");
  assert.doesNotMatch(after, new RegExp(escapeRegex(projectHooksJson)), "the collapsing project scope's trust entries are pruned");
  assert.match(after, new RegExp(escapeRegex(userHooksJson)), "the still-firing user scope's trust entries survive");
});

test("Codex install: an ordinary (non-migrating) reinstall never prunes hooks.state for the still-owning scope", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-no-prune-steady-state-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  const configTomlPath = join(codexHome, "config.toml");
  const projectHooksJson = join(cwd, ".codex", "hooks.json");
  const before = await readFile(configTomlPath, "utf8");
  await writeFile(configTomlPath, `${before}\n${hookStateBlock(projectHooksJson)}\n`);

  const reinstalled = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(reinstalled.hooksSkipped, null);
  assert.equal(reinstalled.prunedHookState.length, 0, "an ordinary reinstall with no canonical-scope collapse must not touch the live scope's own trust cache");
  const after = await readFile(configTomlPath, "utf8");
  assert.match(after, new RegExp(escapeRegex(projectHooksJson)), "trust entries for a scope that still owns its hooks survive an ordinary reinstall");
});

test("Codex install: repeated skip installs (already collapsed) stay idempotent", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-idempotent-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  const first = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(first.hooksSkipped, "user-scope-canonical");
  const second = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(second.hooksSkipped, "user-scope-canonical");
  assert.equal(second.hooks, 0);
  assert.equal(second.prunedHookState.length, 0, "steady-state re-skip has nothing left to prune");
  const hookManifest = JSON.parse(await readFile(join(cwd, ".codex", "muster", ".muster-managed.json"), "utf8"));
  assert.deepEqual(hookManifest.files, []);
  assert.deepEqual(hookManifest.hookGroups, {});
});

// -- Adversarial self-review coverage ----------------------------------------

test("Codex install adversarial: an unmanaged Muster hook in project hooks.json is still rejected even under a healthy user scope (skip does not bypass the conflict check)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-conflict-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  await mkdir(join(cwd, ".codex"), { recursive: true });
  const unmanaged = { hooks: { Stop: [{ hooks: [{ type: "command", command: `node "${join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs")}"` }] }] } };
  await writeFile(join(cwd, ".codex", "hooks.json"), JSON.stringify(unmanaged, null, 2));
  await assert.rejects(() => runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex }), /Codex hook conflict.*unmanaged Muster hook/);
});

test("Codex install adversarial: a failed transaction mid-migration restores the pre-migration dual-scope state byte-identically", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-rollback-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });

  const projectHooksJsonPath = join(cwd, ".codex", "hooks.json");
  const projectManifestPath = join(cwd, ".codex", "muster", ".muster-managed.json");
  const projectRuntimePath = join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs");
  const beforeHooksJson = await readFile(projectHooksJsonPath, "utf8");
  const beforeManifest = await readFile(projectManifestPath, "utf8");
  const beforeRuntime = await readFile(projectRuntimePath, "utf8");

  const calls = [];
  let midTransactionHooksJson = null, midTransactionRuntimeExists = null;
  const failingExecFile = async (_bin, args) => {
    calls.push(args.join(" "));
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [] }) };
    if (args.slice(0, 3).join(" ") === "plugin marketplace add") return { stdout: "" };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [], available: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") {
      // registerPlugin runs LAST inside the transaction's try block (after
      // every filesystem write), so reading the on-disk state HERE, before
      // throwing, proves the migration's writes genuinely landed mid-
      // transaction -- not an assumption about source ordering, a fact this
      // test observes directly.
      midTransactionHooksJson = JSON.parse(await readFile(projectHooksJsonPath, "utf8"));
      midTransactionRuntimeExists = await readFile(projectRuntimePath, "utf8").then(() => true, () => false);
      throw new Error("registration failed mid-migration");
    }
    if (args.slice(0, 3).join(" ") === "plugin marketplace remove") return { stdout: "" };
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };

  await assert.rejects(() => runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: failingExecFile }), /registration failed mid-migration/);
  assert.ok(calls.includes("plugin add muster@muster"), "the migration reached the registration step before failing");

  // Self-evident proof the migration's writes actually happened before the
  // injected failure: at the moment of failure, project hooks.json already
  // carried no muster group for any event, and its hook runtime was already
  // deleted -- the fully-migrated (collapsed) state, not the pre-migration one.
  for (const event of HOOK_EVENTS) assert.equal(musterGroupCount(midTransactionHooksJson, event), 0, `mid-transaction: ${event} was already migrated away before the injected failure`);
  assert.equal(midTransactionRuntimeExists, false, "mid-transaction: the hook runtime was already deleted before the injected failure");

  // And after the failure, the whole transaction is restored byte-identically.
  assert.equal(await readFile(projectHooksJsonPath, "utf8"), beforeHooksJson, "project hooks.json is restored byte-identically");
  assert.equal(await readFile(projectManifestPath, "utf8"), beforeManifest, "project hook manifest is restored byte-identically");
  assert.equal(await readFile(projectRuntimePath, "utf8"), beforeRuntime, "project hook runtime is restored byte-identically");
});

test("Codex uninstall: a canonical-scope-skipped project scope uninstalls cleanly as a no-op on hooks (agents still removed)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-uninstall-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  const installed = await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(installed.hooksSkipped, "user-scope-canonical");

  const removed = await runCodexUninstall({ scope: "project", cwd, home, execFile: absentCodex });
  // 27 profile files plus the (empty) hooks.json removal; no hook runtime
  // files and no thread-limit restore since the user scope is still live.
  assert.equal(removed.files.length, CODEX_COUNTS.agents + 1);
  assert.equal(removed.files.filter(item => item.path.includes(join("muster", "hooks"))).length, 0, "no hook runtime files to remove for a skipped scope");
  assert.ok(removed.files.some(item => item.op === "remove" && item.path === join(cwd, ".codex", "hooks.json")));
  await assert.rejects(() => readFile(join(cwd, ".codex", "agents", ".muster-managed.json"), "utf8"));
  await assert.rejects(() => readFile(join(cwd, ".codex", "muster", ".muster-managed.json"), "utf8"));
  await assert.rejects(() => readFile(join(cwd, ".codex", "hooks.json"), "utf8"));

  // The user scope, still the sole firing scope, is untouched.
  const userHooks = JSON.parse(await readFile(join(codexHome, "hooks.json"), "utf8"));
  for (const event of HOOK_EVENTS) assert.equal(musterGroupCount(userHooks, event), 1);

  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome, execFile: absentCodex });
  const hooks = report.checks.find(check => check.name === "codex-hooks");
  const overlap = report.checks.find(check => check.name === "codex-hooks-overlap");
  assert.equal(hooks?.ok, true, hooks?.detail);
  assert.equal(overlap?.ok, true, overlap?.detail);
});

test("Codex install adversarial: --dry-run previews the collapse without writing or migrating anything", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-scope-collapse-dry-run-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  const projectHooksJsonPath = join(cwd, ".codex", "hooks.json");
  const beforeHooksJson = await readFile(projectHooksJsonPath, "utf8");
  const beforeRuntime = await readFile(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8");

  const dry = await runCodexInstall({ scope: "project", cwd, home, repoRoot, dryRun: true, execFile: absentCodex });
  assert.equal(dry.hooksSkipped, "user-scope-canonical", "dry-run still previews the collapse verdict");
  assert.equal(dry.hooks, 0);

  assert.equal(await readFile(projectHooksJsonPath, "utf8"), beforeHooksJson, "dry-run writes nothing");
  assert.equal(await readFile(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), "utf8"), beforeRuntime, "dry-run removes no hook runtime");
});
