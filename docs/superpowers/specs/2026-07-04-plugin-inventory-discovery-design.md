# Plugin-aware discovery for both harness adapters

**Date:** 2026-07-04
**Status:** Approved

## Problem

`readInstalledCowork` (src/harness.js) discovers providers only from Cowork's own
registry: `claude_desktop_config.json` mcpServers plus MCPB/DXT extensions. It
returns empty `plugins`/`skills`/`agents` lanes on the assumption that "Cowork has
no Claude Code plugins." That assumption is false in practice — Cowork sessions
load Claude Code plugins from `~/.claude/plugins`, including plugin-shipped MCP
servers. Observed result: `muster capabilities --cowork` resolves code-navigation,
browser-control, and refactor to built-in fallbacks even though serena, playwright,
and code-simplifier are installed as plugins.

The Claude Code adapter (`readInstalled`) has a milder version of the same gap:

- It never reads plugin-shipped MCP server declarations (`.mcp.json`). It only
  works for serena/playwright today because the plugin name happens to equal the
  server name, so `isInstalled`'s cross-lane match saves it.
- Its skill/agent collection blanket-walks all of `~/.claude/plugins`, which
  includes `marketplaces/` — every plugin a marketplace *offers*, not just what is
  installed — so it can over-report availability.

Also outdated: the harness.js comment claiming `installed_plugins.json` records no
filesystem path per plugin. The v2 format records `installPath` per install.

## Decision summary

- **Scope:** Cowork discovery sees all plugin lanes (plugins, skills, agents, and
  plugin-shipped MCP servers), not just MCP servers. An agents-only plugin like
  code-simplifier must resolve.
- **Precision:** discovery is driven by `installed_plugins.json` v2 `installPath`
  entries, so only actually-installed plugins are reported. Fallback walk is
  restricted to `~/.claude/plugins/cache/` (never `marketplaces/`).
- **Both adapters share one scanner** so the code path is tested once and server
  names match even when they differ from the plugin name.
- **Structure:** the scanner is a new small module, `src/plugin-inventory.js`,
  matching muster's focused-module style. Composing Cowork on top of
  `readInstalled` was rejected: it would drag `~/.claude/settings.json` servers and
  personal `~/.claude/skills` into Cowork's registry view, which Cowork does not
  load.

## Component: `src/plugin-inventory.js`

Exports `readPluginInventory(home)` returning `{plugins, skills, agents,
mcpServers}`, each an array of deduped names.

Primary path — read `<home>/.claude/plugins/installed_plugins.json`:

- Plugin names come from the keys (`name@marketplace` → name, existing
  `pluginName` convention). Values are arrays of install records (v2).
- For each record with an `installPath`, collect from that directory:
  - **agents:** `agents/*.md` → filename sans `.md`.
  - **skills:** `skills/<name>/SKILL.md` → directory name.
  - **MCP servers:**
    - `.mcp.json` at plugin root, in both wild formats: wrapped
      (`{"mcpServers": {name: {...}}}` — e.g. figma) and bare map
      (`{name: {...}}` — e.g. serena, playwright). If a top-level `mcpServers`
      key holds an object, use its keys; otherwise use the top-level keys whose
      values are objects.
    - `.claude-plugin/plugin.json` `mcpServers` field when it is an inline
      object (keys are server names). A string-path form, if encountered, is
      ignored rather than chased.

Fallback path — when `installed_plugins.json` is missing, unparseable, or no
record carries an `installPath` (v1 format): depth-limited walk (existing
`walkForSubdir` machinery, which moves into this module) rooted at
`<home>/.claude/plugins/`, skipping the top-level `marketplaces/` entry — that
is the offered-but-not-installed trap. The walk covers both the shallow
`plugins/<plugin>/` layout (real: locally-developed plugins like claude-hud)
and the deep `plugins/cache/<marketplace>/<plugin>/<version>/` layout,
collecting the same three kinds. For MCP servers, any directory within the
depth limit that contains a `.mcp.json` or `.claude-plugin/` is treated as a
plugin root and parsed with the same two-format logic. An index that is
present and valid but declares zero plugins short-circuits to an empty result
— no walk (the index affirmatively says nothing is installed). A mixed index
where some records carry installPath and others do not takes the primary path
only; the pathless plugin's name is still reported but its contents are not
scanned (accepted limitation, pinned by test).

Error handling: fail-soft throughout, consistent with `readdirSafe`/`readJson`.
Any missing or unreadable file/dir contributes nothing. The function never throws.

## Adapter integration (src/harness.js)

- `readInstalled` drops its own `collectPluginAgents`/`collectPluginSkills` calls
  and merges `readPluginInventory(home)` into its lanes. Unchanged: plugins from
  `installed_plugins.json` keys (now via the inventory), `~/.claude/settings.json`
  mcpServers, personal `~/.claude/skills` and `~/.claude/agents` dirs.
- `readInstalledCowork` merges the same inventory on top of its existing
  Cowork-registry discovery (`claude_desktop_config.json` + Claude Extensions +
  declared connectors). The "Cowork has no Claude Code plugins/skills/agents"
  comment is rewritten to reflect reality. `connectorsDiscoverable` stays `false`
  — that flag is about remote connectors, which remain non-discoverable.
- The stale "installed_plugins.json records NO filesystem path" comment is
  corrected.

Net effect: `muster capabilities --cowork` resolves serena/playwright via the
mcpServers lane (and plugin names), and code-simplifier via the plugins/agents
lanes.

## Out of scope

- Per-project scope filtering. `installed_plugins.json` records
  `scope: "project"` + `projectPath`; muster continues to treat any installed
  plugin as available regardless of cwd, as it does today.
- Remote connectors (still declared, never discovered).
- MCPB/Claude Extensions handling (unchanged).
- Following string-path `mcpServers` references out of plugin.json.

## Testing

- New `test/plugin-inventory.test.js` with tmpdir fixtures:
  - v2 file with installPaths covering: bare-map `.mcp.json`, wrapped
    `.mcp.json`, plugin.json inline `mcpServers`, and an agents-only plugin
    (code-simplifier shape).
  - Fallback when the file is absent: `cache/` is walked, `marketplaces/` is
    ignored.
  - Malformed JSON and dangling installPaths tolerated (empty result, no throw).
- `test/harness-cowork.test.js`: the "no plugin/skill/agent lanes in Cowork"
  assertion inverts — a fixture home with an installed plugin shows up in Cowork
  lanes. Existing registry/connector tests unchanged.
- `test/harness.test.js` (if present) updated for the shared-scanner merge.
- Full suite must pass.
