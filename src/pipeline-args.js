// `muster pipeline-args <runId> [--pipeline <id>] [--out <path>] [--with <phase,...>]`: turn a
// content pipeline (pipelines/*.yaml) into the exact `muster:pipeline` Workflow args, with each
// phase's role resolved to the builtin skills its agent reads (revival stage 3: the deleted
// domain-router, as data). Deterministic, one Bash call; the main thread commits the file.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { loadPipelines } from "./pipeline.js";
import { runDir } from "./run-dir.js";
import { writeContainedFile } from "./fs-safe.js";
import { specialistCatalog } from "./specialists.js";

// Pipeline role -> builtin skills. brainstorm binds nothing: sp-brainstorm runs a one-question-
// at-a-time interview a subagent cannot hold, so intake works from CONTEXT.md (the main thread
// asks the questions). code-review is the workflow's adversarial review seat; it reads the
// gate criteria, not a skill.
export const ROLE_SKILLS = Object.freeze({
  brainstorm: [],
  "docs-research": ["muster-research"],
  research: ["muster-research"],
  author: ["muster-author"],
  "code-review": [],
  score: ["muster-scorer"],
  humanize: ["muster-humanizer"],
  video: ["muster-video"],
  image: ["muster-image"],
});

const PIPELINES_DIR = new URL("../pipelines/", import.meta.url);
const OUT_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,200}$/;

// Pure: pipeline + options -> { args, problems }.
export function pipelineArgsFrom(pipeline, { runId, outcome, contextPath = null, models = null, out = null, withPhases = [], catalog = specialistCatalog() }) {
  const problems = [];
  const optional = (pipeline.optional_phases || []).filter((p) => withPhases.includes(p.id));
  for (const id of withPhases) if (!optional.some((p) => p.id === id)) problems.push(`pipeline ${pipeline.id} has no optional phase "${id}"`);
  const phases = [...pipeline.phases, ...optional].map((ph) => {
    const ids = ROLE_SKILLS[ph.role];
    if (!ids) problems.push(`phase ${ph.id}: role "${ph.role}" has no skill binding`);
    return {
      id: ph.id, role: ph.role, desc: ph.desc || "",
      skills: (ids || []).filter((id) => catalog.skills.has(id)).map((id) => ({ id, path: catalog.skills.get(id).path })),
    };
  });
  const artifactPath = out || `.muster/runs/${runId}/${pipeline.id}.md`;
  if (!OUT_RE.test(artifactPath)) problems.push(`--out must be a relative path inside the repository: ${artifactPath}`);
  const args = {
    runId, outcome, ...(contextPath ? { contextPath } : {}),
    pipeline: { id: pipeline.id, title: pipeline.title || pipeline.id, gate: pipeline.gate },
    phases, artifactPath,
    ...(models ? { models } : {}),
  };
  return { args, problems };
}

async function readJsonOrNull(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}
async function exists(path) {
  try { await readFile(path); return true; } catch { return false; }
}

export async function writePipelineArgs({ cwd, runId, pipelineId = null, out = null, withPhases = [] }) {
  const dir = runDir(cwd, runId);
  const preflight = await readJsonOrNull(join(dir, "preflight.json"));
  if (!preflight) return { ok: false, runId, problems: [`.muster/runs/${runId}/preflight.json not found: run muster preflight first`] };
  const id = pipelineId || preflight.pipeline;
  if (!id) return { ok: false, runId, problems: ["no pipeline: preflight routed this outcome to code; pass --pipeline <id> to force one"] };
  const pipeline = (await loadPipelines(PIPELINES_DIR)).find((p) => p.id === id);
  if (!pipeline) return { ok: false, runId, problems: [`unknown pipeline "${id}"`] };
  const contextPath = (await exists(join(dir, "CONTEXT.md"))) ? `.muster/runs/${runId}/CONTEXT.md` : null;
  const { args, problems } = pipelineArgsFrom(pipeline, { runId, outcome: preflight.outcome, contextPath, models: preflight.models || null, out, withPhases });
  if (problems.length) return { ok: false, runId, problems };
  await writeContainedFile(cwd, join(dir, "pipeline-args.json"), JSON.stringify(args, null, 2) + "\n");
  return {
    ok: true, runId, path: `.muster/runs/${runId}/pipeline-args.json`, pipeline: pipeline.id, artifactPath: args.artifactPath,
    phases: args.phases.map((p) => `${p.id}${p.skills.length ? ` (${p.skills.map((k) => k.id).join(", ")})` : ""}`),
    gate: pipeline.gate,
  };
}
