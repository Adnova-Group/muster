// `muster plan-lint`: the deterministic plan gates ported from gsd-core v1.20.1 (9385f46).
//
// Sections marked "ported from gsd" carry gsd's own test rows, cited by file and row so a later
// upstream diff can be compared case for case:
//   tests/failing-direction.test.cjs           (#3172)
//   tests/verify-command-grounding.test.cjs    (#2401, #4730, #4767)
//   tests/plan-document.test.cjs               (#4683 threat register)
//   tests/plan-authoring-verification-gaps.test.cjs  (#4927 truncation)
//   tests/verify.test.cjs                      (checkpoint shapes, autonomous)
//   tests/reversibility-tagging.test.cjs       (#1951)
// The rest covers muster's adaptation: the single-file task grammar, the CheckResult shape, the
// already-passes-at-HEAD probe, and one fixture per issue class (test/fixtures/plan-lint/).
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { validateVendorManifest } from "../src/vendor.js";
import { projectManifest, isVendoredItem } from "../src/provenance.js";
import {
  lintPlan,
  parsePlan,
  runPlanLintCli,
  resolveFailingDirection,
  extractFailingDirections,
  extractAutomatedCommands,
  resolveVerifyCommandTarget,
  extractThreatRegisterIds,
  scanPlanTruncation,
  probeAlreadyPassing,
  tokenizeSimpleCommand,
  computeDependencyLevels,
  DIMENSIONS,
} from "../src/plan-lint.js";
import { specialistCatalog } from "../src/specialists.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(here, "fixtures", "plan-lint");
const FIXTURE_REPO = path.join(FIXTURES, "repo");
const CLI = path.join(here, "..", "src", "cli.js");
const readFixture = name => readFileSync(path.join(FIXTURES, name), "utf8");

let ROOT = "";
before(() => { ROOT = mkdtempSync(path.join(tmpdir(), "muster-plan-lint-")); });
after(() => { if (ROOT) rmSync(ROOT, { recursive: true, force: true }); });

function fixtureRoot(name) {
  const dir = path.join(ROOT, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}
function writePackageJson(dir, scripts) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "fx", scripts }), "utf8");
}
const dims = result => result.issues.map(i => i.dimension);
const blockers = result => result.issues.filter(i => i.severity === "blocker");

// ─── Ported from gsd tests/failing-direction.test.cjs ────────────────────────

const SENTINEL = "MISSING — Wave 0 must create tests/auth.test.ts first";
const PLACEHOLDER_ATOMS = ["tbd", "todo", "n/a", "na", "none", "unknown", "tba", "?", "-"];
const KNOWN_STATUSES = new Set(["ok", "missing", "empty", "placeholder", "sentinel", "orphan"]);

function taskWith(parts, { eol = "\n", name = "task-0" } = {}) {
  const body = parts.map(p => ("automated" in p
    ? `  <verify><automated>${p.automated}</automated></verify>`
    : `  <fails_when>${p.failsWhen}</fails_when>`));
  return ["# Plan", "", '<task type="auto">', `  <name>${name}</name>`, "  <action>do the thing</action>", ...body, "  <done>committed</done>", "</task>"].join(eol);
}
function planWithTasks(taskParts, { eol = "\n" } = {}) {
  return taskParts
    .map((parts, i) => taskWith(parts, { eol, name: `task-${i}` }).split(eol).slice(2).join(eol))
    .reduce((acc, t) => `${acc}${eol}${t}`, ["# Plan", ""].join(eol));
}
const statuses = entries => entries.map(e => e.status);

describe("failing direction: pairing (gsd failing-direction.test.cjs)", () => {
  test("row 1: pairs a single statement to its preceding command", () => {
    const out = extractFailingDirections(taskWith([{ automated: "npm test" }, { failsWhen: "non-zero exit" }]));
    assert.equal(out.length, 1);
    assert.equal(out[0].command, "npm test");
    assert.equal(out[0].statement, "non-zero exit");
    assert.equal(out[0].status, "ok");
    assert.equal(out[0].severity, "none");
    assert.equal(out[0].task, "task-0");
  });

  test("row 2: blocks a command with no failing direction, quoting it verbatim", () => {
    const out = extractFailingDirections(taskWith([{ automated: "npm test" }]));
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "missing");
    assert.equal(out[0].severity, "blocker");
    assert.equal(out[0].statement, null);
    assert.equal(out[0].command, "npm test");
  });

  test("row 9: attributes a statement to the command it follows, not the next one", () => {
    const out = extractFailingDirections(taskWith([{ automated: "npm test" }, { failsWhen: "non-zero exit" }, { automated: "npm run lint" }]));
    assert.deepEqual(statuses(out), ["ok", "missing"]);
  });

  test("row 10: does not credit a later statement to an earlier command", () => {
    const out = extractFailingDirections(taskWith([{ automated: "npm test" }, { automated: "npm run lint" }, { failsWhen: "any eslint error" }]));
    assert.deepEqual(statuses(out), ["missing", "ok"]);
  });

  test("row 11: pairs N statements to N commands in order", () => {
    const out = extractFailingDirections(taskWith([
      { automated: "a" }, { failsWhen: "a fails on non-zero exit" },
      { automated: "b" }, { failsWhen: "b fails when stderr is non-empty" },
    ]));
    assert.deepEqual(statuses(out), ["ok", "ok"]);
    assert.deepEqual(out.map(e => e.statement), ["a fails on non-zero exit", "b fails when stderr is non-empty"]);
  });

  test("row 12: statement count at limit-1, limit and limit+1", () => {
    const cmds = ["a", "b", "c"];
    const build = n => {
      const parts = [];
      cmds.forEach((c, i) => { parts.push({ automated: c }); if (i < n) parts.push({ failsWhen: `${c} fails on non-zero exit` }); });
      if (n > cmds.length) parts.push({ failsWhen: "redundant but harmless" });
      return parts;
    };
    assert.deepEqual(statuses(extractFailingDirections(taskWith(build(2)))), ["ok", "ok", "missing"]);
    assert.deepEqual(statuses(extractFailingDirections(taskWith(build(3)))), ["ok", "ok", "ok"]);
    const over = extractFailingDirections(taskWith(build(4)));
    assert.deepEqual(statuses(over), ["ok", "ok", "ok"]);
    assert.equal(over.length, 3);
  });

  test("row 12b: the first statement after a command is the binding one", () => {
    const out = extractFailingDirections(taskWith([{ automated: "npm test" }, { failsWhen: "TBD" }, { failsWhen: 'non-zero exit, or "0 passed" in the summary' }]));
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "placeholder");
    assert.equal(out[0].severity, "blocker");
  });

  test("row 13: warns on a statement bound to no command", () => {
    const out = extractFailingDirections(taskWith([{ failsWhen: "non-zero exit" }, { automated: "npm test" }]));
    assert.equal(out.length, 2);
    const orphan = out.find(e => e.status === "orphan");
    assert.ok(orphan);
    assert.equal(orphan.severity, "warning");
    assert.equal(orphan.command, "");
    assert.equal(out.find(e => e.command === "npm test").status, "missing");
  });

  test("row 14: an empty automated body is not a failing-direction finding", () => {
    const out = extractFailingDirections(taskWith([{ automated: "" }, { automated: "   " }, { automated: "npm test" }]));
    assert.equal(out.length, 1);
    assert.equal(out[0].command, "npm test");
  });

  test("row 15: a verify block with no automated command reports nothing", () => {
    const md = taskWith([]).replace("<done>committed</done>", "<verify>eyeball it</verify>");
    assert.deepEqual(extractFailingDirections(md), []);
  });

  test("row 16: pairs commands that sit outside any task block", () => {
    const md = ["# Plan", "", "<verify><automated>npm run build</automated></verify>", "<fails_when>a non-zero tsc exit</fails_when>", "<verify><automated>npm run lint</automated></verify>"].join("\n");
    const out = extractFailingDirections(md);
    assert.deepEqual(statuses(out), ["ok", "missing"]);
    assert.equal(out[0].task, "");
  });

  test("row 17: pairing does not leak across task boundaries", () => {
    const out = extractFailingDirections(planWithTasks([[{ automated: "a" }, { failsWhen: "a fails on non-zero exit" }], [{ automated: "b" }]]));
    assert.deepEqual(statuses(out), ["ok", "missing"]);
    assert.equal(out[1].task, "task-1");
  });

  test("row 18: CRLF plan text produces identical verdicts", () => {
    const parts = [{ automated: "a" }, { failsWhen: "a fails on non-zero exit" }, { automated: "b" }];
    const pick = es => es.map(e => ({ c: e.command, s: e.statement, st: e.status }));
    assert.deepEqual(pick(extractFailingDirections(taskWith(parts, { eol: "\r\n" }))), pick(extractFailingDirections(taskWith(parts))));
  });

  test("row 20: tolerates attributes on the automated opening tag", () => {
    const md = ["<task><name>t</name>", '<verify><automated tier="fast">npm test</automated></verify>', "<fails_when>non-zero exit</fails_when>", "</task>"].join("\n");
    const out = extractFailingDirections(md);
    assert.equal(out.length, 1);
    assert.equal(out[0].status, "ok");
  });

  test("row 21: non-string plan text yields an empty list without throwing", () => {
    for (const bad of [0, "", [], null, undefined, true, {}]) assert.deepEqual(extractFailingDirections(bad), []);
  });

  test("row 22: bounded walk on pathological unclosed tags", () => {
    assert.ok(Array.isArray(extractFailingDirections("<automated>".repeat(5000) + "<fails_when>".repeat(5000))));
  });

  test("row 36: an unclosed automated opener does not swallow a later block", () => {
    const md = ["<task><name>t</name>", "<verify><automated>", "<verify><automated>npm test</automated></verify>", "<fails_when>non-zero exit</fails_when>", "</task>"].join("\n");
    const recovered = extractFailingDirections(md).find(e => e.command === "npm test");
    assert.ok(recovered);
    assert.equal(recovered.status, "ok");
  });

  test("row 8: a sentinel does not consume the following statement", () => {
    const out = extractFailingDirections(taskWith([{ automated: SENTINEL }, { automated: "npm test" }, { failsWhen: "non-zero exit" }]));
    assert.deepEqual(statuses(out), ["sentinel", "ok"]);
  });
});

describe("failing direction: statement verdicts (gsd failing-direction.test.cjs)", () => {
  test("row 3: treats a whitespace-only statement as empty", () => {
    for (const blank of [" ", "\t", "\n", "  \r\n  "]) {
      const r = resolveFailingDirection("npm test", blank);
      assert.equal(r.status, "empty");
      assert.equal(r.severity, "blocker");
    }
  });

  test("row 4: rejects every placeholder atom, case-insensitively", () => {
    for (const atom of PLACEHOLDER_ATOMS) {
      for (const cased of [atom, atom.toUpperCase(), `  ${atom}  `]) {
        const r = resolveFailingDirection("npm test", cased);
        assert.equal(r.status, "placeholder", cased);
        assert.equal(r.severity, "blocker");
      }
    }
  });

  test("row 5: accepts prose that merely starts with a placeholder word", () => {
    for (const prose of ["TBD in the harness output is printed instead of a count", "none of the assertions print, so the summary line is absent", "- a missing summary line"]) {
      assert.equal(resolveFailingDirection("npm test", prose).status, "ok", prose);
    }
  });

  test("row 19: accepts a statement containing angle brackets and quotes", () => {
    for (const stmt of ["exit code > 0", 'stderr contains "FAIL" && exit != 0', "the line 'ok 0' appears", "a non-zero exit,\nor an empty summary"]) {
      assert.equal(resolveFailingDirection("npm test", stmt).status, "ok", stmt);
    }
  });

  test("rows 6-7: exempts the MISSING sentinel, even when a statement follows it", () => {
    assert.deepEqual([resolveFailingDirection(SENTINEL, null).status, resolveFailingDirection(SENTINEL, null).severity], ["sentinel", "none"]);
    assert.equal(resolveFailingDirection(SENTINEL, "non-zero exit").status, "sentinel");
  });

  test("returns a closed-enum shape for non-string input", () => {
    for (const bad of [null, undefined, 0, [], {}, true]) assert.ok(KNOWN_STATUSES.has(resolveFailingDirection(bad, bad).status));
  });

  test("row 34: an env-var assignment prefixed MISSING= is judged, not exempted", () => {
    for (const cmd of ["MISSING=true npm test && echo done", "MISSING_FOO=1 npm test", "MISSINGLY npm test"]) {
      assert.equal(resolveFailingDirection(cmd, undefined).status, "missing", cmd);
    }
  });

  test("row 35: the real Wave-0 sentinel forms stay exempt", () => {
    for (const cmd of ["MISSING", "MISSING — Wave 0 must create tests/x.test.ts"]) {
      assert.equal(resolveFailingDirection(cmd, undefined).status, "sentinel", cmd);
    }
  });

  test("row 28: adding fails_when does not change extractAutomatedCommands output", () => {
    const without = extractAutomatedCommands(taskWith([{ automated: "npm test" }]));
    const withStmt = extractAutomatedCommands(taskWith([{ automated: "npm test" }, { failsWhen: "non-zero exit" }]));
    assert.deepEqual(withStmt, without);
  });
});

// ─── Ported from gsd tests/verify-command-grounding.test.cjs ─────────────────

describe("verify-command paths: grounded forms (gsd verify-command-grounding.test.cjs)", () => {
  test("row 1: no cd or prefix is not applicable", () => {
    const r = resolveVerifyCommandTarget("npm test -- --filter=x", { projectRoot: fixtureRoot("row1") });
    assert.equal(r.status, "not_applicable");
    assert.equal(r.target, null);
  });

  test("row 2: resolves a cd target that exists", () => {
    const root = fixtureRoot("row2");
    writePackageJson(path.join(root, "frontend"), { lint: "eslint ." });
    const r = resolveVerifyCommandTarget("cd frontend && npm run lint", { projectRoot: root });
    assert.equal(r.status, "ok");
    assert.equal(r.form, "cd");
    assert.equal(r.target, path.join(root, "frontend"));
    assert.equal(r.manifest, "package.json");
  });

  test("row 3: flags the reported unresolvable cd target without prescribing a fix", () => {
    const root = fixtureRoot("row3/a/b");
    const r = resolveVerifyCommandTarget("cd ../../frontend && npm run lint && npm run build", { projectRoot: root });
    assert.equal(r.status, "broken");
    assert.equal(r.reason, "missing_dir");
    assert.equal(r.severity, "blocker");
    assert.equal(r.rawTarget, "../../frontend");
    assert.ok(!("suggestion" in r));
  });

  test("row 4: dir without a manifest is broken for an npm command", () => {
    const root = fixtureRoot("row4");
    mkdirSync(path.join(root, "docs-only"), { recursive: true });
    const r = resolveVerifyCommandTarget("cd docs-only && npm run lint", { projectRoot: root });
    assert.equal(r.reason, "no_manifest");
    assert.equal(r.severity, "blocker");
  });

  test("row 5: non-npm command needs no manifest", () => {
    const root = fixtureRoot("row5");
    mkdirSync(path.join(root, "docs-only"), { recursive: true });
    assert.equal(resolveVerifyCommandTarget("cd docs-only && grep -q x README.md", { projectRoot: root }).status, "ok");
  });

  test("rows 6-7: resolves npm --prefix, leading or trailing", () => {
    const root = fixtureRoot("row6");
    writePackageJson(path.join(root, "web"), { build: "vite build" });
    for (const cmd of ["npm --prefix ./web run build", "npm run build --prefix ./web"]) {
      const r = resolveVerifyCommandTarget(cmd, { projectRoot: root });
      assert.equal(r.status, "ok", cmd);
      assert.equal(r.form, "prefix");
      assert.equal(r.target, path.join(root, "web"));
    }
  });

  test("row 9: folds chained cd segments", () => {
    const root = fixtureRoot("row9");
    writePackageJson(path.join(root, "a", "b"), { test: "node --version" });
    assert.equal(resolveVerifyCommandTarget("cd a && cd b && npm test", { projectRoot: root }).target, path.join(root, "a", "b"));
  });

  test("row 22: cd dot resolves to project root", () => {
    const root = fixtureRoot("row22");
    writePackageJson(root, { test: "node --version" });
    const r = resolveVerifyCommandTarget("cd . && npm test", { projectRoot: root });
    assert.equal(r.status, "ok");
    assert.equal(r.target, root);
  });

  test("row 20: normalizes windows separators", () => {
    const root = fixtureRoot("row20");
    const back = resolveVerifyCommandTarget("cd ..\\..\\frontend && npm test", { projectRoot: root });
    const fwd = resolveVerifyCommandTarget("cd ../../frontend && npm test", { projectRoot: root });
    assert.equal(back.status, fwd.status);
    assert.equal(back.target, fwd.target);
  });

  test("row 35: file at target path is not a directory", () => {
    const root = fixtureRoot("row35");
    writeFileSync(path.join(root, "frontend"), "not a dir", "utf8");
    assert.equal(resolveVerifyCommandTarget("cd frontend && npm test", { projectRoot: root }).reason, "missing_dir");
  });

  test("#4730: escaped && agrees with the literal form", () => {
    const root = fixtureRoot("r4730");
    writePackageJson(path.join(root, "src"), { lint: "eslint ." });
    const lit = resolveVerifyCommandTarget("cd src && npm run lint", { projectRoot: root });
    const esc = resolveVerifyCommandTarget("cd src &amp;&amp; npm run lint", { projectRoot: root });
    assert.equal(esc.status, lit.status);
    assert.equal(esc.rawTarget, "src");
    assert.equal(esc.severity, "none");
  });

  test("#2401 Finding 1: missing script under --prefix is script_missing/warning in either flag order", () => {
    const root = fixtureRoot("f1");
    writePackageJson(path.join(root, "web"), { test: "x" });
    for (const cmd of ["npm --prefix ./web run nope", "npm run nope --prefix ./web"]) {
      const r = resolveVerifyCommandTarget(cmd, { projectRoot: root });
      assert.equal(r.reason, "script_missing", cmd);
      assert.equal(r.severity, "warning");
    }
  });

  test("#2401 Finding 2: a quoted --prefix path with a space resolves", () => {
    const root = fixtureRoot("f2");
    writePackageJson(path.join(root, "my dir"), { test: "x" });
    assert.equal(resolveVerifyCommandTarget('npm --prefix "my dir" run test', { projectRoot: root }).target, path.join(root, "my dir"));
  });
});

describe("verify-command paths: refusals and negative space (gsd verify-command-grounding.test.cjs)", () => {
  for (const [name, command] of [
    ["row 10: a variable path", 'cd "$FRONTEND" && npm test'],
    ["row 11: a glob path", "cd frontend-* && npm test"],
    ["row 12: command substitution", "cd $(git rev-parse --show-toplevel)/web && npm test"],
    ["row 13: backtick substitution", "cd `pwd`/web && npm test"],
    ["row 14: tilde expansion", "cd ~/web && npm test"],
  ]) {
    test(`refuses ${name} as a warning, never a blocker`, () => {
      const r = resolveVerifyCommandTarget(command, { projectRoot: fixtureRoot("hostile") });
      assert.equal(r.status, "unresolvable");
      assert.equal(r.reason, "dynamic_path");
      assert.equal(r.severity, "warning");
    });
  }

  test("row 15: the MISSING sentinel is not applicable", () => {
    const r = resolveVerifyCommandTarget("MISSING — Wave 0 must create tests/x.py first", { projectRoot: fixtureRoot("row15") });
    assert.equal(r.status, "not_applicable");
    assert.equal(r.sentinel, true);
  });

  test("row 16: a pseudo-shell assertion is not applicable", () => {
    assert.equal(resolveVerifyCommandTarget("grep -c '?from=' src/x.tsx == 0", { projectRoot: fixtureRoot("row16") }).status, "not_applicable");
  });

  test("row 17: a dir created by a task's <files> is pending, not broken", () => {
    const r = resolveVerifyCommandTarget("cd frontend && npm test", { projectRoot: fixtureRoot("row17"), declaredPaths: ["frontend/package.json"] });
    assert.equal(r.status, "pending_creation");
    assert.notEqual(r.severity, "blocker");
  });

  test("row 21: a bare climb above the root warns as outside_root", () => {
    const root = fixtureRoot("row21");
    const r = resolveVerifyCommandTarget("cd ../.. && npm test", { projectRoot: root });
    assert.equal(r.reason, "outside_root");
    assert.equal(r.severity, "warning");
    assert.equal(r.base, root);
  });

  test("#4767: an absolute target outside the root is outside_root; inside stays clean", () => {
    const root = fixtureRoot("r4767/root");
    const outside = fixtureRoot("r4767/outside");
    assert.equal(resolveVerifyCommandTarget(`cd ${outside} && npm test`, { projectRoot: root }).reason, "outside_root");
    assert.equal(resolveVerifyCommandTarget(`cd ${root}-sibling && npm test`, { projectRoot: root }).reason, "outside_root");
    mkdirSync(path.join(root, "inner"), { recursive: true });
    assert.equal(resolveVerifyCommandTarget(`cd ${path.join(root, "inner")} && ls`, { projectRoot: root }).severity, "none");
  });

  test("rows 33-34: an invalid or non-object manifest degrades, never blocks", () => {
    for (const [i, body] of ["{ not json", "0", '"s"', "[]", "null", "true"].entries()) {
      const root = fixtureRoot(`row33-${i}`);
      mkdirSync(path.join(root, "frontend"), { recursive: true });
      writeFileSync(path.join(root, "frontend", "package.json"), body, "utf8");
      const r = resolveVerifyCommandTarget("cd frontend && npm run lint", { projectRoot: root });
      assert.notEqual(r.severity, "blocker", body);
    }
  });

  test("row 28: a bare call does not throw", () => {
    assert.equal(typeof resolveVerifyCommandTarget("cd frontend && npm test").base, "string");
  });

  test("row 46: the probe never executes the command", () => {
    const root = fixtureRoot("row46");
    const canary = path.join(root, "pwned");
    resolveVerifyCommandTarget(`cd . && touch ${canary}`, { projectRoot: root });
    resolveVerifyCommandTarget(`npm --prefix . run x; touch ${canary}`, { projectRoot: root });
    assert.equal(existsSync(canary), false);
  });
});

// ─── Ported from gsd tests/plan-document.test.cjs (threat register) ──────────

describe("threat register IDs (gsd plan-document.test.cjs)", () => {
  const register = rows => ["<threat_model>", "| Threat ID | Category | Component | Severity | Disposition | Mitigation |", "|---|---|---|---|---|---|", ...rows, "</threat_model>"].join("\n");

  test("extracts first-cell IDs in document order (gsd and muster grammars)", () => {
    assert.deepEqual(extractThreatRegisterIds(register(["| T-47-01 | T | c | high | mitigate | fix |", "| T-02 | R | c | low | accept | r |", "| T-4.1-05 | D | c | low | accept | r |"])), ["T-47-01", "T-02", "T-4.1-05"]);
  });

  test("the reserved supply-chain row never matches", () => {
    assert.deepEqual(extractThreatRegisterIds(register(["| T-47-SC | T | npm | high | mitigate | gate |", "| T-SC | T | npm | high | mitigate | gate |", "| T-01 | T | c | high | mitigate | fix |"])), ["T-01"]);
  });

  test("rows outside a threat_model block never count", () => {
    assert.deepEqual(extractThreatRegisterIds(["See T-47-01. | T-47-02 | not a register |", "", register(["| T-47-03 | T | c | high | mitigate | fix |"])].join("\n")), ["T-47-03"]);
  });

  test("a register quoted inside a backtick or tilde fence is prose, not a claim", () => {
    const live = register(["| T-47-02 | R | c | low | accept | r |"]);
    for (const fence of ["```", "~~~"]) {
      const quoted = [fence, register(["| T-47-01 | T | c | high | mitigate | fix |"]), fence].join("\n");
      assert.deepEqual(extractThreatRegisterIds(`${quoted}\n\n${live}`), ["T-47-02"]);
    }
  });

  test("case-insensitive tags, multiple blocks, CRLF, indented rows; annotated cells unmatched", () => {
    assert.deepEqual(extractThreatRegisterIds("<THREAT_MODEL>\n| T-47-05 | T | c | h | m | f |\n</THREAT_MODEL>"), ["T-47-05"]);
    assert.deepEqual(extractThreatRegisterIds(`${register(["| T-1 | a | b | c | d | e |"])}\n${register(["| T-2 | a | b | c | d | e |"])}`), ["T-1", "T-2"]);
    assert.deepEqual(extractThreatRegisterIds(register(["| T-47-07 | T | c | h | m | f |"]).replace(/\n/g, "\r\n")), ["T-47-07"]);
    assert.deepEqual(extractThreatRegisterIds("<threat_model>\n  | T-47-09 | T | c | h | m | f |\n</threat_model>"), ["T-47-09"]);
    assert.deepEqual(extractThreatRegisterIds(register(["| T-47-06 (revised) | T | c | h | m | f |"])), []);
    assert.deepEqual(extractThreatRegisterIds("# Plan\n\nDo things.\n"), []);
  });
});

// ─── Ported from gsd tests/plan-authoring-verification-gaps.test.cjs (#4927) ─

describe("truncation (gsd plan-authoring-verification-gaps.test.cjs #4927)", () => {
  const complete = readFixture("clean.md");
  test("a complete plan is not flagged", () => assert.deepEqual(scanPlanTruncation(complete), []));
  test("a plan cut off mid-tag is flagged", () => assert.ok(scanPlanTruncation(complete.slice(0, complete.indexOf("</tasks>") - 4)).length > 0));
  test("a plan cut off before </tasks> is flagged", () => assert.ok(scanPlanTruncation(complete.slice(0, complete.indexOf("</tasks>"))).length > 0));
  test("the incremental-write sentinel is flagged (gsd and muster spellings)", () => {
    for (const s of ["<!-- gsd:write-continue -->", "<!-- muster:write-continue -->"]) {
      assert.ok(scanPlanTruncation(complete.replace("<verification>", `${s}\n<verification>`)).length > 0, s);
    }
  });
  test('prose containing "<" or an HTML example does not false-positive', () => {
    assert.deepEqual(scanPlanTruncation(complete.replace("One entry point only.", "Make sure a < b holds; render a <div> and a <b>bold</b> label.")), []);
  });
});

// ─── Ported from gsd tests/verify.test.cjs and reversibility-tagging.test.cjs ─

function planDoc({ autonomous = true, tasks, tracer = false }) {
  return [
    "---", "run: t", "type: execute", `autonomous: ${autonomous}`, `tracer: ${tracer}`, "must_haves:", "  truths: [x]", "---", "", "<tasks>", ...tasks, "</tasks>", "",
  ].join("\n");
}
const autoTask = (id, wave, extra = "") => [
  `<task id="${id}" type="auto" wave="${wave}"${extra}>`, `  <name>Task ${id}</name>`, `  <files>src/${id}.js</files>`, "  <action>do it</action>",
  `  <verify><automated>node --test test/${id}.test.js</automated><fails_when>non-zero exit</fails_when></verify>`, "  <done>done</done>", "</task>",
].join("\n");

describe("checkpoint and task structure (gsd verify.test.cjs)", () => {
  const checkpoint = (type, body) => [`<task id="c1" type="${type}" wave="2" depends_on="01" gate="blocking">`, `  <name>Checkpoint: ${type}</name>`, ...body, "</task>"].join("\n");
  const lint = (tasks, autonomous = false) => lintPlan(planDoc({ autonomous, tasks }), { projectRoot: fixtureRoot("cp") });

  test("AC1: canonical checkpoint shapes pass with zero findings", () => {
    for (const cp of [
      checkpoint("checkpoint:human-verify", ["<what-built>x</what-built>", "<how-to-verify>y</how-to-verify>", "<resume-signal>approved</resume-signal>"]),
      checkpoint("checkpoint:decision", ["<decision>d</decision>", '<options><option id="a">A</option><option id="b">B</option></options>', "<resume-signal>pick</resume-signal>"]),
      checkpoint("checkpoint:human-action", ["<action>a</action>", "<instructions>i</instructions>", "<verification>v</verification>", "<resume-signal>done</resume-signal>"]),
      checkpoint("checkpoint:future-kind", ["<resume-signal>done</resume-signal>"]),
    ]) {
      const result = lint([autoTask("01", 1), cp]);
      assert.deepEqual(result.issues, [], cp.split("\n")[0]);
    }
  });

  test("AC2: each missing checkpoint field is a task_completeness blocker", () => {
    const cases = [
      ["checkpoint:human-verify", ["<what-built>x</what-built>", "<resume-signal>r</resume-signal>"], "how-to-verify"],
      ["checkpoint:human-verify", ["<how-to-verify>y</how-to-verify>", "<resume-signal>r</resume-signal>"], "what-built"],
      ["checkpoint:decision", ["<decision>d</decision>", "<resume-signal>r</resume-signal>"], "options"],
      ["checkpoint:decision", ['<options><option id="a">A</option></options>', "<resume-signal>r</resume-signal>"], "decision"],
      ["checkpoint:human-action", ["<action>a</action>", "<verification>v</verification>", "<resume-signal>r</resume-signal>"], "instructions"],
      ["checkpoint:human-action", ["<instructions>i</instructions>", "<verification>v</verification>", "<resume-signal>r</resume-signal>"], "action"],
      ["checkpoint:human-action", ["<action>a</action>", "<instructions>i</instructions>", "<verify>v</verify>", "<resume-signal>r</resume-signal>"], "verification"],
      ["checkpoint:future-kind", [], "resume-signal"],
    ];
    for (const [type, body, missing] of cases) {
      const found = blockers(lint([autoTask("01", 1), checkpoint(type, body)]));
      assert.ok(found.some(i => i.dimension === DIMENSIONS.TASK_COMPLETENESS && i.summary.includes(`<${missing}>`)), `${type} without <${missing}>: ${JSON.stringify(found)}`);
    }
  });

  test("#4095: auto_select must name an <option id>", () => {
    const cp = auto => [`<task id="c1" type="checkpoint:decision" wave="2" depends_on="01" auto_select="${auto}">`, "<name>n</name>", "<decision>d</decision>", '<options><option id="a">A</option></options>', "<resume-signal>r</resume-signal>", "</task>"].join("\n");
    assert.deepEqual(lint([autoTask("01", 1), cp("a")]).issues, []);
    assert.ok(blockers(lint([autoTask("01", 1), cp("zz")])).some(i => /auto_select/.test(i.summary)));
    assert.ok(blockers(lint([autoTask("01", 1), cp("")])).some(i => /empty auto_select/.test(i.summary)));
  });

  test("errors when a checkpoint task exists but autonomous is true", () => {
    const cp = checkpoint("checkpoint:human-verify", ["<what-built>x</what-built>", "<how-to-verify>y</how-to-verify>", "<resume-signal>r</resume-signal>"]);
    assert.ok(blockers(lint([autoTask("01", 1), cp], true)).some(i => /autonomous/.test(i.summary)));
  });

  test("AC3, adapted: a non-checkpoint task missing action/verify/files blocks; missing done warns", () => {
    const bare = '<task id="01" type="auto" wave="1">\n  <name>n</name>\n</task>';
    const result = lint([bare], true);
    const by = sev => result.issues.filter(i => i.severity === sev && i.dimension === DIMENSIONS.TASK_COMPLETENESS).map(i => i.summary);
    assert.ok(by("blocker").some(s => s.includes("<action>")));
    assert.ok(by("blocker").some(s => s.includes("<verify>")));
    assert.ok(by("blocker").some(s => s.includes("<files>")));
    assert.ok(by("warning").some(s => s.includes("<done>")));
  });

  test("a task without a type attribute gets the non-checkpoint rules (regression guard)", () => {
    const untyped = '<task id="01" wave="1">\n  <name>n</name>\n  <resume-signal>r</resume-signal>\n</task>';
    assert.ok(blockers(lint([untyped], true)).some(i => i.summary.includes("<action>")));
  });
});

describe("reversibility (gsd reversibility-tagging.test.cjs #1951)", () => {
  const rated = rating => autoTask("02", 2, ' depends_on="01"').replace("  <files>", `  <reversibility rating="${rating}">why</reversibility>\n  <files>`);
  const decision = '<task id="d1" type="checkpoint:decision" wave="2" depends_on="01">\n<name>n</name>\n<decision>d</decision>\n<options><option id="a">A</option></options>\n<resume-signal>r</resume-signal>\n</task>';
  const lint = (tasks, autonomous = true) => lintPlan(planDoc({ autonomous, tasks }), { projectRoot: fixtureRoot("rev") }).issues.filter(i => i.dimension === DIMENSIONS.REVERSIBILITY);

  test("reversible and costly ratings, and no rating at all, are not flagged", () => {
    assert.deepEqual(lint([autoTask("01", 1), rated("reversible")]), []);
    assert.deepEqual(lint([autoTask("01", 1), rated("costly")]), []);
    assert.deepEqual(lint([autoTask("01", 1), autoTask("02", 2, ' depends_on="01"')]), []);
  });

  test("one-way with NO preceding checkpoint:decision warns and never blocks", () => {
    const found = lint([autoTask("01", 1), rated("one-way")]);
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "warning");
    assert.match(found[0].summary, /one-way/);
  });

  test("one-way WITH a preceding checkpoint:decision does not warn", () => {
    assert.deepEqual(lint([autoTask("01", 1), decision, rated("one-way").replace('wave="2" depends_on="01"', 'wave="3" depends_on="d1"')], false), []);
  });

  test("an off-taxonomy rating warns", () => {
    assert.equal(lint([autoTask("01", 1), rated("maybe")])[0].severity, "warning");
  });
});

// ─── muster adaptation: dependencies, waves, files, tracer ───────────────────

describe("dependency graph and waves", () => {
  const lint = (tasks, opts = {}) => lintPlan(planDoc({ tasks, ...opts }), { projectRoot: fixtureRoot("deps") });

  test("computeDependencyLevels assigns longest-path levels and finds cycles (gsd phase.cts)", () => {
    const tasks = parsePlan(planDoc({ tasks: [autoTask("a", 1), autoTask("b", 2, ' depends_on="a"'), autoTask("c", 3, ' depends_on="A, b"')] })).tasks;
    const { level, cycle, unresolved } = computeDependencyLevels(tasks);
    assert.deepEqual([level.get("a"), level.get("b"), level.get("c")], [0, 1, 2]);
    assert.deepEqual(cycle, []);
    assert.deepEqual(unresolved, []);
    const cyclic = parsePlan(planDoc({ tasks: [autoTask("a", 1, ' depends_on="b"'), autoTask("b", 2, ' depends_on="a"'), autoTask("s", 1, ' depends_on="s"')] })).tasks;
    assert.deepEqual(computeDependencyLevels(cyclic).cycle.sort(), ["a", "b", "s"]);
  });

  test("a self-dependency is a cycle blocker", () => {
    assert.ok(blockers(lint([autoTask("01", 1, ' depends_on="01"')])).some(i => /cycle/.test(i.summary)));
  });

  test("a missing or non-integer wave blocks", () => {
    assert.ok(blockers(lint([autoTask("01", 1).replace(' wave="1"', "")])).some(i => /no wave/.test(i.summary)));
    assert.ok(blockers(lint([autoTask("01", 1).replace(' wave="1"', ' wave="first"')])).some(i => /wave "first"/.test(i.summary)));
    assert.ok(blockers(lint([autoTask("01", 1).replace(' wave="1"', ' wave="0"')])).some(i => /wave "0"/.test(i.summary)));
  });

  test("a wave later than dependencies and files require warns; a file-forced wave does not", () => {
    const late = lint([autoTask("01", 1), autoTask("02", 3, ' depends_on="01"')]);
    assert.deepEqual(late.issues.map(i => [i.dimension, i.severity]), [[DIMENSIONS.DEPENDENCIES, "warning"]]);
    const shared = autoTask("02", 2).replace("<files>src/02.js</files>", "<files>src/01.js</files>");
    assert.deepEqual(lint([autoTask("01", 1), shared]).issues, []);
  });

  test("same-wave file overlap blocks, after path normalization", () => {
    const b = autoTask("02", 1).replace("<files>src/02.js</files>", "<files>./src/01.js</files>");
    assert.ok(blockers(lint([autoTask("01", 1), b])).some(i => /both touch src\/01\.js/.test(i.summary)));
  });

  test("duplicate ids collide case-insensitively", () => {
    assert.ok(blockers(lint([autoTask("ab", 1), autoTask("AB", 1).replace("src/AB.js", "src/other.js")])).some(i => /collide/.test(i.summary)));
  });
});

describe("tracer-first", () => {
  const tracer = autoTask("01", 1).replace('type="auto"', 'type="tracer"');
  const lint = tasks => lintPlan(planDoc({ tasks, tracer: true }), { projectRoot: fixtureRoot("tracer") }).issues;

  test("a leading tracer with every expansion in a later wave passes", () => {
    assert.deepEqual(lint([tracer, autoTask("02", 2, ' depends_on="01"')]), []);
  });

  test("an independent task in the tracer's wave passes (live e2e 2026-11-10: small plans ran strictly sequential)", () => {
    // No depends_on and no shared file: it cannot need the tracer, so it shares wave 1 and the
    // wave gets an integration check instead of waiting a whole wave for nothing.
    assert.deepEqual(lint([tracer, autoTask("02", 1)]), []);
    assert.deepEqual(lint([tracer, autoTask("02", 1), autoTask("03", 2, ' depends_on="01"')]), []);
  });

  test("a task that runs before the tracer warns", () => {
    const lateTracer = autoTask("01", 2).replace('type="auto"', 'type="tracer"');
    const found = lint([lateTracer, autoTask("02", 1)]).filter(i => i.dimension === DIMENSIONS.TRACER);
    assert.ok(found.some(i => /before the tracer \(wave 2\)/.test(i.summary)), JSON.stringify(found));
  });

  test("no tracer or a late tracer warns", () => {
    for (const tasks of [[autoTask("01", 1)], [autoTask("02", 1), tracer.replace('id="01"', 'id="03"').replace("src/01.js", "src/03.js")]]) {
      const found = lint(tasks).filter(i => i.dimension === DIMENSIONS.TRACER);
      assert.ok(found.length > 0 && found.every(i => i.severity === "warning"), JSON.stringify(found));
    }
  });

  test("`tracer: false` opts out", () => {
    assert.deepEqual(lintPlan(planDoc({ tasks: [autoTask("01", 1)], tracer: false })).issues, []);
  });
});

// ─── muster adaptation: already passes at HEAD (gsd-plan-checker #4927) ──────

describe("already passes at HEAD", () => {
  let root;
  before(() => {
    root = fixtureRoot("head");
    writeFileSync(path.join(root, "README.md"), "# Title\n\n## Usage\nRun it.\n");
    mkdirSync(path.join(root, "docs"));
  });

  test("grep of a literal already in the file passes at HEAD; one that is absent fails", () => {
    assert.equal(probeAlreadyPassing('grep -q "## Usage" README.md', { projectRoot: root }).status, "passes_at_head");
    assert.equal(probeAlreadyPassing("grep -c '## Quickstart' README.md", { projectRoot: root }).status, "fails_at_head");
    assert.equal(probeAlreadyPassing("rg -qF 'Run it.' README.md", { projectRoot: root }).status, "passes_at_head");
  });

  test("case: grep is case-sensitive unless -i", () => {
    assert.equal(probeAlreadyPassing("grep -q usage README.md", { projectRoot: root }).status, "fails_at_head");
    assert.equal(probeAlreadyPassing("grep -qi usage README.md", { projectRoot: root }).status, "passes_at_head");
  });

  test("test -f / [ -d ] forms", () => {
    assert.equal(probeAlreadyPassing("test -f README.md", { projectRoot: root }).status, "passes_at_head");
    assert.equal(probeAlreadyPassing("test -f NEW.md", { projectRoot: root }).status, "fails_at_head");
    assert.equal(probeAlreadyPassing("[ -d docs ]", { projectRoot: root }).status, "passes_at_head");
  });

  test("a recorded baseline is reported", () => {
    assert.equal(probeAlreadyPassing('grep -q "## Usage" README.md # baseline at HEAD: 1', { projectRoot: root }).baseline, true);
  });

  test("anything it cannot decide by reading files is not applicable", () => {
    for (const cmd of [
      "grep -q x README.md | wc -l", "grep -q x README.md && echo ok", "! grep -q '## Usage' README.md",
      "grep -qE 'Us(age)' README.md", "grep -q 'Us.*' README.md", "grep -rq Usage .", "grep -v x README.md",
      'grep -q "$X" README.md', "grep -q Usage", "grep -q Usage missing.md", "grep -q Usage docs",
      "grep -q Usage ../outside.md", "grep -q Usage /etc/hostname", "test -f *.md", "npm test", "MISSING — later",
    ]) {
      assert.equal(probeAlreadyPassing(cmd, { projectRoot: root }).status, "not_applicable", cmd);
    }
  });

  test("the tokenizer refuses operators and substitution, honours quotes and comments", () => {
    assert.deepEqual(tokenizeSimpleCommand(`grep -q '## a b' "c d" # note`), ["grep", "-q", "## a b", "c d"]);
    for (const bad of ["a | b", "a && b", "a; b", "a > f", "echo $(x)", "echo `x`", 'echo "$HOME"', "a\\ b"]) assert.equal(tokenizeSimpleCommand(bad), null, bad);
  });

  test("the probe never executes the command", () => {
    const canary = path.join(root, "pwned");
    probeAlreadyPassing(`touch ${canary}`, { projectRoot: root });
    probeAlreadyPassing(`grep -q x README.md; touch ${canary}`, { projectRoot: root });
    assert.equal(existsSync(canary), false);
  });
});

// ─── Fixtures: one clean plan, one fixture per issue class ───────────────────

describe("fixtures (test/fixtures/plan-lint)", () => {
  const lintFixture = name => lintPlan(readFixture(name), { projectRoot: FIXTURE_REPO });
  const expected = {
    "structure-truncated.md": { dimension: DIMENSIONS.PLAN_STRUCTURE, blocks: true },
    "structure-frontmatter.md": { dimension: DIMENSIONS.PLAN_STRUCTURE, blocks: true, only: true },
    "task-incomplete.md": { dimension: DIMENSIONS.TASK_COMPLETENESS, blocks: true, only: true },
    "checkpoint-autonomous.md": { dimension: DIMENSIONS.TASK_COMPLETENESS, blocks: true, only: true },
    "failing-direction-missing.md": { dimension: DIMENSIONS.NYQUIST, blocks: true, only: true },
    "failing-direction-placeholder.md": { dimension: DIMENSIONS.NYQUIST, blocks: true, only: true },
    "verify-path-missing.md": { dimension: DIMENSIONS.VERIFY_PATHS, blocks: true, only: true },
    "already-passing.md": { dimension: DIMENSIONS.VERIFY_SANITY, blocks: true, only: true },
    "deps-cycle.md": { dimension: DIMENSIONS.DEPENDENCIES, blocks: true, only: true },
    "deps-unknown.md": { dimension: DIMENSIONS.DEPENDENCIES, blocks: true, only: true },
    "deps-wave-order.md": { dimension: DIMENSIONS.DEPENDENCIES, blocks: true, only: true },
    "same-wave-files.md": { dimension: DIMENSIONS.DEPENDENCIES, blocks: true, only: true },
    "tracer-missing.md": { dimension: DIMENSIONS.TRACER, blocks: false, only: true },
    "reversibility-one-way.md": { dimension: DIMENSIONS.REVERSIBILITY, blocks: false, only: true },
    "threat-duplicate.md": { dimension: DIMENSIONS.THREAT_MODEL, blocks: true, only: true },
  };

  test("the clean plan passes with zero issues", () => {
    assert.deepEqual(lintFixture("clean.md"), { verdict: "PASS", issues: [] });
  });

  test("every fixture on disk has an expectation", () => {
    const onDisk = readdirSync(FIXTURES).filter(f => f.endsWith(".md") && f !== "clean.md").sort();
    assert.deepEqual(onDisk, Object.keys(expected).sort());
  });

  for (const [name, want] of Object.entries(expected)) {
    test(`${name}: reports ${want.dimension}${want.blocks ? " as a blocker" : " without blocking"}`, () => {
      const result = lintFixture(name);
      assert.equal(result.verdict, "ISSUES");
      assert.ok(dims(result).includes(want.dimension), JSON.stringify(result.issues));
      if (want.only) assert.deepEqual([...new Set(dims(result))], [want.dimension], JSON.stringify(result.issues));
      assert.equal(blockers(result).length > 0, want.blocks, JSON.stringify(result.issues));
    });
  }

  test("every issue has exactly the CheckResult keys", () => {
    for (const name of Object.keys(expected)) {
      for (const issue of lintFixture(name).issues) {
        assert.deepEqual(Object.keys(issue).sort(), ["dimension", "required_property", "severity", "summary"]);
        assert.ok(["blocker", "warning", "info"].includes(issue.severity));
        assert.ok(Object.values(DIMENSIONS).includes(issue.dimension));
      }
    }
  });

  test("a fenced example task in the plan body is not linted as a live task", () => {
    const quoted = readFixture("clean.md").replace("<verification>", "```xml\n<task id=\"99\">\n</task>\n```\n\n<verification>");
    assert.deepEqual(lintPlan(quoted, { projectRoot: FIXTURE_REPO }).issues, []);
  });
});

// ─── CLI ─────────────────────────────────────────────────────────────────────

describe("plan-lint CLI", () => {
  const capture = () => { const chunks = []; return { write: s => { chunks.push(s); return true; }, text: () => chunks.join("") }; };
  const run = (args) => {
    const stdout = capture();
    const stderr = capture();
    const code = runPlanLintCli(args, { stdout, stderr, cwd: FIXTURES });
    return { code, stdout: stdout.text(), stderr: stderr.text() };
  };

  test("exit 0 and PASS on the clean plan; --json is the CheckResult", () => {
    const r = run(["clean.md", "--json", "--root", "repo"]);
    assert.equal(r.code, 0);
    assert.deepEqual(JSON.parse(r.stdout), { verdict: "PASS", issues: [] });
  });

  test("exit 1 on blockers, exit 0 on warnings only (verdict still ISSUES)", () => {
    assert.equal(run(["deps-cycle.md", "--root", "repo"]).code, 1);
    const warn = run(["tracer-missing.md", "--json", "--root", "repo"]);
    assert.equal(warn.code, 0);
    assert.equal(JSON.parse(warn.stdout).verdict, "ISSUES");
  });

  test("exit 2 (not evaluated) on a missing file, a directory, or bad usage", () => {
    assert.equal(run(["nope.md"]).code, 2);
    assert.equal(run(["repo"]).code, 2);
    assert.equal(run([]).code, 2);
    assert.equal(run(["clean.md", "--bogus"]).code, 2);
    assert.equal(run(["clean.md", "--root"]).code, 2);
  });

  test("the muster bin dispatches plan-lint with the same exit codes", () => {
    const bin = args => spawnSync(process.execPath, [CLI, "plan-lint", ...args], { cwd: FIXTURES, encoding: "utf8" });
    assert.equal(bin(["clean.md", "--root", "repo"]).status, 0);
    const blocked = bin(["threat-duplicate.md", "--json", "--root", "repo"]);
    assert.equal(blocked.status, 1);
    assert.equal(JSON.parse(blocked.stdout).issues[0].dimension, DIMENSIONS.THREAT_MODEL);
    assert.equal(bin(["missing.md"]).status, 2);
  });
});

// ─── Provenance: the gsd sources are recorded as file items ──────────────────

describe("vendor/manifest.yaml records plan-lint's gsd sources", () => {
  const manifest = parseYaml(readFileSync(path.join(here, "..", "vendor", "manifest.yaml"), "utf8"));
  const gsd = manifest.sources.find(s => s.repo === "open-gsd/gsd-core" && s.items.some(i => i.to === "src/plan-lint.js"));
  const items = gsd ? gsd.items.filter(i => i.to === "src/plan-lint.js") : [];

  test("every ported gsd runtime file is an adapted item pinned at v1.20.1 with a base blob", () => {
    assert.deepEqual(items.filter(i => i.mode === "adapted").map(i => i.from).sort(), [
      "src/gate-verify-command-paths.cts", "src/gate-verify-failure-directions.cts", "src/init.cts",
      "src/markdown-sectionizer.cts", "src/phase.cts", "src/plan-document.cts", "src/verify-command-grounding.cts", "src/verify.cts",
    ]);
    for (const i of items) {
      assert.equal(i.ref, "9385f4618b52ef68ed8a5e8bdd93cfb25bd87765", i.from);
      assert.match(i.baseBlob, /^[0-9a-f]{40}$/, i.from);
    }
  });

  test("file items validate, are never vendored, and project onto no item", () => {
    assert.deepEqual(validateVendorManifest(manifest), { ok: true, errors: [] });
    for (const i of items) assert.equal(isVendoredItem(gsd, i), false);
    for (const entries of projectManifest(manifest).values()) assert.ok(!entries.some(e => String(e.path).endsWith(".cts")));
  });

  test("the validator rejects a malformed file item", () => {
    const bad = structuredClone(manifest);
    bad.sources.find(s => s.id === gsd.id).items.push({ from: "../x.cts", to: "/abs.js", mode: "copied", baseBlob: "abc" });
    const { ok, errors } = validateVendorManifest(bad);
    assert.equal(ok, false);
    for (const field of ["from", "to", "mode", "baseBlob"]) assert.ok(errors.some(e => e.includes(`.${field}:`)), field);
  });
});

// ─── Revival stage 3: agent_hint / skills against the plugin catalog ─────────

describe("agent_hint and skills against the catalog (src/specialists.js)", () => {
  const catalog = specialistCatalog();
  const lint = (tasks, options = {}) => lintPlan(planDoc({ tasks }), { projectRoot: fixtureRoot("cat"), catalog, ...options });
  const completeness = r => r.issues.filter(i => i.dimension === DIMENSIONS.TASK_COMPLETENESS);

  test("a dispatchable specialist and builtin skills pass", () => {
    assert.deepEqual(completeness(lint([autoTask("01", 1, ' agent_hint="wsh-debugger" skills="sp-debug, sp-tdd"')])), []);
  });

  test("an unknown or read-only agent_hint is a warning; an unknown skill is a blocker", () => {
    const unknown = completeness(lint([autoTask("01", 1, ' agent_hint="wsh-nope"')]));
    assert.deepEqual(unknown.map(i => i.severity), ["warning"]);
    assert.match(unknown[0].summary, /unknown agent "wsh-nope"/);
    const seat = completeness(lint([autoTask("01", 1, ' agent_hint="muster-reviewer"')]));
    assert.match(seat[0].summary, /cannot execute a task/);
    const skill = completeness(lint([autoTask("01", 1, ' skills="sp-tdd,no-such-skill"')]));
    assert.deepEqual(skill.map(i => i.severity), ["blocker"]);
    assert.match(skill[0].summary, /unknown skill "no-such-skill"/);
  });

  test("without a catalog only the id shape is checked (pure callers)", () => {
    assert.deepEqual(completeness(lintPlan(planDoc({ tasks: [autoTask("01", 1, ' agent_hint="wsh-nope" skills="no-such-skill"')] }), { projectRoot: fixtureRoot("cat2") })), []);
  });

  test("a skill-less task warns when a high-scoring preflight candidate fits it; skills=\"\" declines", () => {
    const task = autoTask("01", 1).replace("<name>Task 01</name>", "<name>Add a debug trace for the failing test</name>");
    const strong = [{ id: "sp-debug", score: 4 }];
    const warned = completeness(lint([task], { skillCandidates: strong }));
    assert.deepEqual(warned.map(i => i.severity), ["warning"]);
    assert.match(warned[0].summary, /binds no skills, but preflight ranked "sp-debug" highly/);
    assert.deepEqual(completeness(lint([task.replace('wave="1"', 'wave="1" skills=""')], { skillCandidates: strong })), []);
    assert.deepEqual(completeness(lint([task], { skillCandidates: [{ id: "sp-debug", score: 3 }] })), [], "below the high score");
    assert.deepEqual(completeness(lint([autoTask("01", 1)], { skillCandidates: strong })), [], "candidate does not match the task text");
  });

  test("the CLI loads the catalog and the run dir's preflight.json", () => {
    const dir = fixtureRoot("cat-cli");
    const plan = planDoc({ tasks: [autoTask("01", 1, ' agent_hint="wsh-nope"').replace("<name>Task 01</name>", "<name>Debug the failing test</name>")] });
    writeFileSync(path.join(dir, "PLAN.md"), plan);
    writeFileSync(path.join(dir, "preflight.json"), JSON.stringify({ skillCandidates: [{ id: "sp-debug", score: 7 }] }));
    const r = spawnSync(process.execPath, [CLI, "plan-lint", path.join(dir, "PLAN.md"), "--json", "--root", dir], { encoding: "utf8" });
    const out = JSON.parse(r.stdout);
    assert.ok(out.issues.some(i => /unknown agent "wsh-nope"/.test(i.summary)), r.stdout);
    assert.ok(out.issues.some(i => /preflight ranked "sp-debug"/.test(i.summary)), r.stdout);
  });
});
