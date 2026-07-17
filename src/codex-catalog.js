const SUPERPOWERS_NAMES = Object.freeze({
  "sp-brainstorm": "brainstorming",
  "sp-plan": "writing-plans",
  "sp-tdd": "test-driven-development",
  "sp-review": "requesting-code-review",
  "sp-review-recv": "receiving-code-review",
  "sp-debug": "systematic-debugging",
  "sp-verify": "verification-before-completion",
  "sp-subagents": "subagent-driven-development",
  "sp-parallel": "dispatching-parallel-agents"
});

export function codexFallbackSkillId(id) {
  return id.startsWith("gsd-") ? `muster-${id}` : id;
}

function nativeSkillId(id) {
  if (SUPERPOWERS_NAMES[id]) return SUPERPOWERS_NAMES[id];
  if (id.startsWith("wsh-")) return id.slice(4);
  if (id.startsWith("gsd-")) return id;
  return null;
}

// Codex-native upstream skills win only when the live Codex inventory says
// they are enabled. Bundled copies remain deterministic, namespaced fallbacks.
// This adapter is called only by `capabilities --codex`; Claude resolution is
// intentionally unchanged.
export function adaptCatalogForCodex(catalog, installed) {
  const liveSkills = new Set(installed?.skills || []);
  const upstream = [];
  const fallback = [];

  for (const entry of catalog) {
    if (entry.kind !== "builtin") {
      fallback.push(entry.kind === "external" && entry.detect?.kind === "plugin"
        ? { ...entry, detect: { ...entry.detect, codexStrictKind: true } }
        : entry);
      continue;
    }

    const nativeId = nativeSkillId(entry.id);
    if (nativeId && liveSkills.has(nativeId)) {
      upstream.push({
        id: nativeId,
        kind: "external",
        roles: entry.roles,
        rank: entry.id.startsWith("sp-") ? 80 : entry.id.startsWith("gsd-") ? 75 : 70,
        detect: { kind: "skill", match: nativeId },
        invoke: `invoke the enabled Codex-native $${nativeId} skill`
      });
    }

    fallback.push(entry.id.startsWith("gsd-")
      ? { ...entry, id: codexFallbackSkillId(entry.id) }
      : entry);
  }

  return [...upstream, ...fallback];
}
