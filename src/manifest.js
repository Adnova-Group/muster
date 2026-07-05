const SOURCES = new Set(["installed", "builtin", "dynamic", "inline"]);
const MODES = new Set(["single", "tournament"]);
const MERGE_DISPOSITIONS = new Set(["merge-local", "merge-push", "pr", "keep", "ask"]);

// A label list is opaque here: strings that name files/globs for downstream orchestration
// (which task owns/must not touch which paths). No glob matching or overlap detection —
// just shape validation: an array of non-empty (post-trim) strings.
function isValidLabelArray(v) {
  return Array.isArray(v) && v.every((s) => typeof s === "string" && s.trim().length > 0);
}
// Model tiers a crew member may dispatch on. `fable` is the top tier (above opus),
// pre-accepted so a future fable-tier role validates without a schema change.
const MODEL_TIERS = new Set(["haiku", "sonnet", "opus", "fable"]);

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== "object") return { ok: false, errors: ["manifest must be an object"] };
  if (!m.outcome || typeof m.outcome !== "string") errors.push("outcome: required non-empty string");
  if (!Array.isArray(m.successCriteria) || m.successCriteria.length === 0)
    errors.push("successCriteria: required non-empty array");
  if (!Array.isArray(m.crew) || m.crew.length === 0) errors.push("crew: required non-empty array");
  else m.crew.forEach((c, i) => {
    for (const f of ["stage", "provider", "rationale", "evidence", "fallback"])
      if (!c[f]) errors.push(`crew[${i}].${f}: required`);
    if (!SOURCES.has(c.source)) errors.push(`crew[${i}].source: must be one of ${[...SOURCES].join("|")}`);
    // A non-inline member dispatches to a real provider on a real model — the model
    // must travel with it (else dispatch inherits the orchestrator's model). Inline
    // members run in-context and are exempt. A present model must be a known tier.
    if (c.source !== "inline" && !c.model) errors.push(`crew[${i}].model: required for non-inline members`);
    if (c.model && !MODEL_TIERS.has(c.model)) errors.push(`crew[${i}].model: must be one of ${[...MODEL_TIERS].join("|")}`);
  });
  for (const f of ["recommendations", "degradations"])
    if (!Array.isArray(m[f])) errors.push(`${f}: must be an array`);
  if (m.mergeDisposition !== undefined && !MERGE_DISPOSITIONS.has(m.mergeDisposition))
    errors.push(`mergeDisposition: must be one of ${[...MERGE_DISPOSITIONS].join("|")}`);
  if (!Array.isArray(m.plan) || m.plan.length === 0) errors.push("plan: required non-empty array");
  else {
    const ids = new Set();
    const multi = m.plan.length > 1;
    m.plan.forEach((p, i) => {
      if (!p.task) errors.push(`plan[${i}].task: required`);
      if (!MODES.has(p.mode)) errors.push(`plan[${i}].mode: must be single|tournament`);
      if (multi && !p.id) errors.push(`plan[${i}].id: required when plan has multiple tasks`);
      if (p.id) { if (ids.has(p.id)) errors.push(`plan[${i}].id: duplicate id "${p.id}"`); ids.add(p.id); }
      if (p.deps !== undefined && !Array.isArray(p.deps)) errors.push(`plan[${i}].deps: must be an array`);
      if (p.owns !== undefined && !isValidLabelArray(p.owns))
        errors.push(`plan[${i}].owns must be an array of non-empty strings`);
      if (p.frozen !== undefined && !isValidLabelArray(p.frozen))
        errors.push(`plan[${i}].frozen must be an array of non-empty strings`);
    });
    m.plan.forEach((p, i) => {
      for (const d of (p.deps || [])) if (!ids.has(d)) errors.push(`plan[${i}].deps: unknown dep "${d}"`);
    });
  }
  return { ok: errors.length === 0, errors };
}

// Non-fatal advisories: a manifest can be structurally VALID yet signal a likely mistake.
// An all-inline crew almost always means capability resolution was skipped — builtins (e.g.
// `implement -> muster-builder`) resolve for nearly every role, so a hand-authored inline-only
// crew silently bypasses routing and runs everything in-context. muster fails loud, so surface it.
export function manifestWarnings(m) {
  const warnings = [];
  const crew = Array.isArray(m?.crew) ? m.crew : [];
  if (crew.length > 0 && crew.every((c) => c && c.source === "inline")) {
    warnings.push(
      "crew: every member is source:inline — capability resolution was likely skipped. " +
        "Build the crew from `npx -y @adnova-group/muster capabilities` (builtins resolve roles like `implement -> muster-builder`); " +
        "a hand-authored all-inline crew bypasses routing."
    );
  }
  return warnings;
}
