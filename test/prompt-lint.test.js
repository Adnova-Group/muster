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

test("role detection matches 'act as' anywhere, not only at string start", () => {
  const r = lintPrompt("Please act as a senior engineer and review this.\n\nReturn a JSON summary.");
  const ids = r.findings.map(f => f.id);
  assert.ok(!ids.includes("ANTH-ROLE-001"), "'act as' should satisfy the role rule");
});

test("floor principle: a prompt failing a whole dimension does not pass", () => {
  const r = lintPrompt(WEAK);
  assert.equal(r.passing, false, "weak prompt should not pass the floor");
});
