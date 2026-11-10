// Doctor check (PM domain stage D): every pipeline is reachable and every pipeline's sources are
// in vendor/manifest.yaml. The domain-router was deleted in revival stage 2b and for a while
// nothing could run most pipelines; this keeps that from happening silently again.
//
// Reachable means: the muster:pipeline workflow ships, `muster pipeline-args` can bind every
// phase (each role has a skill binding, each phase `skills:` id is a bundled builtin), and some
// command runs it, either by id (a generic runner such as /muster:pm run) or by routing an
// outcome to it through its `match` keywords (/muster:go, /muster:plan via preflight).
// Pure over its inputs; runDoctor supplies them.
import { pipelineArgsFrom } from "./pipeline-args.js";
import { PIPELINE_ALIASES } from "./pipeline.js";

// A command runs pipelines when it calls pipeline-args; it runs any pipeline by id when it also
// passes --pipeline.
export function pipelineRunners(commands) {
  const routed = [];
  const byId = [];
  for (const [name, text] of Object.entries(commands)) {
    if (!/pipeline-args/.test(text)) continue;
    if (/pipeline-args[^\n]*--pipeline\b/.test(text)) byId.push(name);
    else routed.push(name);
  }
  return { routed: routed.sort(), byId: byId.sort() };
}

export function checkPipelineReach({ pipelines, manifest, commands, workflowPresent, catalog, pluginRoot }) {
  const problems = [];
  const runners = pipelineRunners(commands);
  if (!workflowPresent) problems.push("plugin/workflows/pipeline.js (the muster:pipeline workflow) is missing");
  if (!runners.byId.length && !runners.routed.length) problems.push("no command runs pipelines (none calls muster pipeline-args)");
  for (const p of pipelines) {
    const { problems: bind } = pipelineArgsFrom(p, { runId: "doctor", outcome: "", catalog, pluginRoot });
    for (const b of bind) problems.push(`${p.id}: ${b}`);
    const routable = runners.routed.length > 0 && Array.isArray(p.match) && p.match.length > 0;
    if (!runners.byId.length && !routable) problems.push(`${p.id}: no command can run it (no generic runner and no match keywords)`);
  }
  const ids = new Set(pipelines.map(p => p.id));
  for (const [alias, a] of Object.entries(PIPELINE_ALIASES)) {
    if (ids.has(alias)) problems.push(`alias ${alias} shadows a pipeline file`);
    if (a.to && !ids.has(a.to)) problems.push(`alias ${alias} points at missing pipeline ${a.to}`);
  }
  // Sources: a pipeline either has manifest items (its upstream: is stamped from them) or says
  // `upstream: []` (muster's own); a manifest pipeline item never names a missing pipeline.
  const items = (manifest?.sources || []).flatMap(s => (s.items || []).filter(i => i.kind === "pipeline").map(i => ({ id: i.id, source: s.id })));
  const listed = new Set(items.map(i => i.id));
  for (const p of pipelines) {
    const own = Array.isArray(p.upstream) && p.upstream.length === 0;
    if (!listed.has(p.id) && !own) problems.push(`${p.id}: no vendor/manifest.yaml item and no explicit upstream: []`);
    if (listed.has(p.id) && own) problems.push(`${p.id}: has manifest items but an empty upstream: (run muster provenance --write)`);
  }
  for (const i of items) if (!ids.has(i.id)) problems.push(`vendor/manifest.yaml source ${i.source} names missing pipeline ${i.id}`);
  return {
    ok: problems.length === 0,
    problems,
    runners,
    detail: `${pipelines.length} pipeline(s) reachable (by id: ${runners.byId.join(", ") || "none"}; routed: ${runners.routed.join(", ") || "none"}); sources in vendor/manifest.yaml`,
  };
}
