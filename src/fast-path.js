// weight-reduction item, criterion 1 (flagship): single-agent fast path.
//
// Crew assembly (the router SKILL.md's LLM dispatch: specialist search, per-task skill
// binding, surface assignment, the gap protocol) is real reasoning weight paid on EVERY
// outcome, even a one-line trivial fix that has nothing for any of that machinery to
// catch. gate-cadence.js's existing SMALL_TASK_THRESHOLD rule already skips the spec gate
// for a single-task plan, but that decision runs AFTER crew assembly (it scores the
// manifest's computed waves) -- it cannot skip the assembly step itself, because the
// manifest doesn't exist yet.
//
// This module is the PRE-router decision: score the raw outcome TEXT (before any plan
// exists) for whether it is small/single-task enough that the router's full elaborate
// pass is unnecessary, and -- when eligible -- build the minimal manifest directly from
// already-resolved capabilities (no LLM dispatch at all): one task, a builder, and ONE
// reviewer. `plugin/commands/go.md` step 3 wires this in: run `capabilities` (still
// needed, cheap and deterministic, no LLM) either way, but only invoke the router SKILL
// when `scoreOutcomeForFastPath` reports `eligible: false`.
//
// The score is a heuristic over TEXT, not a decomposed plan, so it is deliberately
// conservative: any cross-cutting-scope keyword, multi-deliverable separator, chained
// imperative verbs, an audit/review-scope verb, 2+ enumerated file paths, or an outcome
// long enough to plausibly hide more than one deliverable disqualifies it. False negatives
// (a genuinely small outcome routed the slow way) cost
// nothing but the normal crew-assembly overhead this item is trying to cut for the COMMON
// case; false positives (a multi-task outcome wrongly taking the fast path) would violate
// criterion 5's hard constraint, so every disqualifying signal below errs toward NOT
// eligible. Same discipline as src/interview.js's assessOutcome and src/scope.js's
// detectScope -- deterministic regex signals only, no judgment call smuggled in.
import { STOPWORDS } from "./keyword.js";

// Cross-cutting/broad-scope vocabulary: an outcome naming a repo-wide, cross-service, or
// "the whole X" scope is never a small/local change, regardless of word count.
const CROSS_CUTTING_RE =
  /\b(across|throughout|entire|everywhere|every\s+(?:file|module|service|package|repo|test|suite)|all\s+the|overhaul|migrate|migration|epic|rewrite|redesign|refactor\s+the\s+whole|end-to-end|end\s+to\s+end|multiple\s+(?:services|modules|packages|repos|files))\b/i;

// Shared imperative-verb lexicon: used by CHAINED_VERBS_RE below and by
// MULTI_DELIVERABLE_RE's clause-gated separators. Deliberately a closed list of
// unambiguous task-starting verbs so neither signal over-fires on nouns.
const IMPERATIVE_VERB_SRC =
  "add|fix|update|remove|delete|refactor|implement|create|build|write|change|rename|migrate|extract|wire|extend|document|test";

// Multiple-deliverable separators: connective phrases, semicolons, list markers, or --
// clause-gated -- a comma/plus/newline INTRODUCING a new imperative clause. The gate is
// the point: "Add retry support, update the README" is two asks (comma + imperative
// verb), while "Add retry, backoff, and jitter to fetch" is ONE task with a compound
// object (comma + noun) and must stay fast-path eligible. An ungated [;,+]|\n here
// (tried and reverted in the codex-native audit, PR #73) over-routes every
// punctuation-bearing atomic outcome onto the heavy path -- weight inflation on the
// most common punctuation in English.
const MULTI_DELIVERABLE_RE = new RegExp(
  "\\band\\s+then\\b|\\balso\\b|\\badditionally\\b|\\bas\\s+well\\s+as\\b|;" +
  `|[,+]\\s*(?:and\\s+|then\\s+)?(?:${IMPERATIVE_VERB_SRC})\\b` +
  `|\\n\\s*(?:[-*]\\s|\\d+[.)]\\s|(?:${IMPERATIVE_VERB_SRC})\\b)` +
  "|^\\s*\\d+[.)]\\s",
  "i"
);

// Review-scope action verbs: an outcome whose action is to AUDIT / REVIEW / SWEEP a scope is
// a read-and-assess-then-remediate task spanning some surface -- categorically not the single
// build/fix slice the fast path is for (builder + ONE reviewer, one task; an audit's real crew
// is an investigator + a security/coverage reviewer + a findings ledger). An audit is never one
// small task. None of the existing signals catch a terse "audit src/a.js src/b.js ..." -- its
// verb is not in the imperative build lexicon and "the repo"/"the module" are not the
// cross-cutting vocabulary -- so run-5 dogfood scored it fast-path ELIGIBLE. The match is
// deliberately anchored to the LEADING imperative position (the form muster outcomes use --
// "audit X", "review Y", "sweep Z", also "re-audit X"). That anchor is the point, and it is
// kept strict on purpose: an EARLIER unanchored "<dimension> audit|review" branch (and the
// speculative "inspect"/"assess" verbs) were tried and REVERTED -- they fired on ordinary
// build tasks whose object merely NAMES a review noun ("add a code review bot config", "wire up
// the dependency review action", "assess the retry logic and add backoff"), which are common
// CI/tooling proper nouns, not audit actions. Catching an action-led "run a security audit of
// X" is not worth that false-positive cost: a missed audit only pays the normal crew-assembly
// overhead (a cheap false negative), while wrongly disqualifying a build task is the failure
// this module errs against. So "add an audit log to payments" (verb "add", object is an audit
// log) and "add a review step" stay eligible -- neither LEADS with the review verb.
const REVIEW_SCOPE_RE = /^\s*(?:re-?)?(?:audit|review|sweep)\b/i;

// File-path tokens: a whitespace-delimited token carrying a real directory separator and a
// dotted ALPHABETIC extension (e.g. "src/a.js", "lib/foo/bar.ts", ".github/x.yml"). Two
// deliberate constraints keep false positives rare: (1) the "/"-requirement -- a bare
// "name.ext" would misfire on prose abbreviations ("e.g.", "i.e."); (2) the extension is
// LETTERS only ([A-Za-z]{1,6}) so numeric fractions/versions/ports ("3/4.5", "v1/2.0") are
// not read as paths. A SINGLE path is a legitimate single-file slice ("add a retry helper to
// src/fetch.js") that must stay eligible; only 2+ DISTINCT paths (deduped -- the same file
// named twice in prose is still one file) is a multi-file shape (the run-5 audit named three),
// more than one deliverable's worth of surface, never the fast path.
const FILE_PATH_RE = /\S*\/\S*\.[A-Za-z]{1,6}\b/g;

// Two (or more) independent imperative verbs joined by "and" -- "add X and fix Y" is two
// tasks even with no other multi-deliverable signal. A single verb governing a compound
// OBJECT ("add X and Y", "implement Z and document it") is not caught by this on its own
// -- MULTI_DELIVERABLE_RE and CROSS_CUTTING_RE cover those cases when they are genuinely
// two deliverables; this signal is deliberately narrow (verb ... and ... verb) so it
// doesn't over-fire on "read and write", "build and test" style compound single actions.
const CHAINED_VERBS_RE = new RegExp(`\\b(?:${IMPERATIVE_VERB_SRC})\\b[^.\\n]*\\band\\b[^.\\n]*\\b(?:${IMPERATIVE_VERB_SRC})\\b`, "i");

// A word-count ceiling: past this many meaningful (non-stopword) words, an outcome is
// long enough that it plausibly hides more than one deliverable even with none of the
// above signals firing. Deliberately generous -- most genuinely single-task outcomes are
// much shorter than this -- so it only catches outcomes that are already unusually long.
export const FAST_PATH_MAX_WORDS = 25;

export function scoreOutcomeForFastPath(text) {
  if (typeof text !== "string" || !text.trim()) {
    return { eligible: false, wordCount: 0, reason: "empty outcome: nothing to fast-path" };
  }
  const trimmed = text.trim();
  const wordCount = trimmed.split(/\s+/).filter((w) => !STOPWORDS.has(w.toLowerCase())).length;

  const reasons = [];
  if (CROSS_CUTTING_RE.test(trimmed)) {
    reasons.push('cross-cutting scope signal (e.g. "across", "migrate", "overhaul", "every service") -- not a small/local change');
  }
  if (MULTI_DELIVERABLE_RE.test(trimmed)) {
    reasons.push('multiple-deliverable separator (list markers, "also"/"and then"/"as well as", a semicolon) -- more than one task');
  }
  if (CHAINED_VERBS_RE.test(trimmed)) {
    reasons.push('two or more independent imperative verbs joined by "and" -- more than one task');
  }
  if (REVIEW_SCOPE_RE.test(trimmed)) {
    reasons.push('audit/review-scope verb (e.g. "audit", "review", "sweep", "security audit") -- a read-and-assess task across a scope, never a single build slice');
  }
  const distinctPaths = new Set(trimmed.match(FILE_PATH_RE) || []);
  if (distinctPaths.size >= 2) {
    reasons.push(`outcome enumerates ${distinctPaths.size} distinct file paths -- a multi-file shape, more than one deliverable's worth of surface`);
  }
  if (wordCount > FAST_PATH_MAX_WORDS) {
    reasons.push(`outcome is ${wordCount} meaningful words, over the ${FAST_PATH_MAX_WORDS}-word fast-path bound -- likely hides more than one task`);
  }

  if (reasons.length > 0) {
    return { eligible: false, wordCount, reason: reasons.join("; ") };
  }
  return {
    eligible: true,
    wordCount,
    reason: `single-task/small outcome (${wordCount} meaningful words, no cross-cutting or multi-deliverable signal) -- fast path applies: skip crew assembly + spec gate, builder + one reviewer only`,
  };
}

// Builds the minimal Crew Manifest directly from already-resolved capabilities (the SAME
// `resolveCapabilities()` shape `plugin/commands/go.md` step 3 already captures once into
// `.muster/capabilities.json` -- this never re-resolves capabilities itself, it only reads
// the roles it needs off the object the caller passes in). No LLM dispatch: this is a pure
// deterministic construction, unlike the router SKILL.md persona it substitutes for.
export function buildFastPathManifest({ outcome, successCriteria, capabilities, mergeDisposition = "ask" } = {}) {
  if (typeof outcome !== "string" || !outcome.trim()) {
    throw new Error("buildFastPathManifest: outcome is required (non-empty string)");
  }
  const score = scoreOutcomeForFastPath(outcome);
  if (!score.eligible) {
    throw new Error(`buildFastPathManifest: outcome is not eligible for the fast path: ${score.reason}`);
  }
  if (!capabilities || typeof capabilities !== "object" || !capabilities.roles) {
    throw new Error("buildFastPathManifest: capabilities (resolveCapabilities() output, with a .roles map) is required");
  }
  const implement = capabilities.roles.implement;
  const review = capabilities.roles["code-review"];
  if (!implement || !review) {
    throw new Error("buildFastPathManifest: capabilities.roles must include both 'implement' and 'code-review'");
  }

  const crewMember = (stage, roleEntry, rationale) => ({
    stage,
    provider: roleEntry.chosen.id,
    source: roleEntry.chosen.source,
    model: roleEntry.model,
    rationale,
    evidence: "fast path: outcome scored eligible by scoreOutcomeForFastPath (single-task/small, no cross-cutting or multi-deliverable signal)",
    fallback: roleEntry.chain?.[roleEntry.chain.length - 1]?.id || "inline",
  });

  return {
    outcome,
    successCriteria: Array.isArray(successCriteria) && successCriteria.length > 0 ? successCriteria : [outcome],
    crew: [
      crewMember("implement", implement, "builder -- fast path skips full crew assembly (the router dispatch) for a single-task/small outcome"),
      crewMember("review", review, "one reviewer -- fast path batches review to a single pass, no second reviewer dispatched"),
    ],
    recommendations: [],
    degradations: [],
    mergeDisposition,
    forbiddenActions: [],
    plan: [{ id: "t1", task: outcome, mode: "single", deps: [], surface: "none" }],
  };
}
