// Escapes regex metacharacters in a string so it can be safely interpolated
// into a `new RegExp(...)` pattern (e.g. for whole-word keyword matching).
export function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

// Shared stopword set for src/match.js's ranker and src/interview.js's outcome-clarity
// heuristic. Reconciled from the two lists that had already diverged (match.js lacked
// "or"; interview.js lacked "with"/"is"/"in"/"on") into one union.
// For match.js this is a true no-op: tokenize() already drops sub-3-char tokens before
// the stopword check runs, so "or" (2 chars) was already filtered regardless of whether
// it was in STOPWORDS.
// For interview.js this is a disclosed, narrow behavior change, NOT a proven no-op:
// "with"/"is"/"in"/"on" are now excluded from its meaningful-word count too (it has no
// length-based rescue the way match.js's tokenize() does), which can flip `tooShort`
// false->true for an outcome sitting right at the 6-word boundary that happens to use
// one of these four words. test/interview.test.js + eval:modes/eval:router show no
// regression against the current corpus, but that is evidence against today's fixtures,
// not a formal guarantee for every future outcome string.
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
