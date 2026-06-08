// Pre-route triviality filter: a cheap, deterministic heuristic that flags when an outcome is too
// thin to plan against, so muster can decide whether to run an interactive interview. The model
// makes the final call; this is the pre-filter that keeps a one-line "fix it" from being routed as
// if it were a spec. Conservative by design — over-flagging wastes a question, under-flagging routes
// garbage, so signals only fire on clear evidence of underspecification.
const STOPWORDS = new Set(["a", "an", "the", "to", "of", "and", "or", "for", "it", "this", "that"]);

// A digit anywhere, or any measurable-criteria keyword, clears the no-success-criteria signal.
const CRITERIA = /\b(metric|measure|success|criteria|kpi|target|goal|increase|decrease|reduce|improve|conversion|rate|latency|throughput|by \d)\b/i;

// Bare imperative verbs that, on their own with no concrete object, signal a hand-wavy ask.
const VAGUE_VERB = /^(make|do|build|fix|improve|help|handle|update|change)\b/i;

// A concrete token rescues an outcome from vague-only: a quoted span, a proper noun (capitalized
// mid-sentence), or a digit all point at something specific enough to plan around.
const SPECIFIC = /["'`]|\d|\b[a-z]+[A-Z]|\s[A-Z]/;

export function assessOutcome(text) {
  if (typeof text !== "string" || !text.trim()) return { clear: false, signals: ["empty"] };
  const trimmed = text.trim();

  const meaningful = trimmed
    .split(/\s+/)
    .filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const tooShort = meaningful.length < 6;
  const noCriteria = !CRITERIA.test(trimmed);

  const signals = [];
  if (tooShort) signals.push("too-short");
  if (noCriteria) signals.push("no-success-criteria");
  // Conservative: only a bare vague verb that is ALSO too-short and criteria-less, with no concrete
  // token, counts as vague-only — keeps false positives off well-formed short outcomes.
  if (tooShort && noCriteria && VAGUE_VERB.test(trimmed) && !SPECIFIC.test(trimmed)) {
    signals.push("vague-only");
  }

  return { clear: signals.length === 0, signals };
}
