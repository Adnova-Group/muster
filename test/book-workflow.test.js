// Unit tests for plugin/workflows/book.js, loaded as Claude Code's Workflow runtime runs it: a
// function body with agent/parallel/pipeline/phase/log/args globals (same harness as workflows.test.js).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as S from "../plugin/workflows/book-schemas.js";

const dir = new URL("../plugin/workflows/", import.meta.url);
const AsyncFunction = (async () => {}).constructor;
const SRC = await readFile(new URL("book.js", dir), "utf8");

function load() {
  assert.match(SRC, /^export const meta = \{/);
  return new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", SRC.replace(/^export const meta =/, "const meta ="));
}
const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)));
const pipeline = (items, ...stages) => Promise.all(items.map(async (item, i) => {
  try {
    let v = item;
    for (const s of stages) v = await s(v, item, i);
    return v;
  } catch { return null; }
}));

async function run(args, respond) {
  const calls = [];
  const logs = [];
  const agent = async (prompt, opts) => {
    calls.push({ prompt, opts });
    return respond(opts.label, prompt, opts, calls);
  };
  const result = await load()(agent, parallel, pipeline, () => {}, (m) => logs.push(m), args);
  return { result, calls, logs };
}

const ch = (id, deps = [], extra = {}) => ({ id, title: `Chapter ${id}`, goal: `goal of ${id}`, pov: "third limited, Mara", tense: "past", targetWords: 1200, dependsOn: deps, path: `.muster/runs/b1/chapters/${id}.md`, ...extra });
const manuscript = (ids, status = "planned") => ids.map((id) => ({ id, title: `Chapter ${id}`, path: `.muster/runs/b1/chapters/${id}.md`, status, summary: "" }));
const passArgs = (over = {}) => ({
  runId: "b1", mode: "pass", title: "Salt Road", kind: "fiction", voice: { pov: "third limited", tense: "past", notes: "" },
  canonPath: ".muster/runs/b1/CANON.md", ledgerPath: ".muster/runs/b1/LEDGER.md",
  waves: [[ch("ch01"), ch("ch02")], [ch("ch03", ["ch01"])]], recheck: [], manuscript: manuscript(["ch01", "ch02", "ch03"]),
  passes: { continuity: true, developmental: false, lineEdit: false, beta: 0 }, ...over,
});

const draft = (id, over = {}) => ({ chapterId: id, status: "done", path: `.muster/runs/b1/chapters/${id}.md`, words: 1200, pov: "third limited", tense: "past", summary: `${id} happens`, canonUsed: ["C-001"], newCanon: [{ fact: `fact from ${id}`, category: "world", line: 3 }], notes: [], ...over });
const pass = (id) => ({ chapterId: id, verdict: "PASS", issues: [], debtsResolved: [] });
const issue = (over = {}) => ({ chapter: "ch01", line: 12, quote: "her eyes were green", canonId: "C-002", canonFact: "Mara's eyes are brown", kind: "contradiction", severity: "major", summary: "eye colour changed", maybeIntentional: false, ...over });
const dev = (verdict = "PASS") => ({ verdict, notes: verdict === "PASS" ? [] : [{ chapter: "ch02", action: "cut", severity: "major", summary: "ch02 changes nothing", readerCost: "the middle sags" }], pacing: [{ chapter: "ch01", tension: 3 }] });
const line = (id) => ({ chapterId: id, status: "done", path: `.muster/runs/b1/chapters/${id}.md`, edits: 4, patterns: [{ name: "explained subtext", readerCost: "does the reader's work" }], canonTouched: [] });
const beta = (persona) => ({ persona, source: "simulated", finished: true, putDownChapter: "", engagement: [{ chapter: "ch01", score: 4 }], confusions: [], highlights: [], verdict: "kept reading" });

function happy(label) {
  const [kind, id] = label.split(" ");
  if (kind === "draft" || kind === "fix") return draft(id);
  if (kind === "check") return pass(id);
  if (kind === "develop") return dev();
  if (kind === "line") return line(id);
  if (kind === "beta") return beta(`reader ${id}`);
  throw new Error(`unexpected label ${label}`);
}

test("book: the workflow inlines every book schema exactly as book-schemas.js exports it", () => {
  const body = SRC.slice(SRC.indexOf("const str = "), SRC.indexOf("const FIX_CAP"));
  const inlined = new Function(`${body}; return { OUTLINE_RESULT, OUTLINE_CHECK, DRAFT_RESULT, CONTINUITY_RESULT, DEV_RESULT, LINE_RESULT, BETA_RESULT };`)();
  for (const [name, schema] of Object.entries(inlined)) assert.deepEqual(schema, S[name], `${name} drifted from book-schemas.js`);
  assert.equal(Object.keys(inlined).length, Object.keys(S).length, "every exported schema is inlined");
});

test("book: meta is a pure literal, every phase is declared, and nothing non-deterministic runs", () => {
  const meta = SRC.slice(0, SRC.indexOf("\n}\n") + 2);
  assert.match(meta, /name: 'book'/);
  assert.doesNotMatch(meta, /\$\{|\.\.\./);
  assert.doesNotMatch(SRC, /Date\.now\(\)|Math\.random\(\)|new Date\(\)/);
  for (const [, phase] of SRC.matchAll(/phase: '([A-Za-z]+)'/g)) assert.match(meta, new RegExp(`title: '${phase}'`), `phase ${phase} missing from meta`);
});

test("book pass: waves draft in parallel, later waves see earlier canon, each chapter is checked", async () => {
  const order = [];
  const { result, calls } = await run(passArgs({ models: { writer: { model: "sonnet", effort: "medium" }, continuity: { model: "haiku" } } }), (label, p, o) => { order.push(label); return happy(label, p, o); });
  assert.deepEqual(result.drafts.map((d) => [d.chapterId, d.status]), [["ch01", "done"], ["ch02", "done"], ["ch03", "done"]]);
  assert.deepEqual(result.continuity.map((c) => [c.chapterId, c.final.verdict, c.rounds]), [["ch01", "PASS", 1], ["ch02", "PASS", 1], ["ch03", "PASS", 1]]);
  // ch03 (wave 2) starts only after wave 1 is drafted and checked, and its brief carries wave 1's new facts.
  assert.ok(order.indexOf("draft ch03") > order.indexOf("check ch01 r0") && order.indexOf("draft ch03") > order.indexOf("check ch02 r0"));
  const d3 = calls.find((c) => c.opts.label === "draft ch03");
  assert.match(d3.prompt, /\(ch01\) \[world\] fact from ch01/);
  assert.match(d3.prompt, /\(ch02\) \[world\] fact from ch02/);
  assert.match(d3.prompt, /closing 40 lines of: \.muster\/runs\/b1\/chapters\/ch01\.md, \.muster\/runs\/b1\/chapters\/ch02\.md/);
  // ch01 has no dependency and no predecessor: nothing to read back.
  assert.doesNotMatch(calls.find((c) => c.opts.label === "draft ch01").prompt, /closing 40 lines/);
  for (const c of calls.filter((x) => x.opts.label.startsWith("draft "))) {
    assert.equal(c.opts.agentType, "muster:book-writer");
    assert.deepEqual(c.opts.schema, S.DRAFT_RESULT);
    assert.equal(c.opts.model, "sonnet");
    assert.equal(c.opts.isolation, undefined, "chapters are distinct files in the main checkout");
    assert.match(c.prompt, /This brief may be replayed/);
  }
  for (const c of calls.filter((x) => x.opts.label.startsWith("check "))) {
    assert.equal(c.opts.agentType, "muster:book-continuity-checker");
    assert.deepEqual(c.opts.schema, S.CONTINUITY_RESULT);
    assert.equal(c.opts.model, "haiku");
    assert.equal("effort" in c.opts, false);
    assert.match(c.prompt, /Read only/);
  }
  assert.equal(result.provisionalCanon.length, 3);
  assert.equal(result.development, null);
  assert.deepEqual(result.lineEdits, []);
  assert.deepEqual(result.beta, []);
});

test("book pass: a blocking continuity issue sends the writer back, then the re-check passes", async () => {
  const { result, calls } = await run(passArgs({ waves: [[ch("ch01")]] }), (label) => {
    if (label === "check ch01 r0") return { chapterId: "ch01", verdict: "ISSUES", issues: [issue()], debtsResolved: [] };
    return happy(label);
  });
  const c = result.continuity[0];
  assert.equal(c.rounds, 2);
  assert.equal(c.final.verdict, "PASS");
  assert.equal(c.fixes.length, 1);
  const fix = calls.find((x) => x.opts.label === "fix ch01 r1");
  assert.equal(fix.opts.agentType, "muster:book-writer");
  assert.match(fix.prompt, /\[major\] line 12 "her eyes were green": eye colour changed \(canon C-002: Mara's eyes are brown\)/);
  assert.match(fix.prompt, /Never edit CANON\.md/);
});

test("book pass: minor and maybe-intentional issues never trigger a fix; the cap stops at 2 fixes", async () => {
  const soft = await run(passArgs({ waves: [[ch("ch01")]] }), (label) => {
    if (label.startsWith("check")) return { chapterId: "ch01", verdict: "ISSUES", issues: [issue({ severity: "minor" }), issue({ maybeIntentional: true, quote: "the attack was Tuesday" })], debtsResolved: [] };
    return happy(label);
  });
  assert.equal(soft.calls.some((c) => c.opts.label.startsWith("fix")), false);
  assert.equal(soft.result.continuity[0].final.issues.length, 2, "unfixed issues are returned for the ledger");

  const stuck = await run(passArgs({ waves: [[ch("ch01")]] }), (label) => {
    if (label.startsWith("check")) return { chapterId: "ch01", verdict: "ISSUES", issues: [issue({ severity: "blocker" })], debtsResolved: [] };
    return happy(label);
  });
  assert.equal(stuck.calls.filter((c) => c.opts.label.startsWith("check")).length, 3);
  assert.equal(stuck.calls.filter((c) => c.opts.label.startsWith("fix")).length, 2);
  assert.equal(stuck.result.continuity[0].final.verdict, "ISSUES");
});

test("book pass: re-check chapters run first with their debts and report which debts they showed", async () => {
  const order = [];
  const recheck = [{ ...ch("ch01"), reason: "open continuity debts", debts: [{ id: "D-001", canonId: "C-002", line: 12, quote: "green", summary: "eye colour" }] }];
  const { result, calls } = await run(passArgs({ recheck, waves: [[ch("ch02")]], manuscript: [...manuscript(["ch01"], "drafted"), ...manuscript(["ch02"])] }), (label) => {
    order.push(label);
    if (label === "check ch01 r0") return { chapterId: "ch01", verdict: "PASS", issues: [], debtsResolved: ["D-001"] };
    return happy(label);
  });
  assert.equal(order[0], "check ch01 r0", "re-checks run before drafting");
  assert.match(calls[0].prompt, /- D-001 line 12 vs C-002: eye colour/);
  const c = result.continuity.find((x) => x.chapterId === "ch01");
  assert.deepEqual(c.debtsShown, ["D-001"]);
  assert.deepEqual(c.final.debtsResolved, ["D-001"]);
});

test("book pass: a failed draft is skipped by continuity and by the whole-book passes", async () => {
  const { result, calls } = await run(passArgs({ waves: [[ch("ch01"), ch("ch02")]], manuscript: manuscript(["ch01", "ch02"]), passes: { continuity: true, developmental: true, lineEdit: true, beta: 1 } }), (label) => {
    if (label === "draft ch02") throw new Error("StructuredOutput retry cap (2) exceeded");
    return happy(label);
  });
  assert.equal(result.drafts.find((d) => d.chapterId === "ch02").status, "error");
  assert.equal(calls.some((c) => c.opts.label.startsWith("check ch02")), false);
  const devCall = calls.find((c) => c.opts.label === "develop");
  assert.match(devCall.prompt, /ch01/);
  assert.doesNotMatch(devCall.prompt, /ch02\.md/);
  assert.deepEqual(result.lineEdits.map((l) => l.chapterId), ["ch01"]);
});

test("book pass: line edits wait for a developmental PASS (structure before polish)", async () => {
  const p = { continuity: true, developmental: true, lineEdit: true, beta: 0 };
  const revise = await run(passArgs({ passes: p }), (label) => (label === "develop" ? dev("REVISE") : happy(label)));
  assert.equal(revise.calls.some((c) => c.opts.label.startsWith("line")), false);
  assert.match(revise.result.skipped.lineEdit, /REVISE/);
  assert.equal(revise.result.development.notes[0].action, "cut");

  const ok = await run(passArgs({ passes: p }), happy);
  const lines = ok.calls.filter((c) => c.opts.label.startsWith("line "));
  assert.deepEqual(lines.map((c) => c.opts.label), ["line ch01", "line ch02", "line ch03"]);
  for (const c of lines) {
    assert.equal(c.opts.agentType, "muster:book-line-editor");
    assert.deepEqual(c.opts.schema, S.LINE_RESULT);
    assert.match(c.prompt, /The canon is fixed/);
  }
  const d = ok.calls.find((c) => c.opts.label === "develop");
  assert.equal(d.opts.agentType, "muster:book-developmental-editor");
  assert.deepEqual(d.opts.schema, S.DEV_RESULT);
});

test("book pass: beta readers get distinct personas, read in manuscript order, and never see the bible", async () => {
  const { result, calls } = await run(passArgs({ passes: { continuity: true, developmental: false, lineEdit: false, beta: 3 } }), happy);
  const betas = calls.filter((c) => c.opts.label.startsWith("beta "));
  assert.equal(betas.length, 3);
  assert.equal(new Set(betas.map((b) => b.prompt.split("\n")[0])).size, 3, "three different personas");
  for (const b of betas) {
    assert.equal(b.opts.agentType, "muster:book-beta-reader");
    assert.deepEqual(b.opts.schema, S.BETA_RESULT);
    assert.match(b.prompt, /Do not open \.muster\/runs\/b1\/CANON\.md/);
    assert.ok(b.prompt.indexOf("ch01.md") < b.prompt.indexOf("ch02.md") && b.prompt.indexOf("ch02.md") < b.prompt.indexOf("ch03.md"));
  }
  assert.equal(result.beta.length, 3);
  const nf = await run(passArgs({ kind: "nonfiction", passes: { beta: 1 } }), happy);
  assert.match(nf.calls.find((c) => c.opts.label === "beta 1").prompt, /Target reader/);
});

test("book outline: variants in parallel, the best-checked one is kept, blocking issues revise it", async () => {
  const outline = (title, extra = {}) => ({ status: "done", title, kind: "fiction", premise: "p", voice: { pov: "first", tense: "past" }, chapters: [{ id: "ch01", title: "a", goal: "g", dependsOn: [] }], canon: [{ fact: "Mara is 34", category: "character" }], summary: "ok", ...extra });
  let checks = 0;
  const { result, calls } = await run({ runId: "b2", mode: "outline", brief: "a lighthouse keeper's last winter", variants: 2 }, (label, prompt) => {
    if (label === "outline v1") return outline("Weak");
    if (label === "outline v2") return outline("Strong");
    if (label === "outline check v1") return { verdict: "ISSUES", score: 3, issues: [{ severity: "blocker", summary: "no stakes" }] };
    if (label === "outline check v2") return { verdict: "ISSUES", score: 7, issues: [{ chapter: "ch01", severity: "major", summary: "ch01 changes nothing" }] };
    if (label === "outline r1") { assert.match(prompt, /"title":"Strong"/); assert.match(prompt, /\[major\] ch01: ch01 changes nothing/); return outline("Strong 2"); }
    if (label === "outline check r1") { checks++; return { verdict: "PASS", score: 8, issues: [] }; }
    throw new Error(label);
  });
  assert.equal(result.status, "done");
  assert.equal(result.outline.title, "Strong 2");
  assert.equal(result.revisions, 1);
  assert.equal(checks, 1);
  assert.deepEqual(result.variants.map((v) => v.title), ["Weak", "Strong"]);
  assert.match(calls.find((c) => c.opts.label === "outline v1").prompt, /Variant 1: take a genuinely different angle/);
  assert.equal(calls.find((c) => c.opts.label === "outline v1").opts.agentType, "muster:book-writer");
  assert.equal(calls.find((c) => c.opts.label === "outline check v1").opts.agentType, "muster:book-developmental-editor");
  assert.deepEqual(calls.find((c) => c.opts.label === "outline v1").opts.schema, S.OUTLINE_RESULT);
  assert.deepEqual(calls.find((c) => c.opts.label === "outline check v1").opts.schema, S.OUTLINE_CHECK);
});

test("book outline: revision cap, writer failure, and a plain-string brief", async () => {
  const outline = { status: "done", title: "T", kind: "fiction", premise: "p", voice: { pov: "first", tense: "past" }, chapters: [], canon: [], summary: "" };
  const capped = await run({ runId: "b3", mode: "outline", brief: "x" }, (label) => (label.includes("check") ? { verdict: "ISSUES", score: 2, issues: [{ severity: "blocker", summary: "weak" }] } : outline));
  assert.equal(capped.result.status, "issues");
  assert.equal(capped.result.revisions, 2);

  const dead = await run({ runId: "b4", mode: "outline", brief: "x" }, () => { throw new Error("boom"); });
  assert.equal(dead.result.status, "error");
  assert.match(dead.result.error, /boom/);

  const str = await run("A field guide to urban foraging", (label) => (label.includes("check") ? { verdict: "PASS", score: 9, issues: [] } : outline));
  assert.equal(str.result.runId, "book-a-field-guide-to-urban-foraging");
  assert.match(str.calls[0].prompt, /The author's brief: A field guide to urban foraging/);
});

test("book: junk args return an error without calling any agent", async () => {
  for (const junk of [undefined, "", "{}", JSON.stringify({ runId: "b1" }), JSON.stringify({ runId: "b1", waves: [] })]) {
    const { result, calls } = await run(junk, happy);
    assert.equal(result.status, "error", `args ${junk}`);
    assert.equal(calls.length, 0);
  }
});
