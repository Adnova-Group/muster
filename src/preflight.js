// `muster preflight <outcome>`: one call replacing scope, assess, fast-path, detect,
// capabilities and memory (docs/strategy/stage-2-contracts.md). It prints a compact
// summary (target < 2 KB) and writes the full detail to .muster/runs/<runId>/preflight.json.
import { existsSync } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { detectScope } from "./scope.js";
import { assessOutcome } from "./interview.js";
import { scoreOutcomeForFastPath } from "./fast-path.js";
import { detectProject } from "./detect.js";
import { loadCatalog } from "./catalog.js";
import { readInstalled } from "./harness.js";
import { resolveCapabilities } from "./capabilities.js";
import { readMemory } from "./memory.js";
import { matchProviders, matchSkills } from "./match.js";
import { claudeProfileForConfig } from "./claude.js";
import { PLUGIN_ROOT, musterCli, specialistCatalog, skillFitsStack } from "./specialists.js";
import { classifyDomain } from "./domain.js";
import { loadPipelines, pickPipeline, routePipeline } from "./pipeline.js";
import { writeContainedFile } from "./fs-safe.js";
import { assertRunId, ensureRunDir, slugRunId } from "./run-dir.js";
import { readPins } from "./skill-pins.js";
import { suggestFromCachedRegistry, userCacheDir } from "./skill-registry.js";
import { describeSpec, detectSpecRef } from "./spec-plan.js";

// A builtin candidate at or above this score is a strong match (plan-lint's HIGH_SKILL_SCORE);
// below it, preflight may suggest registry skills from the cached catalog.
const STRONG_SKILL_SCORE = 4;

// Workflow seats -> conceptual tier + semantic effort (claude.js maps workhorse=medium,
// judgment=high). The gates whose output other work trusts (planner, checker, verifier) get
// the top routine tier; the executor is the volume seat. A live stage-2 smoke ran the planner
// on haiku: 3 revisions and 10 minutes for a 2-task plan, so planning is not a place to save.
// Tiers go through claudeProfileForConfig, so MUSTER_MAX_TIER still caps them.
export const SEATS = Object.freeze({
  planner: { tier: "prime", effort: "judgment" },
  checker: { tier: "prime", effort: "judgment" },
  executor: { tier: "core", effort: "workhorse" },
  reviewer: { tier: "core", effort: "judgment" },
  verifier: { tier: "prime", effort: "judgment" },
});

// Plugins whose presence changes what muster should delegate to or stay out of.
const WATCHED_PLUGINS = ["superpowers", "feature-dev", "pr-review-toolkit", "code-review", "commit-commands", "ralph-loop"];

export function seatModels() {
  const models = {};
  for (const [seat, { tier, effort }] of Object.entries(SEATS)) {
    const profile = claudeProfileForConfig({ tier, effort });
    models[seat] = { model: profile.model, effort: profile.workflowEffort };
  }
  return models;
}

// Words that mark an outcome as code work even when it names a document ("fix the release
// notes generator", "add an API that returns blog posts").
const CODE_SIGNAL = /\b(implement|refactor|bug|fix|api|endpoint|function|deploy|tdd|code|module|class|cli|script|repo|test|tests|commit|generator|parser|component|schema|migration)\b|\b[\w./-]+\.(?:js|mjs|cjs|ts|tsx|jsx|py|go|rs|java|rb|json|ya?ml|css|html|sh)\b/i;

// Content routing (the deleted domain-router, as data): `pipeline` when an outcome names a
// content artifact and carries no code signal; `ask` when it names one but also reads like
// code; `code` otherwise. go/plan run pipelines through the muster:pipeline workflow.
export function routeOutcome(outcome, pipelines, profile = {}) {
  const { domain } = classifyDomain(outcome, profile);
  const explicit = pickPipeline(pipelines, outcome);
  const p = explicit || routePipeline(pipelines, outcome, domain);
  if (!p || domain === "software") return { route: "code", domain, pipeline: null };
  return { route: CODE_SIGNAL.test(outcome) ? "ask" : "pipeline", domain: p.domain || domain, pipeline: p.id };
}

async function exists(path) {
  try { await lstat(path); return true; } catch { return false; }
}

export async function detectPlugins(installed, home) {
  const plugins = installed.plugins || [];
  const gsdVia = [];
  if (plugins.some((p) => /^(gsd|gsd-core|get-shit-done)(@|$)/.test(p))) gsdVia.push("plugin");
  if ((installed.agents || []).some((a) => a.startsWith("gsd-"))) gsdVia.push("agents");
  if ((installed.skills || []).some((s) => /^gsd[-:]/.test(s))) gsdVia.push("skills");
  if (await exists(join(home, ".claude", "gsd-core"))) gsdVia.push("~/.claude/gsd-core");
  const watched = {};
  for (const name of WATCHED_PLUGINS) watched[name] = plugins.some((p) => p === name || p.startsWith(`${name}@`));
  return {
    gsd: { installed: gsdVia.length > 0, via: gsdVia },
    plugins: watched,
    counts: { plugins: plugins.length, skills: (installed.skills || []).length, agents: (installed.agents || []).length },
  };
}

const PIPELINES_DIR = new URL("../pipelines/", import.meta.url);

// Env vars that silently replace the per-seat model/effort a Workflow agent() call sets
// (docs/research/2026-11-claude-code-findings.md F8).
export const SEAT_OVERRIDE_ENV = Object.freeze(["CLAUDE_CODE_EFFORT_LEVEL", "CLAUDE_CODE_SUBAGENT_MODEL_FORCE", "CLAUDE_CODE_WORKFLOW_SUBAGENT_MODEL", "CLAUDE_CODE_SUBAGENT_EFFORT"]);

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

// Claude Code's worktree.baseRef, local > project > user settings. "fresh" (the default) branches
// isolated agent worktrees from the remote's default branch, not the local work branch; a live
// probe (2026-11-10, 2.1.322) showed Workflow isolation:'worktree' agents follow it.
export async function worktreeBaseRef(cwd, home) {
  for (const p of [join(cwd, ".claude", "settings.local.json"), join(cwd, ".claude", "settings.json"), join(home, ".claude", "settings.json")]) {
    const v = (await readJsonOrNull(p))?.worktree?.baseRef;
    if (typeof v === "string") return v;
  }
  return "fresh";
}

export function preflightWarnings({ env = process.env, baseRef, hasRemote }) {
  const warnings = [];
  const set = SEAT_OVERRIDE_ENV.filter((k) => env[k]);
  if (set.length) warnings.push(`seat models/effort overridden by env: ${set.map((k) => `${k}=${env[k]}`).join(", ")}`);
  if (hasRemote && baseRef !== "head") warnings.push('worktree.baseRef is not "head": executor worktrees start from the remote default branch and fast-forward to the run base, or block when the remote is ahead; set {"worktree":{"baseRef":"head"}} in .claude/settings.local.json');
  return warnings;
}

// Does the project show a UI? true on a frontend framework or shape, or a UI source file in the
// root or a conventional UI directory (one level, no recursion: preflight stays fast); false
// for an existing project with none of those; undefined for an empty (greenfield) directory,
// where only the outcome can say. Feeds skillFitsStack's UI-skill filter.
const UI_FRAMEWORKS = new Set(["react", "react-native", "expo", "vue", "svelte", "angular", "next", "vite"]);
const UI_SHAPES = new Set(["frontend", "fullstack", "mobile"]);
const UI_FILE = /\.(?:html?|css|scss|sass|less|vue|svelte|jsx|tsx|astro)$/i;
const UI_DIRS = ["", "src", "public", "app", "pages", "components", "web", "static", "templates", "views", "client", "frontend", "www", "ui"];

export async function projectShowsUi(cwd, project = {}) {
  if (project.greenfield) return undefined;
  if ((project.frameworks || []).some((f) => UI_FRAMEWORKS.has(f)) || UI_SHAPES.has(project.shape)) return true;
  for (const d of UI_DIRS) {
    let entries;
    try { entries = await readdir(join(cwd, d), { withFileTypes: true }); } catch { continue; }
    if (entries.some((e) => e.isFile() && UI_FILE.test(e.name))) return true;
  }
  return false;
}

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []);

function rankMemory(entries, outcome) {
  const q = words(outcome);
  return entries
    .map((e) => ({ slug: e.slug, score: [...words(e.content)].filter((w) => q.has(w)).length, excerpt: e.content.slice(0, 400) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

export async function runPreflight({ outcome, cwd, home, catalogDir, runId, model = null, now = new Date(), env = process.env }) {
  if (typeof outcome !== "string" || !outcome.trim()) throw new Error("preflight <outcome>: missing outcome");
  const id = assertRunId(runId || slugRunId(outcome, now));
  const [scope, project, catalog, installed] = await Promise.all([
    detectScope({ cwd, text: outcome }),
    detectProject(cwd),
    loadCatalog(catalogDir),
    readInstalled(home),
  ]);
  const assess = assessOutcome(outcome);
  const fastPath = scoreOutcomeForFastPath(outcome);
  const capabilities = resolveCapabilities(catalog, installed, home);
  const models = seatModels();
  // `--model` pins every Workflow seat to one model (cheap smoke runs, budget lanes); effort stays.
  if (model) for (const seat of Object.keys(models)) models[seat] = { ...models[seat], model };
  // Specialists for agent_hint: plugin agents that can do an executor's job (muster-executor
  // is the default, so muster-* never needs naming). Skills: the plugin's bundled builtins,
  // ranked like `muster match --skills` over their SKILL.md descriptions.
  const specialists = specialistCatalog();
  const matches = matchProviders(outcome, catalog, installed, { limit: 40 });
  const candidates = matches
    .filter((m) => m.score > 0 && specialists.agents.get(m.id)?.dispatchable && !m.id.startsWith("muster-"))
    .slice(0, 5).map((m) => m.id);
  const builtinSkills = [...specialists.skills].map(([id, s]) => ({ id, source: "builtin", description: s.description }));
  // score >= 3 = an id-token hit or three description hits; one shared word ("write") is noise.
  // Language-specific skills are offered only when they fit the project's detected stack (or the
  // outcome names their language), so a JavaScript task is never handed a Python-only skill.
  // UI and design skills likewise need a UI in the project or the outcome.
  const projectUi = await projectShowsUi(cwd, project);
  const skillCandidates = matchSkills(outcome, builtinSkills, { limit: 12 })
    .filter((m) => m.score >= 3 && skillFitsStack(m.id, project.languages || [], outcome, { projectUi }))
    .slice(0, 6).map((m) => ({ id: m.id, score: m.score }));
  // Project pins (.muster/config) lead the candidates; build-args binds them to matching tasks.
  let pins = [];
  try { pins = readPins(cwd).filter((p) => specialists.skills.has(p.id) || existsSync(join(cwd, ".claude", "skills", p.id, "SKILL.md"))); } catch { pins = []; }
  // Only builtin pins join `skills` (plan-lint accepts builtin ids in a task's skills attribute).
  const skills = [...new Set([...pins.filter((p) => specialists.skills.has(p.id)).map((p) => p.id), ...skillCandidates.map((m) => m.id)])];
  // No strong builtin: up to 3 suggestions from the cached ui-skills.com registry (never fetched here).
  const registrySuggestions = skillCandidates.some((m) => m.score >= STRONG_SKILL_SCORE)
    ? []
    : await suggestFromCachedRegistry(outcome, { cacheDir: userCacheDir(env, home) });
  // A SPEC.md named in the outcome (or a backlog item's `{spec: path#REF-02}`) replaces the
  // interview: spec-lint runs here, a ready spec plans straight away, and a spec that is not
  // ready gets one question round on its blocking open questions (`spec.openQuestions`).
  // Building a spec is code work, never a content pipeline.
  const specRef = detectSpecRef(outcome);
  const spec = specRef ? describeSpec({ cwd, ref: specRef }) : null;
  const routing = spec
    ? { route: "code", domain: "software", pipeline: null }
    : routeOutcome(outcome, await loadPipelines(PIPELINES_DIR), project);
  // A spec is one change: its `.md` path must not read as a backlog file ref (scope rule 1).
  if (spec && scope.scope !== "item") Object.assign(scope, { scope: "item", signals: [...(scope.signals || []), `the outcome names a spec (${spec.path}), one change`] });
  const memory = rankMemory(await readMemory(join(cwd, ".muster", "memory"), ""), outcome);
  const baseRef = await worktreeBaseRef(cwd, home);
  const warnings = preflightWarnings({ env, baseRef, hasRemote: !!project.vcs?.hasRemote });
  const detected = await detectPlugins(installed, home);

  const dir = await ensureRunDir(cwd, id);
  const detailPath = join(dir, "preflight.json");
  const detail = {
    runId: id, outcome, createdAt: now.toISOString(), scope, assess, fastPath, project, models,
    candidates, skills, skillCandidates, pins, registrySuggestions, ...routing, ...(spec ? { spec } : {}), worktreeBaseRef: baseRef, warnings, matches, memory, detected,
    roles: capabilities.roles,
    installedSkills: capabilities.skills.map((s) => s.id),
  };
  await writeContainedFile(cwd, detailPath, JSON.stringify(detail, null, 2) + "\n");

  return {
    runId: id,
    scope: scope.scope,
    // With a spec, readiness decides: ready skips the interview, not ready asks spec.openQuestions.
    clear: spec ? spec.ready : assess.clear,
    unclear: spec || assess.clear ? [] : assess.signals,
    fastPath: fastPath.eligible,
    project: {
      languages: project.languages, frameworks: project.frameworks, testRunner: project.testRunner,
      branch: project.vcs?.branch ?? null, dirty: project.vcs?.dirty ?? null,
    },
    ...routing,
    ...(spec ? { spec } : {}),
    models,
    candidates,
    skills,
    ...(pins.length ? { pins } : {}),
    skillRoot: join(PLUGIN_ROOT, "builtins"),
    cli: musterCli(),
    ...(registrySuggestions.length ? { registrySuggestions } : {}),
    ...(warnings.length ? { warnings } : {}),
    memory: memory.slice(0, 3).map((m) => m.slug),
    detected: { gsd: detected.gsd.installed, plugins: Object.keys(detected.plugins).filter((k) => detected.plugins[k]) },
    detail: join(".muster", "runs", id, "preflight.json"),
  };
}
