// speed-tuning item, criterion 3: subagent brief/return discipline, verified by a lint over
// skill prose.
//
// A dispatched brief and the return contract it demands are both real, per-dispatch token
// cost -- this module is a deterministic, no-LLM lint over the ALREADY-WRITTEN skill/agent/
// command prose (never a live dispatch payload; muster has no runtime hook into an actual
// Agent-tool call to measure). The prose marks its own canonical brief/return-contract
// TEMPLATES with an explicit inline directive, the same discipline
// src/prompt-lint.js's `<!-- prompt-lint-disable ID: reason -->` already uses for a
// reviewable, machine-readable opt-out:
//
//   <!-- muster-brief-template:start -->  ... <!-- muster-brief-template:end -->
//   <!-- muster-return-template:start --> ... <!-- muster-return-template:end -->
//
// Any prose author adding a new dispatch/return-contract section wraps it in the matching
// marker pair; this lint then measures ONLY the marked span (never the whole file) against
// this item's stated budgets (<=2000 tokens per brief template, <=1000 tokens per
// return-contract template) and flags any marked span that exceeds its budget.
import { estimateTokens, DEFAULT_CHARS_PER_TOKEN } from "./token-projection.js";

export const BRIEF_TEMPLATE_MAX_TOKENS = 2000;
export const RETURN_CONTRACT_MAX_TOKENS = 1000;

const MARKERS = {
  brief: {
    start: "<!-- muster-brief-template:start -->",
    end: "<!-- muster-brief-template:end -->",
    maxTokens: BRIEF_TEMPLATE_MAX_TOKENS,
  },
  return: {
    start: "<!-- muster-return-template:start -->",
    end: "<!-- muster-return-template:end -->",
    maxTokens: RETURN_CONTRACT_MAX_TOKENS,
  },
};

// Returns every marked span of `kind` ("brief" | "return") as `{ tagStart, contentStart,
// contentEnd }` offsets into `text`, in order -- `tagStart` is the opening `<!-- muster-...
// -->` comment's OWN start (before the comment text), `contentStart`/`contentEnd` bracket the
// span's content (after the opening comment, before the closing one). The shared core
// `extractMarkedSections` (content strings) and `findUnmarkedDispatchSignals` (offset
// containment/adjacency checks, below) both build on this. Throws on an unterminated marker (an
// opening directive with no matching close) rather than silently scanning to EOF -- a missing
// close is an authoring mistake, not a legitimately huge span.
function markedSpanRanges(text, kind) {
  const marker = MARKERS[kind];
  if (!marker) throw new Error(`extractMarkedSections: unknown kind "${kind}" (expected "brief" or "return")`);
  const ranges = [];
  let searchFrom = 0;
  for (;;) {
    const tagStart = text.indexOf(marker.start, searchFrom);
    if (tagStart === -1) break;
    const contentStart = tagStart + marker.start.length;
    const contentEnd = text.indexOf(marker.end, contentStart);
    if (contentEnd === -1) {
      throw new Error(`extractMarkedSections: unterminated ${kind} marker (found "${marker.start}" with no matching "${marker.end}")`);
    }
    ranges.push({ tagStart, contentStart, contentEnd });
    searchFrom = contentEnd + marker.end.length;
  }
  return ranges;
}

// Extracts every marked span of `kind` ("brief" | "return") from `text`, in order. Throws on
// an unterminated marker (an opening directive with no matching close) rather than silently
// scanning to EOF -- a missing close is an authoring mistake, not a legitimately huge span.
export function extractMarkedSections(text, kind) {
  return markedSpanRanges(text, kind).map(({ contentStart, contentEnd }) => text.slice(contentStart, contentEnd));
}

// Scans a { path: text } map (the eval/test caller reads the real files) for every marked
// brief/return-contract span and flags any that exceeds its token budget. Returns
// { findings, briefCount, returnCount } -- `findings` empty means every marked span is
// within budget; the counts let a caller sanity-check that the scan actually found real
// marked content (a lint with zero markers anywhere proves nothing).
export function lintBriefReturnCaps(filesByPath, { charsPerToken = DEFAULT_CHARS_PER_TOKEN } = {}) {
  const findings = [];
  let briefCount = 0;
  let returnCount = 0;
  for (const [path, text] of Object.entries(filesByPath)) {
    for (const content of extractMarkedSections(text, "brief")) {
      briefCount++;
      const tokens = estimateTokens(content.length, charsPerToken);
      if (tokens > BRIEF_TEMPLATE_MAX_TOKENS) {
        findings.push({ path, kind: "brief", tokens, maxTokens: BRIEF_TEMPLATE_MAX_TOKENS });
      }
    }
    for (const content of extractMarkedSections(text, "return")) {
      returnCount++;
      const tokens = estimateTokens(content.length, charsPerToken);
      if (tokens > RETURN_CONTRACT_MAX_TOKENS) {
        findings.push({ path, kind: "return", tokens, maxTokens: RETURN_CONTRACT_MAX_TOKENS });
      }
    }
  }
  return { findings, briefCount, returnCount };
}

// --- Coverage guard (brief-lint-coverage item) -----------------------------------------------
//
// The budget check above only ever measures spans an author already wrapped in a marker --
// nothing stops a NEW dispatch-brief/return-contract template from being added (or an existing
// marker from being stripped by an unrelated edit) with no marker at all, invisible to
// `lintBriefReturnCaps` by construction. This is the second, independent half: a fixed list of
// regex SIGNALS, each one a heading or literal phrase that -- by inspection of every dispatch
// site currently in `plugin/agents`, `plugin/commands`, and `plugin/skills` -- reliably marks
// real per-dispatch brief/return-contract prose (a builder/reviewer/etc. agent's own "## Report
// back", the review-gate skill's own reviewer-identity line, the tournament synthesizer's
// verbatim prompt, and so on) rather than a passing mention of the words "brief" or "return"
// elsewhere. `findUnmarkedDispatchSignals` flags any signal match that is NOT contained inside a
// `muster-brief-template`/`muster-return-template` marked span -- exactly the shape a forgotten
// marker (new template, or a marker accidentally deleted from an old one) takes. This is
// necessarily a fixed, named list (deterministic, no-LLM, same discipline as the rest of this
// module) -- it catches drift that reuses one of these known shapes, not literally any possible
// future prose; test/brief-lint-coverage.test.js documents that scope honestly and proves the
// detector against a synthetic unmarked fixture (not just the already-clean real repo).
export const DISPATCH_SIGNAL_PATTERNS = [
  { name: "dispatch-contract-heading", re: /^## Dispatch contract$/m },
  { name: "report-back-heading", re: /^## Report back$/m },
  { name: "verdict-heading", re: /^## Verdict$/m },
  { name: "return-contract-heading", re: /^## Return contract\b.*$/m },
  { name: "request-response-shapes-heading", re: /^## Request and response shapes$/m },
  { name: "go-spec-gate-return-contract", re: /Return contract: verdict first/ },
  { name: "audit-sweep-return-contract", re: /Each returns findings: severity \(P0\/P1\/P2\)/ },
  { name: "review-gate-full-brief-identity", re: /You are muster's adversarial review gate/ },
  { name: "review-gate-fast-path-brief-identity", re: /You are muster's adversarial reviewer for a small/ },
  { name: "tournament-synthesizer-prompt", re: /You are given several candidate responses, de-identified and numbered/ },
  { name: "tournament-judge-scoring-shape", re: /scores: \{ criterion: n \}, total, passing/ },
];

// Scans a { path: text } map for every DISPATCH_SIGNAL_PATTERNS match (or a caller-supplied
// `patterns` override, e.g. for a synthetic mutant-test fixture) and returns the ones whose match
// offset falls outside every marked span (brief AND return) in that file -- `[]` means every
// recognized dispatch signal in the corpus is marked (and therefore already budget-checked by
// `lintBriefReturnCaps`).
//
// "Covered" allows two shapes, both real conventions this corpus uses: the signal text sits
// STRICTLY INSIDE a marked span's content (e.g. go.md's inline "Return contract: ..." phrase, or
// a whole dispatched-brief file marked start-to-end), OR the signal is a heading that IMMEDIATELY
// PRECEDES a marker's OPENING TAG with nothing but whitespace between them (e.g. "## Report back"
// on its own line, directly above the `<!-- muster-return-template:start -->` that wraps the
// section's actual content) -- the heading names the template; the marker wraps its body;
// together they are one covered unit. A heading followed by anything other than whitespace before
// the next marker tag (unrelated prose, or no marker at all) is NOT covered -- exactly the
// forgotten-marker case this lint exists to catch.
function signalIsCovered(text, matchStart, matchEnd, ranges) {
  for (const { tagStart, contentStart, contentEnd } of ranges) {
    if (matchStart >= contentStart && matchStart < contentEnd) return true; // inside the marked content
    if (matchEnd <= tagStart && text.slice(matchEnd, tagStart).trim() === "") return true; // heading -> marker tag, only whitespace between
  }
  return false;
}

export function findUnmarkedDispatchSignals(filesByPath, { patterns = DISPATCH_SIGNAL_PATTERNS } = {}) {
  const unmarked = [];
  for (const [path, text] of Object.entries(filesByPath)) {
    const briefRanges = markedSpanRanges(text, "brief");
    const returnRanges = markedSpanRanges(text, "return");
    for (const { name, re } of patterns) {
      const match = re.exec(text);
      if (!match) continue;
      const matchStart = match.index;
      const matchEnd = matchStart + match[0].length;
      const covered =
        signalIsCovered(text, matchStart, matchEnd, briefRanges) ||
        signalIsCovered(text, matchStart, matchEnd, returnRanges);
      if (!covered) unmarked.push({ path, signal: name });
    }
  }
  return unmarked;
}
