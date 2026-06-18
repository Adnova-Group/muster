// Deterministic, no-LLM structural linter for Claude prompts. Encodes Anthropic's
// prompt-engineering best practices + guardrail guidance as a cited rule corpus, plus
// the lintlang agent/tool-prompt taxonomy. Pure + synchronous so it is callable at
// runtime on prompts an application generates while assembling agents/workflows.
//
// Each rule cites the doc it comes from (source URL) and carries a stable id so a
// finding traces back to the guidance. Prefer code over the model: every check here is
// a regex/heuristic, never an API call.
import { scoreArtifact } from "./score.js";

const BP = "https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices";
const GUARD = "https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails";
const LINTLANG = "https://github.com/hermes-labs-ai/lintlang";

// Treat the system string (if provided) as part of the searchable surface.
const surface = (text, ctx) => `${ctx.system ? ctx.system + "\n" : ""}${text || ""}`;
const has = (re) => (text, ctx) => re.test(surface(text, ctx));
const firstLines = (text, n = 4) =>
  (text || "").split(/\n/).map(l => l.trim()).filter(Boolean).slice(0, n);

// Interpolated content markers an app injects ({{var}} or ${var}) or a long body.
const hasInterpolation = (text, ctx) =>
  /\{\{\s*\w+\s*\}\}|\$\{\s*\w+\s*\}/.test(text || "") || (text || "").length > 1500 ||
  (Array.isArray(ctx.interpolatedVars) && ctx.interpolatedVars.length > 0);
// Linear-time XML detection: find an opening tag, then a plain string search for its
// matching close tag. The old backreference+lazy-scan regex was O(n^2) and a ReDoS
// risk, since the linter runs at runtime on (possibly attacker-influenced) prompts.
const hasXmlBlock = (text) => {
  if (!text) return false;
  const m = text.match(/<([a-zA-Z][\w-]*)[\s>]/);
  return !!m && text.includes(`</${m[1]}>`);
};
const ACTION_VERB = /^(write|generate|classify|summari[sz]e|extract|identify|analy[sz]e|create|list|translate|rewrite|explain|compare|evaluate|produce|return|find|select|determine|draft|review)\b/i;
// Negative-instruction phrasings. `no <verb>ing` is restricted to a small set of known
// constraint verbs so ordinary noun phrases ("no existing context", "no meaning") are
// not miscounted as negatives. Built per-call (not a shared /g literal) to avoid a
// stateful `lastIndex` foot-gun.
const NEGATIVE_SRC = "\\b(do not|don'?t|never|avoid|no\\s+(?:log|cach|retr|truncat|format|wrap|generat|output|process|nest|render)\\w*ing)\\b";

export const RULES = [
  {
    id: "ANTH-ROLE-001", severity: "error", dimension: "structure",
    title: "Assign Claude a role (system prompt / persona)", source: BP,
    applies: () => true,
    pass: has(/\byou are\b|\byour role is\b|\bact as\b/i),
    fix: "Open with a role, e.g. 'You are a senior X who ...' (system prompt preferred).",
  },
  {
    id: "ANTH-XML-001", severity: "warn", dimension: "structure",
    title: "Wrap interpolated/long content in descriptive XML tags", source: BP,
    applies: (t, c) => hasInterpolation(t, c),
    pass: (t) => hasXmlBlock(t),
    fix: "Wrap injected content in descriptive tags, e.g. <document>{{x}}</document>.",
  },
  {
    id: "ANTH-FMT-001", severity: "warn", dimension: "structure",
    title: "State the output format explicitly", source: BP,
    applies: () => true,
    // Require a format *instruction*, not a bare keyword — "don't use markdown" is not
    // an output-format spec. Anchor on directive phrasing or an output-semantic tag
    // (NOT any XML block: <document>{{x}}</document> wraps *input*, not output format).
    pass: has(/format (your|the) (response|answer|output)|respond with|reply with|(return|output|produce|reply) (with )?(a|an|only |valid )*(json|xml|markdown|yaml|csv|list|object|array)|as (a|an) (json|xml|markdown|yaml|csv)|<(json|output|format|response|result|answer)\b/i),
    fix: "Name the exact output format (JSON shape, prose, markdown) positively.",
  },
  {
    id: "ANTH-SHOT-001", severity: "warn", dimension: "examples",
    title: "Provide examples (multishot) for non-trivial tasks", source: BP,
    applies: (t) => (t || "").length > 200,
    pass: has(/<example[s]?\b|\bexample\s*\d*\s*:|for example,/i),
    fix: "Add 2-5 relevant, diverse examples wrapped in <example> tags.",
  },
  {
    id: "ANTH-POS-001", severity: "warn", dimension: "clarity",
    title: "Prefer positive instructions over negative ones", source: BP,
    applies: () => true,
    pass: (t, c) => {
      const s = surface(t, c);
      const neg = (s.match(new RegExp(NEGATIVE_SRC, "gi")) || []).length;
      return neg <= 2;
    },
    fix: "Tell Claude what TO do instead of stacking 'do not / never' clauses.",
  },
  {
    id: "ANTH-CLEAR-001", severity: "info", dimension: "clarity",
    title: "Lead with a clear, direct action-verb instruction", source: BP,
    applies: () => true,
    // Any of the opening lines leading with an action verb counts — a role line on
    // line 1 followed by "Classify the ..." on line 2 is still clear and direct.
    pass: (t) => firstLines(t).some(l => ACTION_VERB.test(l)),
    fix: "Start the task line with an action verb (Write, Classify, Extract, ...).",
  },
  {
    id: "LINT-TOOL-001", severity: "warn", dimension: "agentic",
    title: "Frame tool use imperatively, not suggestively", source: LINTLANG,
    applies: (t, c) => !!c.hasTools || !!c.isAgent,
    pass: (t, c) => {
      const s = surface(t, c);
      return /\buse the\b|\bcall the\b|\binvoke\b|\bimplement\b/i.test(s) && !/\byou (can|could|may|might)\b/i.test(s);
    },
    fix: "Say 'Use the X tool to ...' / 'Implement ...', not 'you can use ...'.",
  },
  {
    id: "LINT-STOP-002", severity: "warn", dimension: "agentic",
    title: "Define stop / termination conditions for agents", source: LINTLANG,
    applies: (t, c) => !!c.isAgent,
    pass: has(/\bstop when\b|when (you are |you're )?(done|finished|complete)|\buntil\b|\bterminat|\bfinish(ed)? (when|once)/i),
    fix: "State when to stop, e.g. 'Stop once the tests pass or after N attempts.'",
  },
  {
    id: "GUARD-IDK-001", severity: "info", dimension: "guardrails",
    title: "Allow 'I don't know' to reduce hallucination", source: `${GUARD}/reduce-hallucinations`,
    applies: has(/\b(answer|question|fact|factual)\b/i),
    pass: has(/i don'?t know|if (you are |you're )?unsure|if you (do not|don'?t) know|say so/i),
    fix: "Permit Claude to answer 'I don't know' when the context lacks the answer.",
  },
  {
    id: "GUARD-CITE-002", severity: "info", dimension: "guardrails",
    title: "Require citations/quotes when given source documents", source: `${GUARD}/reduce-hallucinations`,
    applies: (t, c) => !!c.hasDocuments || /<document|<context|<source/i.test(t || ""),
    // Require a citation *directive*, not a bare mention of the word "source"
    // ("source code" / "data source" must not satisfy this rule).
    pass: has(/\bcite\b|\bquote\b|with citations?|cite (your |the )?sources?|reference the (source|document|passage)/i),
    fix: "Require a supporting quote/citation for each factual claim.",
  },
  {
    id: "GUARD-SEP-003", severity: "warn", dimension: "guardrails",
    title: "Separate untrusted/interpolated input from instructions", source: `${GUARD}/reduce-prompt-leak`,
    applies: (t, c) => hasInterpolation(t, c),
    pass: (t) => hasXmlBlock(t),
    fix: "Place injected/user content inside its own XML block, away from instructions.",
  },
];

const DIMENSIONS = ["structure", "examples", "clarity", "agentic", "guardrails"];

// Floor gate: the weakest dimension must clear `floor`, and the total must clear
// `pass_total`. Mirrors the book-genesis floor principle used elsewhere in muster.
export const DEFAULT_GATE = { floor: 1, pass_total: 10 };

export function lintPrompt(text, ctx = {}, gate = DEFAULT_GATE) {
  const findings = [];
  const perDim = Object.fromEntries(DIMENSIONS.map(d => [d, { applicable: 0, passed: 0 }]));

  for (const rule of RULES) {
    if (!rule.applies(text, ctx)) continue;
    const dim = perDim[rule.dimension];
    dim.applicable += 1;
    const ok = rule.pass(text, ctx);
    if (ok) {
      dim.passed += 1;
    } else {
      findings.push({
        id: rule.id, severity: rule.severity, dimension: rule.dimension,
        title: rule.title, source: rule.source, fix: rule.fix,
      });
    }
  }

  // Dimension score 0-3. A dimension with no applicable rules scores full marks (3) so
  // it never drags the floor for prompts where it does not apply.
  const rubric = {};
  for (const d of DIMENSIONS) {
    const { applicable, passed } = perDim[d];
    rubric[d] = applicable === 0 ? 3 : Math.round((passed / applicable) * 3);
  }

  const { total, weakest, passing } = scoreArtifact(rubric, gate);
  // Order findings by severity so the worst surfaces first.
  const rank = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { rubric, findings, total, weakest, passing, gate };
}
