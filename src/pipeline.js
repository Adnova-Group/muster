import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { parse } from "yaml";
import { escapeRe } from "./keyword.js";
import { resolveDir } from "./fs-util.js";

export function validatePipeline(p) {
  const errors = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["pipeline must be an object"] };
  if (!p.id) errors.push("pipeline: id required");
  if (!p.domain) errors.push("pipeline: domain required");
  if (!Array.isArray(p.phases) || p.phases.length === 0) errors.push("pipeline: phases required");
  else p.phases.forEach((ph, i) => {
    if (!ph.id) errors.push(`pipeline.phases[${i}].id required`);
    if (!ph.role) errors.push(`pipeline.phases[${i}].role required`);
  });
  if (!p.gate || !Array.isArray(p.gate.criteria) || typeof p.gate.floor !== "number" || typeof p.gate.pass_total !== "number")
    errors.push("pipeline: gate.{criteria,floor,pass_total} required");
  // Optional per-phase builtin bindings, read by path on top of the role's ROLE_SKILLS
  // (src/pipeline-args.js).
  const allPhases = [...(Array.isArray(p.phases) ? p.phases : []), ...(Array.isArray(p.optional_phases) ? p.optional_phases : [])];
  allPhases.forEach((ph, i) => {
    if (ph && ph.skills !== undefined && (!Array.isArray(ph.skills) || !ph.skills.every(s => typeof s === "string" && /^[a-z0-9][a-z0-9-]*$/.test(s))))
      errors.push(`pipeline.phases[${i}].skills: must be a list of builtin ids`);
  });
  if (p.id && Object.hasOwn(PIPELINE_ALIASES, p.id)) errors.push(`pipeline: id ${p.id} is a retired alias (PIPELINE_ALIASES)`);
  return { ok: errors.length === 0, errors };
}

// Old pipeline ids keep resolving (PM domain stage D, docs/strategy/2026-11-pm-domain-design.md).
// `to` is the pipeline that replaced the id; a null `to` retires it and `use` names the surface
// that took over its job. Ids only: keyword routing (`match`) never sees these.
export const PIPELINE_ALIASES = Object.freeze({
  "ai-implementation-spec": Object.freeze({ to: "design", use: null }),
  "user-story": Object.freeze({ to: null, use: "/muster:pm tickets <docs/specs/<slug>/SPEC.md>" }),
});

// Resolve a pipeline id, or a retired alias, against the loaded pipelines. Returns
// { pipeline, id, alias, retired }: `pipeline` is null when the id is unknown or retired, and
// `retired` then names the replacement surface.
export function resolvePipeline(pipelines, id) {
  const direct = pipelines.find(p => p.id === id);
  if (direct) return { pipeline: direct, id, alias: null, retired: null };
  const alias = Object.hasOwn(PIPELINE_ALIASES, id) ? PIPELINE_ALIASES[id] : null;
  if (!alias) return { pipeline: null, id, alias: null, retired: null };
  if (!alias.to) return { pipeline: null, id, alias: id, retired: alias.use };
  return { pipeline: pipelines.find(p => p.id === alias.to) || null, id: alias.to, alias: id, retired: null };
}

export async function loadPipelines(dir) {
  const base = resolveDir(dir);
  const files = (await readdir(base)).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  const pipelines = [];
  for (const f of files) {
    const p = parse(await readFile(join(base, f), "utf8"));
    const { ok, errors } = validatePipeline(p);
    if (!ok) throw new Error(`Invalid pipeline ${f}:\n` + errors.join("\n"));
    pipelines.push(p);
  }
  return pipelines;
}

export function pipelineForDomain(pipelines, domain) {
  return pipelines.find(p => p.domain === domain && p.default)
    || pipelines.find(p => p.domain === domain) || null;
}

// Select a pipeline by matching the outcome against each pipeline's `match` keywords
// (word-boundary). Among all matches, the EARLIEST position in the outcome wins —
// outcomes name the artifact at the head and the subject at the tail ("write a video
// script about the product launch" is a video script). Position ties break by longer
// phrase, then file order. Returns null if none match — callers fall back to
// pipelineForDomain.
export function pickPipeline(pipelines, outcome) {
  const text = (outcome || "");
  let best = null;
  for (const p of pipelines) {
    for (const m of (p.match || [])) {
      const re = new RegExp(`\\b${escapeRe(m)}\\b`, "i");
      const hit = re.exec(text);
      if (!hit) continue;
      if (!best || hit.index < best.index || (hit.index === best.index && m.length > best.len)) {
        best = { p, index: hit.index, len: m.length };
      }
    }
  }
  return best ? best.p : null;
}

// Resolve the pipeline for an outcome: explicit match wins, else domain default.
export function routePipeline(pipelines, outcome, domain) {
  return pickPipeline(pipelines, outcome) || pipelineForDomain(pipelines, domain);
}
