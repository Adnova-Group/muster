import { isAbsolute } from "node:path";

// Batch-plan support for /muster:plan-backlog's backlog-ref form (plan-backlog.md's B1
// step + its B4 "Render ONE batch plan" section; run.md/sprint.md are now dead alias
// stubs, kept only for one-line heads-up compatibility): pure, deterministic functions
// shared by the mode prompt's documented grammar and the eval/modes graders, the same
// single-implementation pattern as src/coordination.js.
//
// parseBacklogRef classifies plan-backlog's `$ARGUMENTS` into the batch-ref grammar,
// which deliberately mirrors go-backlog.md step 1's three source forms so a ref that
// drains under /muster:go-backlog plans identically under /muster:plan-backlog:
//   - a single whitespace-free token with a file extension (any extension -- the WIDEN
//     decision: backlog detection accepts any readable checklist file, not just `.md`)
//     and no ".." substring -> a backlog FILE ref (existence/readability is the caller's
//     job -- sprint-waves is authoritative and its ok:false stops the run; a pure
//     function does no IO, so this is a shape check only, never a filesystem check)
//   - that same file-shaped token but carrying a ".." substring, OR given as an absolute
//     path (node:path's isAbsolute -- POSIX-absolute or a Windows drive-letter/UNC path)
//     -> invalid (neither shape must ever resolve to kind:"file" -- downstream consumers
//     (sprint-waves' caller among them) treat kind:"file" as a green light to read the
//     path directly, and an absolute path needs no traversal at all to name an
//     out-of-project file; mirrors src/memory.js's writeMemory/appendState slug/runId
//     guard and src/scope.js's own isTraversalUnsafe, both of which reject the same two
//     shapes before a join()/read())
//   - `issues:<label>`  -> the GitHub-issues source (coordination Binding A)
//   - `linear:<key>`    -> the Linear source (coordination Binding C)
//   - `issues:`/`linear:` with nothing after the colon -> invalid (report and stop;
//     silently routing the literal text as an outcome would hide the typo)
//   - anything else -> a plain outcome; the single-outcome path is untouched.
// Empty/non-string input is also "outcome": plan-backlog.md's own empty-guard fires
// first and stops before this classification matters.
//
// crossItemConflicts computes the batch plan's cross-item file-conflict FLAGS from
// each item's fence labels (the union of its manifest's plan[].owns). Flags are
// ADVISORY, never a gate: manifest fences validate as opaque path labels
// (validateManifest does no glob matching -- "disjointness stays orchestrator
// judgment", CHANGELOG 0.4.0), and this function keeps that stance by only
// surfacing prefix-shaped overlaps for the human to weigh at the batch-plan
// approval stop. The heuristic: drop every glob segment anywhere in the label
// (split on `/`, drop any segment containing `*`, rejoin the static remainder --
// not just a trailing `/**`/`/*`/`**`/`*`, so a mid-path glob like `src/*/session.js`
// normalizes too), then two labels overlap iff they are equal or one is a
// '/'-boundary prefix of the other. A label that normalizes to "" (a bare `**`)
// owns everything and overlaps any fenced label. Items with no fence data at all
// are returned in `unfenced` instead of being guessed at.

// Any whitespace-free token ending in a dot-extension (WIDEN decision: not restricted to
// `.md`) -- the trailing extension is what distinguishes a file-shaped token from a bare
// word/issue-number ("#42" must stay an outcome, per the fixture below) or an outcome
// sentence, without needing IO to decide. Accepted tradeoff: a bare version/decimal token
// (e.g. "3.14", "v2.0") also satisfies this shape test and is classified kind:"file" --
// distinguishing "looks like a number" from "looks like a filename" would need content or
// an allowlist this pure, IO-free function deliberately doesn't have (existence is the
// caller's job, same stance the .md-only grammar always had); a plain-outcome argument
// that happens to be a bare version number is a narrow, documented edge case, not a new
// hole opened by the widen.
const FILE_TOKEN_RE = /\.[^\s./\\]+$/;

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
  if (!/\s/.test(t) && FILE_TOKEN_RE.test(t)) {
    // Absolute-path guard (mirrors src/scope.js's isTraversalUnsafe): an absolute path
    // names an out-of-project file outright, no ".." traversal needed at all -- checked
    // before the ".." substring check below so both shapes share one "invalid" outcome
    // path rather than an absolute-and-traversal token silently short-circuiting on
    // whichever check happened to run first.
    if (isAbsolute(t)) {
      return { kind: "invalid", reason: "file ref must not be an absolute path" };
    }
    // Traversal guard (mirrors src/memory.js's writeMemory/appendState/appendFollowup
    // slug/runId check): a ".." substring anywhere in an otherwise file-shaped token
    // must never resolve to kind:"file" -- plan-backlog.md B1 and go-backlog.md step 1
    // both treat kind:"file" as a green light to read `path` and run sprint-waves
    // against it.
    if (t.includes("..")) {
      return { kind: "invalid", reason: "file ref must not contain a '..' path segment" };
    }
    return { kind: "file", path: t };
  }
  return { kind: "outcome" };
}

// Normalize a fence label to a comparable static path prefix: forward slashes, every
// glob segment dropped (not just a trailing one -- a mid-path glob, e.g.
// `src/*/session.js`, previously survived normalization untouched because the old regex
// only anchored on a *trailing* `*`/`**`, so a backslash-separated mid-path glob label
// silently escaped normalization and a real overlap went unflagged), no empty/trailing
// segments. Returns "" for an owns-everything label (e.g. a bare `**`).
function normalizeFenceLabel(label) {
  const s = String(label).trim().replace(/\\/g, "/");
  const segments = s.split("/").filter((seg) => seg !== "" && !seg.includes("*"));
  return segments.join("/");
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
