export function renderPlanChecklist(plan, doneIds = []) {
  const done = new Set(doneIds);
  return plan
    .map(t => `- [${done.has(t.id) ? "x" : " "}] ${t.id} — ${t.task}${t.mode === "tournament" ? " (tournament)" : ""}`)
    .join("\n");
}
