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
  return { ok: errors.length === 0, errors };
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
