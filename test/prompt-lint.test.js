import { test } from "node:test";
import assert from "node:assert/strict";
import { lintPrompt, RULES } from "../src/prompt-lint.js";

// A weak prompt: no role, no XML around interpolated content, no examples,
// no output format, negative-heavy framing. Should fail several rules.
const WEAK = "do not be verbose. don't use markdown. never apologize. answer the question: {{question}}";

// A strong prompt exercising the structural best practices.
const STRONG = `You are a senior support engineer.

Classify the ticket below and return JSON.

<ticket>
{{ticket}}
</ticket>

<example>
<input>App crashes on login</input>
<output>{"category":"bug","severity":"high"}</output>
</example>

Format your response as a single JSON object with keys "category" and "severity".`;

test("every rule has id, severity, dimension, source", () => {
  for (const r of RULES) {
    assert.ok(r.id && typeof r.id === "string", `rule missing id`);
    assert.ok(["error", "warn", "info"].includes(r.severity), `${r.id} bad severity`);
    assert.ok(r.dimension, `${r.id} missing dimension`);
    assert.ok(r.source && /https?:\/\//.test(r.source), `${r.id} must cite a source URL`);
  }
});

test("rule ids are unique", () => {
  const ids = RULES.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length, "duplicate rule id");
});

test("lintPrompt returns scored rubric + findings + passing flag", () => {
  const r = lintPrompt(WEAK);
  assert.ok(r.rubric && typeof r.rubric === "object");
  assert.ok(Array.isArray(r.findings));
  assert.equal(typeof r.passing, "boolean");
  assert.ok(typeof r.total === "number");
});

test("weak prompt flags role, output-format, and positive-framing rules", () => {
  const r = lintPrompt(WEAK);
  const ids = r.findings.map(f => f.id);
  assert.ok(ids.includes("ANTH-ROLE-001"), "should flag missing role");
  assert.ok(ids.includes("ANTH-FMT-001"), "should flag missing output format");
  assert.ok(ids.includes("ANTH-POS-001"), "should flag negative framing");
});

test("strong prompt passes role, xml, examples, output-format", () => {
  const r = lintPrompt(STRONG);
  const ids = r.findings.map(f => f.id);
  assert.ok(!ids.includes("ANTH-ROLE-001"), "role present");
  assert.ok(!ids.includes("ANTH-XML-001"), "xml present");
  assert.ok(!ids.includes("ANTH-SHOT-001"), "example present");
  assert.ok(!ids.includes("ANTH-FMT-001"), "format present");
  assert.ok(r.total > lintPrompt(WEAK).total, "strong scores higher than weak");
});

test("findings carry severity and cited source", () => {
  const r = lintPrompt(WEAK);
  for (const f of r.findings) {
    assert.ok(f.id && f.severity && f.source, "finding must carry id/severity/source");
    assert.ok(f.fix && typeof f.fix === "string", "finding must suggest a fix");
  }
});

test("agent prompt without stop conditions flags LINT-STOP-002", () => {
  const agentPrompt = "You are an autonomous agent. Use the search tool to find the answer.";
  const r = lintPrompt(agentPrompt, { isAgent: true, hasTools: true });
  const ids = r.findings.map(f => f.id);
  assert.ok(ids.includes("LINT-STOP-002"), "agent prompt missing stop conditions");
});

test("non-agent prompt does not flag agent-only rules", () => {
  const r = lintPrompt(STRONG);
  const ids = r.findings.map(f => f.id);
  assert.ok(!ids.includes("LINT-STOP-002"), "stop-conditions rule should not apply to non-agent");
});

test("XML detection finds a real block even after a stray tag-like token", () => {
  // A stray <strong> earlier must not hide a real <doc>...</doc> block downstream.
  const r = lintPrompt("You are a writer. Use <strong> styling.\n\n<doc>{{x}}</doc>\n\nReturn JSON.");
  assert.ok(!r.findings.map(f => f.id).includes("ANTH-XML-001"), "XML block present despite stray tag");
});

test("output-format rule accepts 'return a JSON' (article before the format)", () => {
  const r = lintPrompt("You are a bot. Return a JSON object describing the input.");
  assert.ok(!r.findings.map(f => f.id).includes("ANTH-FMT-001"), "'return a JSON' is a format directive");
});

test("input-wrapping XML alone does NOT satisfy the output-format rule", () => {
  // <document>{{x}}</document> wraps input; it is not an output-format declaration.
  const r = lintPrompt("You are an analyst.\n\nSummarize this.\n\n<document>{{x}}</document>");
  const ids = r.findings.map(f => f.id);
  assert.ok(ids.includes("ANTH-FMT-001"), "wrapping input must not pass the format rule");
  assert.ok(!ids.includes("ANTH-XML-001"), "but the XML rule is satisfied");
});

test("positive-framing rule ignores ordinary noun phrases like 'no existing context'", () => {
  const r = lintPrompt("You are a helper. Summarize the input. Note: no existing context is provided, so be concise. Return JSON.");
  const ids = r.findings.map(f => f.id);
  assert.ok(!ids.includes("ANTH-POS-001"), "'no existing' is not a negative instruction");
});

test("real negative instructions still trip the positive-framing rule", () => {
  const r = lintPrompt("Answer this. Do not apologize. Never speculate. Don't add caveats.");
  assert.ok(r.findings.map(f => f.id).includes("ANTH-POS-001"), "three negatives should flag");
});

test("GUARD-CITE-002: flags missing citation directive, passes on a real one", () => {
  const ctx = { hasDocuments: true };
  const miss = lintPrompt("Summarize the source code in the document.", ctx).findings.map(f => f.id);
  assert.ok(miss.includes("GUARD-CITE-002"), "'source code' is not a citation directive");
  const ok = lintPrompt("Answer using the document. Cite your sources for every claim.", ctx).findings.map(f => f.id);
  assert.ok(!ok.includes("GUARD-CITE-002"), "an explicit cite directive passes");
});

test("GUARD-IDK-001: a Q&A prompt without an 'I don't know' escape hatch is flagged", () => {
  assert.ok(lintPrompt("Answer the question accurately.").findings.map(f => f.id).includes("GUARD-IDK-001"));
  assert.ok(!lintPrompt("Answer the question. If you don't know, say so.").findings.map(f => f.id).includes("GUARD-IDK-001"));
});

test("LINT-TOOL-001: suggestive tool language flagged, imperative passes", () => {
  const sugg = lintPrompt("You are an agent. You can use the search tool.", { isAgent: true, hasTools: true });
  assert.ok(sugg.findings.map(f => f.id).includes("LINT-TOOL-001"), "'you can use' is suggestive");
  const imp = lintPrompt("You are an agent. Use the search tool to find the answer. Stop when done.", { isAgent: true, hasTools: true });
  assert.ok(!imp.findings.map(f => f.id).includes("LINT-TOOL-001"), "imperative tool framing passes");
});

test("${var} interpolation (not just {{var}}) is treated as interpolated content", () => {
  const r = lintPrompt("You are a bot. Echo the value. Answer: ${value}");
  assert.ok(r.findings.map(f => f.id).includes("ANTH-XML-001"), "${var} should require XML wrapping");
});

// --- genre-aware linting + broadened detectors -------------------------------

const REVIEWER = `You review a diff. You do not edit code.

## Iron rules
- Read-only. Never modify files.
- One finding per line, each tagged [blocker], [risk], or [nit]. Location first, then the fix.
- Stay in scope. Do not propose unrelated cleanups.`;

test("ROLE detection accepts second-person persona framing ('You review ...')", () => {
  const r = lintPrompt(REVIEWER, { genre: "system" });
  assert.ok(!r.findings.map(f => f.id).includes("ANTH-ROLE-001"), "'You review a diff' assigns a role");
});

test("ROLE still flags a roleless prompt, and excludes suggestive 'You can ...'", () => {
  assert.ok(lintPrompt("Summarize the input and return a list.").findings.map(f => f.id).includes("ANTH-ROLE-001"));
  assert.ok(lintPrompt("You can do whatever. Return a list.").findings.map(f => f.id).includes("ANTH-ROLE-001"),
    "'You can' is suggestive, not a role");
});

test("ROLE excludes input/state descriptions ('You receive ...', 'You get ...')", () => {
  for (const lead of ["You receive a JSON object. Process it.", "You get a payload. Summarize it.", "You find a file. Read it."]) {
    assert.ok(lintPrompt(lead).findings.map(f => f.id).includes("ANTH-ROLE-001"),
      `"${lead}" describes input, not a persona`);
  }
});

test("FMT does not pass on a stray 'tagged' used outside a format spec", () => {
  const r = lintPrompt("You are a classifier. Files tagged as draft must be reviewed.", { genre: "task" });
  assert.ok(r.findings.map(f => f.id).includes("ANTH-FMT-001"), "'tagged as draft' is not a format directive");
});

test("FMT detection accepts a natural-language format spec ('one finding per line, tagged ...')", () => {
  const r = lintPrompt(REVIEWER, { genre: "system" });
  assert.ok(!r.findings.map(f => f.id).includes("ANTH-FMT-001"), "natural-language format is a format spec");
});

test("system genre exempts task-only rules (CLEAR, SHOT); task genre still applies them", () => {
  const longInstruction = "You are a planner. " + "Decompose the work and weigh tradeoffs carefully across the system. ".repeat(8);
  const sys = lintPrompt(longInstruction, { genre: "system" }).findings.map(f => f.id);
  assert.ok(!sys.includes("ANTH-SHOT-001"), "examples are not required of system prompts");
  assert.ok(!sys.includes("ANTH-CLEAR-001"), "action-verb-lead is a task-prompt rule");
  const task = lintPrompt(longInstruction, { genre: "task" }).findings.map(f => f.id);
  assert.ok(task.includes("ANTH-SHOT-001"), "task genre still wants examples");
});

test("POS tolerates more negatives in system genre (guardrail roles), not in task genre", () => {
  const guardraily = "You are a reviewer. Do not edit. Never modify files. Don't propose features.";
  assert.ok(!lintPrompt(guardraily, { genre: "system" }).findings.map(f => f.id).includes("ANTH-POS-001"));
  assert.ok(lintPrompt(guardraily, { genre: "task" }).findings.map(f => f.id).includes("ANTH-POS-001"));
});

test("a well-formed instruction prompt passes the floor in system genre", () => {
  assert.equal(lintPrompt(REVIEWER, { genre: "system" }).passing, true);
});

test("genre defaults to task (backward compatible)", () => {
  // No genre => task rules apply, as before.
  const r = lintPrompt("Summarize the input.");
  assert.ok(r.findings.map(f => f.id).includes("ANTH-ROLE-001"));
});

test("role detection matches 'act as' anywhere, not only at string start", () => {
  const r = lintPrompt("Please act as a senior engineer and review this.\n\nReturn a JSON summary.");
  const ids = r.findings.map(f => f.id);
  assert.ok(!ids.includes("ANTH-ROLE-001"), "'act as' should satisfy the role rule");
});

test("floor principle: a prompt failing a whole dimension does not pass", () => {
  const r = lintPrompt(WEAK);
  assert.equal(r.passing, false, "weak prompt should not pass the floor");
});
