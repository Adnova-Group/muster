const SOURCES = new Set(["installed", "builtin", "dynamic", "inline"]);
const MODES = new Set(["single", "tournament"]);

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
  });
  for (const f of ["recommendations", "degradations"])
    if (!Array.isArray(m[f])) errors.push(`${f}: must be an array`);
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
    });
    m.plan.forEach((p, i) => {
      for (const d of (p.deps || [])) if (!ids.has(d)) errors.push(`plan[${i}].deps: unknown dep "${d}"`);
    });
  }
  return { ok: errors.length === 0, errors };
}
