// Persisted repo-shape "signals": the deterministic project profile + the resolved role map.
export function buildSignals(profile, capabilities) {
  const roles = {};
  for (const [role, r] of Object.entries(capabilities.roles || {})) {
    roles[role] = { chosen: r.chosen, model: r.model };
  }
  return { profile, roles };
}
