// `muster spec-lint`: the deterministic SPEC / INTENT gates (src/spec-lint.js, docs/spec-format.md,
// docs/strategy/2026-11-pm-domain-design.md Appendices C and D).
//
// One fixture per issue class in test/fixtures/spec-lint/ (each is ready.md with one defect, plus
// lite mode and two intents), inline mutations of ready.md for the remaining rules, the ID grammar,
// the CLI exit contract, and the muster-pm builtin's templates, budgets and provenance.
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  lintSpec,
  lintIntent,
  detectDocKind,
  classifyId,
  looksLikeId,
  hasPrimaryMetric,
  runSpecLintCli,
  DIMENSIONS,
  VERIFY_STATUS,
  VERIFY_TYPES,
  EARS_TAGS,
  SPEC_WORD_BUDGET,
} from "../src/spec-lint.js";
import { gitBlobSha } from "../src/vendor-sync.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(here, "..");
const FIXTURES = path.join(here, "fixtures", "spec-lint");
const FIXTURE_REPO = path.join(FIXTURES, "repo");
const CLEAN_INTENT = path.join(FIXTURE_REPO, "docs", "intent", "INT-0007-self-serve-refunds.md");
const CLI = path.join(repoRoot, "src", "cli.js");
const read = p => readFileSync(p, "utf8");
const readFixture = name => read(path.join(FIXTURES, name));
const READY = readFixture("ready.md");

const lint = (text, root = FIXTURE_REPO) => lintSpec(text, { projectRoot: root });
const dims = r => [...new Set(r.issues.map(i => i.dimension))];
const blockers = r => r.issues.filter(i => i.severity === "blocker");
const has = (r, dimension, severity, pattern) =>
  r.issues.some(i => i.dimension === dimension && i.severity === severity && (!pattern || pattern.test(i.summary)));
const swap = (text, from, to) => {
  assert.ok(text.includes(from), `mutation anchor missing: ${from}`);
  return text.replace(from, to);
};

// ─── ID grammar (Appendix C) ─────────────────────────────────────────────────

describe("ID grammar", () => {
  test("classifies every kind in Appendix C", () => {
    assert.deepEqual(classifyId("REF-01"), { kind: "requirement", id: "REF-01" });
    assert.deepEqual(classifyId("REF-01.2"), { kind: "ac", id: "REF-01.2", requirement: "REF-01" });
    assert.deepEqual(classifyId("AUTH2-123.12"), { kind: "ac", id: "AUTH2-123.12", requirement: "AUTH2-123" });
    assert.equal(classifyId("INV-01").kind, "invariant");
    assert.equal(classifyId("EV-001").kind, "eval");
    assert.equal(classifyId("RK-02").kind, "risk");
    assert.equal(classifyId("D-03").kind, "decision");
    assert.equal(classifyId("OQ-01").kind, "open question");
    assert.equal(classifyId("NG-01").kind, "non-goal");
    assert.equal(classifyId("A-01").kind, "assumption");
    assert.equal(classifyId("INT-0007").kind, "intent");
  });

  test("rejects malformed IDs and reserved prefixes used as requirement categories", () => {
    for (const bad of ["REF-1", "REF-0001", "R-01", "ABCDEFGHIJKLM-01", "REF-01.123", "INV-01.1", "EV-1", "INT-07", "INT-00007", "OQ-01.2", "ref-01"]) {
      assert.equal(classifyId(bad), null, bad);
    }
  });

  test("looksLikeId separates ID attempts from prose and evidence labels", () => {
    for (const t of ["REF-01", "REF-1", "INV-01.1", "OQ1"]) assert.ok(looksLikeId(t), t);
    for (const t of ["E1", "E12", "Note", "Most dangerous: A-01", "Session"]) assert.ok(!looksLikeId(t), t);
  });

  test("verify types map to the verifier statuses in docs/spec-format.md", () => {
    assert.deepEqual(VERIFY_TYPES, ["test", "check", "eval", "judgment", "needs-runtime"]);
    assert.equal(VERIFY_STATUS.test, "VERIFIED / FAILED");
    assert.equal(VERIFY_STATUS.judgment, "NEEDS-HUMAN");
    assert.equal(VERIFY_STATUS["needs-runtime"], "NEEDS-RUNTIME");
    assert.deepEqual(Object.keys(EARS_TAGS), ["ubiquitous", "event", "state", "unwanted", "optional"]);
    const doc = read(path.join(repoRoot, "docs", "spec-format.md"));
    for (const [type, status] of Object.entries(VERIFY_STATUS)) assert.ok(doc.includes(`| \`${type}\` |`) && doc.includes(status.split(" / ")[0]), type);
    for (const tag of Object.keys(EARS_TAGS)) assert.ok(doc.includes(`\`[${tag}]\``), tag);
  });
});

// ─── Fixtures ────────────────────────────────────────────────────────────────

describe("fixtures (test/fixtures/spec-lint)", () => {
  const expected = {
    "markers-4.md": { dimension: DIMENSIONS.READINESS, blocks: true, only: true },
    "duplicate-id.md": { dimension: DIMENSIONS.ID_GRAMMAR, blocks: true, only: true },
    "verify-missing.md": { dimension: DIMENSIONS.ACCEPTANCE, blocks: true, only: true },
    "vague.md": { dimension: DIMENSIONS.LANGUAGE, blocks: false, only: true },
    "ev-no-number.md": { dimension: DIMENSIONS.AI_EVALS, blocks: true, only: true },
    "ready-blocking-oq.md": { dimension: DIMENSIONS.READINESS, blocks: true, only: true },
    "no-ac.md": { dimension: DIMENSIONS.REQUIREMENTS, blocks: true, only: true },
    "intent-unresolved.md": { dimension: DIMENSIONS.STRUCTURE, blocks: true, only: true },
    "reserved-prefix.md": { dimension: DIMENSIONS.ID_GRAMMAR, blocks: true },
    "impl-language.md": { dimension: DIMENSIONS.LANGUAGE, blocks: false, only: true },
    "no-non-goals.md": { dimension: DIMENSIONS.SCOPE, blocks: false, only: true },
    "ai-no-refusal.md": { dimension: DIMENSIONS.AI_EVALS, blocks: false, only: true },
    "needs-runtime-no-metric.md": { dimension: DIMENSIONS.OUTCOME_LINK, blocks: false, only: true },
    "intent-bad.md": { intent: true, blocks: false },
  };
  const clean = ["ready.md", "lite.md"];

  test("the ready spec and the lite-mode spec pass with zero issues", () => {
    for (const name of clean) assert.deepEqual(lint(readFixture(name)), { verdict: "PASS", issues: [] }, name);
  });

  test("the clean intent passes with zero issues", () => {
    assert.deepEqual(lintIntent(read(CLEAN_INTENT), { fileName: CLEAN_INTENT }), { verdict: "PASS", issues: [] });
  });

  test("every fixture on disk has an expectation", () => {
    const onDisk = readdirSync(FIXTURES).filter(f => f.endsWith(".md") && !clean.includes(f)).sort();
    assert.deepEqual(onDisk, Object.keys(expected).sort());
  });

  for (const [name, want] of Object.entries(expected).filter(([, w]) => !w.intent)) {
    test(`${name}: reports ${want.dimension}${want.blocks ? " as a blocker" : " without blocking"}`, () => {
      const r = lint(readFixture(name));
      assert.equal(r.verdict, "ISSUES");
      assert.ok(dims(r).includes(want.dimension), JSON.stringify(r.issues));
      if (want.only) assert.deepEqual(dims(r), [want.dimension], JSON.stringify(r.issues));
      assert.equal(blockers(r).length > 0, want.blocks, JSON.stringify(r.issues));
    });
  }

  test("markers-4.md: four markers block; the message counts them", () => {
    assert.ok(has(lint(readFixture("markers-4.md")), DIMENSIONS.READINESS, "blocker", /^4 \[NEEDS CLARIFICATION\] markers$/));
  });

  test("duplicate-id.md names both definition lines", () => {
    assert.ok(has(lint(readFixture("duplicate-id.md")), DIMENSIONS.ID_GRAMMAR, "blocker", /REF-01\.2 is defined 2 times \(line \d+, line \d+\)/));
  });

  test("reserved-prefix.md: INV used as a requirement category is a grammar blocker", () => {
    assert.ok(has(lint(readFixture("reserved-prefix.md")), DIMENSIONS.ID_GRAMMAR, "blocker", /INV is reserved for invariant IDs and is never a requirement category/));
  });

  test("intent-bad.md: every intent rule warns, nothing blocks", () => {
    const r = lintIntent(readFixture("intent-bad.md"), { fileName: "intent-bad.md" });
    assert.equal(blockers(r).length, 0, JSON.stringify(r.issues));
    assert.ok(has(r, DIMENSIONS.OUTCOME, "warning", /^2 Primary rows$/));
    assert.ok(has(r, DIMENSIONS.OUTCOME, "warning", /no Guardrail row/));
    assert.ok(has(r, DIMENSIONS.TRADEOFFS, "warning", /^4 tradeoff principles$/));
    assert.ok(has(r, DIMENSIONS.ASSUMPTIONS, "warning", /A-01 .* has no kill criterion/));
    assert.ok(has(r, DIMENSIONS.ID_GRAMMAR, "warning", /NG-1 .* non-goal IDs are NG-NN/));
    assert.ok(has(r, DIMENSIONS.ID_GRAMMAR, "warning", /ONB-01 .* is a requirement ID/));
    assert.ok(has(r, DIMENSIONS.INTENT_STRUCTURE, "warning", /TBD/));
    assert.ok(has(r, DIMENSIONS.INTENT_STRUCTURE, "warning", /status "in progress"/));
    assert.ok(has(r, DIMENSIONS.INTENT_STRUCTURE, "warning", /no owner/));
  });

  test("every issue has exactly the CheckResult keys", () => {
    const all = [
      ...Object.keys(expected).filter(n => !expected[n].intent).flatMap(n => lint(readFixture(n)).issues),
      ...lintIntent(readFixture("intent-bad.md")).issues,
    ];
    for (const issue of all) {
      assert.deepEqual(Object.keys(issue).sort(), ["dimension", "required_property", "severity", "summary"]);
      assert.ok(["blocker", "warning", "info"].includes(issue.severity));
      assert.ok(Object.values(DIMENSIONS).includes(issue.dimension));
    }
  });
});

// ─── SPEC rules, one mutation of ready.md each ───────────────────────────────

describe("spec rules", () => {
  test("structure: no frontmatter, bad YAML, missing spec/status, unknown status, unknown change", () => {
    assert.ok(has(lint(READY.replace(/^---[\s\S]*?\n---\n/, "")), DIMENSIONS.STRUCTURE, "blocker", /no frontmatter/));
    assert.ok(has(lint(swap(READY, "change: new", "change: [new")), DIMENSIONS.STRUCTURE, "blocker", /does not parse/));
    assert.ok(has(lint(swap(READY, "spec: refunds-self-serve\n", "")), DIMENSIONS.STRUCTURE, "blocker", /no spec field/));
    assert.ok(has(lint(swap(READY, "status: ready\n", "")), DIMENSIONS.STRUCTURE, "blocker", /no status field/));
    assert.ok(has(lint(swap(READY, "status: ready", "status: done")), DIMENSIONS.STRUCTURE, "blocker", /unknown status "done"/));
    const change = lint(swap(READY, "change: new", "change: rewrite"));
    assert.ok(has(change, DIMENSIONS.STRUCTURE, "warning", /unknown change/));
    assert.equal(blockers(change).length, 0);
  });

  test("structure: no intent link and no inline Intent blocks; an escaping or absolute intent path blocks", () => {
    assert.ok(has(lint(swap(READY, "intent: docs/intent/INT-0007-self-serve-refunds.md\n", "")), DIMENSIONS.STRUCTURE, "blocker", /no intent link and no ## Intent/));
    assert.ok(has(lint(swap(READY, "intent: docs/intent/INT-0007-self-serve-refunds.md", "intent: ../ready.md")), DIMENSIONS.STRUCTURE, "blocker", /leaves the project root/));
    assert.ok(has(lint(swap(READY, "intent: docs/intent/INT-0007-self-serve-refunds.md", `intent: ${CLEAN_INTENT}`)), DIMENSIONS.STRUCTURE, "blocker", /absolute/));
    assert.ok(has(lint(swap(READY, "intent: docs/intent/INT-0007-self-serve-refunds.md", "intent: [a, b]")), DIMENSIONS.STRUCTURE, "blocker", /is a list/));
    assert.ok(has(lint(swap(READY, "intent: docs/intent/INT-0007-self-serve-refunds.md", "intent: docs/intent")), DIMENSIONS.STRUCTURE, "blocker", /does not resolve/));
    assert.deepEqual(lint(swap(READY, "intent: docs/intent/INT-0007-self-serve-refunds.md", "intent: docs/intent/INT-0007-self-serve-refunds.md#outcome")).issues, []);
  });

  test("structure: an unclosed code fence blocks", () => {
    assert.ok(has(lint(swap(READY, "## Assumptions\n", "## Assumptions\n```\n")), DIMENSIONS.STRUCTURE, "blocker", /unclosed code fence/));
  });

  test("id grammar: a malformed bold-lead ID blocks", () => {
    assert.ok(has(lint(swap(READY, "- **REF-01.3** [state]", "- **REF-1.3** [state]")), DIMENSIONS.ID_GRAMMAR, "blocker", /REF-1\.3 .* is not a valid ID/));
  });

  test("requirements: a criterion under the wrong requirement, outside Requirements, or a requirement outside the section blocks", () => {
    assert.ok(has(lint(swap(READY, "- **REF-01.3** [state]", "- **REF-02.9** [state]")), DIMENSIONS.REQUIREMENTS, "blocker", /REF-02\.9 .* sits under REF-01/));
    assert.ok(has(lint(swap(READY, "## Assumptions\n", "## Assumptions\n- **REF-01.9** [ubiquitous] The system shall log. — verify: test\n")), DIMENSIONS.REQUIREMENTS, "blocker", /REF-01\.9 .* is not a list item under ## Requirements/));
    assert.ok(has(lint(swap(READY, "## Assumptions\n", "## Assumptions\n- **REF-09** stray\n")), DIMENSIONS.REQUIREMENTS, "blocker", /REF-09 .* outside a ## Requirements heading/));
    assert.ok(has(lint(swap(READY, "### REF-02 Self-serve", "### INV-02 Self-serve")), DIMENSIONS.REQUIREMENTS, "blocker", /INV-02 .* is an invariant ID and cannot head a requirement/));
    const notReq = lint(swap(READY, "## Invariants", "### Notes\nSome notes.\n\n## Invariants"));
    assert.ok(has(notReq, DIMENSIONS.REQUIREMENTS, "warning", /heading "Notes/));
    assert.equal(blockers(notReq).length, 0);
  });

  test("requirements: a spec with no requirement and no invariant blocks", () => {
    const empty = "---\nspec: x\nintent: inline\nstatus: draft\n---\n\n## Intent\nJob: x\n\n## Requirements\n";
    assert.ok(has(lint(empty), DIMENSIONS.REQUIREMENTS, "blocker", /no ### CAT-NN requirement and no INV-NN invariant/));
  });

  test("acceptance: no shall, two verify types and an unknown verify type each block", () => {
    assert.ok(has(lint(swap(READY, "the system shall reject a second request", "the system rejects a second request")), DIMENSIONS.ACCEPTANCE, "blocker", /REF-01\.3 .* has no "shall"/));
    assert.ok(has(lint(swap(READY, "for that order. — verify: test", "for that order. — verify: test — verify: judgment")), DIMENSIONS.ACCEPTANCE, "blocker", /2 verify types/));
    assert.ok(has(lint(swap(READY, "for that order. — verify: test", "for that order. — verify: manual")), DIMENSIONS.ACCEPTANCE, "blocker", /unknown verify type "manual"/));
    assert.ok(has(lint(swap(READY, "through the admin flow. — verify: test", "through the admin flow.")), DIMENSIONS.ACCEPTANCE, "blocker", /INV-01 .* has no verify type/));
  });

  test("acceptance: EARS tag missing, unknown or mismatched, an over-long criterion and an invariant without 'continue to' warn", () => {
    const warnOnly = (text, pattern) => {
      const r = lint(text);
      assert.ok(has(r, DIMENSIONS.ACCEPTANCE, "warning", pattern), JSON.stringify(r.issues));
      assert.equal(blockers(r).length, 0, JSON.stringify(r.issues));
    };
    warnOnly(swap(READY, "- **REF-01.3** [state] While", "- **REF-01.3** While"), /REF-01\.3 .* has no EARS tag/);
    warnOnly(swap(READY, "- **REF-01.3** [state]", "- **REF-01.3** [complex]"), /unknown EARS tag \[complex\]/);
    warnOnly(swap(READY, "- **REF-01.3** [state]", "- **REF-01.3** [event]"), /tagged \[event\] but its condition does not use "when"/);
    warnOnly(swap(READY, "for that order. — verify: test", `for that order ${"and keeps the order history intact ".repeat(14)}. — verify: test`), /REF-01\.3 .* is \d{3} characters/);
    warnOnly(swap(READY, "The system shall continue to settle", "The system shall settle"), /INV-01 .* does not say what shall continue to work/);
  });

  test("readiness: ready with one marker blocks; a draft with three markers does not", () => {
    const withMarker = swap(READY, "## Assumptions\n", "## Assumptions\n- Window: [NEEDS CLARIFICATION: 30 or 60 days?]\n");
    assert.ok(has(lint(withMarker), DIMENSIONS.READINESS, "blocker", /status is ready but 1 marker/));
    assert.ok(has(lint(swap(withMarker, "status: ready", "status: in-build")), DIMENSIONS.READINESS, "blocker", /status is in-build/));
    const three = swap(swap(READY, "status: ready", "status: draft"), "## Assumptions\n", `## Assumptions\n${"- [NEEDS CLARIFICATION: x]\n".repeat(3)}`);
    assert.deepEqual(lint(three).issues, []);
  });

  test("readiness: markers inside comments and fenced examples are not counted", () => {
    const quoted = swap(READY, "## Assumptions\n", `## Assumptions\n<!-- [NEEDS CLARIFICATION: a] -->\n\`\`\`\n[NEEDS CLARIFICATION: b]\n- **REF-01.1** quoted\n\`\`\`\n`);
    assert.deepEqual(lint(quoted).issues, []);
  });

  test("readiness: a resolved open question no longer blocks; one without blocks: warns", () => {
    const blocking = readFixture("ready-blocking-oq.md");
    assert.deepEqual(lint(swap(blocking, "blocks: build", "blocks: build — resolved 2026-11-10, see Clarifications")).issues, []);
    const noBlocks = lint(swap(READY, " — owner: Dana Ruiz — blocks: launch", " — owner: Dana Ruiz"));
    assert.ok(has(noBlocks, DIMENSIONS.READINESS, "warning", /OQ-01 .* has no blocks: value/));
    assert.equal(blockers(noBlocks).length, 0);
  });

  test("ai evals: the pass-rule column is found by its header; 'Takes user text: no' waives the refusal/injection rows", () => {
    const reordered = READY
      .replace("| ID | Behavior required | Eval method | Pass rule (fixed before the run) | Case set |", "| ID | Pass rule | Behavior required | Eval method | Case set |")
      .replace(/\| (\*\*EV-0\d\*\*) \| ([^|]+) \| ([^|]+) \| ([^|]+) \| ([^|]+) \|/g, "| $1 | $4 | $2 | $3 | $5 |");
    assert.deepEqual(lint(reordered).issues, []);
    assert.ok(has(lint(reordered.replace("| 30/30 refuse |", "| always |")), DIMENSIONS.AI_EVALS, "blocker", /EV-02 .* "always" has no number/));
    const noRows = readFixture("ai-no-refusal.md");
    assert.deepEqual(lint(swap(noRows, "| **EV-01** |", "Takes user text: no\n\n| ID | x | y | z | w |\n|---|---|---|---|---|\n| **EV-01** |")).issues, []);
  });

  test("ai evals: an AI section with no EV rows warns", () => {
    const r = lint(READY.replace(/\| \*\*EV-0\d\*\* \|[^\n]*\n/g, ""));
    assert.ok(has(r, DIMENSIONS.AI_EVALS, "warning", /no EV-NN rows/));
    assert.equal(blockers(r).length, 0);
  });

  test("language: a quantified quality word is fine; vague words in invariants warn", () => {
    assert.deepEqual(lint(swap(READY, "show its id.", "show its id within 2 s, fast enough for checkout.")).issues, []);
    assert.ok(has(lint(swap(READY, "through the admin flow.", "through the seamless admin flow.")), DIMENSIONS.LANGUAGE, "warning", /INV-01 .* "seamless"/));
    assert.ok(has(lint(swap(READY, "### REF-01 Customer can", "### REF-01 Robust way a customer can")), DIMENSIONS.LANGUAGE, "warning", /REF-01 .* "robust"/));
  });

  test("outcome link: a needs-runtime criterion is fine when the linked intent has a Primary row", () => {
    assert.ok(READY.includes("verify: needs-runtime"));
    assert.ok(hasPrimaryMetric(read(CLEAN_INTENT)));
    assert.ok(!hasPrimaryMetric("| Primary | <one metric> | x |"));
  });

  test("length: a body over the word budget warns; the Traceability block does not count", () => {
    const filler = `${"word ".repeat(SPEC_WORD_BUDGET)}\n`;
    const long = lint(swap(READY, "## Assumptions\n", `## Assumptions\n${filler}`));
    assert.ok(has(long, DIMENSIONS.LENGTH, "warning", /words$/));
    assert.equal(blockers(long).length, 0);
    assert.deepEqual(lint(`${READY}| ${filler} | | | | |\n`).issues, []);
  });

  test("lint never throws on garbage", () => {
    for (const junk of ["", "---", "---\n---\n", "\u0000\u0001", "## Requirements\n### \n- ****", null, undefined, 42]) {
      assert.doesNotThrow(() => lintSpec(junk, { projectRoot: FIXTURE_REPO }));
      assert.doesNotThrow(() => lintIntent(junk));
    }
  });
});

// ─── INTENT rules ────────────────────────────────────────────────────────────

describe("intent rules", () => {
  const INTENT = read(CLEAN_INTENT);
  const lintI = text => lintIntent(text, { fileName: CLEAN_INTENT });

  test("frontmatter: none, or no id, blocks; a malformed id blocks; a file-name mismatch warns", () => {
    assert.ok(has(lintI(INTENT.replace(/^---[\s\S]*?\n---\n/, "")), DIMENSIONS.INTENT_STRUCTURE, "blocker", /no frontmatter/));
    assert.ok(has(lintI(swap(INTENT, "id: INT-0007\n", "")), DIMENSIONS.INTENT_STRUCTURE, "blocker", /no id/));
    assert.ok(has(lintI(swap(INTENT, "id: INT-0007", "id: INT-7")), DIMENSIONS.ID_GRAMMAR, "blocker", /not INT-NNNN/));
    const mismatch = lintI(swap(INTENT, "id: INT-0007", "id: INT-0008"));
    assert.ok(has(mismatch, DIMENSIONS.INTENT_STRUCTURE, "warning", /does not match id INT-0008/));
    assert.equal(blockers(mismatch).length, 0);
  });

  test("a duplicated ID blocks even in an intent", () => {
    assert.ok(has(lintI(swap(INTENT, "## Constraints", "- **NG-01** again\n\n## Constraints")), DIMENSIONS.ID_GRAMMAR, "blocker", /NG-01 is defined 2 times/));
  });

  test("outcome, tradeoffs and assumptions sections each warn when missing or incomplete", () => {
    assert.ok(has(lintI(INTENT.replace(/## Outcome[\s\S]*?## Non-goals/, "## Non-goals")), DIMENSIONS.OUTCOME, "warning", /no ## Outcome/));
    assert.ok(has(lintI(INTENT.replace(/\| Primary \|[^\n]*\n/, "")), DIMENSIONS.OUTCOME, "warning", /0 Primary rows/));
    assert.ok(has(lintI(INTENT.replace(/## Bets and assumptions[\s\S]*?## Decisions/, "## Decisions")), DIMENSIONS.ASSUMPTIONS, "warning", /no assumptions section/));
    assert.ok(has(lintI(swap(INTENT, "| Kill criterion |", "| Notes |")), DIMENSIONS.ASSUMPTIONS, "warning", /no Kill criterion column/));
    const three = INTENT.replace("## Bets", "- When a third thing conflicts, prefer it.\n\n## Bets");
    assert.deepEqual(lintI(three).issues, []);
  });

  test("detectDocKind: spec frontmatter wins, then an INT id or file name", () => {
    assert.equal(detectDocKind(READY, "SPEC.md"), "spec");
    assert.equal(detectDocKind(INTENT, "anything.md"), "intent");
    assert.equal(detectDocKind("# no frontmatter", "docs/intent/INT-0001-x.md"), "intent");
    assert.equal(detectDocKind("# no frontmatter", "notes.md"), "spec");
  });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

describe("spec-lint CLI", () => {
  const capture = () => { const chunks = []; return { write: s => { chunks.push(s); return true; }, text: () => chunks.join("") }; };
  const run = args => {
    const stdout = capture();
    const stderr = capture();
    const code = runSpecLintCli(args, { stdout, stderr, cwd: FIXTURES });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };

  test("exit 0 and PASS on the ready spec; --json is exactly the CheckResult", () => {
    const r = run(["ready.md", "--json", "--root", "repo"]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { verdict: "PASS", issues: [] });
    assert.match(run(["ready.md", "--root", "repo"]).stdout, /^spec-lint ready\.md: PASS/);
  });

  test("exit 1 on blockers, exit 0 on warnings only (verdict still ISSUES)", () => {
    assert.equal(run(["duplicate-id.md", "--root", "repo"]).code, 1);
    const warn = run(["vague.md", "--json", "--root", "repo"]);
    assert.equal(warn.code, 0);
    assert.equal(JSON.parse(warn.stdout).verdict, "ISSUES");
  });

  test("intents are auto-detected by id or file name, and --intent forces the intent rules", () => {
    assert.match(run(["repo/docs/intent/INT-0007-self-serve-refunds.md"]).stdout, /\(intent\): PASS/);
    const bad = run(["intent-bad.md", "--json"]);
    assert.equal(bad.code, 0);
    assert.ok(JSON.parse(bad.stdout).issues.some(i => i.dimension === DIMENSIONS.OUTCOME));
    const forced = run(["ready.md", "--intent", "--json"]);
    assert.equal(forced.code, 1, "a spec linted as an intent has no id");
    assert.ok(JSON.parse(forced.stdout).issues.some(i => i.dimension === DIMENSIONS.INTENT_STRUCTURE && /no id/.test(i.summary)));
  });

  test("exit 2 (not evaluated) on a missing file, a directory, or bad usage", () => {
    assert.equal(run(["nope.md"]).code, 2);
    assert.equal(run(["repo"]).code, 2);
    assert.equal(run([]).code, 2);
    assert.equal(run(["a.md", "b.md"]).code, 2);
    assert.equal(run(["ready.md", "--bogus"]).code, 2);
    assert.equal(run(["ready.md", "--root"]).code, 2);
  });

  test("the muster bin dispatches spec-lint with the same exit codes", () => {
    const bin = args => spawnSync(process.execPath, [CLI, "spec-lint", ...args], { cwd: FIXTURES, encoding: "utf8" });
    assert.equal(bin(["ready.md", "--root", "repo"]).status, 0);
    const blocked = bin(["ev-no-number.md", "--json", "--root", "repo"]);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stdout).issues[0].dimension, DIMENSIONS.AI_EVALS);
    assert.equal(bin(["missing.md"]).status, 2);
  });
});

// ─── The muster-pm builtin ───────────────────────────────────────────────────

describe("muster-pm builtin", () => {
  const pm = path.join(repoRoot, "plugin", "builtins", "muster-pm");
  const tokens = p => Buffer.byteLength(read(p), "utf8") / 4;

  test("the SPEC template lints clean against the fixture intent, and the INTENT template has no blocker", () => {
    assert.deepEqual(lint(read(path.join(pm, "templates", "SPEC.md"))), { verdict: "PASS", issues: [] });
    assert.equal(blockers(lintIntent(read(path.join(pm, "templates", "INTENT.md")))).length, 0);
  });

  test("context budgets: SKILL.md at most 2.5k tokens, each template about 1k (bytes/4 estimate)", () => {
    assert.ok(tokens(path.join(pm, "SKILL.md")) <= 2500, `SKILL.md is ~${Math.round(tokens(path.join(pm, "SKILL.md")))} tokens`);
    for (const t of ["INTENT.md", "SPEC.md"]) {
      const n = tokens(path.join(pm, "templates", t));
      assert.ok(n <= 1300, `templates/${t} is ~${Math.round(n)} tokens`);
    }
  });

  test("SKILL.md has a one-line description and points at every template and reference", () => {
    const text = read(path.join(pm, "SKILL.md"));
    const fm = parseYaml(text.match(/^---\n([\s\S]*?)\n---/)[1]);
    assert.equal(fm.name, "muster-pm");
    assert.ok(fm.description && !fm.description.includes("\n"));
    for (const f of ["templates/INTENT.md", "templates/SPEC.md", "references/ears.md", "references/ai-evals.md"]) assert.ok(text.includes(`(${f})`), f);
    assert.ok(fm.upstream.some(u => u.repo === "gotalab/cc-sdd" && u.relation === "vendored"));
    for (const author of ["Anthropic", "OpenAI", "Hamel Husain"]) assert.ok(fm.upstream.some(u => u.kind === "article" && String(u.author).startsWith(author)), author);
  });

  test("references/ears.md is cc-sdd's ears-format, byte for byte, as a merge-tracked verbatim item", () => {
    const manifest = parseYaml(read(path.join(repoRoot, "vendor", "manifest.yaml")));
    const source = manifest.sources.find(s => s.repo === "gotalab/cc-sdd");
    assert.ok(source && source.license === "MIT" && /^[0-9a-f]{40}$/.test(source.ref));
    const item = source.items.find(i => i.to === "plugin/builtins/muster-pm/references/ears.md");
    assert.equal(item.mode, "verbatim");
    assert.equal(item.from, "tools/cc-sdd/templates/shared/settings/rules/ears-format.md");
    assert.equal(gitBlobSha(readFileSync(path.join(pm, "references", "ears.md"))), item.baseBlob);
  });

  test("references/ai-evals.md is muster-native and its inspirations are recorded as articles", () => {
    const manifest = parseYaml(read(path.join(repoRoot, "vendor", "manifest.yaml")));
    const articles = manifest.sources.filter(s => s.kind === "article" && s.items.some(i => i.id === "muster-pm"));
    assert.ok(articles.length >= 4);
    assert.ok(articles.every(a => a.relation === "inspired-by" && a.fetch === false && /^https:\/\//.test(a.url)));
    const evals = read(path.join(pm, "references", "ai-evals.md"));
    for (const rule of [/Binary per case/, /fixed up front/, /evals you have not discovered yet/, /No similarity metrics/, /A rate needs a designed sample/, /Refusal/, /Injection/, /Abstention/]) assert.match(evals, rule);
  });
});
