// Pre-route triviality filter: a cheap, deterministic heuristic that flags when an outcome is too
// thin to plan against, so muster can decide whether to run an interactive interview. The model
// makes the final call; this is the pre-filter that keeps a one-line "fix it" from being routed as
// if it were a spec. Conservative by design — over-flagging wastes a question, under-flagging routes
// garbage, so signals only fire on clear evidence of underspecification.
import { STOPWORDS } from "./keyword.js";

// A quantified pattern clears the no-success-criteria signal on its own: multi-digit "by N",
// a bare "N%", a comparative quantifier ("at least/at most/above/below/under/over/within")
// followed by a number, or "N consecutive". A bare digit alone does NOT count — digits embedded
// in identifiers/filenames (e.g. "file2.js", "config2") are not measurables, since \b requires
// a non-word boundary immediately before the digit run.
const CRITERIA_QUANTIFIED =
  /\bby \d+\b|\b\d+%|\b(?:at least|at most|above|below|under|over|within)\s+\d+\b|\b\d+\s+consecutive\b/i;
const NUMBER_WORD = "(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)";
const CRITERIA_QUANTIFIED_WORDS = new RegExp(
  `\\bby\\s+${NUMBER_WORD}\\b|\\b(?:at least|at most|above|below|under|over|within)\\s+${NUMBER_WORD}\\b|\\b${NUMBER_WORD}\\s+consecutive\\b|\\bzero\\s+(?:failures?|errors?|defects?|regressions?|dropped|lost)\\b`,
  "i",
);

// A measurable-criteria keyword ("improve", "target", "rate", ...) is necessary but not
// sufficient on its own — "improve X significantly" restates intent without stating a metric.
// A keyword only clears the signal when it co-occurs with an actual measurable elsewhere in the
// outcome (a boundary-safe digit, or a comparative quantifier word), so padding can't fake it.
const CRITERIA_KEYWORD =
  /\b(metric|measure|success|criteria|kpi|target|goal|increase|decrease|reduce|improve|conversion|rate|latency|throughput)\b/i;
const MEASURABLE_NEARBY = /\b\d|\b(?:at least|at most|above|below|under|over|within)\b/i;
const MEASURABLE_WORD_NEARBY = new RegExp(`\\b${NUMBER_WORD}\\b|\\b(?:at least|at most|above|below|under|over|within)\\b`, "i");

// Bare imperative verbs that, on their own with no concrete object, signal a hand-wavy ask.
const VAGUE_VERB = /^(make|do|build|fix|improve|help|handle|update|change)\b/i;

// A concrete token rescues an outcome from vague-only: a quoted span, a proper noun (capitalized
// mid-sentence), or a digit all point at something specific enough to plan around.
const SPECIFIC = /["'`]|\d|\b[a-z]+[A-Z]|\s[A-Z]/;

export function assessOutcome(text, { codex = false } = {}) {
  if (typeof text !== "string" || !text.trim()) return { clear: false, signals: ["empty"] };
  const trimmed = text.trim();

  const meaningful = trimmed
    .split(/\s+/)
    .filter((w) => !STOPWORDS.has(w.toLowerCase()));
  const tooShort = meaningful.length < 6;
  const hasQuantified = CRITERIA_QUANTIFIED.test(trimmed) || (codex && CRITERIA_QUANTIFIED_WORDS.test(trimmed));
  const hasKeyword = CRITERIA_KEYWORD.test(trimmed);
  const hasMeasurable = MEASURABLE_NEARBY.test(trimmed) || (codex && MEASURABLE_WORD_NEARBY.test(trimmed));
  const noCriteria = !(hasQuantified || (hasKeyword && hasMeasurable));

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
