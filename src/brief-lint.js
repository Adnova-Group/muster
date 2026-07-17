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

// Extracts every marked span of `kind` ("brief" | "return") from `text`, in order. Throws on
// an unterminated marker (an opening directive with no matching close) rather than silently
// scanning to EOF -- a missing close is an authoring mistake, not a legitimately huge span.
export function extractMarkedSections(text, kind) {
  const marker = MARKERS[kind];
  if (!marker) throw new Error(`extractMarkedSections: unknown kind "${kind}" (expected "brief" or "return")`);
  const sections = [];
  let searchFrom = 0;
  for (;;) {
    const startIdx = text.indexOf(marker.start, searchFrom);
    if (startIdx === -1) break;
    const contentStart = startIdx + marker.start.length;
    const endIdx = text.indexOf(marker.end, contentStart);
    if (endIdx === -1) {
      throw new Error(`extractMarkedSections: unterminated ${kind} marker (found "${marker.start}" with no matching "${marker.end}")`);
    }
    sections.push(text.slice(contentStart, endIdx));
    searchFrom = endIdx + marker.end.length;
  }
  return sections;
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
