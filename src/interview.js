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

// Prose-form success criteria (backlog item codex-assess-criteria-detect, 2026-07-18 Codex
// dogfood): an engineering-shaped outcome routinely states its acceptance behavior as prose
// clauses -- "the builder accepts an injected verifier, receipts record verified: true/false,
// callers fail loud when verification fails" -- rather than a "Success criteria:"-labeled
// list or a bare metric. The two clearing paths above (CRITERIA_QUANTIFIED,
// CRITERIA_KEYWORD+MEASURABLE_NEARBY) both structurally require a digit or a
// measurement-vocabulary word, so a purely-prose, purely-behavioral spec like that one trips
// neither and reads as "no-success-criteria" even though it is exhaustively specific.
//
// "fail(s) loud(ly)" / "fail-loud" -- muster's own named failure-discipline phrase -- is the
// ONE prose-criteria signal kept here. It survived two rounds of adversarial review with zero
// breaks found. Two other candidate signals were tried and DELIBERATELY DROPPED after both
// proved structurally unsound, not just under-tuned:
//   - an explicit obligation ("must"/"should" + a verb). Fix-loop 1's ungated
//     `must/should + [a-z]+` cleared plain vague modal filler ("you must be kidding, just
//     handle it"). Fix-loop 2 narrowed it to a closed ~30-verb whitelist mirroring this file's
//     VAGUE_VERB precedent -- and it STILL cleared "fix the reporting bug, it must include
//     some improvements I guess" and "honestly you must validate my feelings sometimes, it's
//     exhausting", because ordinary English reuses almost every verb across technical and
//     casual registers; no verb whitelist closes that gap, only hedge-aware clause parsing
//     could, which this module deliberately doesn't do (deterministic regex signals only).
//   - a labeled field:value pair ("verified: true/false", "status: ok"). Fix-loop 1's open
//     `[a-z][\w-]*:` label cleared ordinary discourse asides ("note: yes, ..."). Fix-loop 2's
//     closed field-name whitelist (status/verified/valid/...) still cleared "handle the
//     reporting bug, status: ok this is fine for now I think" -- the same vague-primary-clause-
//     plus-incidental-aside shape, just with a whitelisted field name substituted for "note".
// Neither signal is load-bearing for the dogfood fixture (CRITERIA_FAIL_LOUD alone clears it,
// via both "fail loud" and "fail-loud" occurring in the text), so this file stays with the one
// signal proven robust rather than continuing to narrow vocabulary against an open-ended
// vague-sentence-plus-incidental-aside construction. Also deliberately NOT added: a generic
// "enumerated concrete behaviors" verb-counting heuristic, for the identical reason.
const CRITERIA_FAIL_LOUD = /\bfail(?:s|ing)?[\s-]loud(?:ly)?\b/i;

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
  const hasProseCriteria = CRITERIA_FAIL_LOUD.test(trimmed);
  const noCriteria = !(hasQuantified || (hasKeyword && hasMeasurable) || hasProseCriteria);

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
