import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateManifest } from "../src/manifest.js";
import { codeGradeManifest, gradeCase } from "../eval/router/grade-lib.mjs";

// CI regression guard for the router eval (eval/router/). A PR runner cannot call the
// model, so this does NOT re-run the router. It guards the deterministic contract instead:
// the golden manifests in out/ still satisfy validateManifest + role coverage, the grader
// works, and the router skill still documents the `model` crew field (the fix the eval
// found). The full model-driven re-run is a separate manual/scheduled job (see README).
const root = new URL("../", import.meta.url);
const read = (rel) => readFile(new URL(rel, root), "utf8");

const dataset = JSON.parse(await read("eval/router/dataset.json"));
const results = JSON.parse(await read("eval/router/results.json"));
const judgeById = Object.fromEntries(results.cases.map(c => [c.id, c.judgeScore]));

test("every golden router manifest validates and is not all-inline", async () => {
  for (const c of dataset.cases) {
    const m = JSON.parse(await read(`eval/router/out/${c.id}.json`));
    const v = validateManifest(m);
    assert.ok(v.ok, `${c.id} golden manifest invalid: ${JSON.stringify(v.errors)}`);
    assert.ok(m.crew.length > 0 && !m.crew.every(x => x.source === "inline"), `${c.id} crew is all-inline`);
    // The fix the eval found: every non-inline crew member carries a model tier.
    for (const x of m.crew)
      if (x.source !== "inline") assert.ok(x.model, `${c.id} crew member ${x.stage} missing model`);
  }
});

test("each golden manifest covers its expected roles and grades as passing", async () => {
  for (const c of dataset.cases) {
    const m = JSON.parse(await read(`eval/router/out/${c.id}.json`));
    const code = codeGradeManifest(m, c.expectRoles);
    assert.ok(code.score >= 6, `${c.id} weak code grade: ${code.reason}`);
    const g = gradeCase({ manifest: m, judgeScore: judgeById[c.id], expectRoles: c.expectRoles, passThreshold: dataset.passThreshold });
    assert.ok(g.passing, `${c.id} should pass: code ${g.code}, judge ${g.model}, score ${g.score}`);
  }
});

test("router eval run passes the accuracy bar on the goldens", async () => {
  const rows = [];
  for (const c of dataset.cases) {
    const m = JSON.parse(await read(`eval/router/out/${c.id}.json`));
    rows.push(gradeCase({ manifest: m, judgeScore: judgeById[c.id], expectRoles: c.expectRoles, passThreshold: dataset.passThreshold }));
  }
  const accuracy = rows.filter(r => r.passing).length / rows.length;
  assert.ok(accuracy >= 0.8, `router eval accuracy ${(accuracy * 100).toFixed(0)}% below 80% bar`);
});

test("router skill still documents the required `model` crew field (guards the eval fix)", async () => {
  const skill = await read("plugin/skills/router/SKILL.md");
  // The crew-shape spec line must include the model field, else the router regresses to
  // emitting manifests that fail validation (the defect this eval originally caught).
  const crewShape = skill.split("\n").find(l => l.includes('"crew"') && l.includes('"stage"'));
  assert.ok(crewShape, "router skill must document the crew shape");
  assert.match(crewShape, /"model"/, "crew shape must include the model field");
});

test("a manifest missing model fails the code grade (the original defect)", () => {
  const noModel = { outcome: "x", successCriteria: ["a"], crew: [{ stage: "implement", provider: "muster-builder", source: "builtin", rationale: "r", evidence: "e", fallback: "inline" }], recommendations: [], degradations: [], plan: [{ task: "do it", mode: "single" }] };
  assert.equal(codeGradeManifest(noModel, ["implement"]).score, 0, "missing model must score 0");
});
