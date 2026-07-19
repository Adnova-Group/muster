import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync } from "node:fs";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertRegularFile,
  assertRegularTree,
  copyStagedPluginTree,
  generateCodexProfiles,
  profileToml,
  publishCodexPlugin,
  resolveCodexPlugin
} from "../src/codex-release.js";
import { CODEX_COUNTS } from "../src/codex.js";

const repoRoot = new URL("../", import.meta.url).pathname;

async function write(path, content) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

async function stagedPlugin(root, marker) {
  const plugin = join(root, `${marker}-staged`);
  await write(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "muster", version: "0.5.0" }));
  await write(join(plugin, "skills", "muster", "SKILL.md"), `---\nname: muster\ndescription: ${marker}\n---\n\n${marker}\n`);
  await write(join(plugin, "runtime", "muster.mjs"), `export const marker = ${JSON.stringify(marker)};\n`);
  await write(join(plugin, "agents", "muster-builder.toml"), `name = "muster-builder"\nmarker = ${JSON.stringify(marker)}\n`);
  await write(join(plugin, "package.json"), JSON.stringify({ version: "0.5.0" }));
  return plugin;
}

const marketplaceTemplate = { name: "muster", plugins: [{ name: "muster", source: { source: "local", path: "./legacy" }, category: "Productivity" }] };
const publish = (root, marker, overrides = {}) => publishCodexPlugin({
  pluginsRoot: join(root, ".agents", "plugins"),
  packageVersion: "0.5.0",
  marketplaceTemplate,
  ...overrides
});

async function tempRoot(t) {
  const root = await mkdtemp(join(tmpdir(), "muster-codex-release-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("generateCodexProfiles reads the frozen agent mapping and produces one TOML per role", async t => {
  const root = await tempRoot(t);
  await write(join(root, "codex", "agents.manifest.json"), JSON.stringify({
    format: 1,
    agents: {
      "test-role": { source: "sources/test-role.md", tier: "sonnet", readOnly: true }
    }
  }));
  await write(join(root, "sources", "test-role.md"), "---\nname: test-role\ndescription: A test role.\n---\n\nBody instructions.\n");
  const profiles = await generateCodexProfiles(root);
  assert.deepEqual([...profiles.keys()], ["test-role.toml"]);
  const content = profiles.get("test-role.toml");
  assert.match(content, /name = "test-role"/);
  assert.match(content, /sandbox_mode = "read-only"/);
  assert.match(content, /Body instructions\./);
});

test("generateCodexProfiles fails closed on an invalid tier, reasoning, or model override", async t => {
  const root = await tempRoot(t);
  await write(join(root, "sources", "role.md"), "---\nname: role\ndescription: role\n---\n\nBody\n");
  for (const [config, expected] of [
    [{ source: "sources/role.md", tier: "not-a-tier" }, /unknown Codex profile tier/],
    [{ source: "sources/role.md", tier: "sonnet", reasoning: "max" }, /invalid Codex profile reasoning override/],
    [{ source: "sources/role.md", tier: "sonnet", model: "gpt-4" }, /invalid Codex profile model override/]
  ]) {
    await write(join(root, "codex", "agents.manifest.json"), JSON.stringify({ format: 1, agents: { role: config } }));
    await assert.rejects(generateCodexProfiles(root), expected);
  }
});

test("profileToml is a pure function usable independent of the manifest reader", () => {
  const source = "---\nname: x\ndescription: X role.\n---\n\nInstructions.\n";
  const text = profileToml("x", source, { tier: "opus" });
  assert.match(text, /name = "x"/);
  assert.match(text, /description = "X role\."/);
  assert.match(text, /Instructions\./);
});

test("publishCodexPlugin stages, validates, and publishes a plugin with a marketplace pointer", async t => {
  const root = await tempRoot(t);
  const staged = await stagedPlugin(root, "one");
  const published = await publish(root, "one", { stagedPlugin: staged });
  assert.equal(published.pluginRoot, join(root, ".agents", "plugins", "plugin"));
  assert.equal(published.profilesRoot, join(root, ".agents", "plugins", "plugin", "agents"));
  assert.equal(published.packageVersion, "0.5.0");
  const pointer = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(pointer.plugins[0].source.path, "./.agents/plugins/plugin");
  assert.equal(await readFile(join(published.pluginRoot, "runtime", "muster.mjs"), "utf8"), 'export const marker = "one";\n');
});

test("marketplace pointer targets the hooks-free Codex plugin relative to the add-root, not the repo-root Claude plugin (hook-bombardment regression)", async t => {
  // Codex 0.144.5 resolves a marketplace entry's source.path relative to the
  // `codex plugin marketplace add`-ed root (== root here, since pluginsRoot is
  // <root>/.agents/plugins), NOT the marketplace.json's own dir. "./plugin"
  // resolves to <root>/plugin -- the Claude plugin, whose default hooks/hooks.json
  // Codex >=0.144.5 auto-fires, duplicating the scoped hooks.json install. The
  // pointer must descend into the sibling hooks-free .agents/plugins/plugin.
  const root = await tempRoot(t);
  const pluginsRoot = join(root, ".agents", "plugins");
  const published = await publishCodexPlugin({ pluginsRoot, stagedPlugin: await stagedPlugin(root, "regression"), packageVersion: "0.5.0", marketplaceTemplate });
  const pointerPath = join(pluginsRoot, "marketplace.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  assert.equal(pointer.plugins[0].source.path, "./.agents/plugins/plugin");
  // The path, resolved from the add-root, must reach the published plugin dir.
  assert.equal(join(root, pointer.plugins[0].source.path), published.pluginRoot);
  assert.equal(published.pluginRoot, join(pluginsRoot, "plugin"));
  // Reverting to the old "./plugin" contract (which reinstalls the with-hooks
  // Claude plugin) must now fail closed at resolve.
  pointer.plugins[0].source.path = "./plugin";
  await writeFile(pointerPath, JSON.stringify(pointer));
  await assert.rejects(resolveCodexPlugin(root, { pluginsRoot }), /valid Muster plugin contract/);
});

test("publishCodexPlugin fully replaces the previous plugin tree, not merges", async t => {
  const root = await tempRoot(t);
  await publish(root, "old", { stagedPlugin: await stagedPlugin(root, "old") });
  await write(join(root, ".agents", "plugins", "plugin", "stale-leftover.txt"), "should not survive\n");
  await publish(root, "new", { stagedPlugin: await stagedPlugin(root, "new") });
  await assert.rejects(readFile(join(root, ".agents", "plugins", "plugin", "stale-leftover.txt"), "utf8"));
  assert.equal(await readFile(join(root, ".agents", "plugins", "plugin", "runtime", "muster.mjs"), "utf8"), 'export const marker = "new";\n');
});

test("publishCodexPlugin copies the staged tree rather than moving it, leaving the caller's staging directory intact", async t => {
  const root = await tempRoot(t);
  const staged = await stagedPlugin(root, "copy-check");
  await publish(root, "copy-check", { stagedPlugin: staged });
  assert.equal(
    await readFile(join(staged, "runtime", "muster.mjs"), "utf8"),
    'export const marker = "copy-check";\n',
    "publish must copy the staged tree (cpSync) rather than rename/move it out from under the caller, since stagedPlugin may be on a different device than pluginsRoot"
  );
});

test("publishCodexPlugin restores the previous plugin if the copy-publish step fails after retirement", async t => {
  const root = await tempRoot(t);
  await publish(root, "before", { stagedPlugin: await stagedPlugin(root, "before") });
  const pluginPath = join(root, ".agents", "plugins", "plugin");
  // Staging the "new" tree at the exact path of the plugin being replaced
  // forces a deterministic, device-independent copy failure: once the
  // existing plugin is renamed aside (retirement), the directory used as
  // `stagedPlugin` no longer exists at its original location, so the
  // cpSync publish step fails with ENOENT. This exercises the same
  // retire-then-copy-then-restore-on-failure sequence a genuine copy
  // failure would hit, without needing to fake a cross-device rename.
  await assert.rejects(publish(root, "broken", { stagedPlugin: pluginPath }));
  assert.equal(
    await readFile(join(pluginPath, "runtime", "muster.mjs"), "utf8"),
    'export const marker = "before";\n',
    "a failed publish must restore the previous plugin rather than leave the directory empty or missing"
  );
  assert.deepEqual(
    (await readdir(join(root, ".agents", "plugins"))).filter(name => name.startsWith(".muster-retired-")),
    [],
    "retired staging directory must not linger after a restore"
  );
});

test("publishCodexPlugin reuses a preexisting marketplace pointer instead of requiring a template", async t => {
  const root = await tempRoot(t);
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  await write(join(root, ".agents", "plugins", "marketplace.json"), JSON.stringify({
    name: "muster",
    interface: { displayName: "Muster" },
    plugins: [{ name: "muster", source: { source: "local", path: "./somewhere-else" }, category: "Productivity" }]
  }));
  const published = await publishCodexPlugin({ pluginsRoot: join(root, ".agents", "plugins"), stagedPlugin: await stagedPlugin(root, "reuse"), packageVersion: "0.5.0" });
  const pointer = JSON.parse(await readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
  assert.equal(pointer.interface.displayName, "Muster", "unrelated pointer fields must survive an update");
  assert.equal(pointer.plugins[0].source.path, "./.agents/plugins/plugin");
  assert.equal(published.packageVersion, "0.5.0");
});

test("publishCodexPlugin requires a package version and rejects a marketplace that does not describe muster", async t => {
  const root = await tempRoot(t);
  await assert.rejects(publishCodexPlugin({ pluginsRoot: join(root, ".agents", "plugins"), stagedPlugin: await stagedPlugin(root, "no-version"), packageVersion: "" }), /package version is required/);
  await mkdir(join(root, "other-plugins"), { recursive: true });
  await write(join(root, "other-plugins", "marketplace.json"), JSON.stringify({ name: "not-muster", plugins: [] }));
  await assert.rejects(
    publishCodexPlugin({ pluginsRoot: join(root, "other-plugins"), stagedPlugin: await stagedPlugin(root, "wrong-marketplace"), packageVersion: "0.5.0" }),
    /does not describe the Muster plugin/
  );
});

test("publishCodexPlugin rejects a symlink in the staged tree without publishing it", async t => {
  const root = await tempRoot(t);
  const staged = await stagedPlugin(root, "symlink");
  const outside = join(root, "outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(staged, "skills", "muster", "escape.md"));
  await assert.rejects(publish(root, "symlink", { stagedPlugin: staged }), /symlink|regular file/i);
  await assert.rejects(readFile(join(root, ".agents", "plugins", "marketplace.json"), "utf8"));
});

test("publishCodexPlugin's copy-time filter rejects a symlink introduced into the staged tree after pre-lock validation (TOCTOU) and restores the previous plugin", async t => {
  const root = await tempRoot(t);
  await publish(root, "toctou-before", { stagedPlugin: await stagedPlugin(root, "toctou-before") });
  const staged = await stagedPlugin(root, "toctou-after");
  const outside = join(root, "toctou-outside.txt");
  await writeFile(outside, "secret");
  // publishCodexPlugin's own pre-lock `assertRegularTree(stagedPlugin)` call
  // (above, before this injected copy step ever runs) sees a clean tree here
  // — the symlink below is planted only once the copy step itself begins,
  // simulating a same-user writer mutating the staged tmpdir in the window
  // between that validation and the copy. Delegating to the real
  // `copyStagedPluginTree` (the production default) means this exercises
  // that exact copy-time filter, not a test double standing in for it.
  const copyStagedPlugin = async (source, destination) => {
    await symlink(outside, join(source, "skills", "muster", "escape-after-validate.md"));
    copyStagedPluginTree(source, destination);
  };
  await assert.rejects(publish(root, "toctou-after", { stagedPlugin: staged, copyStagedPlugin }), /symlink|unsafe/i);
  assert.equal(
    await readFile(join(root, ".agents", "plugins", "plugin", "runtime", "muster.mjs"), "utf8"),
    'export const marker = "toctou-before";\n',
    "a symlink introduced after the pre-lock validation must not overwrite the previously published plugin"
  );
  assert.deepEqual(
    (await readdir(join(root, ".agents", "plugins"))).filter(name => name.startsWith(".muster-retired-")),
    [],
    "retired staging directory must not linger after a restore"
  );
});

test("publishCodexPlugin's destination re-validation independently rejects a symlink that reaches pluginPath even when the copy step does not filter it", async t => {
  const root = await tempRoot(t);
  await publish(root, "dest-check-before", { stagedPlugin: await stagedPlugin(root, "dest-check-before") });
  const staged = await stagedPlugin(root, "dest-check-after");
  const outside = join(root, "dest-check-outside.txt");
  await writeFile(outside, "secret");
  // Bypasses the default copy-time filter entirely (raw cpSync, no symlink
  // rejection) and instead plants the symlink directly at the destination
  // after the copy completes, so only the post-copy `assertRegularTree`
  // re-validation (not the copy-time filter) can catch it — proving that
  // defense is independently effective, not just redundant with the filter.
  const copyStagedPlugin = async (source, destination) => {
    cpSync(source, destination, { recursive: true });
    await symlink(outside, join(destination, "skills", "muster", "escape-in-destination.md"));
  };
  await assert.rejects(publish(root, "dest-check-after", { stagedPlugin: staged, copyStagedPlugin }), /symlink/i);
  assert.equal(
    await readFile(join(root, ".agents", "plugins", "plugin", "runtime", "muster.mjs"), "utf8"),
    'export const marker = "dest-check-before";\n',
    "a symlink present only at the destination must not survive the publish"
  );
  assert.deepEqual((await readdir(join(root, ".agents", "plugins"))).filter(name => name.startsWith(".muster-retired-")), []);
});

// --- Symlinked-ANCESTOR containment: `ensureOrdinaryDirectory` validated only
// the terminal pluginsRoot, so a symlinked ANCESTOR of pluginsRoot could
// redirect every publish mutation (copy / retire rename / orphan sweep /
// pointer commit) out of the intended tree and into the link's target.
// run-5 security audit High #2. ---

test("publishCodexPlugin refuses a symlinked ANCESTOR of pluginsRoot and never copies the staged tree through it into the link's target", async t => {
  const root = await tempRoot(t);
  // The attacker's redirect target: a real, initially-empty directory the
  // symlinked ancestor points at. A publish that walks through the symlink
  // would materialize the plugin tree HERE instead of the intended location.
  const victim = join(root, "victim-target");
  await mkdir(victim, { recursive: true });
  // `redirect` is a symlinked ANCESTOR of pluginsRoot (before this fix only
  // the terminal pluginsRoot itself was checked for being an ordinary dir).
  await symlink(victim, join(root, "redirect"));
  const pluginsRoot = join(root, "redirect", "plugins");
  await assert.rejects(
    publishCodexPlugin({ pluginsRoot, stagedPlugin: await stagedPlugin(root, "ancestor-copy"), packageVersion: "0.5.0", marketplaceTemplate }),
    /symlink|ordinary directory/i,
    "a symlinked ancestor of pluginsRoot must be rejected before any publish mutation"
  );
  // Nothing may have been written THROUGH the symlink into the link's target:
  // no `plugins` dir, no plugin tree, no marketplace pointer.
  assert.deepEqual(await readdir(victim), [], "no publish mutation may reach the symlinked ancestor's target");
});

test("publishCodexPlugin refuses a symlinked ANCESTOR of pluginsRoot and never retires the previous plugin or sweeps its orphans through it", async t => {
  const root = await tempRoot(t);
  // Publish a real plugin at the CANONICAL (symlink-free) location first.
  const canonicalPlugins = join(root, "canonical", "plugins");
  await publishCodexPlugin({ pluginsRoot: canonicalPlugins, stagedPlugin: await stagedPlugin(root, "victim-plugin"), packageVersion: "0.5.0", marketplaceTemplate });
  // Plant crash-debris the sweep would delete and content the retire rename
  // would move, if either ran through the symlinked ancestor.
  const orphan = join(canonicalPlugins, ".muster-retired-1-canary");
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, "keepme.txt"), "canary\n");
  // Reach the SAME real directory via a symlinked ancestor.
  await symlink(join(root, "canonical"), join(root, "redirect"));
  await assert.rejects(
    publishCodexPlugin({ pluginsRoot: join(root, "redirect", "plugins"), stagedPlugin: await stagedPlugin(root, "attacker"), packageVersion: "0.5.0", marketplaceTemplate }),
    /symlink|ordinary directory/i,
    "a symlinked ancestor must be rejected before the sweep or retire rename runs"
  );
  // The retire rename must NOT have moved the previous plugin, and the orphan
  // sweep must NOT have deleted the canary, through the symlinked ancestor.
  assert.equal(
    await readFile(join(canonicalPlugins, "plugin", "runtime", "muster.mjs"), "utf8"),
    'export const marker = "victim-plugin";\n',
    "previous plugin must not be retired/renamed through a symlinked ancestor"
  );
  assert.equal(await readFile(join(orphan, "keepme.txt"), "utf8"), "canary\n", "orphan sweep must not run through a symlinked ancestor");
});

test("publishCodexPlugin re-validates pluginsRoot canonically before the pointer commit and refuses an ancestor swapped in mid-publish", async t => {
  const root = await tempRoot(t);
  // A VALID plugin tree the swapped-in symlink will point at, so the post-copy
  // assertRegularTree still passes and ONLY the pre-pointer-commit realpath
  // re-validation can catch the ancestor swap.
  const evil = join(root, "evil");
  await mkdir(join(evil, "plugins"), { recursive: true });
  cpSync(await stagedPlugin(root, "evil-src"), join(evil, "plugins", "plugin"), { recursive: true });
  const mid = join(root, "mid");
  const pluginsRoot = join(mid, "plugins");
  // Swap the real `mid` ancestor for a symlink to the evil tree AFTER the copy
  // has completed, mimicking a same-user writer redirecting the ancestor in
  // the window between the copy and the marketplace-pointer commit.
  const copyStagedPlugin = async (source, destination) => {
    copyStagedPluginTree(source, destination);
    await rename(mid, join(root, "mid-real"));
    await symlink(evil, mid);
  };
  await assert.rejects(
    publishCodexPlugin({ pluginsRoot, stagedPlugin: await stagedPlugin(root, "mid-swap"), packageVersion: "0.5.0", marketplaceTemplate, copyStagedPlugin }),
    /symlink|ordinary directory|realpath|resolves to/i,
    "an ancestor swapped in after the copy must be caught by the pre-pointer-commit re-validation"
  );
  // The marketplace pointer must NEVER have been committed through the swapped
  // ancestor into the evil tree.
  await assert.rejects(
    readFile(join(evil, "plugins", "marketplace.json"), "utf8"),
    "the pointer commit must not reach the swapped-in ancestor's target"
  );
});

test("publishCodexPlugin refuses the copy-failure rollback through an ancestor swapped in during the failed copy, never deleting through the symlink", async t => {
  const root = await tempRoot(t);
  // The link's target holds a canary the rollback's `rmSync(pluginPath)` would
  // destroy if it resolved pluginPath (join(pluginsRoot, "plugin")) through the
  // swapped ancestor: join(root, "mid", "plugins", "plugin") -> evil/plugins/plugin.
  const evil = join(root, "evil");
  await mkdir(join(evil, "plugins", "plugin"), { recursive: true });
  await writeFile(join(evil, "plugins", "plugin", "CANARY.txt"), "do-not-delete\n");
  const mid = join(root, "mid");
  const pluginsRoot = join(mid, "plugins");
  // Swap the real `mid` ancestor for a symlink to the evil tree, THEN fail the
  // copy -- mimicking any copy/validation failure racing an ancestor swap. The
  // catch handler's rollback (`rmSync(pluginPath)` + the retired-backup restore)
  // must refuse to run through the now-poisoned ancestor rather than delete the
  // canary out from under the link.
  const copyStagedPlugin = async () => {
    await rename(mid, join(root, "mid-real"));
    await symlink(evil, mid);
    throw new Error("simulated copy failure");
  };
  await assert.rejects(
    publishCodexPlugin({ pluginsRoot, stagedPlugin: await stagedPlugin(root, "rollback"), packageVersion: "0.5.0", marketplaceTemplate, copyStagedPlugin }),
    /rollback refused|symlink|ordinary directory/i,
    "a rollback through a swapped-in ancestor must be refused, not executed"
  );
  assert.equal(
    await readFile(join(evil, "plugins", "plugin", "CANARY.txt"), "utf8"),
    "do-not-delete\n",
    "the copy-failure rollback must not delete through the swapped-in ancestor into the link's target"
  );
});

test("copyStagedPluginTree hard-fails (not a silent skip) when the source tree contains a symlink, without publishing the tainted entry", async t => {
  const root = await tempRoot(t);
  const source = join(root, "copy-source"), destination = join(root, "copy-destination");
  await write(join(source, "keep.txt"), "kept\n");
  const outside = join(root, "copy-outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(source, "escape.txt"));
  assert.throws(() => copyStagedPluginTree(source, destination), /unsafe.*symlink|symlink.*unsafe/i);
  await assert.rejects(readFile(join(destination, "escape.txt"), "utf8"), "the rejected symlink must not have been copied");
});

test("publishCodexPlugin sweeps an orphaned .muster-retired-* directory left by a prior crashed publish", async t => {
  const root = await tempRoot(t);
  await mkdir(join(root, ".agents", "plugins"), { recursive: true });
  const orphan = join(root, ".agents", "plugins", ".muster-retired-99999-orphan");
  await mkdir(orphan, { recursive: true });
  await writeFile(join(orphan, "leftover.txt"), "crash debris\n");
  await publish(root, "sweep", { stagedPlugin: await stagedPlugin(root, "sweep") });
  assert.deepEqual((await readdir(join(root, ".agents", "plugins"))).filter(name => name.startsWith(".muster-retired-")), []);
});

test("resolveCodexPlugin absorbs a brief concurrent-publish ENOENT window with a bounded retry", async t => {
  const root = await tempRoot(t);
  await publish(root, "retry-window", { stagedPlugin: await stagedPlugin(root, "retry-window") });
  const pluginPath = join(root, ".agents", "plugins", "plugin");
  const parked = `${pluginPath}.parked`;
  await rename(pluginPath, parked);
  setTimeout(() => { rename(parked, pluginPath).catch(() => {}); }, 20);
  const selected = await resolveCodexPlugin(root, { pluginsRoot: join(root, ".agents", "plugins") });
  assert.equal(selected.packageVersion, "0.5.0");
});

test("resolveCodexPlugin round-trips a published plugin and fails closed when nothing was built", async t => {
  const root = await tempRoot(t);
  await assert.rejects(resolveCodexPlugin(root, { pluginsRoot: join(root, ".agents", "plugins") }), /is missing|Codex plugin staging directory/);
  await publish(root, "resolve", { stagedPlugin: await stagedPlugin(root, "resolve") });
  const selected = await resolveCodexPlugin(root, { pluginsRoot: join(root, ".agents", "plugins") });
  assert.equal(selected.pluginRoot, join(root, ".agents", "plugins", "plugin"));
  assert.equal(selected.packageVersion, "0.5.0");
  assert.equal(await readFile(join(selected.profilesRoot, "muster-builder.toml"), "utf8"), 'name = "muster-builder"\nmarker = "resolve"\n');
});

test("resolveCodexPlugin rejects a marketplace pointer that does not name the fixed plugin path", async t => {
  const root = await tempRoot(t);
  await publish(root, "pointer", { stagedPlugin: await stagedPlugin(root, "pointer") });
  const pointerPath = join(root, ".agents", "plugins", "marketplace.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  pointer.plugins[0].source.path = "./somewhere-else";
  await writeFile(pointerPath, JSON.stringify(pointer));
  await assert.rejects(resolveCodexPlugin(root, { pluginsRoot: join(root, ".agents", "plugins") }), /valid Muster plugin contract/);
});

test("resolveCodexPlugin rejects a published plugin tree containing a symlink", async t => {
  const root = await tempRoot(t);
  const published = await publish(root, "tamper", { stagedPlugin: await stagedPlugin(root, "tamper") });
  const outside = join(root, "outside-published.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(published.pluginRoot, "skills", "muster", "escape.md"));
  await assert.rejects(resolveCodexPlugin(root, { pluginsRoot: join(root, ".agents", "plugins") }), /symlink/i);
});

test("concurrent publishes to the same pluginsRoot serialize and leave one coherent winner", async t => {
  const root = await tempRoot(t);
  const results = await Promise.all(["a", "b", "c"].map(async marker => {
    const staged = await stagedPlugin(root, `race-${marker}`);
    return publish(root, `race-${marker}`, { stagedPlugin: staged });
  }));
  for (const published of results) assert.equal(published.packageVersion, "0.5.0");
  const selected = await resolveCodexPlugin(root, { pluginsRoot: join(root, ".agents", "plugins") });
  assert.match(await readFile(join(selected.pluginRoot, "runtime", "muster.mjs"), "utf8"), /export const marker = "race-[abc]";\n/);
  assert.deepEqual((await readdir(join(root, ".agents", "plugins"))).filter(name => name.startsWith(".muster-retired-")), []);
});

test("assertRegularTree and assertRegularFile reject symlinks without following them", async t => {
  const root = await tempRoot(t);
  await write(join(root, "tree", "a.txt"), "a\n");
  const outside = join(root, "outside.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(root, "tree", "escape.txt"));
  await assert.rejects(assertRegularTree(join(root, "tree")), /symlink/i);
  await symlink(outside, join(root, "file-link.txt"));
  await assert.rejects(assertRegularFile(join(root, "file-link.txt")), /symlink/i);
  await assert.doesNotReject(assertRegularFile(outside));
});

// --- Trust-boundary containment: codex/agents.manifest.json is attacker-shaped
// input (a manifest-controlled `id` becomes a `<id>.toml` path segment and
// `config.source` becomes a read path). run-5 security audit High #1. ---

test("generateCodexProfiles refuses a manifest agent id that is not a safe kebab token", async t => {
  const root = await tempRoot(t);
  await write(join(root, "sources", "role.md"), "---\nname: role\ndescription: role\n---\n\nBody\n");
  // Each of these, unguarded, becomes a `<id>.toml` Map key that a downstream
  // writer join()s into a destination path -- "../evil" -> "../evil.toml"
  // escapes agentsDir (arbitrary write). Reject the id BEFORE it is a segment.
  // Also rejects trailing/doubled hyphens ("a-", "a--b"): the token is the
  // exact stem of PROFILE_FILENAME, so no accepted id can trip the downstream
  // destination guard (assertContainedProfiles) on a legitimate input.
  for (const id of ["../evil", "a/../../b", "evil/sub", "..", ".", "UPPER", "has space", "-lead", "a-", "a--b", "", "a\\b"]) {
    await write(join(root, "codex", "agents.manifest.json"),
      JSON.stringify({ format: 1, agents: { [id]: { source: "sources/role.md", tier: "opus" } } }));
    await assert.rejects(generateCodexProfiles(root), /is not a safe token/,
      `id ${JSON.stringify(id)} must be rejected before becoming a path segment`);
  }
});

test("generateCodexProfiles refuses a config.source that escapes the distribution root, without reading it", async t => {
  const parent = await mkdtemp(join(tmpdir(), "muster-codex-src-escape-"));
  t.after(() => rm(parent, { recursive: true, force: true }));
  const root = join(parent, "root");
  // A real, readable agent markdown planted OUTSIDE the distribution root. An
  // unguarded reader would happily read it and emit a profile; the containment
  // check must reject BEFORE the read, so this file is provably never touched.
  const sentinel = join(parent, "SENTINEL.md");
  await writeFile(sentinel, "---\nname: leak\ndescription: SENTINEL-CONTENT\n---\n\nSENTINEL-CONTENT body\n");
  for (const source of ["../SENTINEL.md", "../../SENTINEL.md", sentinel /* absolute */]) {
    await write(join(root, "codex", "agents.manifest.json"),
      JSON.stringify({ format: 1, agents: { role: { source, tier: "opus" } } }));
    await assert.rejects(generateCodexProfiles(root), err => {
      // The containment guard fires before readRegular, so the error is the
      // path-only containment rejection -- never the sentinel's contents.
      assert.match(err.message, /is not contained by/, `source ${JSON.stringify(source)} must be a containment rejection`);
      assert.doesNotMatch(err.message, /SENTINEL-CONTENT/, "the escaping source must never be read");
      return true;
    });
  }
});

test("generateCodexProfiles accepts every real committed manifest id and source (no regression)", async () => {
  const profiles = await generateCodexProfiles(repoRoot);
  assert.equal(profiles.size, CODEX_COUNTS.agents);
  for (const key of profiles.keys()) assert.match(key, /^[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/);
});
