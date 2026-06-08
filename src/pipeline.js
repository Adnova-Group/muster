import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";

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
  if (!p.gate || !Array.isArray(p.gate.criteria) || typeof p.gate.floor !== "number")
    errors.push("pipeline: gate.{criteria,floor} required");
  return { ok: errors.length === 0, errors };
}

export async function loadPipelines(dir) {
  const base = dir instanceof URL ? fileURLToPath(dir) : dir;
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
  return pipelines.find(p => p.domain === domain) || null;
}
