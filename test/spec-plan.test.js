// PM stage B: plan integration and traceability (docs/strategy/2026-11-pm-domain-design.md
// "Plan integration", docs/plan-format.md "Planning from a spec"). Covers plan-lint's
// spec_traceability dimension, preflight's spec detection, the CONTEXT.md import, the
// clarification round and `muster spec-trace`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { trackedMkdtemp } from "../test-support/helpers.js";
import { DIMENSIONS, lintPlan } from "../src/plan-lint.js";
import {
  applyClarifications, describeSpec, detectSpecRef, parseSpecRef, runSpecClarify, specModel, specScope, upsertSpecImport, writeSpecContext,
} from "../src/spec-plan.js";
import { parseAcceptance, runSpecTrace } from "../src/spec-trace.js";
import { runPreflight } from "../src/preflight.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const fixtures = join(root, "test/fixtures/spec-plan");
const repo = join(fixtures, "repo");
const NOW = new Date("2026-11-10T12:00:00Z");
const tmp = (p) => trackedMkdtemp(join(tmpdir(), `muster-spec-plan-${p}-`));
const planText = (name) => readFile(join(fixtures, "plans", name), "utf8");
const trace = (result) => result.issues.filter((i) => i.dimension === DIMENSIONS.SPEC_TRACEABILITY);
const bySeverity = (issues, s) => issues.filter((i) => i.severity === s);

async function lintFixture(name, edit = (t) => t) {
  return lintPlan(edit(await planText(name)), { projectRoot: repo });
}

async function repoCopy(label) {
  const dir = await tmp(label);
  await cp(repo, dir, { recursive: true });
  return dir;
}

// ── plan-lint spec_traceability ─────────────────────────────────────────────

test("plan-lint: a plan covering every in-scope ID passes with only the needs-runtime info", async () => {
  const r = await lintFixture("covered.md");
  assert.equal(bySeverity(r.issues, "blocker").length, 0);
  assert.equal(bySeverity(r.issues, "warning").length, 0);
  assert.deepEqual(trace(r).map((i) => [i.severity, i.summary]), [["info", "REF-02.1 is needs-runtime: the verifier records NEEDS-RUNTIME, never VERIFIED"]]);
});

test("plan-lint: an uncovered test criterion blocks", async () => {
  const issues = trace(await lintFixture("uncovered.md"));
  const blockers = bySeverity(issues, "blocker");
  assert.equal(blockers.length, 1);
  assert.match(blockers[0].summary, /^REF-01\.2 \(verify: test\) is covered by no task$/);
  assert.match(blockers[0].required_property, /Every in-scope test, check and eval ID appears in some task's covers/);
});

test("plan-lint: an unknown or uncoverable covers ID blocks", async () => {
  const blockers = bySeverity(trace(await lintFixture("unknown-id.md")), "blocker").map((i) => i.summary);
  assert.deepEqual(blockers, [
    "EV-09 (task 03 covers) is not defined in docs/specs/refunds/SPEC.md",
    "D-01 (task 03 covers) is a decision ID, which a task cannot cover",
  ]);
  const proves = trace(await lintFixture("covered.md", (t) => t.replace('proves="REF-01.1"', 'proves="REF-01.7"')));
  assert.ok(proves.some((i) => i.severity === "blocker" && /^REF-01\.7 \(task 01 proves\)/.test(i.summary)));
  const ac = trace(await lintFixture("covered.md", (t) => t.replace("ac: [REF-01.1]", "ac: [REF-09.1]")));
  assert.ok(ac.some((i) => i.severity === "blocker" && /^REF-09\.1 \(must_haves\.truths\[0\] ac\)/.test(i.summary)));
});

test("plan-lint: a spec that is not ready blocks, naming the status and the questions still blocking build", async () => {
  const blockers = bySeverity(trace(await lintFixture("not-ready.md")), "blocker");
  assert.equal(blockers.length, 1);
  assert.equal(blockers[0].summary, "docs/specs/draft/SPEC.md is not ready: its status is draft, and OQ-01, NC-1 still block build");
});

test("plan-lint: a missing, unreadable or out-of-root spec blocks and stops the dimension", async () => {
  for (const [ref, why] of [["docs/specs/nope/SPEC.md", /ENOENT/], ["../outside/SPEC.md", /outside the project root/], ["docs/specs", /not a regular file/]]) {
    const issues = trace(await lintFixture("covered.md", (t) => t.replace("spec: docs/specs/refunds/SPEC.md", `spec: ${ref}`)));
    assert.equal(issues.length, 1, ref);
    assert.equal(issues[0].severity, "blocker");
    assert.match(issues[0].summary, why);
  }
  const empty = trace(await lintFixture("covered.md", (t) => t.replace("spec: docs/specs/refunds/SPEC.md", "spec:")));
  assert.deepEqual(empty.map((i) => i.summary), ["spec is empty"]);
});

test("plan-lint: a spec-less plan is unchanged; the dimension is purely additive", async () => {
  const less = await lintFixture("spec-less.md");
  assert.equal(less.verdict, "PASS");
  assert.equal(trace(less).length, 0);
  // covers/proves/requirements without spec: are ignored, exactly like any unknown attribute.
  const covered = await lintFixture("covered.md");
  assert.deepEqual(covered.issues.filter((i) => i.dimension !== DIMENSIONS.SPEC_TRACEABILITY), less.issues);
  const classic = await readFile(join(root, "test/fixtures/plan-lint/clean.md"), "utf8");
  assert.equal(trace(lintPlan(classic, { projectRoot: join(root, "test/fixtures/plan-lint/repo") })).length, 0);
});

test("plan-lint: the four warnings (judgment checkpoint, proves, invariant prohibition, missing decision)", async () => {
  const issues = trace(await lintFixture("covered.md", (t) => t
    .replace('type="checkpoint:human-verify" wave="3" depends_on="02" covers="REF-02.2"', 'type="checkpoint:human-verify" wave="3" depends_on="02"')
    .replace('<automated proves="EV-01 EV-02">', '<automated proves="EV-01">')
    .replace("      ac: [INV-01]\n", "")
    .replace("decisions: [D-01, D-02]", "decisions: [D-01]")
    .replace("Partial refunds issued", "Partial refunds made")));
  assert.equal(bySeverity(issues, "blocker").length, 0);
  assert.deepEqual(bySeverity(issues, "warning").map((i) => i.summary), [
    "REF-02.2 is verify: judgment but no checkpoint:human-verify task covers it",
    "EV-02 is covered by task 03 but no <automated proves> names it",
    "INV-01 is not listed in must_haves.prohibitions",
    "D-02 is decided in docs/specs/refunds/SPEC.md but missing from decisions:",
  ]);
  // An invariant named in a prohibition statement (string form) counts as listed.
  const named = trace(await lintFixture("covered.md", (t) => t.replace("      ac: [INV-01]\n", "").replace("Partial refunds issued by support agents", "INV-01: partial refunds issued by support agents")));
  assert.ok(!named.some((i) => /INV-01 is not listed/.test(i.summary)));
});

test("plan-lint: a requirement ID in covers covers each of its criteria", async () => {
  const issues = trace(await lintFixture("uncovered.md", (t) => t.replace('covers="INV-01"', 'covers="REF-01 INV-01"').replace("<automated>node --test test/window.test.js", '<automated proves="REF-01.2">node --test test/window.test.js')));
  assert.equal(bySeverity(issues, "blocker").length, 0);
});

test("plan-lint: a #REF scope narrows coverage; invariants stay in scope; an unknown anchor blocks", async () => {
  // Only REF-01 is in scope: REF-02's judgment criterion and EV-02 (cites no REF-01 ID) drop out,
  // EV-01 (cites REF-01) and INV-01 stay.
  const scoped = trace(await lintFixture("covered.md", (t) => t
    .replace("spec: docs/specs/refunds/SPEC.md", "spec: docs/specs/refunds/SPEC.md#REF-01")
    .replace(/<task id="04"[\s\S]*?<\/task>\n/, "")
    .replace('covers="EV-01 EV-02"', 'covers="EV-01"').replace('proves="EV-01 EV-02"', 'proves="EV-01"')
    .replace("autonomous: false", "autonomous: true")));
  assert.deepEqual(scoped.map((i) => i.severity), []);
  const model = specModel(await readFile(join(repo, "docs/specs/refunds/SPEC.md"), "utf8"));
  assert.deepEqual(specScope(model, ["REF-01"]).items.map((e) => e.id), ["REF-01.1", "REF-01.2", "INV-01", "EV-01"]);
  assert.deepEqual(specScope(model, []).items.map((e) => e.id), ["REF-01.1", "REF-01.2", "REF-02.1", "REF-02.2", "INV-01", "EV-01", "EV-02"]);
  const bad = trace(await lintFixture("covered.md", (t) => t.replace("spec: docs/specs/refunds/SPEC.md", "spec: docs/specs/refunds/SPEC.md#REF-07")));
  assert.ok(bad.some((i) => i.severity === "blocker" && /scope #REF-07/.test(i.summary)));
});

test("plan-lint CLI exits 1 on the uncovered fixture and 0 on the covered one", () => {
  const cli = join(root, "src/cli.js");
  const run = (name) => spawnSync(process.execPath, [cli, "plan-lint", join(fixtures, "plans", name), "--root", repo], { encoding: "utf8" });
  assert.equal(run("covered.md").status, 0);
  const bad = run("uncovered.md");
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /BLOCKER \[spec_traceability\] REF-01\.2/);
});

test("the plan-lint -> spec-plan -> spec-lint import cycle loads from any entry point", () => {
  for (const m of ["spec-lint", "plan-lint", "spec-plan", "spec-trace", "preflight"]) {
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(join(root, "src", `${m}.js`))});`], { encoding: "utf8" });
    assert.equal(r.status, 0, `${m}: ${r.stderr}`);
  }
});

// ── preflight spec detection ─────────────────────────────────────────────────

test("detectSpecRef: a SPEC.md path, an anchor, a docs/specs file and a backlog annotation", () => {
  assert.equal(detectSpecRef("/muster:plan docs/specs/refunds/SPEC.md"), "docs/specs/refunds/SPEC.md");
  assert.equal(detectSpecRef("build `docs/specs/refunds/SPEC.md#REF-02`, then stop."), "docs/specs/refunds/SPEC.md#REF-02");
  assert.equal(detectSpecRef("implement docs/specs/billing/limits.md"), "docs/specs/billing/limits.md");
  assert.equal(detectSpecRef("- [ ] Refund window {spec: docs/specs/refunds/SPEC.md#REF-02}"), "docs/specs/refunds/SPEC.md#REF-02");
  assert.equal(detectSpecRef("add a --json flag to hygiene"), null);
  assert.deepEqual(parseSpecRef("docs/specs/x/SPEC.md#REF-02,REF-03"), { path: "docs/specs/x/SPEC.md", anchors: ["REF-02", "REF-03"] });
});

test("preflight: a ready spec skips the interview and reports its IDs in the same call", async () => {
  const cwd = await repoCopy("pf-ready");
  const s = await runPreflight({ outcome: "/muster:plan docs/specs/refunds/SPEC.md", cwd, home: await tmp("pf-home"), catalogDir: join(root, "catalog"), runId: "r1", now: NOW, env: { MUSTER_CACHE_DIR: await tmp("pf-cache") } });
  assert.equal(s.clear, true);
  assert.deepEqual(s.unclear, []);
  assert.equal(s.route, "code");
  assert.deepEqual(s.spec, {
    path: "docs/specs/refunds/SPEC.md", anchor: null, status: "ready", ready: true,
    acs: ["REF-01.1", "REF-01.2", "REF-02.1", "REF-02.2"], invariants: ["INV-01"], evals: ["EV-01", "EV-02"], decisions: ["D-01", "D-02"], openQuestions: [],
  });
  const detail = JSON.parse(await readFile(join(cwd, ".muster/runs/r1/preflight.json"), "utf8"));
  assert.equal(detail.spec.path, "docs/specs/refunds/SPEC.md");
});

test("preflight: a draft spec is not clear and lists only its blocking questions; a scoped backlog item narrows the IDs", async () => {
  const cwd = await repoCopy("pf-draft");
  const home = await tmp("pf-home2");
  const env = { MUSTER_CACHE_DIR: await tmp("pf-cache2") };
  const s = await runPreflight({ outcome: "plan docs/specs/draft/SPEC.md", cwd, home, catalogDir: join(root, "catalog"), runId: "r2", now: NOW, env });
  assert.equal(s.clear, false);
  assert.deepEqual(s.unclear, []);
  assert.equal(s.spec.ready, false);
  assert.deepEqual(s.spec.openQuestions, [
    { id: "OQ-01", question: "Does the window start at delivery or at dispatch?" },
    { id: "NC-1", question: "30 or 60 days?" },
  ]);
  const scoped = await runPreflight({ outcome: "- [ ] Refund window {spec: docs/specs/refunds/SPEC.md#REF-02}", cwd, home, catalogDir: join(root, "catalog"), runId: "r3", now: NOW, env });
  assert.equal(scoped.spec.anchor, "REF-02");
  assert.deepEqual(scoped.spec.acs, ["REF-02.1", "REF-02.2"]);
  assert.deepEqual(scoped.spec.evals, []);
  const missing = describeSpec({ cwd, ref: "docs/specs/gone/SPEC.md" });
  assert.equal(missing.ready, false);
  assert.match(missing.error, /cannot read docs\/specs\/gone\/SPEC\.md: ENOENT/);
});

// ── CONTEXT.md import ────────────────────────────────────────────────────────

test("spec-context: decisions are imported verbatim and LOCKED with the spec's path and sha256; non-goals become Deferred Ideas", async () => {
  const cwd = await repoCopy("ctx");
  const specText = await readFile(join(cwd, "docs/specs/refunds/SPEC.md"), "utf8");
  const sha = createHash("sha256").update(specText).digest("hex");
  const report = await writeSpecContext({ cwd, runId: "r1", specRef: "docs/specs/refunds/SPEC.md" });
  assert.equal(report.ok, true);
  assert.equal(report.sha256, sha);
  assert.deepEqual(report.decisions, ["D-01", "D-02"]);
  const ctx = await readFile(join(cwd, ".muster/runs/r1/CONTEXT.md"), "utf8");
  assert.match(ctx, new RegExp(`Source: \`docs/specs/refunds/SPEC\\.md\` \\(sha256 \`${sha}\`\\)`));
  assert.match(ctx, /## Decisions\n\nLOCKED: imported verbatim from the spec/);
  for (const line of specText.split("\n").filter((l) => /^- \*\*D-0\d\*\*/.test(l))) assert.ok(ctx.includes(`\n${line}\n`), `verbatim: ${line}`);
  assert.match(ctx, /## Deferred Ideas[\s\S]*- NG-02 refunds for gift cards — because finance treats them as stored value\./);
  assert.match(ctx, /- \*\*NG-01\*\* Partial refunds by customers — because support keeps that judgment\. \(from the intent\)/);
  assert.doesNotMatch(ctx, /^- NG-01 \(intent\)/m, "a bare reference is replaced by the intent's wording");
});

test("spec-context: re-import replaces only the generated block and reads the spec from preflight.json", async () => {
  const cwd = await repoCopy("ctx2");
  await mkdir(join(cwd, ".muster/runs/r2"), { recursive: true });
  await writeFile(join(cwd, ".muster/runs/r2/preflight.json"), JSON.stringify({ spec: { path: "docs/specs/refunds/SPEC.md", anchor: "REF-01" } }));
  await writeFile(join(cwd, ".muster/runs/r2/CONTEXT.md"), "# Run r2: context\n\n## Claude's Discretion\n\n- naming is free\n");
  const first = await writeSpecContext({ cwd, runId: "r2" });
  assert.equal(first.spec, "docs/specs/refunds/SPEC.md#REF-01");
  await writeSpecContext({ cwd, runId: "r2" });
  const ctx = await readFile(join(cwd, ".muster/runs/r2/CONTEXT.md"), "utf8");
  assert.equal((ctx.match(/muster:spec-import:start/g) || []).length, 1);
  assert.match(ctx, /## Claude's Discretion\n\n- naming is free/);
  assert.match(ctx, /Scope: REF-01\./);
  assert.equal(upsertSpecImport("", "BLOCK", "r9"), "# Run r9: context\n\nBLOCK\n");
  assert.deepEqual((await writeSpecContext({ cwd, runId: "r3" })).ok, false);
  assert.equal((await writeSpecContext({ cwd, runId: "../x", specRef: "docs/specs/refunds/SPEC.md" })).ok, false);
});

test("spec-context CLI writes CONTEXT.md and prints the report", async () => {
  const cwd = await repoCopy("ctx-cli");
  const out = JSON.parse(execFileSync(process.execPath, [join(root, "src/cli.js"), "spec-context", "r1", "--spec", "docs/specs/refunds/SPEC.md"], { cwd, encoding: "utf8" }));
  assert.equal(out.contextPath, ".muster/runs/r1/CONTEXT.md");
});

// ── clarification round ──────────────────────────────────────────────────────

test("spec-clarify: answers resolve the OQ, replace the marker, land under a dated session and promote the draft", async () => {
  const cwd = await repoCopy("clarify");
  const r = await runSpecClarify({ cwd, specPath: "docs/specs/draft/SPEC.md", date: "2026-11-10", answers: [{ id: "OQ-01", a: "At delivery." }, { id: "NC-1", a: "30 days" }] });
  assert.deepEqual({ ok: r.ok, applied: r.applied, status: r.status, ready: r.ready, promoted: r.promoted, remaining: r.remaining },
    { ok: true, applied: ["OQ-01", "NC-1"], status: "ready", ready: true, promoted: true, remaining: [] });
  const text = await readFile(join(cwd, "docs/specs/draft/SPEC.md"), "utf8");
  assert.match(text, /^status: ready$/m);
  assert.match(text, /the window length of 30 days next to the refusal/);
  assert.match(text, /blocks: build — resolved 2026-11-10: see Clarifications/);
  assert.match(text, /## Clarifications\n\n### Session 2026-11-10\n- Q: Does the window start at delivery or at dispatch\? → A: At delivery\.\n- Q: 30 or 60 days\? → A: 30 days\n$/);
  // Another answer the same day appends to the same session (any open question may be answered).
  const again = applyClarifications(text, [{ id: "OQ-02", a: "Yes", q: "Link to support?" }], { date: "2026-11-10" });
  assert.deepEqual(again.applied, ["OQ-02"]);
  assert.match(again.text, /→ A: 30 days\n- Q: Link to support\? → A: Yes\n$/);
  assert.equal((again.text.match(/### Session 2026-11-10/g) || []).length, 1);
});

test("spec-clarify: an existing Clarifications session gets the new answers; unknown ids fail; a question-free draft is promoted", async () => {
  const spec = (await readFile(join(repo, "docs/specs/draft/SPEC.md"), "utf8")).replace("## Assumptions", "## Clarifications\n\n### Session 2026-11-10\n- Q: Earlier? → A: Yes.\n\n## Assumptions");
  const { text, applied } = applyClarifications(spec, [{ id: "OQ-01", a: "At delivery." }], { date: "2026-11-10" });
  assert.deepEqual(applied, ["OQ-01"]);
  assert.match(text, /### Session 2026-11-10\n- Q: Earlier\? → A: Yes\.\n- Q: Does the window start at delivery or at dispatch\? → A: At delivery\.\n\n## Assumptions/);
  const cwd = await repoCopy("clarify2");
  const bad = await runSpecClarify({ cwd, specPath: "docs/specs/draft/SPEC.md", date: "2026-11-10", answers: [{ id: "OQ-77", a: "x" }] });
  assert.equal(bad.ok, false);
  assert.deepEqual(bad.unknown, ["OQ-77"]);
  assert.equal(bad.ready, false);
  const quiet = (await readFile(join(cwd, "docs/specs/draft/SPEC.md"), "utf8"))
    .replace(" of [NEEDS CLARIFICATION: 30 or 60 days?]", " of 30 days").replace("blocks: build", "blocks: launch");
  await writeFile(join(cwd, "docs/specs/draft/SPEC.md"), quiet);
  const promoted = await runSpecClarify({ cwd, specPath: "docs/specs/draft/SPEC.md", date: "2026-11-10", answers: [] });
  assert.equal(promoted.promoted, true);
  assert.equal(promoted.ready, true);
});

// ── spec-trace ───────────────────────────────────────────────────────────────

const ACCEPTANCE = `---
run: r1
status: human_needed
---
# Run r1: Verification Report

## Acceptance
| ID | Verify | Status | Evidence |
|---|---|---|---|
| REF-01.1 | test | ✓ VERIFIED | \`node --test test/refunds.test.js\` 4 passing |
| **REF-01.2** | test | ORPHANED | no task covers it |
| REF-02.1 | needs-runtime | NEEDS-RUNTIME | production data only |
| REF-02.2 | judgment | NEEDS-HUMAN | copy deck review |
| INV-01 | test | VERIFIED | admin-partial.test.js passing |
| EV-01 | eval | VERIFIED | 195/200 |
| EV-02 | eval | VERIFIED | 20/20 |

## Gaps Summary
`;

async function traceRun(label, planName, verification) {
  const cwd = await repoCopy(label);
  await mkdir(join(cwd, ".muster/runs/r1"), { recursive: true });
  await writeFile(join(cwd, ".muster/runs/r1/PLAN.md"), await planText(planName));
  if (verification) await writeFile(join(cwd, ".muster/runs/r1/VERIFICATION.md"), verification);
  return cwd;
}

test("parseAcceptance: reads ID and Status columns, tolerating bold, backticks and status icons", () => {
  const rows = parseAcceptance(ACCEPTANCE);
  assert.deepEqual([...rows].map(([id, r]) => `${id} ${r.status}`), [
    "REF-01.1 VERIFIED", "REF-01.2 ORPHANED", "REF-02.1 NEEDS-RUNTIME", "REF-02.2 NEEDS-HUMAN", "INV-01 VERIFIED", "EV-01 VERIFIED", "EV-02 VERIFIED",
  ]);
  assert.equal(parseAcceptance("# no table").size, 0);
  assert.equal(parseAcceptance("## Acceptance\n| ID | Status |\n|---|---|\n| REF-01.1 | UNVERIFIED |\n").size, 0, "UNVERIFIED is not VERIFIED");
});

test("spec-trace: a fixture run writes VERIFIED, ORPHANED and NEEDS-RUNTIME rows and keeps the spec ready", async () => {
  const cwd = await traceRun("trace", "uncovered.md", ACCEPTANCE);
  const r = await runSpecTrace({ cwd, runId: "r1" });
  assert.equal(r.ok, true);
  assert.equal(r.shipped, false);
  assert.equal(r.status, "ready");
  assert.deepEqual(r.counts, { VERIFIED: 4, ORPHANED: 1, "NEEDS-RUNTIME": 1, "NEEDS-HUMAN": 1 });
  const spec = await readFile(join(cwd, "docs/specs/refunds/SPEC.md"), "utf8");
  const table = spec.slice(spec.indexOf("## Traceability"));
  assert.equal(table, [
    "## Traceability",
    "<!-- generated by `muster spec-trace`; do not edit -->",
    "| ID | Tasks | Verify | Status | Run |",
    "|---|---|---|---|---|",
    "| REF-01.1 | 01 | test (proved by 01) | VERIFIED | r1 |",
    "| REF-01.2 | — | test | ORPHANED | r1 |",
    "| REF-02.1 | — | needs-runtime | NEEDS-RUNTIME | r1 |",
    "| REF-02.2 | 04 | judgment | NEEDS-HUMAN | r1 |",
    "| INV-01 | 02 | test (proved by 02) | VERIFIED | r1 |",
    "| EV-01 | 03 | eval (proved by 03) | VERIFIED | r1 |",
    "| EV-02 | 03 | eval (proved by 03) | VERIFIED | r1 |",
    "",
  ].join("\n"));
  assert.match(spec, /^status: ready$/m);
});

test("spec-trace: with no Acceptance row, an uncovered ID is ORPHANED and a needs-runtime one NEEDS-RUNTIME", async () => {
  const cwd = await traceRun("trace-derived", "uncovered.md", "---\nstatus: passed\n---\n# no acceptance table\n");
  const r = await runSpecTrace({ cwd, runId: "r1" });
  const status = Object.fromEntries(r.rows.map((x) => [x.id, x.status]));
  assert.equal(status["REF-01.2"], "ORPHANED");
  assert.equal(status["REF-02.1"], "NEEDS-RUNTIME");
  assert.equal(status["REF-02.2"], "NEEDS-HUMAN");
  assert.equal(status["REF-01.1"], "UNVERIFIED");
});

test("spec-trace: every ID VERIFIED or explicitly accepted sets status: shipped; out-of-scope rows survive a scoped run", async () => {
  const all = ACCEPTANCE.replace("| **REF-01.2** | test | ORPHANED | no task covers it |", "| REF-01.2 | test | VERIFIED | ok |");
  const cwd = await traceRun("trace-ship", "covered.md", all);
  const partial = await runSpecTrace({ cwd, runId: "r1", accept: ["REF-02.1"] });
  assert.equal(partial.shipped, false);
  assert.deepEqual(partial.open, ["REF-02.2 NEEDS-HUMAN"]);
  const r = await runSpecTrace({ cwd, runId: "r1", accept: ["REF-02.1", "REF-02.2"] });
  assert.equal(r.shipped, true);
  assert.equal(r.status, "shipped");
  assert.deepEqual(r.counts, { VERIFIED: 5, ACCEPTED: 2 });
  assert.match(await readFile(join(cwd, "docs/specs/refunds/SPEC.md"), "utf8"), /^status: shipped$/m);

  // A later run scoped to REF-01 rewrites only REF-01's rows (plus the always-in-scope INV-01, EV-01).
  const cwd2 = await traceRun("trace-scope", "covered.md", ACCEPTANCE);
  await runSpecTrace({ cwd: cwd2, runId: "r1" });
  await mkdir(join(cwd2, ".muster/runs/r2"), { recursive: true });
  const scopedPlan = (await planText("covered.md")).replace("spec: docs/specs/refunds/SPEC.md", "spec: docs/specs/refunds/SPEC.md#REF-01");
  await writeFile(join(cwd2, ".muster/runs/r2/PLAN.md"), scopedPlan);
  await writeFile(join(cwd2, ".muster/runs/r2/VERIFICATION.md"), all.replace("run: r1", "run: r2"));
  await runSpecTrace({ cwd: cwd2, runId: "r2" });
  const spec = await readFile(join(cwd2, "docs/specs/refunds/SPEC.md"), "utf8");
  assert.match(spec, /\| REF-01\.2 \| 02 \| test \(proved by 02\) \| VERIFIED \| r2 \|/);
  assert.match(spec, /\| REF-02\.2 \| 04 \| judgment \| NEEDS-HUMAN \| r1 \|/, "REF-02 rows from r1 are kept");
  assert.match(spec, /\| EV-02 \| 03 \| eval \(proved by 03\) \| VERIFIED \| r1 \|/);
});

test("spec-trace: --coverage prints one line per requirement and writes nothing; missing inputs are refused", async () => {
  const cwd = await traceRun("trace-cov", "uncovered.md", null);
  const before = await readFile(join(cwd, "docs/specs/refunds/SPEC.md"), "utf8");
  const r = await runSpecTrace({ cwd, runId: "r1", coverage: true });
  assert.deepEqual(r.coverage, [
    "REF-01: covered 1/2, proved 1/2 · .1→01 .2→UNCOVERED",
    "REF-02: covered 1/2, proved 0/0 · .1 needs-runtime .2→04 human-verify",
    "INV-01: covered by 02 · prohibition yes · proved",
    "EV-01: covered by 03 · eval command in 03",
    "EV-02: covered by 03 · eval command in 03",
  ]);
  assert.equal(await readFile(join(cwd, "docs/specs/refunds/SPEC.md"), "utf8"), before);
  const noVerification = await runSpecTrace({ cwd, runId: "r1" });
  assert.equal(noVerification.ok, false);
  assert.match(noVerification.problems[0], /VERIFICATION\.md .*run spec-trace after verification/);
  const stray = await runSpecTrace({ cwd: await traceRun("trace-stray", "covered.md", ACCEPTANCE), runId: "r1", accept: ["INV-99"] });
  assert.match(stray.problems[0], /--accept INV-99: not in this run's scope/);
  const specless = await traceRun("trace-specless", "spec-less.md", ACCEPTANCE);
  assert.match((await runSpecTrace({ cwd: specless, runId: "r1" })).problems[0], /names no spec/);
});

test("spec-trace CLI: human summary, --json and exit codes", async () => {
  const cwd = await traceRun("trace-cli", "uncovered.md", ACCEPTANCE);
  const cli = join(root, "src/cli.js");
  const ok = spawnSync(process.execPath, [cli, "spec-trace", "r1"], { cwd, encoding: "utf8" });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, /^spec-trace r1: docs\/specs\/refunds\/SPEC\.md: 4 VERIFIED, 1 ORPHANED, 1 NEEDS-RUNTIME, 1 NEEDS-HUMAN; status stays ready/);
  assert.match(ok.stdout, /open: REF-01\.2 ORPHANED/);
  const json = spawnSync(process.execPath, [cli, "spec-trace", "r1", "--coverage", "--json"], { cwd, encoding: "utf8" });
  assert.equal(JSON.parse(json.stdout).coverage.length, 5);
  assert.equal(spawnSync(process.execPath, [cli, "spec-trace", "nope"], { cwd, encoding: "utf8" }).status, 1);
  assert.equal(spawnSync(process.execPath, [cli, "spec-trace"], { cwd, encoding: "utf8" }).status, 2);
});
