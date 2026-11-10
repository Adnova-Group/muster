// `muster preflight <outcome>`: one call replacing scope, assess, fast-path, detect,
// capabilities and memory (docs/strategy/stage-2-contracts.md). It prints a compact
// summary (target < 2 KB) and writes the full detail to .muster/runs/<runId>/preflight.json.
import { lstat } from "node:fs/promises";
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
import { PLUGIN_ROOT, specialistCatalog } from "./specialists.js";
import { classifyDomain } from "./domain.js";
import { loadPipelines, pickPipeline, routePipeline } from "./pipeline.js";
import { writeContainedFile } from "./fs-safe.js";
import { assertRunId, ensureRunDir, slugRunId } from "./run-dir.js";

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

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []);

function rankMemory(entries, outcome) {
  const q = words(outcome);
  return entries
    .map((e) => ({ slug: e.slug, score: [...words(e.content)].filter((w) => q.has(w)).length, excerpt: e.content.slice(0, 400) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

export async function runPreflight({ outcome, cwd, home, catalogDir, runId, model = null, now = new Date() }) {
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
  const skillCandidates = matchSkills(outcome, builtinSkills, { limit: 6 }).filter((m) => m.score >= 3).map((m) => ({ id: m.id, score: m.score }));
  const skills = skillCandidates.map((m) => m.id);
  const routing = routeOutcome(outcome, await loadPipelines(PIPELINES_DIR), project);
  const memory = rankMemory(await readMemory(join(cwd, ".muster", "memory"), ""), outcome);
  const detected = await detectPlugins(installed, home);

  const dir = await ensureRunDir(cwd, id);
  const detailPath = join(dir, "preflight.json");
  const detail = {
    runId: id, outcome, createdAt: now.toISOString(), scope, assess, fastPath, project, models,
    candidates, skills, skillCandidates, ...routing, matches, memory, detected,
    roles: capabilities.roles,
    installedSkills: capabilities.skills.map((s) => s.id),
  };
  await writeContainedFile(cwd, detailPath, JSON.stringify(detail, null, 2) + "\n");

  return {
    runId: id,
    scope: scope.scope,
    clear: assess.clear,
    unclear: assess.clear ? [] : assess.signals,
    fastPath: fastPath.eligible,
    project: {
      languages: project.languages, frameworks: project.frameworks, testRunner: project.testRunner,
      branch: project.vcs?.branch ?? null, dirty: project.vcs?.dirty ?? null,
    },
    ...routing,
    models,
    candidates,
    skills,
    skillRoot: join(PLUGIN_ROOT, "builtins"),
    memory: memory.slice(0, 3).map((m) => m.slug),
    detected: { gsd: detected.gsd.installed, plugins: Object.keys(detected.plugins).filter((k) => detected.plugins[k]) },
    detail: join(".muster", "runs", id, "preflight.json"),
  };
}
