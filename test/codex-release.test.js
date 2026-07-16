import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  assertRegularFile,
  assertRegularTree,
  generateCodexProfiles,
  profileToml,
  publishCodexPlugin,
  resolveCodexPlugin
} from "../src/codex-release.js";

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
  pluginsRoot: join(root, "plugins"),
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
  assert.equal(published.pluginRoot, join(root, "plugins", "plugin"));
  assert.equal(published.profilesRoot, join(root, "plugins", "plugin", "agents"));
  assert.equal(published.packageVersion, "0.5.0");
  const pointer = JSON.parse(await readFile(join(root, "plugins", "marketplace.json"), "utf8"));
  assert.equal(pointer.plugins[0].source.path, "./plugin");
  assert.equal(await readFile(join(published.pluginRoot, "runtime", "muster.mjs"), "utf8"), 'export const marker = "one";\n');
});

test("publishCodexPlugin fully replaces the previous plugin tree, not merges", async t => {
  const root = await tempRoot(t);
  await publish(root, "old", { stagedPlugin: await stagedPlugin(root, "old") });
  await write(join(root, "plugins", "plugin", "stale-leftover.txt"), "should not survive\n");
  await publish(root, "new", { stagedPlugin: await stagedPlugin(root, "new") });
  await assert.rejects(readFile(join(root, "plugins", "plugin", "stale-leftover.txt"), "utf8"));
  assert.equal(await readFile(join(root, "plugins", "plugin", "runtime", "muster.mjs"), "utf8"), 'export const marker = "new";\n');
});

test("publishCodexPlugin reuses a preexisting marketplace pointer instead of requiring a template", async t => {
  const root = await tempRoot(t);
  await mkdir(join(root, "plugins"), { recursive: true });
  await write(join(root, "plugins", "marketplace.json"), JSON.stringify({
    name: "muster",
    interface: { displayName: "Muster" },
    plugins: [{ name: "muster", source: { source: "local", path: "./somewhere-else" }, category: "Productivity" }]
  }));
  const published = await publishCodexPlugin({ pluginsRoot: join(root, "plugins"), stagedPlugin: await stagedPlugin(root, "reuse"), packageVersion: "0.5.0" });
  const pointer = JSON.parse(await readFile(join(root, "plugins", "marketplace.json"), "utf8"));
  assert.equal(pointer.interface.displayName, "Muster", "unrelated pointer fields must survive an update");
  assert.equal(pointer.plugins[0].source.path, "./plugin");
  assert.equal(published.packageVersion, "0.5.0");
});

test("publishCodexPlugin requires a package version and rejects a marketplace that does not describe muster", async t => {
  const root = await tempRoot(t);
  await assert.rejects(publishCodexPlugin({ pluginsRoot: join(root, "plugins"), stagedPlugin: await stagedPlugin(root, "no-version"), packageVersion: "" }), /package version is required/);
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
  await assert.rejects(readFile(join(root, "plugins", "marketplace.json"), "utf8"));
});

test("resolveCodexPlugin round-trips a published plugin and fails closed when nothing was built", async t => {
  const root = await tempRoot(t);
  await assert.rejects(resolveCodexPlugin(root, { pluginsRoot: join(root, "plugins") }), /is missing|Codex plugin staging directory/);
  await publish(root, "resolve", { stagedPlugin: await stagedPlugin(root, "resolve") });
  const selected = await resolveCodexPlugin(root, { pluginsRoot: join(root, "plugins") });
  assert.equal(selected.pluginRoot, join(root, "plugins", "plugin"));
  assert.equal(selected.packageVersion, "0.5.0");
  assert.equal(await readFile(join(selected.profilesRoot, "muster-builder.toml"), "utf8"), 'name = "muster-builder"\nmarker = "resolve"\n');
});

test("resolveCodexPlugin rejects a marketplace pointer that does not name the fixed plugin path", async t => {
  const root = await tempRoot(t);
  await publish(root, "pointer", { stagedPlugin: await stagedPlugin(root, "pointer") });
  const pointerPath = join(root, "plugins", "marketplace.json");
  const pointer = JSON.parse(await readFile(pointerPath, "utf8"));
  pointer.plugins[0].source.path = "./somewhere-else";
  await writeFile(pointerPath, JSON.stringify(pointer));
  await assert.rejects(resolveCodexPlugin(root, { pluginsRoot: join(root, "plugins") }), /valid Muster plugin contract/);
});

test("resolveCodexPlugin rejects a published plugin tree containing a symlink", async t => {
  const root = await tempRoot(t);
  const published = await publish(root, "tamper", { stagedPlugin: await stagedPlugin(root, "tamper") });
  const outside = join(root, "outside-published.txt");
  await writeFile(outside, "secret");
  await symlink(outside, join(published.pluginRoot, "skills", "muster", "escape.md"));
  await assert.rejects(resolveCodexPlugin(root, { pluginsRoot: join(root, "plugins") }), /symlink/i);
});

test("concurrent publishes to the same pluginsRoot serialize and leave one coherent winner", async t => {
  const root = await tempRoot(t);
  const results = await Promise.all(["a", "b", "c"].map(async marker => {
    const staged = await stagedPlugin(root, `race-${marker}`);
    return publish(root, `race-${marker}`, { stagedPlugin: staged });
  }));
  for (const published of results) assert.equal(published.packageVersion, "0.5.0");
  const selected = await resolveCodexPlugin(root, { pluginsRoot: join(root, "plugins") });
  assert.match(await readFile(join(selected.pluginRoot, "runtime", "muster.mjs"), "utf8"), /export const marker = "race-[abc]";\n/);
  assert.deepEqual((await readdir(join(root, "plugins"))).filter(name => name.startsWith(".muster-retired-")), []);
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
