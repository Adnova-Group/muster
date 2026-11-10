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

// The exact shell prefix that runs this install's CLI, for agents and workflow briefs: `muster`
// is rarely on PATH in a user's project and CLAUDE_PLUGIN_ROOT may be unset in an agent's shell,
// so it names runtime/muster.sh by absolute path, derived from PLUGIN_ROOT like skillRoot.
// The path is double-quoted with sh's four in-quote specials escaped.
export function musterCli(pluginRoot = PLUGIN_ROOT, platform = process.platform) {
  let path = join(pluginRoot, "runtime", "muster.sh");
  if (platform === "win32") path = path.replace(/\\/g, "/");
  return `sh "${path.replace(/[\\"$`]/g, "\\$&")}"`;
}

// Workflow seats run their own stages; they are never a task's executor.
export const WORKFLOW_SEATS = Object.freeze(["muster-planner", "muster-plan-checker", "muster-reviewer", "muster-verifier", "muster-test-writer", "muster-integration-checker"]);

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

// Language-specific builtins, tagged by id. A skill with no tag is general and always fits.
// The JavaScript family covers TypeScript, Node, React, Next.js, Vue, Svelte, Tailwind and GSAP's React skill.
const LANGUAGE_PATTERNS = [
  ["python", /(^|-)python(-|$)|(^|-)django(-|$)|(^|-)fastapi(-|$)/],
  ["go", /^go-|(^|-)golang(-|$)/],
  ["javascript", /(^|-)(javascript|typescript|nodejs|node|react|nextjs|vue|svelte|tailwind|angular)(-|$)/],
  ["rust", /(^|-)rust(-|$)/],
  ["java", /(^|-)(java|kotlin|spring)(-|$)/],
  ["swift", /(^|-)(swift|swiftui|ios)(-|$)/],
];
const LANGUAGE_FAMILY = { typescript: "javascript", tsx: "javascript", jsx: "javascript", node: "javascript", kotlin: "java" };

export function skillLanguage(id) {
  for (const [language, pattern] of LANGUAGE_PATTERNS) if (pattern.test(String(id))) return language;
  return null;
}

// UI and design builtins (live e2e 2026-11-10: a CLI-only `--json` outcome was offered
// uupm-ui-ux-pro-max and emil-break-ui on description words like "empty" and "counts"). The
// families are UI by construction; the token list catches the rest by id.
const UI_SKILL = /^(?:impeccable|emil|gsap|taste|uupm|elaya|jk|intent)-|^(?:hallmark|typeui|pfd)$|(?:^|-)(?:ui|ux|frontend|css|tailwind|responsive|wcag|figma|react|nextjs|vue|svelte|angular|browser)(?:-|$)|(?:^|-)(?:canvas|frontend|landing-page)-design$|(?:^|-)design-system(?:-|$)/;
// An outcome that names a UI surface keeps the UI skills whatever the project looks like.
// Deliberately broad: a false keep costs a skill the planner ignores, a false drop costs the skill.
const UI_OUTCOME = /\b(?:ui|ux|gui|user interface|page|pages|screen|screens|component|components|css|scss|html|design|designs|frontend|front-end|layout|styling|styles?heet|theme|button|buttons|modal|dialog|form|forms|animation|animations|animate|responsive|accessibility|a11y|wcag|web ?app|website|landing|dashboard|figma|react|vue|svelte|angular|next\.js|tailwind|browser)\b/i;

export function isUiSkill(id) {
  return UI_SKILL.test(String(id));
}

export function outcomeNamesUi(outcome) {
  return UI_OUTCOME.test(String(outcome));
}

// A language-specific skill fits when the project's detected languages include its language, or the
// outcome names that language. With no detected languages (unknown stack) every skill fits.
// A UI skill also needs a UI: `projectUi: false` (the project shows none) drops it unless the
// outcome names one; `projectUi` unknown (undefined) keeps it.
export function skillFitsStack(id, languages = [], outcome = "", { projectUi } = {}) {
  if (projectUi === false && isUiSkill(id) && !outcomeNamesUi(outcome)) return false;
  const language = skillLanguage(id);
  if (!language || !languages.length) return true;
  const detected = new Set(languages.map((l) => LANGUAGE_FAMILY[String(l).toLowerCase()] || String(l).toLowerCase()));
  if (detected.has(language)) return true;
  const named = language === "javascript" ? /\b(javascript|typescript|node(\.js)?|react|next\.js|vue|svelte|tailwind)\b/i
    : language === "go" ? /\b(go|golang)\b/i : new RegExp(`\\b${language}\\b`, "i");
  return named.test(String(outcome));
}
