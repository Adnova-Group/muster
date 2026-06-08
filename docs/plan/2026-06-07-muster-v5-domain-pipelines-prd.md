# Muster slice 5 — Domain pipelines (framework + PRD) — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Make work-domain first-class — deterministic domain detection, a pipeline registry, a deterministic scorer — plus the PRD pipeline + domain-router skills, so Muster produces PM artifacts, not just code.

**Architecture:** New deterministic modules `src/domain.js` (`classifyDomain`), `src/pipeline.js` (`loadPipelines`/`validatePipeline`/`pipelineForDomain`), `src/score.js` (`scoreArtifact`) — unit-tested; wired as `muster domain|pipeline|score`. The PRD flow + domain routing are markdown skills reusing slice-2's review gate.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, dep `yaml`. Apache-2.0. **Source of truth:** `docs/design/2026-06-07-muster-v5-domain-pipelines-prd.md`.

---

## File structure (additions)
```
src/domain.js            # classifyDomain(outcome, profile, override)            (new)
src/pipeline.js          # loadPipelines / validatePipeline / pipelineForDomain  (new)
src/score.js             # scoreArtifact(scores, gate)                           (new)
pipelines/prd.yaml       # the PRD pipeline definition                           (new)
src/cli.js               # + domain / pipeline / score subcommands              (modify)
plugin/skills/domain-router/SKILL.md  # classify -> select pipeline -> run        (new)
plugin/skills/prd-pipeline/SKILL.md   # intake->research->draft->review->score    (new)
plugin/.claude-plugin/plugin.json     # register the two skills                   (modify)
test/domain.test.js  test/pipeline.test.js  test/score.test.js  test/integration.slice5.test.js
```

---

## Task 1: `classifyDomain` + `muster domain`

**Files:** Create `src/domain.js`, `test/domain.test.js`; modify `src/cli.js`

- [ ] **Step 1: Failing test `test/domain.test.js`**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDomain } from "../src/domain.js";

test("override always wins", () => {
  assert.deepEqual(classifyDomain("anything", {}, "marketing"),
    { domain: "marketing", source: "override", confidence: 1 });
});
test("pm keyword in outcome", () => {
  assert.equal(classifyDomain("Write a PRD for checkout", {}).domain, "pm");
});
test("business keyword", () => {
  assert.equal(classifyDomain("Build a business case for X", {}).domain, "business");
});
test("workspace -> software when no keyword", () => {
  assert.equal(classifyDomain("make it faster", { shape: "backend", greenfield: false }).domain, "software");
});
test("unknown when nothing matches", () => {
  assert.equal(classifyDomain("hello there", { shape: "unknown", greenfield: true }).domain, "unknown");
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/domain.test.js`

- [ ] **Step 3: Implement `src/domain.js`**
```js
const DOMAIN_KEYWORDS = {
  pm: ["prd", "product spec", "user story", "epic", "roadmap", "requirements", "product brief"],
  business: ["business case", "investor", "pitch", "financial model", "market analysis"],
  marketing: ["lead magnet", "campaign", "landing page", "go-to-market", "gtm", "email sequence"],
  ops: ["runbook", "sop", "operations", "process doc", "incident"],
  software: ["implement", "refactor", "bug", "api", "endpoint", "function", "deploy"]
};

export function classifyDomain(outcome, profile = {}, override) {
  if (override) return { domain: override, source: "override", confidence: 1 };
  const text = (outcome || "").toLowerCase();
  for (const [domain, kws] of Object.entries(DOMAIN_KEYWORDS)) {
    if (kws.some(k => text.includes(k))) return { domain, source: "outcome", confidence: 0.8 };
  }
  if (profile.shape && profile.shape !== "unknown" && !profile.greenfield) {
    return { domain: "software", source: "workspace", confidence: 0.6 };
  }
  return { domain: "unknown", source: "none", confidence: 0 };
}
```

- [ ] **Step 4: Wire `muster domain` in `src/cli.js`** — add `import { classifyDomain } from "./domain.js";` (detect is already imported). Branch before final else:
```js
  } else if (cmd === "domain") {
    if (!rest[0]) fail("domain <outcome> [--domain x]: missing outcome");
    const di = rest.indexOf("--domain");
    const override = di >= 0 ? rest[di + 1] : undefined;
    const outcome = rest.filter((r, i) => i !== di && i !== di + 1)[0] || rest[0];
    out(classifyDomain(outcome, await detectProject(process.cwd()), override));
```
(If `detectProject` isn't already imported in cli.js, add it.) Update usage to include `domain <outcome>`.

- [ ] **Step 5: Run → 5 pass; `npm test` green. Commit**
```bash
git add src/domain.js src/cli.js test/domain.test.js
git commit -m "feat(domain): hybrid classifyDomain + muster domain"
```

---

## Task 2: pipeline registry + `pipelines/prd.yaml` + `muster pipeline`

**Files:** Create `src/pipeline.js`, `pipelines/prd.yaml`, `test/pipeline.test.js`; modify `src/cli.js`

- [ ] **Step 1: Failing test `test/pipeline.test.js`**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePipeline, loadPipelines, pipelineForDomain } from "../src/pipeline.js";

test("validatePipeline accepts a well-formed pipeline", () => {
  const p = { id: "prd", domain: "pm", phases: [{ id: "draft", role: "author" }],
    gate: { criteria: ["clarity"], floor: 2 } };
  assert.deepEqual(validatePipeline(p), { ok: true, errors: [] });
});
test("validatePipeline rejects missing phases/gate", () => {
  const r = validatePipeline({ id: "x", domain: "pm" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /phases/.test(e)));
  assert.ok(r.errors.some(e => /gate/.test(e)));
});
test("loads shipped pipelines and finds PRD by domain", async () => {
  const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
  assert.ok(ps.length > 0);
  const prd = pipelineForDomain(ps, "pm");
  assert.equal(prd.id, "prd");
  assert.ok(prd.phases.length >= 3);
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement `src/pipeline.js`**
```js
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";

export function validatePipeline(p) {
  const errors = [];
  if (!p || typeof p !== "object") return { ok: false, errors: ["pipeline must be an object"] };
  if (!p.id) errors.push("pipeline: id required");
  if (!p.domain) errors.push("pipeline: domain required");
  if (!Array.isArray(p.phases) || p.phases.length === 0) errors.push("pipeline: phases required");
  else p.phases.forEach((ph, i) => {
    if (!ph.id) errors.push(`pipeline.phases[${i}].id required`);
    if (!ph.role) errors.push(`pipeline.phases[${i}].role required`);
  });
  if (!p.gate || !Array.isArray(p.gate.criteria) || typeof p.gate.floor !== "number")
    errors.push("pipeline: gate.{criteria,floor} required");
  return { ok: errors.length === 0, errors };
}

export async function loadPipelines(dir) {
  const base = dir instanceof URL ? fileURLToPath(dir) : dir;
  const files = (await readdir(base)).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  const pipelines = [];
  for (const f of files) {
    const p = parse(await readFile(join(base, f), "utf8"));
    const { ok, errors } = validatePipeline(p);
    if (!ok) throw new Error(`Invalid pipeline ${f}:\n` + errors.join("\n"));
    pipelines.push(p);
  }
  return pipelines;
}

export function pipelineForDomain(pipelines, domain) {
  return pipelines.find(p => p.domain === domain) || null;
}
```

- [ ] **Step 4: Create `pipelines/prd.yaml`**
```yaml
id: prd
domain: pm
title: Product Requirements Document
phases:
  - { id: intake,   role: brainstorm,    desc: "clarify problem, audience, success metrics" }
  - { id: research, role: docs-research, desc: "gather evidence: market, competitor, customer context" }
  - { id: draft,    role: author,        desc: "draft PRD sections: problem, goals, scope, requirements, metrics" }
  - { id: review,   role: code-review,   desc: "adversarial review gate (reuse review-gate)" }
  - { id: score,    role: score,         desc: "score vs rubric, apply floor principle" }
gate:
  criteria: [problem-clarity, outcome-alignment, evidence, scope-discipline, feasibility, measurability]
  floor: 2
  pass_total: 14
```

- [ ] **Step 5: Wire `muster pipeline` in `src/cli.js`** — add `import { loadPipelines, pipelineForDomain } from "./pipeline.js";` and:
```js
  } else if (cmd === "pipeline") {
    if (!rest[0]) fail("pipeline <domain|id>: missing arg");
    const ps = await loadPipelines(new URL("../pipelines/", import.meta.url));
    out(pipelineForDomain(ps, rest[0]) || ps.find(p => p.id === rest[0]) || null);
```
Update usage to include `pipeline <domain|id>`.

- [ ] **Step 6: Run → 3 pass; `npm test` green. Commit**
```bash
git add src/pipeline.js pipelines/prd.yaml src/cli.js test/pipeline.test.js
git commit -m "feat(pipeline): registry + loader/validator + PRD pipeline + muster pipeline"
```

---

## Task 3: `scoreArtifact` + `muster score`

**Files:** Create `src/score.js`, `test/score.test.js`; modify `src/cli.js`

- [ ] **Step 1: Failing test `test/score.test.js`**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreArtifact } from "../src/score.js";

test("passes when floor + total met", () => {
  const r = scoreArtifact({ a: 3, b: 3, c: 2 }, { floor: 2, pass_total: 7 });
  assert.equal(r.passing, true);
  assert.equal(r.total, 8);
});
test("fails on floor — one weak dimension reported", () => {
  const r = scoreArtifact({ a: 3, b: 1, c: 3 }, { floor: 2, pass_total: 5 });
  assert.equal(r.passing, false);
  assert.equal(r.weakest.criterion, "b");
});
test("fails on total even if floor met", () => {
  const r = scoreArtifact({ a: 2, b: 2, c: 2 }, { floor: 2, pass_total: 10 });
  assert.equal(r.passing, false);
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement `src/score.js`**
```js
// Book-genesis floor principle: weakest dimension must clear `floor` AND total must clear `pass_total`.
export function scoreArtifact(scores, gate = {}) {
  const entries = Object.entries(scores || {});
  const total = entries.reduce((s, [, v]) => s + v, 0);
  let weakest = { criterion: null, value: entries.length ? Infinity : 0 };
  for (const [c, v] of entries) if (v < weakest.value) weakest = { criterion: c, value: v };
  const passing = entries.length > 0 && weakest.value >= (gate.floor ?? 0) && total >= (gate.pass_total ?? 0);
  return { total, weakest, passing };
}
```

- [ ] **Step 4: Wire `muster score` in `src/cli.js`** — add `import { scoreArtifact } from "./score.js";` and:
```js
  } else if (cmd === "score") {
    if (!rest[0]) fail("score <file.json>: missing file path ({scores, gate})");
    const { scores, gate } = JSON.parse(await readFile(rest[0], "utf8"));
    out(scoreArtifact(scores, gate));
```
Update usage to include `score <file>`.

- [ ] **Step 5: Run → 3 pass; `npm test` green. Commit**
```bash
git add src/score.js src/cli.js test/score.test.js
git commit -m "feat(score): scoreArtifact (floor principle) + muster score"
```

---

## Task 4: domain-router + prd-pipeline skills

**Files:** Create `plugin/skills/domain-router/SKILL.md`, `plugin/skills/prd-pipeline/SKILL.md`; modify `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Create `plugin/skills/domain-router/SKILL.md`**
```markdown
---
name: domain-router
description: Pick the work domain for an outcome and route to its pipeline (PM/PRD, etc.), else fall back to the software route. Glass-box: records the domain choice + why.
---

# Domain router

1. Classify: `npx muster domain "<outcome>" [--domain <override>]` -> `{domain, source, confidence}`.
2. If `domain` is `unknown`, classify it yourself (model judgment) from the outcome + workspace and
   record that you did so and why (glass box).
3. Look up a pipeline: `npx muster pipeline <domain>`.
   - If a pipeline exists (e.g. `pm` -> PRD), invoke that pipeline skill (e.g. **prd-pipeline**).
   - Else proceed with the existing software route -> Crew Manifest -> orchestrator flow.
4. Record the chosen domain + pipeline (or software fallback) in the run STATE.
```

- [ ] **Step 2: Create `plugin/skills/prd-pipeline/SKILL.md`**
```markdown
---
name: prd-pipeline
description: Produce a PRD via a phased pipeline (intake -> research -> draft -> review -> score) with an adversarial review gate and a floor-principle score gate.
---

# PRD pipeline

Load the pipeline: `npx muster pipeline prd`. Run its phases in order, anchored to the outcome:

1. **intake** (role: brainstorm) — clarify the problem, audience, and explicit success metrics. No
   PRD without success metrics (outcome-anchored).
2. **research** (role: docs-research) — dispatch the chosen provider (a knowledge-work PM/research
   plugin or context7/web) for market, competitor, and customer evidence. Cite sources.
3. **draft** (role: author) — draft the PRD sections: problem, goals, non-goals, scope, requirements,
   success metrics. Use the chosen author provider; else built-in/inline.
4. **review** (role: code-review) — run the **review-gate** skill adversarially over the draft.
5. **score** (role: score) — a judge scores each `gate.criteria` dimension 0-3 with evidence; write
   `{scores, gate}` to `.muster/prd-score.json`; run `npx muster score .muster/prd-score.json`.
   - If not `passing` (floor or total), loop draft+review addressing the `weakest` dimension. Cap 3,
     then ESCALATE with the weakest dimension — do not ship a failing PRD.

Output: the finished PRD + the score card. Append each phase (checkbox) + the scores to the run STATE
and write the PRD to the LLM-Wiki memory (ready for a future ForceVue connector). Glass box throughout.
```

- [ ] **Step 3: Register in `plugin/.claude-plugin/plugin.json`** — add `"skills/domain-router/SKILL.md"` and `"skills/prd-pipeline/SKILL.md"` to the `skills` array. Keep other entries.

- [ ] **Step 4: Validate + commit**
Run: `node -e "JSON.parse(require('fs').readFileSync('plugin/.claude-plugin/plugin.json','utf8')); console.log('ok')"`; `npm test` green.
```bash
git add plugin/
git commit -m "feat(skills): domain-router + prd-pipeline (PM domain)"
```

---

## Task 5: Integration test + README

**Files:** Create `test/integration.slice5.test.js`; modify `README.md`

- [ ] **Step 1: Write the integration test**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyDomain } from "../src/domain.js";
import { loadPipelines, pipelineForDomain } from "../src/pipeline.js";
import { scoreArtifact } from "../src/score.js";

test("a PRD outcome routes to the PRD pipeline and scores by floor", async () => {
  const d = classifyDomain("Write a PRD for the new onboarding flow", {});
  assert.equal(d.domain, "pm");
  const prd = pipelineForDomain(await loadPipelines(new URL("../pipelines/", import.meta.url)), d.domain);
  assert.equal(prd.id, "prd");

  // a judge's scores -> deterministic gate
  const good = scoreArtifact(
    { "problem-clarity": 3, "outcome-alignment": 3, evidence: 2, "scope-discipline": 2, feasibility: 2, measurability: 2 },
    prd.gate);
  assert.equal(good.passing, true);
  const weak = scoreArtifact({ ...{ "problem-clarity": 3, "outcome-alignment": 3, evidence: 3, "scope-discipline": 3, feasibility: 3, measurability: 1 } }, prd.gate);
  assert.equal(weak.passing, false);           // measurability below floor
  assert.equal(weak.weakest.criterion, "measurability");
});
```

- [ ] **Step 2: Run full suite — paste summary (all green)**

- [ ] **Step 3: README + commit**
Append to `README.md`:
```markdown

Domain pipelines: Muster detects the work domain (`npx muster domain "<outcome>"`) and runs a phased pipeline — the first is PRD (`npx muster pipeline prd`), scored by a floor principle (`npx muster score`). PM/business work is first-class, not just code. Design: `docs/design/2026-06-07-muster-v5-domain-pipelines-prd.md`
```
```bash
git add test/integration.slice5.test.js README.md
git commit -m "test(integration): PRD outcome -> pm domain -> PRD pipeline -> floor-gated score"
```

---

## Self-review (completed)
- **Spec coverage:** classifyDomain (§3) → Task 1; pipeline registry + prd.yaml (§4) → Task 2;
  scoreArtifact (§5) → Task 3; domain-router + prd-pipeline skills (§6) → Task 4; CLI
  domain/pipeline/score (§7) → Tasks 1-3; integration (§3-5) → Task 5. Deferred (other pipelines,
  enum expansion, ForceVue) absent.
- **Placeholder scan:** deterministic steps carry full code; skills carry exact markdown. No TBD.
- **Type consistency:** classifyDomain `{domain,source,confidence}` consistent CLI+tests; pipeline
  shape `{id,domain,phases[],gate{criteria,floor,pass_total}}` consistent across validate/load/prd.yaml/
  integration; scoreArtifact `{total,weakest,passing}` consistent; prd.gate consumed by scoreArtifact.

## Notes for the executor
- Branch off `master` first.
- Roles in phases are free strings resolved by the slice-1 ladder; `author`/`research`/`score` may have
  no installed provider on a bare machine → builtin/inline (the PRD still drafts). That's intended.
- Keep the rubric as in `prd.yaml` (6 dims, floor 2, pass_total 14); the judge produces the per-dim scores.
