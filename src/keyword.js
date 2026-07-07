// Escapes regex metacharacters in a string so it can be safely interpolated
// into a `new RegExp(...)` pattern (e.g. for whole-word keyword matching).
export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Shared stopword set for src/match.js's ranker and src/interview.js's outcome-clarity
// heuristic. Reconciled from the two lists that had already diverged (match.js lacked
// "or"; interview.js lacked "with"/"is"/"in"/"on") into one union, verified behavior-
// preserving for both callers: match.js's tokenize() already drops sub-3-char tokens
// before the stopword check, so "or" (2 chars) was already filtered regardless; and
// interview.js's meaningful-word-count boundary was checked against its test suite +
// eval:modes/eval:router with no regression.
export const STOPWORDS = new Set([
  "a", "an", "and", "for", "in", "is", "it", "of", "on", "or", "that", "the", "this", "to", "with",
]);

// Lowercase, split on non-alphanumerics, drop <3-char tokens and stopwords. Caller dedupes.
// Shared by src/match.js's rankers (matchProviders/matchSkills/signalsFromTask).
export function tokenize(text) {
  if (typeof text !== "string") return [];
  return text.toLowerCase().split(/[^a-z0-9]+/)
    .filter(t => t.length >= 3 && !STOPWORDS.has(t));
}
