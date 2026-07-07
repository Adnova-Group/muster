import { join, dirname } from "node:path";
import { readFileSync, readdirSync, existsSync, lstatSync } from "node:fs";
import { lstat } from "node:fs/promises";
import { readJson, readdirSafe } from "./fs-util.js";

// True when `p` is itself a symlink. lstat (unlike stat/existsSync/readFile,
// which all follow the final path component) reports on the link itself, so
// this is the one check that can veto reading or recursing through it. A
// missing/unreadable path reports false — the caller's own subsequent
// read/stat already fail-soft on absence; this only needs to veto genuine
// symlinks, not paper over other lstat failures.
async function isSymlink(p) {
  try { return (await lstat(p)).isSymbolicLink(); }
  catch { return false; }
}
function isSymlinkSync(p) {
  try { return lstatSync(p).isSymbolicLink(); }
  catch { return false; }
}

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
      if (cfg && typeof cfg === "object" && !Array.isArray(cfg)) names.push(name);
    }
  }
  const pj = await readJson(join(root, ".claude-plugin/plugin.json"));
  if (pj && pj.mcpServers && typeof pj.mcpServers === "object" && !Array.isArray(pj.mcpServers)) {
    names.push(...Object.keys(pj.mcpServers));
  }
  return names;
}

// Agent names (sans .md) from <root>/agents/. A symlinked agents/ dir is
// rejected before it's ever listed — a malicious plugin's own repo content
// can ship "agents" as a symlink just as easily as "skills" below.
async function agentsFromPluginRoot(root) {
  const agentsDir = join(root, "agents");
  if (await isSymlink(agentsDir)) return [];
  return (await readdirSafe(agentsDir))
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.slice(0, -3));
}

// Skill names from <root>/skills/<name>/SKILL.md — the directory name is the
// skill name. Every level of this fixed 3-deep shape (the skills/ dir
// itself, the per-skill name dir, and the terminal SKILL.md) is rejected
// when symlinked, not just the last one listed-and-trusted: a malicious
// plugin could point any of the three outside its own root (e.g. a whole
// skill dir, or even skills/ itself, symlinked at some unrelated directory
// that happens to contain a real, non-symlink SKILL.md — lstat only
// inspects the FINAL path component, so checking just the file, or just one
// directory up, misses a symlink planted at the other levels) to get a
// bogus skill registered from content it never actually shipped.
async function skillsFromPluginRoot(root) {
  const found = [];
  const skillsDir = join(root, "skills");
  if (await isSymlink(skillsDir)) return found;
  for (const name of await readdirSafe(skillsDir)) {
    const skillDir = join(skillsDir, name);
    if (await isSymlink(skillDir)) continue;
    const skillMd = join(skillDir, "SKILL.md");
    if ((await readdirSafe(skillDir)).includes("SKILL.md") && !(await isSymlink(skillMd))) {
      found.push(name);
    }
  }
  return found;
}

// Extracts the `description:` field from a SKILL.md's YAML frontmatter (the
// block between the first pair of `---` lines). resolveCapabilities
// (src/capabilities.js) is synchronous — it's reused by several un-awaited
// call sites in cli.js — so the skills-inventory description lookup can't
// route through this module's async readJson/readdirSafe helpers. Kept
// fail-soft like the rest of this file: a missing file or absent frontmatter
// degrades to "" rather than throwing.
//
// Deliberately NOT a full YAML parse: a plain scalar `description:` value is
// legitimately allowed to contain a mid-string ": " (e.g. muster's own
// router/orchestrator SKILL.md read "... Glass-box: every choice ..."), and
// that reads as a nested flow-mapping to a strict parser, which throws. A
// targeted line extraction sidesteps that entirely — this only ever needs a
// single scalar value, never the rest of the frontmatter's structure.
function descriptionFromSkillMdSync(path) {
  // `path` always has the fixed 3-deep shape <root>/skills/<name>/SKILL.md
  // (root being home/.claude/skills, an installPath, or a walked plugin
  // dir). Any of its 3 components below root -- the skills/ segment itself,
  // the per-skill name dir, or the terminal SKILL.md -- can be a symlink
  // planted by a malicious plugin's own repo content, pointing outside its
  // root; readFileSync/existsSync all follow every one of them. lstat only
  // inspects the FINAL component of whatever path it's given, so checking
  // `path` alone (or even just one level up) missed the skills/ segment
  // itself being the symlink -- a live-caught gap. All 3 fixed levels are
  // checked here, the one choke point both of this function's callers (the
  // direct home/.claude/skills check and findSkillMdSync's returned
  // candidate, from either its installPath or walk lane) funnel through.
  if (isSymlinkSync(path) || isSymlinkSync(dirname(path)) || isSymlinkSync(dirname(dirname(path)))) return "";
  let text;
  try { text = readFileSync(path, "utf8"); } catch { return ""; }
  const fm = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!fm) return "";
  const lines = fm[1].split(/\r?\n/);
  const descLine = lines.find((l) => /^description:/.test(l));
  if (descLine === undefined) return "";
  let value = descLine.slice("description:".length).trim();
  // Block scalar indicator (`|` literal or `>` folded, optional chomping
  // modifier) with no inline value: the real content is the indented lines
  // that follow. Degrade to just the first of those rather than reproducing
  // YAML's block-scalar joining/indentation rules.
  if (/^[|>][-+]?\d*$/.test(value)) {
    const first = lines.slice(lines.indexOf(descLine) + 1).find((l) => l.trim() !== "");
    return first ? first.trim() : "";
  }
  // Strip one layer of matching surrounding quotes.
  if (value.length >= 2) {
    const first = value[0], last = value[value.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      value = value.slice(1, -1);
    }
  }
  return value;
}

// Synchronous, cached directory listing. `cache.dirs` maps an absolute
// directory path to its Dirent[] listing (or [] when unreadable) so a cache
// object shared across many findSkillMdSync calls — one resolveCapabilities
// call covers every currently-installed skill name — reads each directory at
// most once instead of re-walking the whole plugins tree from scratch per
// skill name. `cache` is a plain object owned by the caller (ultimately
// resolveCapabilities); there is no module-level shared state.
function readdirSyncCached(dir, cache) {
  if (!cache.dirs) cache.dirs = new Map();
  if (cache.dirs.has(dir)) return cache.dirs.get(dir);
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { entries = []; }
  cache.dirs.set(dir, entries);
  return entries;
}

// Synchronously reads installed_plugins.json's installPath records straight
// off disk (this whole lookup path must stay synchronous — see
// descriptionFromSkillMdSync's note above, this module's async readJson
// can't be used here). Cached on `cache.installPaths` so a shared cache
// parses the index at most once. Mirrors readPluginInventory's own v2-shape
// handling; fail-soft like the rest of this file.
function installPathsFromIndexSync(pluginsBase, cache) {
  if (cache.installPaths) return cache.installPaths;
  let index = null;
  try { index = JSON.parse(readFileSync(join(pluginsBase, "installed_plugins.json"), "utf8")); } catch { index = null; }
  const paths = [];
  if (index && index.plugins && typeof index.plugins === "object" && !Array.isArray(index.plugins)) {
    for (const recs of Object.values(index.plugins)) {
      for (const rec of Array.isArray(recs) ? recs : []) {
        if (rec && typeof rec.installPath === "string") paths.push(rec.installPath);
      }
    }
  }
  cache.installPaths = paths;
  return paths;
}

// Search for <base>/**/skills/<name>/SKILL.md. Resolves via
// installed_plugins.json's authoritative installPath records first — the
// plugins/cache/ dir holds every version ever installed, stale ones
// included, and a name-only directory-order walk can hit a stale one before
// the actually-installed version (live-observed: an old cached 0.2.4 instead
// of the active 0.4.0). Only falls back to the depth-limited walk (mirrors
// walkFallback's shape: never descends into a top-level marketplaces/ —
// that lists what a marketplace OFFERS, not what's installed) when the
// index lookup misses — no index, or none of its installPaths ship this
// skill. `cache` is threaded down from the caller (see readdirSyncCached /
// installPathsFromIndexSync above) so repeated lookups for different skill
// names share one walk.
function findSkillMdSync(base, name, maxDepth = 4, cache = {}) {
  for (const installPath of installPathsFromIndexSync(base, cache)) {
    const candidate = join(installPath, "skills", name, "SKILL.md");
    if (existsSync(candidate)) return candidate;
  }

  function walk(dir, depth, atBase) {
    const entries = readdirSyncCached(dir, cache);
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (atBase && entry.name === "marketplaces") continue;
      if (entry.name === "skills") {
        const candidate = join(dir, "skills", name, "SKILL.md");
        if (existsSync(candidate)) return candidate;
        continue;
      }
      if (depth < maxDepth) {
        const found = walk(join(dir, entry.name), depth + 1, false);
        if (found) return found;
      }
    }
    return null;
  }
  return walk(base, 0, true);
}

// Synchronous description lookup for an already-known installed skill name
// (the caller — resolveCapabilities — already has the authoritative name via
// `installed.skills`; this only needs to locate its SKILL.md and parse the
// description). Checks <home>/.claude/skills/<name>/SKILL.md first (the
// harness.js own-skills lane), then falls back to findSkillMdSync (installed
// _plugins.json installPath resolution, then a depth-limited walk).
// Fail-soft: "" when nothing is found or unreadable. `cache` is optional —
// a fresh call site gets its own one-shot cache — but resolveCapabilities
// passes one shared object through its whole skills-inventory loop so the
// underlying plugins-tree walk happens at most once per directory, however
// many installed skill names it looks up.
export function installedSkillDescription(home, name, cache = {}) {
  const direct = join(home, ".claude/skills", name, "SKILL.md");
  if (existsSync(direct)) return descriptionFromSkillMdSync(direct);
  const found = findSkillMdSync(join(home, ".claude/plugins"), name, 4, cache);
  return found ? descriptionFromSkillMdSync(found) : "";
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
      // A malicious plugin can ship a symlinked directory (e.g. evil ->
      // $HOME) to escape its own root; plain readdir/recursion follows it
      // and would walk the target system-wide. lstat (which does NOT follow
      // the final symlink, unlike readdir) vetoes descending into one —
      // checked before the agents/skills special-cases too, since either of
      // those names could itself be the symlink.
      if (await isSymlink(join(dir, entry))) continue;
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
  const hasIndex = !!(index && index.plugins && typeof index.plugins === "object" && !Array.isArray(index.plugins));
  const keys = hasIndex ? Object.keys(index.plugins) : [];
  const roots = [];
  for (const key of keys) {
    plugins.push(pluginName(key));
    for (const rec of Array.isArray(index.plugins[key]) ? index.plugins[key] : []) {
      if (rec && typeof rec.installPath === "string") roots.push(rec.installPath);
    }
  }

  if (roots.length) {
    // Primary path: at least one installPath is known. Documented all-or-nothing —
    // a mixed index (some records with installPath, some without) takes this path
    // only; pathless siblings' names are still reported but their contents (agents/
    // skills/mcpServers) are not scanned (accepted limitation, pinned by test).
    for (const root of roots) {
      agents.push(...await agentsFromPluginRoot(root));
      skills.push(...await skillsFromPluginRoot(root));
      mcpServers.push(...await serversFromPluginRoot(root));
    }
  } else if (!hasIndex || keys.length) {
    // No index at all, or a v1-shaped index (keys but no installPath anywhere):
    // best-effort walk. An index with ZERO keys skips this — it affirmatively
    // says nothing is installed, and walking would resurrect stale cache dirs.
    await walkFallback(base, 4, { agents, skills, mcpServers });
  }

  return {
    plugins: [...new Set(plugins)],
    skills: [...new Set(skills)],
    agents: [...new Set(agents)],
    mcpServers: [...new Set(mcpServers)]
  };
}
