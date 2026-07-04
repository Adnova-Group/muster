# Plugin Inventory Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both harness adapters (`readInstalled`, `readInstalledCowork`) discover Claude Code plugins — names, agents, skills, and plugin-shipped MCP servers — via a shared installPath-driven scanner, so roles resolve to installed plugin providers instead of built-in fallbacks.

**Architecture:** New focused module `src/plugin-inventory.js` exports `readPluginInventory(home)`. Primary path reads `installed_plugins.json` v2 and scans each recorded `installPath`; fallback is a depth-limited walk of `~/.claude/plugins` that skips `marketplaces/`. Both adapters in `src/harness.js` merge the inventory into their lanes. Spec: `docs/superpowers/specs/2026-07-04-plugin-inventory-discovery-design.md`.

**Tech Stack:** Node ESM, `node:test` + `node:assert/strict`, no dependencies. Test helper: `tmpProject` from `test-support/helpers.js` (builds a tmpdir from a `{relPath: content}` map; object content is JSON-stringified).

## Global Constraints

- Fail-soft discovery: any missing/unreadable file or dir contributes nothing; discovery functions never throw (matches `readdirSafe`/`readJson` posture in this repo).
- No new dependencies. Plain JS, ESM imports, no TypeScript.
- `.mcp.json` parsing must accept BOTH wild formats: wrapped `{"mcpServers": {name: cfg}}` (figma) and bare map `{name: cfg}` (serena, playwright).
- `plugin.json` `mcpServers` counts only when it is an inline object; a string path form is ignored, never chased.
- The fallback walk never enters the top-level `marketplaces/` entry (offered ≠ installed).
- All returned arrays are deduped (`[...new Set(...)]`).
- `readInstalledCowork` keeps `connectorsDiscoverable: false` and the declared-connectors contract unchanged.
- Test runner: `npm test` runs `node --test`. Single file: `node --test test/<file>.test.js`.
- Commit after every green task, message style `feat|fix|docs|test(scope): summary`, with the trailer:
  `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>` and
  `Claude-Session: https://claude.ai/code/session_015r21wTE1asb9soEWFg11qb`

---

### Task 1: `readdirSafe` moves to fs-util + `src/plugin-inventory.js` scanner

**Files:**
- Modify: `src/fs-util.js` (add `readdir` import + `readdirSafe` export)
- Create: `src/plugin-inventory.js`
- Test: `test/plugin-inventory.test.js`

**Interfaces:**
- Consumes: `readJson(path) -> object|null` from `src/fs-util.js` (absent/unreadable → null silently; invalid JSON → stderr warning + null).
- Produces: `readPluginInventory(home) -> Promise<{plugins: string[], skills: string[], agents: string[], mcpServers: string[]}>` (all deduped, never throws) from `src/plugin-inventory.js`; `readdirSafe(path) -> Promise<string[]>` from `src/fs-util.js`. Task 2 and Task 3 import both.

- [ ] **Step 1: Write the failing tests**

Create `test/plugin-inventory.test.js` with exactly:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpProject } from "../test-support/helpers.js";
import { readPluginInventory } from "../src/plugin-inventory.js";

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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --test test/plugin-inventory.test.js`
Expected: FAIL — `Cannot find module '.../src/plugin-inventory.js'` (ERR_MODULE_NOT_FOUND).

- [ ] **Step 3: Add `readdirSafe` to fs-util**

In `src/fs-util.js`, change the first line from:

```js
import { readFile, stat } from "node:fs/promises";
```

to:

```js
import { readdir, readFile, stat } from "node:fs/promises";
```

and append at the end of the file:

```js
// Directory listing with graceful degradation: a missing dir, a plain file, or
// any unreadable path lists as empty rather than throwing.
export async function readdirSafe(p) {
  try { return await readdir(p); } catch { return []; }
}
```

- [ ] **Step 4: Write `src/plugin-inventory.js`**

Create the file with exactly:

```js
import { join } from "node:path";
import { readJson, readdirSafe } from "./fs-util.js";

// installed_plugins.json keys are "name@marketplace".
function pluginName(key) { return key.split("@")[0]; }

// MCP server names declared by the plugin rooted at `root`. Two on-disk
// formats exist for <root>/.mcp.json: wrapped ({"mcpServers": {name: cfg}},
// e.g. figma) and a bare map ({name: cfg}, e.g. serena, playwright). A
// plugin.json `mcpServers` field counts only when it is an inline object —
// the string path form is ignored, not chased.
async function serversFromPluginRoot(root) {
  const names = [];
  const mcp = await readJson(join(root, ".mcp.json"));
  if (mcp && typeof mcp === "object" && !Array.isArray(mcp)) {
    const wrapped = mcp.mcpServers && typeof mcp.mcpServers === "object" && !Array.isArray(mcp.mcpServers);
    const map = wrapped ? mcp.mcpServers : mcp;
    for (const [name, cfg] of Object.entries(map)) {
      if (cfg && typeof cfg === "object") names.push(name);
    }
  }
  const pj = await readJson(join(root, ".claude-plugin/plugin.json"));
  if (pj && pj.mcpServers && typeof pj.mcpServers === "object" && !Array.isArray(pj.mcpServers)) {
    names.push(...Object.keys(pj.mcpServers));
  }
  return names;
}

// Agent names (sans .md) from <root>/agents/.
async function agentsFromPluginRoot(root) {
  return (await readdirSafe(join(root, "agents")))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

// Skill names from <root>/skills/<name>/SKILL.md — the directory name is the
// skill name.
async function skillsFromPluginRoot(root) {
  const found = [];
  const skillsDir = join(root, "skills");
  for (const name of await readdirSafe(skillsDir)) {
    if ((await readdirSafe(join(skillsDir, name))).includes("SKILL.md")) found.push(name);
  }
  return found;
}

// Fallback for installs that record no installPath (v1 index shape) or no
// installed_plugins.json at all: depth-limited walk of ~/.claude/plugins,
// covering both the shallow plugins/<plugin>/ layout and the deep
// plugins/cache/<marketplace>/<plugin>/<version>/ layout. The top-level
// marketplaces/ entry is never walked — it holds every plugin a marketplace
// OFFERS, not what is installed. Any dir containing .mcp.json or
// .claude-plugin/ is treated as a plugin root for server collection.
// readdirSafe returns [] for files, so leaf entries terminate naturally.
async function walkFallback(base, maxDepth, out) {
  async function walk(dir, depth, atBase) {
    if (depth > maxDepth) return;
    const entries = await readdirSafe(dir);
    if (entries.includes(".mcp.json") || entries.includes(".claude-plugin")) {
      out.mcpServers.push(...await serversFromPluginRoot(dir));
    }
    for (const entry of entries) {
      if (atBase && entry === "marketplaces") continue;
      if (entry === "agents") { out.agents.push(...await agentsFromPluginRoot(dir)); continue; }
      if (entry === "skills") { out.skills.push(...await skillsFromPluginRoot(dir)); continue; }
      await walk(join(dir, entry), depth + 1, false);
    }
  }
  await walk(base, 0, true);
}

// Inventory of installed Claude Code plugins under <home>/.claude/plugins:
// plugin names plus the agents, skills, and MCP servers those plugins ship.
// Driven by installed_plugins.json v2 installPath records so only
// actually-installed plugins are reported (the cache also holds stale
// versions, and marketplaces/ holds offered-not-installed plugins).
// Fail-soft throughout: any missing or unreadable file/dir contributes
// nothing; never throws.
export async function readPluginInventory(home) {
  const base = join(home, ".claude/plugins");
  const plugins = [], skills = [], agents = [], mcpServers = [];

  const index = await readJson(join(base, "installed_plugins.json"));
  const roots = [];
  if (index && index.plugins) {
    for (const [key, records] of Object.entries(index.plugins)) {
      plugins.push(pluginName(key));
      for (const rec of Array.isArray(records) ? records : []) {
        if (rec && typeof rec.installPath === "string") roots.push(rec.installPath);
      }
    }
  }

  if (roots.length) {
    for (const root of roots) {
      agents.push(...await agentsFromPluginRoot(root));
      skills.push(...await skillsFromPluginRoot(root));
      mcpServers.push(...await serversFromPluginRoot(root));
    }
  } else {
    await walkFallback(base, 4, { agents, skills, mcpServers });
  }

  return {
    plugins: [...new Set(plugins)],
    skills: [...new Set(skills)],
    agents: [...new Set(agents)],
    mcpServers: [...new Set(mcpServers)]
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `node --test test/plugin-inventory.test.js`
Expected: PASS, 6/6. Note: the junk-values test intentionally triggers no stderr warning (the index IS valid JSON); no warnings expected.

- [ ] **Step 6: Run the full suite (nothing else should move yet)**

Run: `npm test`
Expected: PASS — no existing file imports the new module yet.

- [ ] **Step 7: Commit**

```bash
git add src/fs-util.js src/plugin-inventory.js test/plugin-inventory.test.js
git commit -m "feat(discovery): plugin inventory scanner — installPath-driven with cache-walk fallback"
```

(with the standard trailer from Global Constraints)

---

### Task 2: `readInstalled` merges the inventory

**Files:**
- Modify: `src/harness.js` (delete `pluginName`, `readdirSafe`, `walkForSubdir`, `collectPluginAgents`, `collectPluginSkills`; rewrite `readInstalled`)
- Test: `test/harness.test.js` (one new test; all 11 existing tests must keep passing unchanged)

**Interfaces:**
- Consumes: `readPluginInventory(home)` and `readdirSafe(p)` from Task 1.
- Produces: `readInstalled(home) -> Promise<{plugins, skills, mcpServers, agents}>` — same shape as today, now including plugin-shipped MCP servers. Task 3 relies on `readPluginInventory` being the single scanner.

- [ ] **Step 1: Write the failing test**

Append to `test/harness.test.js` (also add `import { writeFile, mkdir } from "node:fs/promises";` and `import { join, dirname } from "node:path";` to the imports at the top):

```js
test("merges plugin-shipped mcp servers via installPath records", async () => {
  const home = await tmpProject({
    "install/serena/.mcp.json": { serena: { command: "uvx" } },
    ".claude/settings.json": { mcpServers: { context7: {} } }
  });
  const idx = join(home, ".claude/plugins/installed_plugins.json");
  await mkdir(dirname(idx), { recursive: true });
  await writeFile(idx, JSON.stringify({
    version: 2, plugins: { "serena@official": [{ installPath: join(home, "install/serena") }] }
  }));
  const r = await readInstalled(home);
  assert.deepEqual(r.mcpServers.sort(), ["context7", "serena"]);
  assert.deepEqual(r.plugins, ["serena"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/harness.test.js`
Expected: 1 FAIL — `merges plugin-shipped mcp servers via installPath records` (mcpServers is `["context7"]`, missing `serena`). The 11 pre-existing tests PASS.

- [ ] **Step 3: Rewrite harness.js top section and `readInstalled`**

In `src/harness.js`, replace everything from line 1 down to (but not including) the `// --- Claude Cowork adapter ---` comment block — i.e. the imports, `pluginName`, `readdirSafe`, `walkForSubdir`, `collectPluginAgents`, `collectPluginSkills` — with:

```js
import { join } from "node:path";
import { readJson, readdirSafe } from "./fs-util.js";
import { readPluginInventory } from "./plugin-inventory.js";
```

Then replace the entire `readInstalled` function (currently the last function in the file) with:

```js
export async function readInstalled(home) {
  // Installed Claude Code plugins: names + the agents/skills/MCP servers they
  // ship (installPath-driven, see plugin-inventory.js).
  const inv = await readPluginInventory(home);

  const mcpServers = [...inv.mcpServers];
  const settings = await readJson(join(home, ".claude/settings.json"));
  if (settings && settings.mcpServers) mcpServers.push(...Object.keys(settings.mcpServers));

  const skills = [...inv.skills];
  for (const name of await readdirSafe(join(home, ".claude/skills"))) {
    const entries = await readdirSafe(join(home, ".claude/skills", name));
    if (entries.includes("SKILL.md")) skills.push(name);
  }

  const agents = [...inv.agents];
  for (const f of await readdirSafe(join(home, ".claude/agents"))) {
    if (f.endsWith(".md")) agents.push(f.slice(0, -3));
  }

  return {
    plugins: inv.plugins,
    skills: [...new Set(skills)],
    mcpServers: [...new Set(mcpServers)],
    agents: [...new Set(agents)]
  };
}
```

Note: the old `import { readdir } from "node:fs/promises";` is gone — everything now goes through `readdirSafe`. Verify no remaining reference: `grep -n "readdir\b\|walkForSubdir\|collectPlugin\|pluginName" src/harness.js` should show only `readdirSafe` usages.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/harness.test.js`
Expected: PASS, 12/12. The "merges agents/skills from installed plugin dirs" tests exercise the fallback walk (their index records carry no installPath) and must still pass.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS — `readInstalledCowork` still compiles (it uses `readJson`, `readdirSafe` via `readExtensionNames`, both still imported/defined). If `readExtensionNames` fails on the removed local `readdirSafe`, it now resolves to the fs-util import — confirm no duplicate-identifier error.

- [ ] **Step 6: Commit**

```bash
git add src/harness.js test/harness.test.js
git commit -m "feat(harness): readInstalled merges plugin inventory (plugin-shipped MCP servers now count)"
```

---

### Task 3: `readInstalledCowork` merges the inventory

**Files:**
- Modify: `src/harness.js` (Cowork section comment + `readInstalledCowork`)
- Test: `test/harness-cowork.test.js`

**Interfaces:**
- Consumes: `readPluginInventory(home)` from Task 1.
- Produces: `readInstalledCowork(home, opts)` — same return shape, but `plugins`/`skills`/`agents` lanes now populated from the plugin inventory and `mcpServers` additionally includes plugin-shipped servers. `connectorsDiscoverable`/`connectorsDeclared` unchanged.

- [ ] **Step 1: Write the failing test**

Append to `test/harness-cowork.test.js`:

```js
test("readInstalledCowork: merges Claude Code plugin inventory into all lanes", async () => {
  const home = fixture((d) => {
    const install = path.join(d, ".claude/plugins/cache/official/serena/1.0.0");
    mkdirSync(path.join(install, "agents"), { recursive: true });
    writeFileSync(path.join(install, ".mcp.json"), JSON.stringify({ serena: { command: "uvx" } }));
    writeFileSync(path.join(install, "agents/serena-agent.md"), "# serena agent");
    writeFileSync(path.join(d, ".claude/plugins/installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "serena@official": [{ installPath: install }] }
    }));
  });
  const cfg = fixture((d) => {
    writeFileSync(path.join(d, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { foo: {} } }));
  });
  try {
    const r = await readInstalledCowork(home, { dir: cfg });
    assert.deepEqual(r.mcpServers.sort(), ["foo", "serena"], "registry + plugin servers merge");
    assert.deepEqual(r.plugins, ["serena"], "plugin lane populated");
    assert.deepEqual(r.agents, ["serena-agent"], "agent lane populated");
    assert.equal(r.connectorsDiscoverable, false, "connector contract unchanged");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});
```

Also update the stale assertion message in the existing "reads local mcpServers and enumerates Claude Extensions" test — that test passes `"/ignored"` as home (no plugins exist there), so the lanes are empty for that reason, not because Cowork can't have plugins. Change:

```js
    assert.deepEqual([r.plugins, r.skills, r.agents], [[], [], []], "no plugin/skill/agent lanes in Cowork");
```

to:

```js
    assert.deepEqual([r.plugins, r.skills, r.agents], [[], [], []], "no plugins installed in this fixture home");
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/harness-cowork.test.js`
Expected: 1 FAIL — the new test (`r.mcpServers` is `["foo"]`, `r.plugins` is `[]`). The 6 pre-existing tests PASS.

- [ ] **Step 3: Merge the inventory in `readInstalledCowork`**

In `src/harness.js`, replace the Cowork section header comment:

```js
// --- Claude Cowork adapter ----------------------------------------------------
// Cowork extends only through MCP: local MCP servers (claude_desktop_config.json),
// MCPB/DXT desktop extensions (a Claude Extensions/ dir, no index file), and remote
// connectors (cloud/account state, NOT on disk). See memory cowork-connector-storage.
```

with:

```js
// --- Claude Cowork adapter ----------------------------------------------------
// Cowork's own registry extends through MCP: local MCP servers
// (claude_desktop_config.json), MCPB/DXT desktop extensions (a Claude
// Extensions/ dir, no index file), and remote connectors (cloud/account state,
// NOT on disk — see memory cowork-connector-storage). Cowork sessions ALSO
// load Claude Code plugins from ~/.claude/plugins, so the plugin inventory
// (plugin-shipped MCP servers, agents, skills) merges into every lane.
```

Replace the `readInstalledCowork` doc comment (the three lines starting `// Cowork-flavored readInstalled:`) with:

```js
// Cowork-flavored readInstalled: same {plugins, skills, mcpServers, agents} shape
// resolveCapabilities consumes. Cowork registry discovery (local servers +
// extensions) fills mcpServers; the Claude Code plugin inventory fills every
// lane. Remote connectors cannot be discovered (connectorsDiscoverable:false)
// and must be DECLARED.
```

And replace the function's return (and add the inventory read above it) so the function body after the `discovered` loop reads:

```js
  const inv = await readPluginInventory(home);

  return {
    plugins: inv.plugins,
    skills: inv.skills,
    agents: inv.agents,
    mcpServers: [...new Set([...discovered, ...inv.mcpServers, ...declaredConnectors])],
    connectorsDiscoverable: false,
    connectorsDeclared: [...new Set(declaredConnectors)]
  };
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --test test/harness-cowork.test.js`
Expected: PASS, 7/7. The `"/ignored"` and `"/no/such/home"` fixtures yield empty inventories (fail-soft), so pre-existing expectations hold.

- [ ] **Step 5: Run the full suite**

Run: `npm test`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/harness.js test/harness-cowork.test.js
git commit -m "fix(cowork): capability discovery sees Claude Code plugins — servers, agents, skills"
```

---

### Task 4: Live verification + changelog

**Files:**
- Modify: `CHANGELOG.md`

**Interfaces:**
- Consumes: the finished adapters via `src/cli.js capabilities`.
- Produces: nothing downstream; this is the end-to-end gate.

- [ ] **Step 1: Full suite, once more from clean**

Run: `npm test`
Expected: PASS, zero failures.

- [ ] **Step 2: Live smoke test against the real environment**

Run: `node src/cli.js capabilities --cowork | head -60`
Expected: code-navigation resolves to serena, browser-control to playwright, and refactor to code-simplifier (not built-in fallbacks). Also run `node src/cli.js capabilities | head -60` and confirm the same three roles resolve to the plugins there too. If the real `~/.claude/plugins` differs from expectations, inspect with `node -e "import('./src/plugin-inventory.js').then(async m => console.log(await m.readPluginInventory(process.env.HOME)))"` before concluding anything is broken.

- [ ] **Step 3: Changelog entry**

In `CHANGELOG.md`, insert directly below the intro paragraph (before `## [0.3.2]`):

```markdown
## [Unreleased]

### Fixed
- **Plugin-aware provider discovery in both harness adapters.** Capability resolution now sees installed Claude Code plugins (`~/.claude/plugins`) in Cowork as well as Claude Code: plugin-shipped MCP servers (`.mcp.json` in both wrapped and bare-map formats, plus inline `plugin.json` declarations), plugin agents, and plugin skills all count as installed providers. Roles like code-navigation (serena), browser-control (playwright), and refactor (code-simplifier) resolve to the installed plugins instead of built-in fallbacks. Discovery is driven by `installed_plugins.json` v2 `installPath` records so only actually-installed plugins are reported; the path-less fallback walk skips `marketplaces/` (offered != installed). Shared scanner: `src/plugin-inventory.js`.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md
git commit -m "docs(changelog): plugin-aware discovery entry under Unreleased"
```
