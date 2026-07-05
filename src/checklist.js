function fenceSuffix(t) {
  const parts = [];
  if (Array.isArray(t.owns) && t.owns.length > 0) parts.push(`owns: ${t.owns.join(", ")}`);
  if (Array.isArray(t.frozen) && t.frozen.length > 0) parts.push(`frozen: ${t.frozen.join(", ")}`);
  return parts.length > 0 ? ` [${parts.join(" | ")}]` : "";
}

export function renderPlanChecklist(plan, doneIds = []) {
  const done = new Set(doneIds);
  return plan
    .map(t => `- [${done.has(t.id) ? "x" : " "}] ${t.id} — ${t.task}${t.mode === "tournament" ? " (tournament)" : ""}${fenceSuffix(t)}`)
    .join("\n");
}
