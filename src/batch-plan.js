// Batch-plan support for /muster:run's backlog-ref form (run.md step 0b + its
// "Batch plan" section): pure, deterministic functions shared by the mode prompt's
// documented grammar and the eval/modes graders, the same single-implementation
// pattern as src/coordination.js.
//
// parseBacklogRef classifies run's `$ARGUMENTS` into the batch-ref grammar, which
// deliberately mirrors sprint.md step 1's three source forms so a ref that drains
// under /muster:sprint plans identically under /muster:run:
//   - a single whitespace-free token ending in `.md` -> a backlog FILE ref
//     (existence/parseability is the caller's job -- sprint-waves is authoritative
//     and its ok:false stops the run; a pure function does no IO)
//   - `issues:<label>`  -> the GitHub-issues source (coordination Binding A)
//   - `linear:<key>`    -> the Linear source (coordination Binding C)
//   - `issues:`/`linear:` with nothing after the colon -> invalid (report and stop;
//     silently routing the literal text as an outcome would hide the typo)
//   - anything else -> a plain outcome; the single-outcome path is untouched.
// Empty/non-string input is also "outcome": run.md's own empty-guard fires first
// and stops before this classification matters.
//
// crossItemConflicts computes the batch plan's cross-item file-conflict FLAGS from
// each item's fence labels (the union of its manifest's plan[].owns). Flags are
// ADVISORY, never a gate: manifest fences validate as opaque path labels
// (validateManifest does no glob matching -- "disjointness stays orchestrator
// judgment", CHANGELOG 0.4.0), and this function keeps that stance by only
// surfacing prefix-shaped overlaps for the human to weigh at the batch-plan
// approval stop. The heuristic: strip a trailing glob (`/**`, `/*`, `**`, `*`),
// then two labels overlap iff they are equal or one is a '/'-boundary prefix of
// the other. A label that normalizes to "" (a bare `**`) owns everything and
// overlaps any fenced label. Items with no fence data at all are returned in
// `unfenced` instead of being guessed at.

export function parseBacklogRef(text) {
  if (typeof text !== "string") return { kind: "outcome" };
  const t = text.trim();
  if (t === "") return { kind: "outcome" };
  if (/^issues:/i.test(t)) {
    const label = t.slice("issues:".length).trim();
    if (!label) return { kind: "invalid", reason: "issues: ref with an empty label" };
    return { kind: "issues", label };
  }
  if (/^linear:/i.test(t)) {
    const key = t.slice("linear:".length).trim();
    if (!key) return { kind: "invalid", reason: "linear: ref with an empty team key or project" };
    return { kind: "linear", key };
  }
  if (!/\s/.test(t) && /\.md$/i.test(t)) return { kind: "file", path: t };
  return { kind: "outcome" };
}

// Normalize a fence label to a comparable path prefix: forward slashes, no
// trailing glob, no trailing slash. Returns "" for an owns-everything label.
function normalizeFenceLabel(label) {
  let s = String(label).trim().replace(/\\/g, "/");
  s = s.replace(/\/?\*{1,2}$/, "");
  s = s.replace(/\/+$/, "");
  return s;
}

function fenceLabelsOverlap(a, b) {
  const na = normalizeFenceLabel(a);
  const nb = normalizeFenceLabel(b);
  if (na === "" || nb === "") return true;
  return na === nb || na.startsWith(nb + "/") || nb.startsWith(na + "/");
}

export function crossItemConflicts(items) {
  if (!Array.isArray(items)) return { conflicts: [], unfenced: [] };
  const fenced = [];
  const unfenced = [];
  for (const item of items) {
    const id = item && item.id;
    const owns = item && Array.isArray(item.owns) ? item.owns.filter((o) => String(o).trim() !== "") : [];
    if (owns.length === 0) unfenced.push(id);
    else fenced.push({ id, owns });
  }
  const conflicts = [];
  for (let i = 0; i < fenced.length; i++) {
    for (let j = i + 1; j < fenced.length; j++) {
      const overlaps = [];
      for (const a of fenced[i].owns) {
        for (const b of fenced[j].owns) {
          if (fenceLabelsOverlap(a, b)) overlaps.push(`${a} ~ ${b}`);
        }
      }
      if (overlaps.length > 0) conflicts.push({ a: fenced[i].id, b: fenced[j].id, overlaps });
    }
  }
  return { conflicts, unfenced };
}
