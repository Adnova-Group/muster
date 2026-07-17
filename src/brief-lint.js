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
// `sectionOwned: true` marks a signal that is itself a markdown heading owning the WHOLE
// section beneath it (from the heading to the next `## ` heading, or EOF) -- for these, coverage
// requires the marker to span that entire section, not just sit near the heading (see
// `signalIsCovered`'s review-fix note below: a heading + a trivially small marked span + a huge
// UNMARKED tail before the next heading must NOT read as covered, since the tail is exactly the
// real, unbudgeted template content). Every other signal is a hand-picked inline phrase already
// wrapped tightly around its own real content (a whole file, a single sentence, a lettered
// sub-bullet) with no comparable "rest of the section" to silently leave unmarked, so the
// simpler strictly-inside-the-span check is enough for those.
//
// Disclosed scope gap (review finding, fix loop 1): each muster-{builder,strategist,investigator,
// improver,surgeon}.md agent ALSO opens with a one-line "Respond with a structured ..." sentence
// that paraphrases the very same return contract its marked "## Report back" section states in
// full below -- that opening sentence carries no signal of its own here, so a future edit that
// ONLY bloats the one-liner (leaving "## Report back" untouched) would not trip this guard.
// Accepted as-is: these sentences are short by construction and duplicate content this list
// already marks and budget-checks in full further down the same file; a signal exists for the
// canonical, fuller statement of each contract, not for every paraphrase of it.
export const DISPATCH_SIGNAL_PATTERNS = [
  { name: "dispatch-contract-heading", re: /^## Dispatch contract$/m, sectionOwned: true },
  { name: "report-back-heading", re: /^## Report back$/m, sectionOwned: true },
  { name: "verdict-heading", re: /^## Verdict$/m, sectionOwned: true },
  { name: "return-contract-heading", re: /^## Return contract\b.*$/m, sectionOwned: true },
  { name: "request-response-shapes-heading", re: /^## Request and response shapes$/m, sectionOwned: true },
  { name: "go-spec-gate-return-contract", re: /Return contract: verdict first/ },
  { name: "audit-sweep-return-contract", re: /Each returns findings: severity \(P0\/P1\/P2\)/ },
  { name: "review-gate-full-brief-identity", re: /You are muster's adversarial review gate/ },
  { name: "review-gate-fast-path-brief-identity", re: /You are muster's adversarial reviewer for a small/ },
  { name: "tournament-synthesizer-prompt", re: /You are given several candidate responses, de-identified and numbered/ },
  { name: "tournament-judge-scoring-shape", re: /scores: \{ criterion: n \}, total, passing/ },
];

// The start of the next `## `-level heading at or after `fromIndex`, or `text.length` (EOF) when
// none remains -- the section boundary a `sectionOwned` signal's marker must reach.
function nextSectionBoundary(text, fromIndex) {
  const re = /^## /m;
  re.lastIndex = 0;
  const rest = text.slice(fromIndex);
  const match = re.exec(rest);
  return match ? fromIndex + match.index : text.length;
}

// Scans a { path: text } map for every DISPATCH_SIGNAL_PATTERNS match (or a caller-supplied
// `patterns` override, e.g. for a synthetic mutant-test fixture) and returns every match whose
// offset falls outside every marked span (brief AND return) in that file -- `[]` means every
// recognized dispatch signal in the corpus is marked (and therefore already budget-checked by
// `lintBriefReturnCaps`).
//
// "Covered" allows two shapes, both real conventions this corpus uses:
//
//   1. An inline signal's text sits STRICTLY INSIDE a marked span's content (e.g. go.md's inline
//      "Return contract: ..." phrase, or a whole dispatched-brief file marked start-to-end).
//   2. A `sectionOwned` heading's (e.g. "## Report back") WHOLE SECTION -- from right after the
//      heading line to the next `## `-level heading, or EOF -- is FULLY partitioned by one or
//      more marked spans (brief and/or return) with nothing but whitespace in the gaps: before
//      the first span, between consecutive spans, and after the last span through the section
//      boundary. Muster-runner.md's "## Dispatch contract" section is exactly this shape: one
//      brief-template span (the BRIEF contents) followed by one return-template span (the return
//      receipts), nothing but a blank line between and after them -- two markers, one fully-owned
//      section. A heading followed by unrelated prose before any marker (or no marker at all) is
//      not covered -- the forgotten-marker case. Review finding this closes: a heading
//      immediately followed by a trivially small marked span that leaves the section's REAL,
//      unbounded content UNMARKED afterward must NOT read as covered -- that shape would
//      otherwise pass while leaving the actual per-dispatch content entirely outside
//      `lintBriefReturnCaps`'s budget check, defeating the point of this guard. Requiring the
//      section's non-whitespace content to be fully accounted for by marker spans closes that
//      gap without breaking the legitimate multi-marker-per-section case.
function sectionIsFullyMarked(text, sectionStart, sectionEnd, allSpans) {
  const inSection = allSpans
    .filter((s) => s.tagStart >= sectionStart && s.tagStart < sectionEnd)
    .sort((a, b) => a.tagStart - b.tagStart);
  if (inSection.length === 0) return false;
  let cursor = sectionStart;
  for (const span of inSection) {
    if (text.slice(cursor, span.tagStart).trim() !== "") return false;
    cursor = span.closingTagEnd;
  }
  return text.slice(cursor, sectionEnd).trim() === "";
}

function signalIsCovered(text, matchStart, matchEnd, sectionOwned, allSpans) {
  for (const { contentStart, contentEnd } of allSpans) {
    if (matchStart >= contentStart && matchStart < contentEnd) return true; // inside a marked span's content
  }
  if (!sectionOwned) return false; // an inline signal has no "rest of section" to check
  const sectionEnd = nextSectionBoundary(text, matchEnd);
  return sectionIsFullyMarked(text, matchEnd, sectionEnd, allSpans);
}

// Every match of `re` in `text`, as `[start, end)` offsets -- always scans with a fresh global
// copy of the pattern regardless of the flags the caller wrote it with, so a repeated signal (two
// "## Report back" sections, one marked and one added later without a marker) is never silently
// reduced to just its first occurrence.
function allMatches(re, text) {
  const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const matches = [];
  for (const match of text.matchAll(global)) {
    matches.push([match.index, match.index + match[0].length]);
  }
  return matches;
}

export function findUnmarkedDispatchSignals(filesByPath, { patterns = DISPATCH_SIGNAL_PATTERNS } = {}) {
  const unmarked = [];
  for (const [path, text] of Object.entries(filesByPath)) {
    const allSpans = [
      ...markedSpanRanges(text, "brief").map((s) => ({ ...s, closingTagEnd: s.contentEnd + MARKERS.brief.end.length })),
      ...markedSpanRanges(text, "return").map((s) => ({ ...s, closingTagEnd: s.contentEnd + MARKERS.return.end.length })),
    ];
    for (const { name, re, sectionOwned } of patterns) {
      for (const [matchStart, matchEnd] of allMatches(re, text)) {
        if (!signalIsCovered(text, matchStart, matchEnd, sectionOwned, allSpans)) {
          unmarked.push({ path, signal: name });
        }
      }
    }
  }
  return unmarked;
}
