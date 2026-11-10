// Deterministic AI-tell score (0–100) for human-facing text — the measurable, CI-gateable
// companion to the [[muster-humanizer]] LLM rewrite. Pure + synchronous, no API calls: every
// detector is a regex/heuristic, so the same text always scores the same. 100 = no tells found;
// each detected tell subtracts a weighted penalty (capped per category so one noisy category can't
// alone zero a long, otherwise-clean document). Adapted from conorbronsdon/avoid-ai-writing's
// scored-engine idea + the humanizer tell taxonomy. Every word and phrase below traces to an
// MIT source (avoid-ai-writing's SKILL/references/detector, blader/humanizer,
// aaaronmiller/humanize-writing, hardikpandya/stop-slop, petergyang/no-ai-slop) or is muster's own; vendor/manifest.yaml records the
// 2026-11-09 clean-room review that set these lists and the re-pin that refreshed them.

// Each detector: { category, weight (penalty per hit), cap (max penalty from this category), re }.
// `re` MUST be global (/g) so match counting works. A detector may instead carry `count(text)`,
// returning the matched strings, for rules a single regex cannot express (paragraph clusters).
// Weight rationale: em/en dash is the single strongest tell (7); banned openers, signposting,
// chat residue and cutoff disclaimers are strong sentence-level tells (5–6); tier-1 vocab is a
// per-word tell (4); copula, hedge stacks and clusters are weaker (3); curly quotes are weak alone
// because word processors curl them (2). Caps ≈ 3–6 hits before a category saturates, so one
// repeated tell in a long document can't alone drive the score to 0 — multiple tell *types* are
// what sink it. Values are heuristic, not empirically calibrated; tune against scored examples,
// don't treat them as exact.

// Tier 2: ordinary words that only count when two or more share a paragraph (avoid-ai-writing's
// Tier 2 rule). Kept identical to the Tier 2 list in muster-humanizer/SKILL.md.
const TIER2_RE = /\b(?:navigate|intricate|crucial|vital|essential|comprehensive|nuanced|myriad|streamline|bolster|encompass|cornerstone|plethora|harness|foster|elevate|facilitate|multifaceted|quietly|garner)\b/gi;

const DETECTORS = [
  // Em/en dash. Both upstreams also treat a spaced double hyphen ( -- ) as a dash; the rewrite
  // rule in SKILL.md bans it, but the scorer does not count it yet because muster's own docs use
  // it as their plain-ASCII separator and would need a sweep first.
  { category: "em/en-dash", weight: 7, cap: 28, re: /[—–]/g },
  // Curly quotes (not a curly apostrophe inside a word, as in don’t): weak alone, since editors
  // and word processors auto-curl them.
  { category: "curly-quote", weight: 2, cap: 8, re: /[“”‘]|(?<![A-Za-z])’|’(?![A-Za-z])/g },
  { category: "banned-opener", weight: 6, cap: 24, re: /(?:^|\n)\s*(?:Certainly|Moreover|Additionally|Furthermore|Notably|Importantly|Interestingly|Undoubtedly|Ultimately)\b/gi },
  { category: "signposting", weight: 5, cap: 25, re: /\b(?:it'?s important to note|it'?s worth noting|in today'?s world|at the end of the day|when it comes to|needless to say|let'?s dive in|let'?s explore|let'?s break (?:this|it) down|here'?s what you need to know|here'?s the thing|without further ado|in conclusion|that being said|let me be clear|the uncomfortable truth is|here'?s what nobody tells you|what most people get wrong|the part everyone misses)\b/gi },
  { category: "tier1-vocab", weight: 4, cap: 28, re: /\b(?:delve|leverage|tapestry|realm|testament|robust|seamless|embark|landscape|paradigm|pivotal|underscore|showcase|utilize|holistic|synergy|game-changer|cutting-edge|meticulous|interplay|vibrant|nestled|enduring)\b/gi },
  { category: "tier2-cluster", weight: 3, cap: 12, count: tier2Clusters },
  { category: "negative-parallelism", weight: 6, cap: 18, re: /\bnot just\b[^.\n]{1,60}?\b(?:it'?s|but)\b|\bit'?s not (?:about|just)\b[^.\n]{1,60}?\bit'?s\b/gi },
  { category: "copula-avoidance", weight: 3, cap: 12, re: /\b(?:serves as|boasts|stands as|functions as|plays a (?:crucial|key|vital|pivotal|significant) role)\b/gi },
  { category: "hedge-stack", weight: 3, cap: 9, re: /\b(?:could|may|might) (?:potentially|possibly|arguably)\b/gi },
  { category: "sycophancy", weight: 6, cap: 18, re: /\b(?:great question|i hope this helps|you'?re absolutely right|feel free to reach out|would you like me to|let me know if you'?d like me to)\b/gi },
  { category: "cutoff-disclaimer", weight: 6, cap: 18, re: /\b(?:as of my last (?:training )?update|up to my last training update|as of my knowledge cut-?off|while specific details are (?:limited|scarce)|as an ai (?:language )?model)\b/gi },
  { category: "generic-conclusion", weight: 4, cap: 12, re: /\b(?:the future looks bright|only time will tell|exciting times (?:lie |are )?ahead)\b/gi },
  // Emoji & pictographs (1F300–1FAFF) + regional-indicator flag letters (1F1E6–1F1FF). The old
  // 2600–27BF block was dropped: it flagged ordinary typographic dingbats (✓ ★ ☎ ✏ ♻) as AI tells.
  // ZWJ-sequence emoji still count — each component sits in 1F300–1FAFF.
  { category: "emoji", weight: 4, cap: 12, re: /[\u{1F300}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}]/gu },
];

// One hit per paragraph that carries two or more DISTINCT Tier 2 words.
function tier2Clusters(text) {
  const hits = [];
  for (const para of text.split(/\n\s*\n/)) {
    const words = [...new Set((para.match(TIER2_RE) || []).map((w) => w.toLowerCase()))];
    if (words.length >= 2) hits.push(words.slice(0, 3).join(" + "));
  }
  return hits;
}

// Protected regions never count against the text: code (fenced blocks and inline spans) and
// URLs (blader/humanizer's dash rule leaves them alone), and quoted material, meaning
// blockquote lines and double-quoted spans (avoid-ai-writing's self-reference escape hatch:
// a document that quotes "I hope this helps" as an example is not using it). Masked regions are
// replaced with spaces so paragraph and line structure survive.
const blank = (m) => m.replace(/[^\n]/g, " ");
function maskCode(s) {
  return s
    .replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, blank)
    .replace(/`[^`\n]+`/g, blank)
    .replace(/\bhttps?:\/\/[^\s)>\]]+/g, blank);
}
function maskQuotes(s) {
  return s
    .replace(/^[ \t]*>[^\n]*$/gm, blank)
    .replace(/"[^"\n]{1,300}"|“[^”\n]{1,300}”/g, blank);
}

// Score `text` for AI tells. Returns { score (0–100), passing, threshold, penalty, findings }.
// findings is ordered by penalty (worst first); each carries up to 2 example matches for context.
export function scoreHumanness(text, { threshold = 85 } = {}) {
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 100) {
    throw new TypeError("threshold must be a finite number between 0 and 100");
  }
  const codeMasked = maskCode(String(text || ""));
  const prose = maskQuotes(codeMasked);
  const findings = [];
  let penalty = 0;
  for (const d of DETECTORS) {
    // Curly quotes are counted before quoted spans are masked, or masking would hide them.
    const s = d.category === "curly-quote" ? codeMasked : prose;
    const matches = d.count ? d.count(s) : s.match(d.re) || [];
    if (matches.length === 0) continue;
    const raw = matches.length * d.weight;
    const applied = Math.min(d.cap, raw);
    penalty += applied;
    findings.push({
      category: d.category,
      count: matches.length,
      penalty: applied,
      capped: raw > d.cap,
      examples: [...new Set(matches.map((m) => m.trim()).filter(Boolean))].slice(0, 2),
    });
  }
  findings.sort((a, b) => b.penalty - a.penalty);
  const score = Math.max(0, 100 - penalty);
  return { score, passing: score >= threshold, threshold, penalty, findings };
}
