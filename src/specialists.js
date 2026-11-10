// The plugin's dispatchable specialists and bundled skills, read synchronously from the
// catalog, plugin/agents/ and plugin/builtins/ (revival stage 3: wire the rebuild's dropped
// breadth back in). One source for preflight's candidates, plan-lint's catalog check,
// build-args' agentType/skill paths and pipeline-args' phase bindings.
//
// The Workflow agentType of a plugin agent is `muster:<frontmatter name>`, which is not the
// catalog id for the vendored wshobson agents (wsh-debugger -> debugging-toolkit-debugger),
// so the type is resolved here from the agent file instead of being spelled from the id.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { matchFrontmatter } from "./frontmatter.js";
import { agentProfiles } from "./agent-manifest.js";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
// Source tree and npm package: <root>/plugin. The bundled plugin runtime runs from
// plugin/runtime/cli/bin/, so ROOT is plugin/runtime/cli/ and the plugin is two levels up.
export const PLUGIN_ROOT = !existsSync(join(ROOT, "plugin", "builtins")) && existsSync(join(ROOT, "..", "..", "builtins"))
  ? join(ROOT, "..", "..")
  : join(ROOT, "plugin");

// Workflow seats run their own stages; they are never a task's executor.
export const WORKFLOW_SEATS = Object.freeze(["muster-planner", "muster-plan-checker", "muster-reviewer", "muster-verifier"]);

function readFrontmatter(path) {
  try {
    const fm = matchFrontmatter(readFileSync(path, "utf8"));
    return fm ? parseYaml(fm.body) || {} : null;
  } catch {
    return null;
  }
}

function catalogEntries(catalogDir) {
  const out = [];
  for (const f of readdirSync(catalogDir).filter((n) => /\.ya?ml$/.test(n)).sort()) {
    const entries = parseYaml(readFileSync(join(catalogDir, f), "utf8")) || [];
    if (Array.isArray(entries)) out.push(...entries);
  }
  return out;
}

const cache = new Map();

// { agents: Map<id, {agentType, description, dispatchable, roles}>,
//   skills: Map<id, {path, description, roles, keywords, rank, license}> }
// Roles let project pins (src/skill-pins.js) bind a skill to the tasks of one role.
// `dispatchable` = a plugin agent that can do an executor's job: not a workflow seat, not
// declared read-only in the agent manifest, and able to run git (Bash) to commit.
export function specialistCatalog({ catalogDir = join(ROOT, "catalog"), pluginRoot = PLUGIN_ROOT } = {}) {
  const key = `${catalogDir}\0${pluginRoot}`;
  if (cache.has(key)) return cache.get(key);
  const profiles = agentProfiles();
  const agents = new Map();
  const skills = new Map();
  for (const e of catalogEntries(catalogDir)) {
    if (e.kind === "agent") {
      const file = join(pluginRoot, "agents", `${e.id}.md`);
      const fm = readFrontmatter(file);
      if (!fm || !fm.name) continue;
      const tools = String(fm.tools || "").split(/[\s,]+/);
      const dispatchable = !WORKFLOW_SEATS.includes(e.id) && !profiles[e.id]?.readOnly && tools.includes("Bash");
      agents.set(e.id, { agentType: `muster:${fm.name}`, description: String(fm.description || e.description || ""), dispatchable, roles: e.roles || [] });
    } else if (e.kind === "builtin") {
      const path = join(pluginRoot, "builtins", e.id, "SKILL.md");
      if (!existsSync(path)) continue;
      const fm = readFrontmatter(path) || {};
      skills.set(e.id, {
        path, description: String(fm.description || e.description || ""),
        roles: e.roles || [], keywords: e.keywords || [], rank: e.rank ?? 0, license: String(fm.license || e.provenance?.license || ""),
      });
    }
  }
  const result = { agents, skills };
  cache.set(key, result);
  return result;
}

// The agentType build.js dispatches for an agent_hint, or null for the default executor.
export function agentTypeFor(hint, catalog = specialistCatalog()) {
  const a = hint ? catalog.agents.get(hint) : null;
  return a && a.dispatchable ? a.agentType : null;
}

export function skillPath(id, catalog = specialistCatalog()) {
  return catalog.skills.get(id)?.path ?? null;
}
