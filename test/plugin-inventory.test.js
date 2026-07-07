import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpProject } from "../test-support/helpers.js";
import { readPluginInventory, installedSkillDescription } from "../src/plugin-inventory.js";

// installed_plugins.json must reference absolute installPaths inside the tmp
// home, which aren't known until tmpProject returns — hence written after.
async function writeIndex(home, plugins) {
  const p = join(home, ".claude/plugins/installed_plugins.json");
  await mkdir(dirname(p), { recursive: true });
  await writeFile(p, JSON.stringify({ version: 2, plugins }));
}

test("installPath-driven: agents, skills, and both .mcp.json formats", async () => {
  const home = await tmpProject({
    // bare-map format (serena/playwright style)
    "install/serena/.mcp.json": { serena: { command: "uvx" } },
    // wrapped format (figma style)
    "install/figma/.mcp.json": { mcpServers: { figma: { type: "http" } } },
    // inline plugin.json declaration
    "install/hud/.claude-plugin/plugin.json": { name: "hud", mcpServers: { hud: { command: "node" } } },
    // agents-only plugin (code-simplifier shape) — no MCP server at all
    "install/code-simplifier/agents/code-simplifier.md": "# agent",
    "install/code-simplifier/skills/simplify/SKILL.md": "# skill"
  });
  await writeIndex(home, {
    "serena@official": [{ installPath: join(home, "install/serena") }],
    "figma@official": [{ installPath: join(home, "install/figma") }],
    "hud@local": [{ installPath: join(home, "install/hud") }],
    "code-simplifier@official": [{ installPath: join(home, "install/code-simplifier") }]
  });
  const r = await readPluginInventory(home);
  assert.deepEqual(r.plugins.sort(), ["code-simplifier", "figma", "hud", "serena"]);
  assert.deepEqual(r.mcpServers.sort(), ["figma", "hud", "serena"]);
  assert.deepEqual(r.agents, ["code-simplifier"]);
  assert.deepEqual(r.skills, ["simplify"]);
});

test("plugin.json string mcpServers path is ignored, not chased", async () => {
  const home = await tmpProject({
    "install/x/.claude-plugin/plugin.json": { name: "x", mcpServers: "./servers.json" },
    "install/x/servers.json": { sneaky: { command: "node" } }
  });
  await writeIndex(home, { "x@local": [{ installPath: join(home, "install/x") }] });
  const r = await readPluginInventory(home);
  assert.deepEqual(r.mcpServers, []);
});

test("fallback walk covers shallow + cache layouts, never marketplaces/", async () => {
  const home = await tmpProject({
    // no installed_plugins.json at all → fallback walk
    ".claude/plugins/claude-hud/.mcp.json": { hud: { command: "node" } },
    ".claude/plugins/cache/official/serena/1.0.0/.mcp.json": { serena: { command: "uvx" } },
    ".claude/plugins/cache/official/tool/1.0.0/agents/tool-agent.md": "# a",
    ".claude/plugins/cache/official/tool/1.0.0/skills/tool-skill/SKILL.md": "# s",
    // marketplace OFFERS these — must not be reported
    ".claude/plugins/marketplaces/kw/sales/.mcp.json": { gmail: { command: "node" } },
    ".claude/plugins/marketplaces/kw/sales/agents/seller.md": "# a"
  });
  const r = await readPluginInventory(home);
  assert.deepEqual(r.mcpServers.sort(), ["hud", "serena"]);
  assert.deepEqual(r.agents, ["tool-agent"]);
  assert.deepEqual(r.skills, ["tool-skill"]);
  assert.deepEqual(r.plugins, [], "no index file → no plugin names");
});

test("records without installPath (v1 shape) fall back to the walk", async () => {
  const home = await tmpProject({
    ".claude/plugins/installed_plugins.json": { version: 2, plugins: { "serena@official": [{}] } },
    ".claude/plugins/cache/official/serena/1.0.0/.mcp.json": { serena: { command: "uvx" } }
  });
  const r = await readPluginInventory(home);
  assert.deepEqual(r.plugins, ["serena"], "names still come from index keys");
  assert.deepEqual(r.mcpServers, ["serena"], "servers come from the fallback walk");
});

test("missing home, dangling installPath, junk values: empty, never throws", async () => {
  const empty = await readPluginInventory(await tmpProject({}));
  assert.deepEqual(empty, { plugins: [], skills: [], agents: [], mcpServers: [] });

  const home = await tmpProject({
    ".claude/plugins/installed_plugins.json": {
      version: 2,
      plugins: { "gone@official": [{ installPath: "/no/such/dir" }], "junk@official": "not-an-array" }
    }
  });
  const r = await readPluginInventory(home);
  assert.deepEqual(r.plugins.sort(), ["gone", "junk"]);
  assert.deepEqual(r.mcpServers, []);
  assert.deepEqual(r.agents, []);
});

test("duplicate names across install records dedupe", async () => {
  const home = await tmpProject({
    "a/serena/.mcp.json": { serena: { command: "uvx" } },
    "b/serena/.mcp.json": { serena: { command: "uvx" } }
  });
  await writeIndex(home, {
    "serena@official": [
      { installPath: join(home, "a/serena") },
      { installPath: join(home, "b/serena") }
    ]
  });
  const r = await readPluginInventory(home);
  assert.deepEqual(r.mcpServers, ["serena"]);
  assert.deepEqual(r.plugins, ["serena"]);
});

test("mixed index: any installPath switches to primary-only (pathless siblings not walked)", async () => {
  const home = await tmpProject({
    "install/withpath/.mcp.json": { withpath: { command: "node" } },
    ".claude/plugins/cache/official/nopath/1.0.0/.mcp.json": { nopath: { command: "node" } }
  });
  await writeIndex(home, {
    "withpath@official": [{ installPath: join(home, "install/withpath") }],
    "nopath@official": [{}]
  });
  const r = await readPluginInventory(home);
  assert.deepEqual(r.plugins.sort(), ["nopath", "withpath"], "both names reported");
  assert.deepEqual(r.mcpServers, ["withpath"], "accepted limitation: pathless sibling's cache dir is not walked");
});

test("empty v2 index: nothing installed, stale cache is NOT walked", async () => {
  const home = await tmpProject({
    ".claude/plugins/installed_plugins.json": { version: 2, plugins: {} },
    ".claude/plugins/cache/official/stale-plugin/9.9.9/.mcp.json": { staleServer: { command: "node" } }
  });
  const r = await readPluginInventory(home);
  assert.deepEqual(r, { plugins: [], skills: [], agents: [], mcpServers: [] });
});

test("array-valued bare-map .mcp.json entries are not servers", async () => {
  const home = await tmpProject({
    "install/x/.mcp.json": { weird: [1, 2, 3], real: { command: "node" } }
  });
  await writeIndex(home, { "x@local": [{ installPath: join(home, "install/x") }] });
  const r = await readPluginInventory(home);
  assert.deepEqual(r.mcpServers, ["real"]);
});

// ---------------------------------------------------------------------------
// installedSkillDescription: the plugins-lane skill-description lookup used
// by capabilities.js's skills inventory (see capabilities.test.js for the
// SKILL.md-frontmatter-parsing regression coverage).
// ---------------------------------------------------------------------------

test("installedSkillDescription resolves via installed_plugins.json's installPath, not directory-order (which would hit a stale cached version first)", async () => {
  const home = await tmpProject({
    // Directory order would hit 0.2.4 before 0.4.0 (lexical order), which is
    // exactly the live bug: a name-only walk returned muster 0.2.4 (stale)
    // instead of the actually-installed 0.4.0.
    ".claude/plugins/cache/official/thing/0.2.4/skills/my-skill/SKILL.md":
      "---\ndescription: stale v0.2.4 description\n---\n",
    ".claude/plugins/cache/official/thing/0.4.0/skills/my-skill/SKILL.md":
      "---\ndescription: current v0.4.0 description\n---\n"
  });
  await writeIndex(home, {
    "thing@official": [{ installPath: join(home, ".claude/plugins/cache/official/thing/0.4.0") }]
  });
  assert.equal(installedSkillDescription(home, "my-skill"), "current v0.4.0 description");
});

test("installedSkillDescription: a shared cache reads each plugins directory at most once across multiple skill lookups", async () => {
  const home = await tmpProject({
    // No installed_plugins.json here -- forces the bounded fallback walk, the
    // path the perf finding was about.
    ".claude/plugins/cache/official/plugin-a/1.0.0/skills/skill-a/SKILL.md": "---\ndescription: a\n---\n",
    ".claude/plugins/cache/official/plugin-b/1.0.0/skills/skill-b/SKILL.md": "---\ndescription: b\n---\n"
  });
  const cache = {};
  assert.equal(installedSkillDescription(home, "skill-a", cache), "a");
  const officialDir = join(home, ".claude/plugins/cache/official");
  const listingAfterFirst = cache.dirs && cache.dirs.get(officialDir);
  assert.ok(listingAfterFirst, "shared cache must record the directory listing it already read");

  assert.equal(installedSkillDescription(home, "skill-b", cache), "b");
  const listingAfterSecond = cache.dirs.get(officialDir);
  assert.equal(
    listingAfterSecond,
    listingAfterFirst,
    "second lookup must reuse the cached listing (same reference), not re-read the directory"
  );
});
