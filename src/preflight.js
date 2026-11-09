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
import { matchProviders } from "./match.js";
import { agentProfiles } from "./agent-manifest.js";
import { claudeProfileForConfig } from "./claude.js";
import { writeContainedFile } from "./fs-safe.js";
import { assertRunId, ensureRunDir, slugRunId } from "./run-dir.js";

// Workflow seats -> the capability role whose resolved model they inherit, plus the
// semantic effort (claude.js maps workhorse=medium, judgment=high).
export const SEATS = Object.freeze({
  planner: { role: "plan", effort: "judgment" },
  checker: { role: "plan", effort: "judgment" },
  executor: { role: "implement", effort: "workhorse" },
  reviewer: { role: "code-review", effort: "judgment" },
  verifier: { role: "code-review", effort: "judgment" },
});

// Plugins whose presence changes what muster should delegate to or stay out of.
const WATCHED_PLUGINS = ["superpowers", "feature-dev", "pr-review-toolkit", "code-review", "commit-commands", "ralph-loop"];

export function seatModels(roles) {
  const models = {};
  for (const [seat, { role, effort }] of Object.entries(SEATS)) {
    const r = roles[role] || {};
    const profile = claudeProfileForConfig({ tier: r.model || "core", effort });
    models[seat] = { model: r.claudeModel || profile.model, effort: profile.workflowEffort };
  }
  return models;
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

const words = (s) => new Set(String(s).toLowerCase().match(/[a-z0-9][a-z0-9-]{2,}/g) || []);

function rankMemory(entries, outcome) {
  const q = words(outcome);
  return entries
    .map((e) => ({ slug: e.slug, score: [...words(e.content)].filter((w) => q.has(w)).length, excerpt: e.content.slice(0, 400) }))
    .filter((e) => e.score > 0)
    .sort((a, b) => b.score - a.score || a.slug.localeCompare(b.slug));
}

export async function runPreflight({ outcome, cwd, home, catalogDir, runId, now = new Date() }) {
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
  const models = seatModels(capabilities.roles);
  // Specialists for agentHint; the muster-* agents are workflow seats, not task specialists.
  const agentIds = new Set([...Object.keys(agentProfiles()), ...(installed.agents || [])]);
  const matches = matchProviders(outcome, catalog, installed);
  const candidates = matches.filter((m) => m.score > 0 && agentIds.has(m.id) && !m.id.startsWith("muster-")).slice(0, 5).map((m) => m.id);
  const memory = rankMemory(await readMemory(join(cwd, ".muster", "memory"), ""), outcome);
  const detected = await detectPlugins(installed, home);

  const dir = await ensureRunDir(cwd, id);
  const detailPath = join(dir, "preflight.json");
  const detail = {
    runId: id, outcome, createdAt: now.toISOString(), scope, assess, fastPath, project, models,
    candidates, matches, memory, detected,
    roles: capabilities.roles,
    skills: capabilities.skills.map((s) => s.id),
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
    models,
    candidates,
    memory: memory.slice(0, 3).map((m) => m.slug),
    detected: { gsd: detected.gsd.installed, plugins: Object.keys(detected.plugins).filter((k) => detected.plugins[k]) },
    detail: join(".muster", "runs", id, "preflight.json"),
  };
}
