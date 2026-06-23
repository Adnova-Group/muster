import { test } from "node:test";
import assert from "node:assert/strict";
import {
  interpolate, codeGrade, buildGraderPrompt, parseGraderResponse, runEval, gradeCollected,
} from "../src/prompt-eval.js";

test("gradeCollected scores pre-collected outputs offline", () => {
  const res = gradeCollected({
    dataset: [
      { output: '{"a":1}', format: "json", graderResponse: '{"score": 8}' },
      { output: "not json", format: "json", graderResponse: '{"score": 2}' },
    ],
    passThreshold: 7,
  });
  assert.equal(res.results[0].score, 9); // (10 + 8) / 2
  assert.equal(res.results[0].passing, true);
  assert.equal(res.results[1].score, 1); // (0 + 2) / 2
  assert.equal(res.results[1].passing, false);
  assert.equal(res.accuracy, 0.5);
});

test("interpolate fills {{VAR}} slots from a test case", () => {
  const out = interpolate("Solve: {{task}} for {{user}}", { task: "add 2+2", user: "Ann" });
  assert.equal(out, "Solve: add 2+2 for Ann");
});

test("interpolate leaves unknown slots untouched", () => {
  assert.equal(interpolate("Hi {{missing}}", {}), "Hi {{missing}}");
});

test("codeGrade validates JSON output", () => {
  assert.equal(codeGrade('{"a":1}', "json"), 10);
  assert.equal(codeGrade("{not json}", "json"), 0);
});

test("codeGrade validates regex output", () => {
  assert.equal(codeGrade("^a[0-9]+$", "regex"), 10);
  assert.equal(codeGrade("a(", "regex"), 0);
});

test("codeGrade returns null when no format is given (not applicable)", () => {
  assert.equal(codeGrade("anything", undefined), null);
});

test("codeGrade tool-call validates a function-call shape", () => {
  assert.equal(codeGrade('{"name":"search","arguments":{"q":"x"}}', "tool-call"), 10);
  assert.equal(codeGrade('```json\n{"tool":"get","input":{"id":1}}\n```', "tool-call"), 10);
  assert.equal(codeGrade('{"name":"search"}', "tool-call"), 0);          // no arguments object
  assert.equal(codeGrade('{"arguments":{"q":"x"}}', "tool-call"), 0);    // no tool name
  assert.equal(codeGrade('{"name":"x","arguments":[1,2]}', "tool-call"), 0); // args not an object
  assert.equal(codeGrade("just prose", "tool-call"), 0);
});

test("codeGrade trajectory validates an array of tool calls", () => {
  assert.equal(codeGrade('[{"name":"a","arguments":{}},{"tool":"b","input":{"x":1}}]', "trajectory"), 10);
  assert.equal(codeGrade('[]', "trajectory"), 0);                         // empty trajectory
  assert.equal(codeGrade('[{"name":"a","arguments":{}},{"oops":true}]', "trajectory"), 0); // one bad step
  assert.equal(codeGrade('{"name":"a","arguments":{}}', "trajectory"), 0); // single object, not an array
});

test("codeGrade python rejects prose but accepts real Python", () => {
  assert.equal(codeGrade("The quick brown fox (really) jumps.", "python"), 0);
  assert.equal(codeGrade("def add(a, b):\n    return a + b", "python"), 10);
});

test("codeGrade python does not misread a markdown heading as code", () => {
  // Balanced delimiters + a leading '#' must NOT count as a Python comment signal.
  assert.equal(codeGrade("# Overview\n\nThis is a plain document about things.", "python"), 0);
});

test("codeGrade returns null for an unknown format", () => {
  assert.equal(codeGrade("anything: 1", "yaml"), null);
});

test("validateRegex caps overlong patterns", () => {
  assert.equal(codeGrade("a".repeat(5000), "regex"), 0);
});

test("parseGraderResponse scrapes a score from non-JSON, else 0", () => {
  const r = parseGraderResponse("the model rambled, score = 6, end");
  assert.equal(r.score, 6);
  assert.equal(r.reasoning, "unparseable grader response");
  assert.equal(parseGraderResponse("total nonsense, no number").score, 0);
});

test("interpolate stringifies falsy values rather than dropping them", () => {
  assert.equal(interpolate("n={{n}}", { n: 0 }), "n=0");
  assert.equal(interpolate("x={{x}}", { x: "" }), "x=");
});

test("gradeCollected scores an entry with neither code nor model grade as 0", () => {
  const res = gradeCollected({ dataset: [{ output: "freeform" }], passThreshold: 7 });
  assert.equal(res.results[0].score, 0);
  assert.equal(res.results[0].passing, false);
});

test("gradeCollected does not leak a __proto__ key from a hostile suite entry", () => {
  const entry = JSON.parse('{"output":"{}","format":"json","__proto__":{"x":1}}');
  const res = gradeCollected({ dataset: [entry] });
  assert.ok(!Object.prototype.hasOwnProperty.call(res.results[0], "__proto__"));
});

test("runEval rejects an empty dataset", async () => {
  await assert.rejects(
    () => runEval({ dataset: [], promptTemplate: "x", callModel: async () => "y" }),
    /non-empty/
  );
});

test("buildGraderPrompt asks for reasoning + a numeric score and embeds the output", () => {
  const p = buildGraderPrompt("THE_OUTPUT", "must be polite");
  assert.match(p, /THE_OUTPUT/);
  assert.match(p, /must be polite/);
  assert.match(p, /score/i);
  assert.match(p, /strength|weakness|reason/i);
});

test("parseGraderResponse extracts score from a fenced JSON block", () => {
  const r = parseGraderResponse('```json\n{"score": 8, "reasoning": "good"}\n```');
  assert.equal(r.score, 8);
  assert.equal(r.reasoning, "good");
});

test("parseGraderResponse clamps score to 0-10 and tolerates plain JSON", () => {
  assert.equal(parseGraderResponse('{"score": 99}').score, 10);
  assert.equal(parseGraderResponse('{"score": -5}').score, 0);
});

test("runEval merges code + model grades and reports accuracy", async () => {
  const dataset = [
    { task: "give me JSON", format: "json" },
    { task: "give me JSON again", format: "json" },
  ];
  // Fake model: returns valid JSON for the task, and an 8/10 when graded.
  const callModel = async (prompt) => {
    if (/grader|evaluate/i.test(prompt)) return '```json\n{"score": 8, "reasoning": "ok"}\n```';
    return '{"answer": 42}';
  };
  const res = await runEval({
    dataset,
    promptTemplate: "Respond to: {{task}}",
    callModel,
    passThreshold: 7,
  });
  assert.equal(res.results.length, 2);
  // code grade 10 + model grade 8 -> average 9 -> passes threshold 7
  for (const r of res.results) assert.ok(r.score >= 7, `expected pass, got ${r.score}`);
  assert.equal(res.accuracy, 1);
  assert.ok(res.averageScore >= 7);
});

test("runEval without a format skips code grading and uses model score only", async () => {
  const callModel = async (prompt) =>
    /grader|evaluate/i.test(prompt) ? '{"score": 4}' : "some prose";
  const res = await runEval({
    dataset: [{ task: "write a poem" }],
    promptTemplate: "{{task}}",
    callModel,
    passThreshold: 7,
  });
  assert.equal(res.results[0].score, 4);
  assert.equal(res.accuracy, 0);
});
