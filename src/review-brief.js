// fast-path-token-gap item, lever 1: which reviewer BRIEF a single (reviewerCount:1, diff
// under DEFAULT_REVIEW_DIFF_THRESHOLD) dispatch gets. The full plugin/skills/review-gate/
// SKILL.md carries three content-conditioned gates that most small diffs never touch at all
// -- the citation guard (docs/weight-reduction.md and docs/speed-tuning.md's own named
// follow-up), the mutant-kill gate, and the 3 surface-type definition-of-done gates -- yet
// EVERY reviewer dispatch loads the whole file regardless (see eval/perf/replay-fast-path.mjs
// step 1's comment). plugin/skills/review-gate/fast-path-brief.md is a real, smaller,
// standalone brief carrying only the essential correctness+security checks (never a subset of
// what the full brief also always includes: the verdict/escalation contract and the intent-
// vs-implementation check) -- used ONLY when this module's `lightBriefEligible` says so.
//
// Criterion 2 of this item (no reduction in what a small diff actually gets checked) is a
// HARD constraint, enforced here BY CONSTRUCTION rather than by review discipline alone: the
// light brief is eligible only for reviewerCount:1 AND only when none of the three triggers
// below fire against the diff's changed files (or, for the citation trigger, the diff TEXT
// itself). The moment any trigger fires -- even at reviewerCount:1 -- eligibility is false and
// the caller must fall back to the full, unchanged review-gate/SKILL.md brief. Conservative by
// construction, same discipline as src/fast-path.js's scoreOutcomeForFastPath: a false
// "not eligible" costs only the (already-paid, pre-this-item) full-brief overhead; a false
// "eligible" would violate criterion 2, so every regex below is deliberately broad/inclusive
// rather than narrowly tuned.

// Mutant-kill gate trigger: "a wave adds a new test/eval guard (a test file, an assertion, an
// eval/*/dataset.json case, a lint/doctor rule)" -- review-gate/SKILL.md's own words. Detecting
// "adds a new assertion" precisely isn't possible from changed file PATHS alone, so this errs
// toward over-inclusion: touching a test file, an eval dataset.json, or a lint/doctor rule
// SOURCE file at all is enough to fall back to the full brief.
export const MUTANT_KILL_TRIGGER_RE =
  /(^|\/)test\/.*\.test\.[cm]?js$|(^|\/)eval\/.*\/dataset\.json$|(^|\/)src\/[^/]*lint[^/]*\.js$|(^|\/)src\/doctor\.js$/i;

// Citation guard trigger: review-gate/SKILL.md step 3 runs `citation-check` "on each artifact"
// -- src/citation-guard.js's own scope is "research/content artifacts that cite claims inline
// as `[src: <anchor>]`". Any changed markdown file is treated as a potential citation-bearing
// artifact (conservative: a docs/content file MAY carry citations even if this particular edit
// doesn't add any); a `[src: ...]` anchor appearing directly in the diff text is an even more
// direct signal, checked independently of path.
export const CITATION_TRIGGER_RE = /\.md$/i;
const CITATION_TEXT_RE = /\[src:\s*[^\]]*\]/;

// Surface-type definition-of-done gate trigger (design/UX gate's own path globs):
// `components/**`, `app/**/page.*`, `*.css`, `*.scss`. The fast path's manifest always sets
// `surface: "none"` (src/fast-path.js's buildFastPathManifest), so the `surface` field itself
// never fires these gates for a fast-path task -- but a diff can still physically touch a
// UI-globbed path, so this stays a live, diff-based check rather than trusting the static
// `surface: "none"` alone.
export const SURFACE_TRIGGER_RE = /(^|\/)components\/|(^|\/)app\/.*page\.|\.css$|\.scss$/i;

function assertDiffFilesArray(diffFiles, fnName) {
  if (!Array.isArray(diffFiles)) {
    throw new Error(`${fnName}: diffFiles must be an array of path strings, got ${typeof diffFiles}`);
  }
}

// Pure, deterministic: given the diff's changed file paths (and, optionally, the diff's own
// text, for the citation-in-text signal), reports which of the three review-gate content
// gates the diff could plausibly trigger. `any` is the single fold callers need for
// eligibility; the individual flags stay in the shape for glass-box diagnostics/logging.
export function detectReviewTriggers(diffFiles = [], { diffText = "" } = {}) {
  assertDiffFilesArray(diffFiles, "detectReviewTriggers");
  const paths = diffFiles.filter((f) => typeof f === "string");
  const mutantKill = paths.some((f) => MUTANT_KILL_TRIGGER_RE.test(f));
  const citation = paths.some((f) => CITATION_TRIGGER_RE.test(f)) || CITATION_TEXT_RE.test(diffText || "");
  const surface = paths.some((f) => SURFACE_TRIGGER_RE.test(f));
  return { mutantKill, citation, surface, any: mutantKill || citation || surface };
}

// The single eligibility gate a caller (review-gate/SKILL.md step 1, wired through the
// orchestrating agent) consults: light brief usable only for a single-reviewer, sub-threshold
// diff (reviewerCount:1) that trips none of the three content triggers above. Any other
// reviewerCount, or any trigger firing, means false -- always fall back to the full brief.
export function lightBriefEligible({ reviewerCount, diffFiles = [], diffText = "" } = {}) {
  if (reviewerCount !== 1) return false;
  return !detectReviewTriggers(diffFiles, { diffText }).any;
}
