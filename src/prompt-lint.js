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
// Strip code before pattern checks that should not see code samples — a `${x}` template
// literal, a Ruby `#{x}`, or a `never` keyword inside an example is not an interpolation
// marker / negative instruction the prompt actually issues. Language-AGNOSTIC: a fenced
// block holds any language, so its contents are blanked regardless of syntax. Handles all
// common code-block forms: ``` and ~~~ fences (any length + info string, even unclosed),
// HTML <pre>/<code>, 4-space / tab indented blocks, and inline `code`. Line-based and O(n).
function stripCode(s) {
  let fence = null; // the fence char (` or ~) of the block we are inside, if any
  const out = String(s).split("\n").map((line) => {
    const m = line.match(/^[ \t]*(`{3,}|~{3,})/);
    if (fence) {                                   // inside a fenced block
      if (m && m[1][0] === fence) fence = null;    // a matching fence closes it
      return " ";
    }
    if (m) { fence = m[1][0]; return " "; }         // open fence — remember its char
    if (/^(?: {4}|\t)\S/.test(line)) return " ";    // indented code line
    return line;
  }).join("\n");
  return out
    .replace(/<pre\b[\s\S]*?<\/pre>/gi, " ")
    .replace(/<code\b[\s\S]*?<\/code>/gi, " ")
    .replace(/`[^`\n]*`/g, " ");
}

// Interpolation markers an app injects, across templating styles/frameworks:
//   {{var}} (Handlebars/Jinja/Vue) · ${var} (JS/shell) · #{var} (Ruby) ·
//   <%= var %> / <% var %> (ERB/EJS) · %(name)s (Python printf). Distinctive enough to
// avoid prose false positives; checked against code-stripped text so examples don't count.
const INTERP_RE = /\{\{\s*[\w.]+\s*\}\}|\$\{\s*[\w.]+\s*\}|#\{\s*[\w.]+\s*\}|<%=?\s*[\w.]+\s*%>|%\([\w.]+\)[sd]/;

// Length is deliberately NOT a trigger: a long instruction/system prompt is not the same
// as a prompt that stuffs long *interpolated* content, and flagging it for missing XML
// wrapping is a false positive (surfaced by dogfooding the linter on muster's own agent
// prompts). Checked against code-stripped text so markers in code examples don't count.
const hasInterpolation = (text, ctx) =>
  INTERP_RE.test(stripCode(text || "")) ||
  (Array.isArray(ctx.interpolatedVars) && ctx.interpolatedVars.length > 0);
// Linear-time XML detection: collect every opening- and closing-tag name in two passes,
// return true if any name appears as both. Two matchAll scans + a small set intersection
// are O(n) — unlike the old backreference+lazy-scan regex, which was O(n^2) and a ReDoS
// risk (the linter runs at runtime on possibly attacker-influenced prompts). Detecting any
// open/close pair (not just the first tag) avoids a false negative when a stray tag-like
// token precedes the real block, e.g. "Use <strong> styling. <doc>{{x}}</doc>".
const hasXmlBlock = (text) => {
  if (!text) return false;
  const opens = new Set();
  for (const m of text.matchAll(/<([a-zA-Z][\w-]*)[\s>]/g)) opens.add(m[1]);
  if (opens.size === 0) return false;
  for (const m of text.matchAll(/<\/([a-zA-Z][\w-]*)>/g)) if (opens.has(m[1])) return true;
  return false;
};
const ACTION_VERB = /^(write|generate|classify|summari[sz]e|extract|identify|analy[sz]e|create|list|translate|rewrite|explain|compare|evaluate|produce|return|find|select|determine|draft|review)\b/i;
// Negative-instruction phrasings. `no <verb>ing` is restricted to a small set of known
// constraint verbs so ordinary noun phrases ("no existing context", "no meaning") are
// not miscounted as negatives. Built per-call (not a shared /g literal) to avoid a
// stateful `lastIndex` foot-gun.
const NEGATIVE_SRC = "\\b(do not|don'?t|never|avoid|no\\s+(?:log|cach|retr|truncat|format|wrap|generat|output|process|nest|render)\\w*ing)\\b";

export const RULES = [
  {
    id: "ANTH-ROLE-001", severity: "error", systemSeverity: "warn", dimension: "structure",
    title: "Assign Claude a role (system prompt / persona)", source: BP,
    applies: () => true,
    pass: (t, c) => {
      const s = surface(t, c);
      if (/\byou are\b|\byour role is\b|\bact as\b/i.test(s)) return true;
      // Second-person persona framing — an opening line like "You review a diff." assigns
      // a role by action. Exclude suggestive/modal openers ("You can ...") AND input/state
      // descriptions ("You receive ...", "You get ...") that don't assign a persona.
      return firstLines(s).some(l =>
        /^you\s+[a-z]+/i.test(l) &&
        !/^you\s+(can|could|may|might|should|would|will|must|need|have|receive|get|got|find|obtain|hold|contain|see)\b/i.test(l));
    },
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
    id: "ANTH-FMT-001", severity: "warn", systemSeverity: "info", dimension: "structure",
    title: "State the output format explicitly", source: BP,
    applies: () => true,
    // Require a format *instruction*, not a bare keyword — "don't use markdown" is not
    // an output-format spec. Anchor on directive phrasing or an output-semantic tag
    // (NOT any XML block: <document>{{x}}</document> wraps *input*, not output format).
    pass: has(/format (your|the) (response|answer|output)|respond with|reply with|(?:return|output|produce|reply|emit|respond|generate)[^.\n]{0,40}?\b(json|xml|markdown|yaml|csv|list|object|array|table)\b|as (a|an) (json|xml|markdown|yaml|csv)|<(json|output|format|response|result|answer)\b|one [\w-]+ per line|one per line|per (finding|item|line|row|entry)\b|as (?:a |an )?(?:bullet(?:ed)?|numbered|markdown)\s*(?:list|table)|prefix(?:ed)? (?:each |every )?\w+ with/i),
    fix: "Name the exact output format (JSON shape, prose, markdown, or a clear per-line/list spec).",
  },
  {
    id: "ANTH-SHOT-001", severity: "warn", dimension: "examples", taskOnly: true,
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
      const s = stripCode(surface(t, c));
      const neg = (s.match(new RegExp(NEGATIVE_SRC, "gi")) || []).length;
      // System/instruction prompts (esp. guardrail roles) legitimately use more
      // prohibitions ("read-only", "never modify"), so tolerate more before flagging.
      return neg <= (c.genre === "system" ? 5 : 2);
    },
    fix: "Tell Claude what TO do instead of stacking 'do not / never' clauses.",
  },
  {
    id: "ANTH-CLEAR-001", severity: "info", dimension: "clarity", taskOnly: true,
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
    // lintlang H3 (schema-intent mismatch). Only fires when the caller passes the actual tool
    // schemas via ctx.tools = [{ name, inputSchema:{ required:[...] } }] — a bare `--tools` flag
    // (hasTools) does NOT trigger it, because without the schema there is nothing to check against.
    id: "LINT-SCHEMA-003", severity: "warn", dimension: "agentic",
    title: "Reference every provided tool and its required fields (schema↔intent alignment)", source: LINTLANG,
    applies: (t, c) => Array.isArray(c.tools) && c.tools.length > 0,
    pass: (t, c) => {
      const s = surface(t, c).toLowerCase();
      return c.tools.every((tool) => {
        const name = String((tool && tool.name) || "").toLowerCase();
        if (!name || !s.includes(name)) return false; // a tool the prompt never names cannot be driven correctly
        const req = (tool.inputSchema && tool.inputSchema.required) || [];
        return req.every((f) => s.includes(String(f).toLowerCase())); // each required arg must be referenced
      });
    },
    fix: "Name every callable tool and reference each of its required arguments so the prompt's intent matches the tool schema.",
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

// genre: "task" (default) — a single-task prompt; full rubric applies.
//        "system" — an agent/skill/instruction (system) prompt; task-only rules
//        (action-verb lead, multishot examples) are exempt and POS tolerates more
//        prohibitions. The scanner tags discovered prompt docs as "system".
// Rules a prompt opts out of via an inline directive, e.g.
//   <!-- prompt-lint-disable ANTH-POS-001: reason -->
// The proper way to handle a legitimate exception (an orchestration prompt that must
// stack prohibitions) — explicit and reviewable, not by mangling the prompt.
function disabledRules(text) {
  const ids = new Set();
  const re = /prompt-lint-disable[:\s]+([A-Z][A-Z0-9-]*(?:\s*,\s*[A-Z][A-Z0-9-]*)*)/gi;
  let m;
  while ((m = re.exec(text)) !== null)
    for (const id of m[1].split(/\s*,\s*/)) ids.add(id.toUpperCase());
  return ids;
}

export function lintPrompt(text, ctx = {}, gate = DEFAULT_GATE) {
  const findings = [];
  const perDim = Object.fromEntries(DIMENSIONS.map(d => [d, { applicable: 0, passed: 0 }]));
  const systemGenre = ctx.genre === "system";
  const disabled = disabledRules(surface(text, ctx));
  const suppressed = [];

  for (const rule of RULES) {
    if (rule.taskOnly && systemGenre) continue; // task-prompt technique — exempt for system prompts
    if (disabled.has(rule.id)) { suppressed.push(rule.id); continue; } // explicit opt-out
    if (!rule.applies(text, ctx)) continue;
    // Effective severity can soften by genre (e.g. FMT reads as advisory for system
    // prompts) — but severity is a REPORTING label only. Every applicable rule counts
    // toward the score, so zero findings (any severity) == a perfect 15/15. taskOnly
    // exemptions above are the only way a rule drops out for a genre.
    const severity = (systemGenre && rule.systemSeverity) || rule.severity;
    const ok = rule.pass(text, ctx);
    const dim = perDim[rule.dimension];
    dim.applicable += 1;
    if (ok) dim.passed += 1;
    if (!ok) findings.push({
      id: rule.id, severity, dimension: rule.dimension,
      title: rule.title, source: rule.source, fix: rule.fix,
    });
  }

  // Dimension score 0-3 over every applicable rule (all severities count). A dimension
  // with no applicable rules (e.g. examples for a system prompt, where SHOT is exempt)
  // scores full marks (3) so it never drags the floor where it does not apply. Net: a
  // prompt with zero findings scores a perfect 15/15.
  const rubric = {};
  for (const d of DIMENSIONS) {
    const { applicable, passed } = perDim[d];
    rubric[d] = applicable === 0 ? 3 : Math.round((passed / applicable) * 3);
  }

  const { total, weakest, passing } = scoreArtifact(rubric, gate);
  // Order findings by severity so the worst surfaces first.
  const rank = { error: 0, warn: 1, info: 2 };
  findings.sort((a, b) => rank[a.severity] - rank[b.severity]);
  return { rubric, findings, total, weakest, passing, gate, suppressed };
}

// lintlang H7 (role confusion). lintPrompt operates on one prompt string and cannot see turn
// structure; this lints a chat-format prompt (an array of { role, content }) for role-ordering
// hygiene. Pure + synchronous like the rest of the module. Returns { findings, ok }.
const ROLE_BLEED = /^\s*(system|assistant|user)\s*:/im;
export function lintChat(messages) {
  const findings = [];
  const add = (id, title, detail) =>
    findings.push({ id, severity: "warn", dimension: "structure", title, detail, source: LINTLANG });
  if (!Array.isArray(messages) || messages.length === 0) {
    add("LINT-ROLE-010", "Chat must be a non-empty array of {role, content}", "no messages to lint");
    return { findings, ok: false };
  }
  messages.forEach((m, i) => {
    const role = m && m.role;
    if (role === "system" && i !== 0)
      add("LINT-ROLE-011", "System message must be first", `system role found at index ${i}`);
    if (i > 0) {
      const prev = messages[i - 1] && messages[i - 1].role;
      if (role && role !== "system" && role === prev)
        add("LINT-ROLE-012", "Roles should alternate (no two consecutive same-role turns)", `${role} follows ${prev} at index ${i}`);
    }
    if (typeof (m && m.content) === "string" && ROLE_BLEED.test(m.content))
      add("LINT-ROLE-013", "Role bleed: content embeds a role marker that can confuse turn parsing", `index ${i} content opens with a 'role:' marker`);
  });
  return { findings, ok: findings.length === 0 };
}

// lintlang H4 (context-boundary erosion). A single prompt can't reveal cross-task state leakage;
// this lints a WORKFLOW — an array of sibling prompts ({ id?, text } or strings) — for the same
// concrete mutable-state artifact (a file path / state token) referenced by 2+ prompts without
// isolation. Conservative on purpose: only a shared concrete token flags, to avoid noise.
const STATE_TOKEN = /\b[\w./-]*(?:state|scratch|memory|ledger|\.muster\/[\w./-]+|[\w-]+\.(?:json|txt|md|log))\b/gi;
export function lintWorkflow(prompts) {
  const findings = [];
  if (!Array.isArray(prompts) || prompts.length < 2) return { findings, ok: true };
  const items = prompts.map((p, i) => ({ id: (p && p.id) || `prompt[${i}]`, text: typeof p === "string" ? p : (p && p.text) || "" }));
  const seen = new Map(); // token -> Set(prompt ids)
  for (const it of items) {
    for (const raw of it.text.match(STATE_TOKEN) || []) {
      const tok = raw.toLowerCase();
      if (!seen.has(tok)) seen.set(tok, new Set());
      seen.get(tok).add(it.id);
    }
  }
  for (const [tok, ids] of seen) {
    if (ids.size >= 2)
      findings.push({
        id: "LINT-CTX-020", severity: "warn", dimension: "guardrails",
        title: "Shared mutable-state artifact referenced across sibling tasks (context-boundary erosion)",
        detail: `'${tok}' referenced by ${[...ids].join(", ")}`, source: LINTLANG,
        fix: "Give each task its own scoped state, or declare the shared artifact read-only / owned by one task.",
      });
  }
  return { findings, ok: findings.length === 0 };
}
