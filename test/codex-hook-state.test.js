// Regression coverage for the codex-hook-bombardment diagnose fix: Codex's
// shared config.toml records a permanent [hooks.state] trust decision per
// hook definition (see docs/research/codex-cli.md section 4.1) that nothing
// ever pruned as scopes were deleted or case-duplicated -- so a dead or
// duplicate checkout kept a live, still-firing hook registration forever.
// reconcileConfigTomlHookState (src/codex-install.js) is the fix, mirroring
// reconcileScopeRegistryEntries' own dev/ino + case-normalize discipline
// but targeting config.toml's trust-cache text instead of the JSON scope
// registry; this file covers the pure editor plus its install/uninstall/
// doctor wiring.
//
// Fix iteration 1 (review-gate blockers, both config-safety/correctness
// issues against the user's REAL global config.toml):
//   (1) a `[[array.of.tables]]` header (e.g. `[[mcp_servers.*.env_http_
//       headers]]`) was NOT recognized as a section boundary, so it could be
//       silently absorbed and DELETED when it directly followed a pruned
//       section -- fixed by ANY_TOML_HEADER now matching both `[...]` and
//       `[[...]]`.
//   (2) `[projects."<root>"]` -- Codex's OWN trusted-directory record, never
//       muster's -- was pruned alongside a departing project scope, which on
//       an ordinary `muster uninstall codex --scope project` (the project
//       directory still fully existing) revoked a user's deliberate trust
//       decision and any non-muster keys living in that same section.
//       [hooks.state] pruning was also attributed at hooksJsonPath
//       granularity alone, sweeping up a co-located NON-muster hook entry
//       (different group/hook index, same path) too. Fixed: [projects] is
//       never touched at all now, and the scope actually being uninstalled
//       is pruned by its EXACT owned `<event>:<groupIndex>:<hookIndex>` keys
//       (see ownedHookStateKeys in src/codex-install.js) rather than by path
//       alone; other scopes reconciled away as dead/duplicate byproducts
//       keep the original path-level prune (safe there -- see that
//       function's comment for why).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { reconcileConfigTomlHookState, runCodexInstall, runCodexUninstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const absentCodex = async () => { throw new Error("codex absent"); };
const escapeRegex = value => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const HOOK_EVENTS = ["session_start", "user_prompt_submit", "pre_tool_use", "post_tool_use", "subagent_start", "subagent_stop", "stop"];
const hookStateBlock = (hooksJsonPath, events = HOOK_EVENTS) =>
  events.map(event => `[hooks.state."${hooksJsonPath}:${event}:0:0"]\ntrusted_hash = "sha256:${"0".repeat(64)}"\n`).join("\n");
const projectTrustBlock = root => `[projects."${root}"]\ntrust_level = "trusted"\n`;

// -- Pure text-editor unit tests: reconcileConfigTomlHookState --------------

test("Codex config.toml hook-state: reconcile prunes a stale entry whose scope is no longer live (regression 1)", () => {
  const registered = [
    { scope: "project", configDir: "/repo-a/.codex" },
    { scope: "project", configDir: "/repo-b/.codex" }
  ];
  const kept = [{ scope: "project", configDir: "/repo-b/.codex" }]; // repo-a's scope was pruned upstream
  const text = [
    "model = \"gpt-5.6-sol\"",
    "",
    hookStateBlock("/repo-a/.codex/hooks.json", ["session_start", "stop"]),
    hookStateBlock("/repo-b/.codex/hooks.json", ["session_start"])
  ].join("\n");
  const pruned = [];
  const result = reconcileConfigTomlHookState(text, registered, kept, { onPrune: item => pruned.push(item) });
  assert.doesNotMatch(result.text, /repo-a/);
  assert.match(result.text, /repo-b/);
  assert.match(result.text, /model = "gpt-5\.6-sol"/, "unrelated config keys survive untouched");
  assert.equal(pruned.length, 2, "both of repo-a's hooks.state entries are reported pruned");
  assert.ok(pruned.every(item => item.type === "hooks.state" && item.configDir === "/repo-a/.codex"));
});

test("Codex config.toml hook-state: reconcile collapses a case-duplicate entry, keeping the on-disk casing (regression 2)", () => {
  const registered = [
    { scope: "project", configDir: "/mnt/c/users/foo/repo/.codex" },
    { scope: "project", configDir: "/mnt/c/Users/foo/repo/.codex" }
  ];
  const kept = [{ scope: "project", configDir: "/mnt/c/Users/foo/repo/.codex" }]; // canonical on-disk casing survivor
  const text = [
    hookStateBlock("/mnt/c/users/foo/repo/.codex/hooks.json", ["pre_tool_use"]),
    hookStateBlock("/mnt/c/Users/foo/repo/.codex/hooks.json", ["pre_tool_use"])
  ].join("\n");
  const result = reconcileConfigTomlHookState(text, registered, kept);
  assert.doesNotMatch(result.text, /\/mnt\/c\/users\/foo/, "the non-canonical-cased duplicate is pruned");
  assert.match(result.text, /\/mnt\/c\/Users\/foo/, "the canonical on-disk-cased entry is kept");
});

test("Codex config.toml hook-state: reconcile leaves non-Muster hook entries untouched (regression 3)", () => {
  const registered = [{ scope: "project", configDir: "/repo/.codex" }];
  const kept = []; // /repo's scope is being pruned
  const text = [
    hookStateBlock("/repo/.codex/hooks.json", ["session_start"]),
    hookStateBlock("/opt/other-tool/.codex/hooks.json", ["session_start"]), // never registered by Muster
    "[hooks.state.\"muster@muster:hooks/hooks.json:pre_tool_use:0:0\"]\ntrusted_hash = \"sha256:abc\"\n" // plugin-bundled: no filesystem scope to attribute
  ].join("\n");
  const result = reconcileConfigTomlHookState(text, registered, kept);
  assert.doesNotMatch(result.text, /\/repo\/\.codex/, "the pruned Muster scope's own entry is removed");
  assert.match(result.text, /other-tool/, "an unrelated tool's hooks.json entry is never touched");
  assert.match(result.text, /muster@muster/, "the plugin-bundled trust key (no scope registry path) is never touched");
});

test("Codex config.toml [projects]: reconcile NEVER prunes a [projects] entry, even alongside its stale paired hooks.state entry (blocker 2a regression)", () => {
  // Prior to fix iteration 1 this exact fixture pruned [projects."/repo"]
  // alongside the departing scope's hooks.state entry -- PoC-proved to
  // revoke a user's deliberate Codex trust decision (and any non-muster
  // keys sharing that section) on an ordinary uninstall. [projects] is
  // Codex's own trusted-directory record; muster never created it and
  // cannot reliably attribute it as its own, so it is never touched at all.
  const registered = [{ scope: "project", configDir: "/repo/.codex" }];
  const kept = [];
  const text = [
    hookStateBlock("/repo/.codex/hooks.json", ["session_start"]),
    projectTrustBlock("/repo"),
    projectTrustBlock("/some/other/project") // unrelated project trust, never touched
  ].join("\n");
  const result = reconcileConfigTomlHookState(text, registered, kept);
  assert.doesNotMatch(result.text, /\/repo\/\.codex/, "the stale hooks.state entry for the pruned scope is still removed");
  assert.match(result.text, /\[projects\."\/repo"\]/, "the paired [projects] entry is NEVER pruned, even though its scope's hooks.state was");
  assert.match(result.text, /some\/other\/project/, "an unrelated [projects] entry is untouched too");
  assert.deepEqual(result.prunedProjects, [], "prunedProjects is always empty now -- [projects] pruning was removed entirely");
});

// -- Blocker 1: [[array-of-tables]] headers as section boundaries -----------

test("Codex config.toml hook-state: a `[[array-of-tables]]` block directly after a pruned stale section survives byte-identical (blocker 1 regression)", () => {
  const registered = [{ scope: "project", configDir: "/repo-gone/.codex" }];
  const kept = [];
  const arrayBlock = [
    "[[mcp_servers.foo.env_http_headers]]",
    "name = \"X-Custom-Header\"",
    "value = \"abc\"",
    "",
    "[[mcp_servers.foo.env_http_headers]]",
    "name = \"X-Other-Header\"",
    "value = \"def\""
  ].join("\n");
  // No blank line between the stale section's last line and the first
  // `[[...]]` header -- the exact adjacency the PoC exploited: the
  // ANY_TOML_HEADER boundary regex previously did not match a double-bracket
  // header at all, so the pruned section's span silently extended through
  // (and deleted) both array-of-tables blocks below.
  const text = `${hookStateBlock("/repo-gone/.codex/hooks.json", ["session_start", "stop"])}${arrayBlock}\n`;
  const result = reconcileConfigTomlHookState(text, registered, kept);
  assert.doesNotMatch(result.text, /repo-gone/, "the stale muster section is gone");
  assert.ok(result.text.includes(arrayBlock), "both [[...]] blocks survive byte-identical, never absorbed into the pruned section's deleted span");
});

test("Codex config.toml hook-state: the array-of-tables boundary guard also holds directly after a [projects] section (blocker 1 regression)", () => {
  const registered = [{ scope: "project", configDir: "/repo-gone/.codex" }];
  const kept = [];
  const text = [
    projectTrustBlock("/some/project"), // never pruned; the following [[...]] must not be swallowed into its span either
    "[[mcp_servers.foo.env_http_headers]]",
    "name = \"X-Test\"",
    "value = \"abc\"",
    "",
    hookStateBlock("/repo-gone/.codex/hooks.json", ["session_start"]) // the actual prunable stale entry, elsewhere in the file
  ].join("\n");
  const result = reconcileConfigTomlHookState(text, registered, kept);
  assert.match(result.text, /\[projects\."\/some\/project"\]/, "the [projects] section itself is never touched");
  assert.match(result.text, /\[\[mcp_servers\.foo\.env_http_headers\]\]/, "the array-of-tables block directly after it survives");
  assert.match(result.text, /X-Test/, "the array-of-tables block's own content survives, not just its header");
  assert.doesNotMatch(result.text, /repo-gone/, "the actual stale hooks.state entry is still pruned elsewhere in the file");
});

test("Codex config.toml hook-state: a realistic multi-section config.toml round-trips through reconcile byte-identical except the intended prune", () => {
  // Realistic fixture: model, [mcp_servers.*] tables (nested + `[[...]]`
  // array-of-tables), [hooks.state] (one stale, one live), [projects] with a
  // non-muster key, comments, and a quoted key -- exactly the shape a real
  // user's ~/.codex/config.toml has (see docs/research/codex-cli.md and the
  // PoC that motivated fix iteration 1).
  const beforeLines = [
    "# Realistic Codex config.toml fixture used to prove byte-identical",
    "# round-tripping through reconcile, except for the one intended prune.",
    "model = \"gpt-5.6-sol\"",
    "approval_policy = \"on-request\"",
    "",
    "[mcp_servers.linear]",
    "command = \"npx\"",
    "args = [\"-y\", \"@linear/mcp-server\"]",
    "",
    "[mcp_servers.linear.env]",
    "\"API_KEY\" = \"secret-value\" # quoted key with an inline comment",
    "",
    "[hooks.state.\"/repo-gone/.codex/hooks.json:session_start:0:0\"]",
    "trusted_hash = \"sha256:aaaa\"",
    "[hooks.state.\"/repo-gone/.codex/hooks.json:stop:0:0\"]",
    "trusted_hash = \"sha256:bbbb\"",
    "[[mcp_servers.linear.env_http_headers]]",
    "name = \"X-Custom-Header\"",
    "value = \"abc\"",
    "",
    "[[mcp_servers.linear.env_http_headers]]",
    "name = \"X-Other-Header\"",
    "value = \"def\"",
    "",
    "[projects.\"/repo-keep\"]",
    "trust_level = \"trusted\"",
    "custom_non_muster_key = \"keep-me\"",
    "",
    "[hooks.state.\"/repo-keep/.codex/hooks.json:session_start:0:0\"]",
    "trusted_hash = \"sha256:cccc\"",
    "",
    "[[mcp_servers.other.env_http_headers]]",
    "name = \"Authorization\"",
    "value = \"Bearer xyz\"",
    "",
    "[tui]",
    "color = true"
  ];
  // Exactly beforeLines with the four lines belonging to repo-gone's two
  // stale [hooks.state] sections removed -- nothing else changes.
  const afterLines = [
    "# Realistic Codex config.toml fixture used to prove byte-identical",
    "# round-tripping through reconcile, except for the one intended prune.",
    "model = \"gpt-5.6-sol\"",
    "approval_policy = \"on-request\"",
    "",
    "[mcp_servers.linear]",
    "command = \"npx\"",
    "args = [\"-y\", \"@linear/mcp-server\"]",
    "",
    "[mcp_servers.linear.env]",
    "\"API_KEY\" = \"secret-value\" # quoted key with an inline comment",
    "",
    "[[mcp_servers.linear.env_http_headers]]",
    "name = \"X-Custom-Header\"",
    "value = \"abc\"",
    "",
    "[[mcp_servers.linear.env_http_headers]]",
    "name = \"X-Other-Header\"",
    "value = \"def\"",
    "",
    "[projects.\"/repo-keep\"]",
    "trust_level = \"trusted\"",
    "custom_non_muster_key = \"keep-me\"",
    "",
    "[hooks.state.\"/repo-keep/.codex/hooks.json:session_start:0:0\"]",
    "trusted_hash = \"sha256:cccc\"",
    "",
    "[[mcp_servers.other.env_http_headers]]",
    "name = \"Authorization\"",
    "value = \"Bearer xyz\"",
    "",
    "[tui]",
    "color = true"
  ];
  const registered = [
    { scope: "project", configDir: "/repo-gone/.codex" },
    { scope: "project", configDir: "/repo-keep/.codex" }
  ];
  const kept = [{ scope: "project", configDir: "/repo-keep/.codex" }];
  const pruned = [];
  const result = reconcileConfigTomlHookState(`${beforeLines.join("\n")}\n`, registered, kept, { onPrune: item => pruned.push(item) });
  assert.equal(result.text, `${afterLines.join("\n")}\n`, "byte-identical to the source except the two repo-gone [hooks.state] sections");
  assert.equal(pruned.length, 2);
  assert.ok(pruned.every(item => item.type === "hooks.state" && item.configDir === "/repo-gone/.codex"));
  assert.deepEqual(result.prunedProjects, []);
});

test("Codex config.toml hook-state: reconcile is a byte-identical no-op when every registered scope is kept", () => {
  const registered = [{ scope: "user", configDir: "/home/x/.codex" }];
  const kept = registered;
  const text = `theme = "dark"\n\n${hookStateBlock("/home/x/.codex/hooks.json", ["session_start"])}\n[tui]\ncolor = true\n`;
  const result = reconcileConfigTomlHookState(text, registered, kept);
  assert.equal(result.text, text);
  assert.deepEqual(result.prunedHookState, []);
  assert.deepEqual(result.prunedProjects, []);
});

// -- Blocker 2(b): exact-key hooks.state attribution -------------------------

test("Codex config.toml hook-state: reconcile narrows pruning to the exact muster-owned key, leaving a co-located non-muster hooks.state entry (different index, same path) untouched (blocker 2b regression)", () => {
  // Root cause: attribution at hooksJsonPath granularity alone would prune
  // BOTH entries below, even though only one (index 0) is muster's own.
  // ownedHookStateKeys (passed here directly, as install/uninstall compute
  // it from the live hooks.json + the scope's exact hookGroups manifest)
  // narrows a not-kept entry's prune to only its listed compound keys.
  const registered = [{
    scope: "project",
    configDir: "/repo/.codex",
    ownedHookStateKeys: ["session_start:0:0"] // only muster's own exact key at this path
  }];
  const kept = [];
  const text = [
    hookStateBlock("/repo/.codex/hooks.json", ["session_start"]), // muster's own: groupIndex 0, hookIndex 0
    "[hooks.state.\"/repo/.codex/hooks.json:session_start:1:0\"]", // co-located NON-muster entry: same path, different group index
    "trusted_hash = \"sha256:userowned\""
  ].join("\n");
  const pruned = [];
  const result = reconcileConfigTomlHookState(text, registered, kept, { onPrune: item => pruned.push(item) });
  assert.equal(pruned.length, 1);
  assert.equal(pruned[0].groupIndex, 0);
  assert.match(result.text, /session_start:1:0/, "the co-located non-muster entry (different index) survives");
  assert.doesNotMatch(result.text, /session_start:0:0/, "muster's own exact key is still pruned");
});

// -- Install-time integration -------------------------------------------------

test("Codex hook-state: a clean single-scope install leaves zero stale registrations (regression 4)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hookstate-clean-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  const result = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  assert.deepEqual(result.prunedHookState, []);
  assert.deepEqual(result.prunedProjectTrust, []);
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absentCodex });
  const check = report.checks.find(item => item.name === "codex-hook-state");
  assert.equal(check?.ok, true);
});

test("Codex hook-state: a stale case-duplicate scope is reconciled away by the next install", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hookstate-install-prune-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  const keep = join(tmp, "project-keep"), gone = join(tmp, "project-gone");
  await runCodexInstall({ cwd: keep, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ cwd: gone, home, repoRoot, execFile: absentCodex });
  const goneHooksJson = join(gone, ".codex", "hooks.json");
  const configTomlPath = join(codexHomeDir, "config.toml");
  const before = await readFile(configTomlPath, "utf8");
  await writeFile(configTomlPath, `${before}\n${hookStateBlock(goneHooksJson, ["session_start"])}\n`);
  await rm(gone, { recursive: true, force: true });

  const result = await runCodexInstall({ cwd: keep, home, repoRoot, execFile: absentCodex });
  assert.equal(result.prunedHookState.length, 1);
  assert.equal(result.prunedHookState[0].configDir, join(gone, ".codex"));
  const after = await readFile(configTomlPath, "utf8");
  assert.doesNotMatch(after, new RegExp(escapeRegex(goneHooksJson)));
  assert.match(after, /\[agents\]/, "unrelated config.toml content (the thread-limit floor) survives");
});

// -- Uninstall integration (fix C) --------------------------------------------

test("Codex uninstall prunes only the departing scope's config.toml [hooks.state] registrations (regression 5)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hookstate-uninstall-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  const configTomlPath = join(codexHomeDir, "config.toml");
  const projectHooksJson = join(cwd, ".codex", "hooks.json");
  const userHooksJson = join(codexHomeDir, "hooks.json");
  const before = await readFile(configTomlPath, "utf8");
  const augmented = `${before}\n${hookStateBlock(projectHooksJson, ["session_start", "pre_tool_use"])}\n${hookStateBlock(userHooksJson, ["session_start"])}\n`;
  await writeFile(configTomlPath, augmented);

  const result = await runCodexUninstall({ scope: "project", cwd, home, execFile: absentCodex });
  const after = await readFile(configTomlPath, "utf8");
  assert.doesNotMatch(after, new RegExp(escapeRegex(projectHooksJson)), "the departing project scope's hook trust entries are removed");
  assert.match(after, new RegExp(escapeRegex(userHooksJson)), "the still-live user scope's hook trust entries survive");
  assert.match(after, /\[agents\]/, "the thread-limit floor is untouched -- the user scope is still live");
  assert.equal(result.prunedHookState.length, 2);
  assert.deepEqual(result.prunedProjectTrust, [], "muster never prunes a [projects] entry (blocker 2a)");

  // The still-live user scope's own uninstall must be unaffected by the
  // earlier project-scope prune.
  const last = await runCodexUninstall({ scope: "user", cwd, home, execFile: absentCodex });
  assert.equal(last.prunedHookState.length, 1);
  await assert.rejects(readFile(configTomlPath, "utf8"), /ENOENT/, "the final scope's uninstall restores/removes the Muster-created config.toml as before");
});

test("Codex uninstall --scope project leaves an existing project's [projects] trust record (and its non-muster keys) fully intact, even though its own hooks.state entry is pruned (blocker 2a regression)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hookstate-projects-intact-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  const configTomlPath = join(codexHomeDir, "config.toml");
  const projectHooksJson = join(cwd, ".codex", "hooks.json");
  const before = await readFile(configTomlPath, "utf8");
  // Simulates Codex's own real state for this still-fully-existing project:
  // a trust decision on muster's own hook (which uninstall legitimately
  // prunes below) plus its own [projects] trust record carrying a
  // non-muster key (which must survive an ordinary uninstall untouched).
  const augmented = `${before}\n${hookStateBlock(projectHooksJson, ["session_start"])}\n${projectTrustBlock(cwd)}non_muster_key = "user-set-this"\n`;
  await writeFile(configTomlPath, augmented);

  const result = await runCodexUninstall({ scope: "project", cwd, home, execFile: absentCodex });
  const after = await readFile(configTomlPath, "utf8"); // must survive -- must NOT be deleted
  assert.doesNotMatch(after, new RegExp(escapeRegex(projectHooksJson)), "the departing scope's own hooks.state entry is still pruned");
  assert.match(after, new RegExp(`\\[projects\\."${escapeRegex(cwd)}"\\]`), "the project's [projects] trust record survives an ordinary uninstall (blocker 2a)");
  assert.match(after, /non_muster_key = "user-set-this"/, "a non-muster key inside that same [projects] section survives too");
  assert.deepEqual(result.prunedProjectTrust, [], "muster never reports a pruned [projects] entry -- it never prunes one");
});

test("Codex uninstall --scope project prunes only its own exact [hooks.state] key, leaving a co-located non-muster hook definition (different index) at the same hooksJsonPath intact (blocker 2b regression)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hookstate-exact-index-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  const configTomlPath = join(codexHomeDir, "config.toml");
  const projectHooksJson = join(cwd, ".codex", "hooks.json");
  const before = await readFile(configTomlPath, "utf8");
  // Simulates Codex having trusted BOTH muster's own SessionStart group (at
  // its real index 0, one group per event -- see codex/hooks/hooks.json)
  // AND a user's own separately-trusted SessionStart hook definition living
  // in the SAME hooks.json at group index 1.
  const coLocatedNonMusterEntry = `[hooks.state."${projectHooksJson}:session_start:1:0"]\ntrusted_hash = "sha256:userowned"\n`;
  await writeFile(configTomlPath, `${before}\n${hookStateBlock(projectHooksJson, ["session_start"])}\n${coLocatedNonMusterEntry}`);

  const result = await runCodexUninstall({ scope: "project", cwd, home, execFile: absentCodex });
  const after = await readFile(configTomlPath, "utf8");
  assert.match(after, new RegExp(`${escapeRegex(projectHooksJson)}:session_start:1:0`), "the co-located non-muster entry (different index) at the same path survives uninstall");
  assert.doesNotMatch(after, new RegExp(`${escapeRegex(projectHooksJson)}:session_start:0:0`), "muster's own exact SessionStart key is still pruned");
  assert.ok(result.prunedHookState.some(item => item.event === "session_start" && item.groupIndex === 0), "the pruned entry is reported as muster's exact group index 0");
});

// -- Doctor integration (fix D) ------------------------------------------------

test("Codex doctor reports over-registration when a stale scope's hook trust entries are still present (regression 6)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hookstate-doctor-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  const keep = join(tmp, "project-keep"), gone = join(tmp, "project-gone");
  await runCodexInstall({ cwd: keep, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ cwd: gone, home, repoRoot, execFile: absentCodex });
  const goneHooksJson = join(gone, ".codex", "hooks.json");
  const configTomlPath = join(codexHomeDir, "config.toml");
  const before = await readFile(configTomlPath, "utf8");
  await writeFile(configTomlPath, `${before}\n${hookStateBlock(goneHooksJson, ["session_start"])}\n`);
  await rm(gone, { recursive: true, force: true });

  const report = await runCodexDoctor({ root: repoRoot, cwd: keep, codexHome: codexHomeDir, execFile: absentCodex });
  const check = report.checks.find(item => item.name === "codex-hook-state");
  assert.equal(check?.ok, false);
  assert.match(check?.detail || "", /stale or case-duplicate/);
  assert.match(check?.detail || "", /muster install codex/);
  assert.equal(report.ok, false);
});

test("Codex doctor does not treat a legitimate simultaneous project+user install as over-registration", async t => {
  // Escalated design point (see the returned report): both scopes firing
  // hooks.json-layer hooks at once is Muster's existing, intentional,
  // doctor-accepted design (see codex-hooks-overlap) -- this fix targets
  // stale/duplicate accumulation only, not legitimate dual-scope installs.
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hookstate-doctor-dual-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  await runCodexInstall({ scope: "project", cwd, home, repoRoot, execFile: absentCodex });
  await runCodexInstall({ scope: "user", cwd, home, repoRoot, execFile: absentCodex });
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: codexHomeDir, execFile: absentCodex });
  const check = report.checks.find(item => item.name === "codex-hook-state");
  assert.equal(check?.ok, true);
});

test("Codex doctor reports codex-hook-state ok:true when config.toml is absent entirely", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hookstate-doctor-missing-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHomeDir = join(home, ".codex");
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: codexHomeDir, execFile: absentCodex });
  const check = report.checks.find(item => item.name === "codex-hook-state");
  assert.equal(check?.ok, true);
  assert.match(check?.detail || "", /not found/);
});
