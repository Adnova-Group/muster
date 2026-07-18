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
// imperative verbs, or an outcome long enough to plausibly hide more than one deliverable
// disqualifies it. False negatives (a genuinely small outcome routed the slow way) cost
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

// Multiple-deliverable separators: list punctuation, bare newlines, or connective
// phrases that stitch two-or-more independent asks into one sentence.
const MULTI_DELIVERABLE_RE =
  /\band\s+then\b|\balso\b|\badditionally\b|\bas\s+well\s+as\b|[;,+]|\n|^\s*\d+[.)]\s/i;

// Two (or more) independent imperative verbs joined by "and" -- "add X and fix Y" is two
// tasks even with no other multi-deliverable signal. A single verb governing a compound
// OBJECT ("add X and Y", "implement Z and document it") is not caught by this on its own
// -- MULTI_DELIVERABLE_RE and CROSS_CUTTING_RE cover those cases when they are genuinely
// two deliverables; this signal is deliberately narrow (verb ... and ... verb) so it
// doesn't over-fire on "read and write", "build and test" style compound single actions.
const IMPERATIVE_VERB_SRC =
  "add|fix|update|remove|delete|refactor|implement|create|build|write|change|rename|migrate|extract|wire|extend|document|test";
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
