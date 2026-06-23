// Deterministic AI-tell score (0–100) for human-facing text — the measurable, CI-gateable
// companion to the [[muster-humanizer]] LLM rewrite. Pure + synchronous, no API calls: every
// detector is a regex/heuristic, so the same text always scores the same. 100 = no tells found;
// each detected tell subtracts a weighted penalty (capped per category so one noisy category can't
// alone zero a long, otherwise-clean document). Adapted from conorbronsdon/avoid-ai-writing's
// scored-engine idea + the humanizer tell taxonomy.

// Each detector: { category, weight (penalty per hit), cap (max penalty from this category), re }.
// `re` MUST be global (/g) so match counting works.
const DETECTORS = [
  { category: "em/en-dash-or-curly-quote", weight: 7, cap: 28, re: /[—–“”‘’]/g },
  { category: "banned-opener", weight: 6, cap: 24, re: /(?:^|\n)\s*(?:Certainly|Moreover|Additionally|Furthermore|Indeed|Notably|Importantly|Ultimately|Overall)\b/gi },
  { category: "signposting", weight: 5, cap: 25, re: /\b(?:it'?s important to note|in today'?s world|at the end of the day|when it comes to|needless to say|let'?s dive in|in conclusion|that being said)\b/gi },
  { category: "tier1-vocab", weight: 4, cap: 28, re: /\b(?:delve|leverage|tapestry|realm|testament|foster|robust|seamless|elevate|embark|landscape|paradigm|harness|pivotal|multifaceted|underscore|showcase|utilize|facilitate|holistic|synergy|game-changer|cutting-edge|unlock)\b/gi },
  { category: "negative-parallelism", weight: 6, cap: 18, re: /\bnot just\b[^.\n]{1,60}?\b(?:it'?s|but)\b|\bit'?s not (?:about|just)\b[^.\n]{1,60}?\bit'?s\b/gi },
  { category: "copula-avoidance", weight: 3, cap: 12, re: /\b(?:serves as|boasts|stands as|functions as|plays a (?:crucial|key|vital|pivotal|significant) role)\b/gi },
  { category: "sycophancy", weight: 6, cap: 18, re: /\b(?:great question|i hope this helps|as an ai|happy to help|i'?m just an ai)\b/gi },
  { category: "emoji", weight: 4, cap: 12, re: /[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu },
];

// Score `text` for AI tells. Returns { score (0–100), passing, threshold, penalty, findings }.
// findings is ordered by penalty (worst first); each carries up to 2 example matches for context.
export function scoreHumanness(text, { threshold = 85 } = {}) {
  const s = String(text || "");
  const findings = [];
  let penalty = 0;
  for (const d of DETECTORS) {
    const matches = s.match(d.re) || [];
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
