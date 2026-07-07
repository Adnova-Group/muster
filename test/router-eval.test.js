import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { validateManifest } from "../src/manifest.js";
import { suggestSkillsForStack, lastColonSegment } from "../src/match.js";
import { codeGradeManifest, gradeCase, bindsSkill, hasSkillGapDegradation, hasSkillGapRecommendation } from "../eval/router/grade-lib.mjs";

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

test("role coverage does not false-positive on a plan task's trailing-punctuation token (the trailing empty-string-token defect)", () => {
  // A plan task ending in punctuation (e.g. "...findings.") makes split(/\W+/) yield a
  // trailing "" token. "".includes(r) is false, but r.includes("") is true for ANY role
  // r — so the old substring-based covers() falsely "covered" every expected role via that
  // empty token alone, regardless of actual crew composition. Reproduces the gate-proven
  // bug: a crew containing only `implement` must NOT cover security-review/code-review.
  const implementOnly = {
    outcome: "x", successCriteria: ["a"],
    crew: [{ stage: "implement", provider: "muster-builder", source: "builtin", model: "sonnet", rationale: "r", evidence: "e", fallback: "inline" }],
    recommendations: [], degradations: [],
    plan: [{ task: "Audit the entire codebase for security vulnerabilities and remediate the findings.", mode: "single" }],
  };
  const g = codeGradeManifest(implementOnly, ["security-review", "code-review"]);
  assert.match(g.reason, /role coverage 0\/2/, `expected 0/2 role coverage, got: ${g.reason}`);
  assert.ok(g.score < 10, `an implement-only crew must not score full marks for security/code review coverage (got ${g.score})`);
});

// ---------------------------------------------------------------------------
// Luca regression (t7): the failure this guards was a Next.js+Supabase customer-facing
// app routed live, where supabase/vercel/design/humanizer/verification skills never fired.
// The manifest still "validated" and had non-empty crew/plan — so "skills[] non-empty" is
// NOT a sufficient guard (a router could bind an arbitrary/wrong skill and still clear a
// bare non-empty check). These assertions check the ACTUAL bound skill id (last-colon-
// segment, namespace-insensitive) per task type, the surface tag, non-empty rationale AND
// evidence on every binding, and that a deliberately-missing stack-mapped skill (ai-sdk)
// surfaces as a skill-gap degradation + a recommendation proposing a fix. If a future
// router-prompt edit drops any of these bindings from the golden manifest, this case
// flips red — that's the point.
// ---------------------------------------------------------------------------

const lucaCase = dataset.cases.find(c => c.id === "luca-finance-poc");
const lucaManifestPromise = read(`eval/router/out/${lucaCase.id}.json`).then(JSON.parse);

function taskByKeyword(manifest, keyword) {
  return manifest.plan.find(p => p.task.toLowerCase().includes(keyword.toLowerCase()));
}

test("Luca regression: schema/migration task binds a supabase skill, surface integration|none", async () => {
  const m = await lucaManifestPromise;
  const t = taskByKeyword(m, "schema");
  assert.ok(t, "expected a schema/migration plan task in the Luca golden manifest");
  assert.ok(bindsSkill(t, "supabase"), `schema task must bind a skill whose last-colon-segment is "supabase" with non-empty rationale+evidence, got: ${JSON.stringify(t.skills)}`);
  assert.ok(["integration", "none"].includes(t.surface), `schema task surface must be "integration" or "none", got: ${t.surface}`);
});

test("Luca regression: chat UI task binds nextjs and/or shadcn AND a design/frontend skill, surface ui", async () => {
  const m = await lucaManifestPromise;
  const t = taskByKeyword(m, "chat ui");
  assert.ok(t, "expected a chat-UI plan task in the Luca golden manifest");
  assert.ok(bindsSkill(t, "nextjs") || bindsSkill(t, "shadcn"), `chat UI task must bind nextjs and/or shadcn, got: ${JSON.stringify(t.skills)}`);
  assert.ok(bindsSkill(t, "frontend-design") || (t.skills || []).some(s => /design/i.test(lastColonSegment(s.id || ""))),
    `chat UI task must bind a design/frontend skill, got: ${JSON.stringify(t.skills)}`);
  assert.equal(t.surface, "ui", `chat UI task surface must be "ui", got: ${t.surface}`);
});

test("Luca regression: branded-report/copy task binds the humanizer skill, surface copy", async () => {
  const m = await lucaManifestPromise;
  const t = taskByKeyword(m, "branded monthly report");
  assert.ok(t, "expected a branded-report/copy plan task in the Luca golden manifest");
  assert.ok(bindsSkill(t, "muster-humanizer") || (t.skills || []).some(s => /humaniz/i.test(lastColonSegment(s.id || ""))),
    `copy task must bind muster-humanizer or a humanizer-tagged skill, got: ${JSON.stringify(t.skills)}`);
  assert.equal(t.surface, "copy", `copy task surface must be "copy", got: ${t.surface}`);
});

test("Luca regression: QBO OAuth task binds the verification skill, surface integration", async () => {
  const m = await lucaManifestPromise;
  const t = taskByKeyword(m, "oauth integration");
  assert.ok(t, "expected a QBO OAuth integration plan task in the Luca golden manifest");
  assert.ok(bindsSkill(t, "sp-verify") || (t.skills || []).some(s => /verif/i.test(lastColonSegment(s.id || ""))),
    `OAuth task must bind sp-verify or a verification-tagged skill, got: ${JSON.stringify(t.skills)}`);
  assert.equal(t.surface, "integration", `OAuth task surface must be "integration", got: ${t.surface}`);
});

test("Luca regression: every skill binding in the plan carries non-empty rationale AND evidence (distinct fields)", async () => {
  const m = await lucaManifestPromise;
  let bindingCount = 0;
  for (const p of m.plan) {
    for (const s of (p.skills || [])) {
      bindingCount++;
      assert.ok(typeof s.rationale === "string" && s.rationale.trim().length > 0, `${p.id} skill "${s.id}" missing rationale`);
      assert.ok(typeof s.evidence === "string" && s.evidence.trim().length > 0, `${p.id} skill "${s.id}" missing evidence`);
      assert.notEqual(s.rationale, s.evidence, `${p.id} skill "${s.id}" rationale and evidence must not be the same field doing double duty`);
    }
  }
  assert.ok(bindingCount >= 4, `expected at least 4 skill bindings across the Luca plan, found ${bindingCount}`);
});

test("Luca regression: a stack-mapped missing skill (ai-sdk) surfaces as a skill-gap degradation + recommendation", async () => {
  const m = await lucaManifestPromise;
  // Prove the fixture is honest: the deliberately-incomplete inventory really is missing
  // this skill per the live deterministic stack map (src/match.js), not just hand-asserted.
  const signals = { frameworks: lucaCase.profile.frameworks, languages: lucaCase.profile.languages, keywords: [] };
  const suggestions = suggestSkillsForStack(signals, lucaCase.skillsInventory);
  const gap = suggestions.find(s => lastColonSegment(s.id) === lastColonSegment(lucaCase.expectedSkillGap));
  assert.ok(gap, `expected suggestSkillsForStack to suggest "${lucaCase.expectedSkillGap}" for this fixture's ProjectProfile signals`);
  assert.equal(gap.missing, true, `"${lucaCase.expectedSkillGap}" must be flagged missing:true against the fixture's deliberately-incomplete skillsInventory`);

  assert.ok(hasSkillGapDegradation(m, lucaCase.expectedSkillGap), `golden manifest degradations must record a skill-gap for "${lucaCase.expectedSkillGap}", got: ${JSON.stringify(m.degradations)}`);
  assert.ok(hasSkillGapRecommendation(m, lucaCase.expectedSkillGap), `golden manifest recommendations must propose a fix for the "${lucaCase.expectedSkillGap}" gap, got: ${JSON.stringify(m.recommendations)}`);
});
