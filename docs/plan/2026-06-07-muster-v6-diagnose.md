# Muster slice 6 — Diagnose (bug-fix) mode — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A failure-first diagnose mode — a `debug` role resolving across providers, deterministic failure-classification + fix-manifest seeding, and a diagnose skill that runs systematic debugging → fix → regression → verify via the existing orchestrator + review-gate.

**Architecture:** New `src/diagnose.js` (`classifyFailure`, `buildDiagnoseManifest`) — unit-tested; `muster diagnose` CLI. `debug` role added to capabilities + the vendored debugging built-ins remapped to it. The diagnose loop is a markdown skill reusing slices 1–2.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, dep `yaml`. Apache-2.0. **Source of truth:** `docs/design/2026-06-07-muster-v6-diagnose.md`.

---

## File structure (additions)
```
src/diagnose.js                 # classifyFailure, buildDiagnoseManifest                 (new)
src/capabilities.js             # ROLES += "debug"                                        (modify)
catalog/builtins.generated.yaml # sp-debug + wsh-debugging-strategies roles += debug      (modify)
vendor/manifest.yaml            # same remap (source of truth)                            (modify)
catalog/software.yaml           # wshobson-agents roles += debug                          (modify)
src/cli.js                      # + diagnose subcommand                                   (modify)
plugin/commands/diagnose.md     # /muster:diagnose                                        (new, auto-discovered)
plugin/skills/diagnose/SKILL.md # the diagnose loop                                       (new, auto-discovered)
test/diagnose.test.js  test/integration.slice6.test.js
```

---

## Task 1: `debug` role (ladder across providers)

**Files:** Modify `src/capabilities.js`, `catalog/builtins.generated.yaml`, `vendor/manifest.yaml`, `catalog/software.yaml`; extend `test/capabilities.test.js`

- [ ] **Step 1: Failing test (append to `test/capabilities.test.js`)**
```js
import { loadCatalog } from "../src/catalog.js";
test("debug role resolves to a built-in on a bare machine (not inline)", async () => {
  const cat = await loadCatalog(new URL("../catalog/", import.meta.url));
  const a = resolveCapabilities(cat, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["debug"], "debug role must exist");
  assert.equal(a.roles["debug"].chosen.source, "builtin");
  assert.notEqual(a.roles["debug"].chosen.id, "inline");
});
```

- [ ] **Step 2: Run → FAIL** (`debug` not in ROLES yet) — `node --test test/capabilities.test.js`

- [ ] **Step 3: Add `debug` to ROLES** in `src/capabilities.js` — change the ROLES array to:
```js
const ROLES = [
  "code-navigation", "docs-research", "brainstorm", "plan", "implement",
  "code-review", "security-review", "test-author", "refactor", "frontend", "tech-debt", "debug"
];
```

- [ ] **Step 4: Add `debug` to the catalog (this is what makes the test pass)**
  - In `catalog/builtins.generated.yaml`, find the `sp-debug` entry and the `wsh-debugging-strategies` entry; add `debug` to each `roles:` list (keep existing roles). Example for sp-debug:
    ```yaml
    - id: sp-debug
      kind: builtin
      roles:
        - implement
        - debug
      rank: 50
      provenance: { adapted_from: obra/superpowers systematic-debugging/SKILL.md, license: MIT }
    ```
    (Match the existing formatting in the file; just append `- debug` under each of the two entries' `roles`.)
  - In `vendor/manifest.yaml` (source of truth), update the same two items' `roles` to include `debug`, so a future `muster vendor` regenerates correctly. Find the superpowers item `sp-debug` and the wshobson item `wsh-debugging-strategies`; set `roles: [implement, debug]` (sp-debug) and add `debug` to the wsh one.
  - In `catalog/software.yaml`, the `wshobson-agents` external entry: add `debug` to its `roles` list (so an installed wshobson would win the debug role).

- [ ] **Step 5: Run → pass; `npm test` full suite green. Commit**
```bash
git add src/capabilities.js catalog/builtins.generated.yaml vendor/manifest.yaml catalog/software.yaml test/capabilities.test.js
git commit -m "feat(debug): add debug role; map superpowers/wshobson debugging built-ins + external"
```

---

## Task 2: `classifyFailure` + `buildDiagnoseManifest`

**Files:** Create `src/diagnose.js`, `test/diagnose.test.js`

- [ ] **Step 1: Failing test `test/diagnose.test.js`**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, buildDiagnoseManifest } from "../src/diagnose.js";
import { validateManifest } from "../src/manifest.js";

test("classifyFailure: test/CI output -> ci", () => {
  assert.equal(classifyFailure("FAIL test/foo.test.js\n  at x.js:3").mode, "ci");
});
test("classifyFailure: prose symptom -> bug", () => {
  assert.equal(classifyFailure("the login button sometimes does nothing").mode, "bug");
});
test("classifyFailure: --ci flag forces ci", () => {
  assert.equal(classifyFailure("anything", { ci: true }).mode, "ci");
});
test("classifyFailure: empty throws", () => {
  assert.throws(() => classifyFailure("  "), /empty/);
});

const caps = { roles: {
  debug: { chosen: { id: "sp-debug", source: "builtin" }, recommendations: ["install wshobson debugging agents for debug"] },
  implement: { chosen: { id: "sp-debug", source: "builtin" }, recommendations: [] },
  "test-author": { chosen: { id: "sp-tdd", source: "builtin" }, recommendations: [] },
  "code-review": { chosen: { id: "superpowers", source: "installed" }, recommendations: [] }
}};

test("buildDiagnoseManifest produces a valid fix manifest", () => {
  const m = buildDiagnoseManifest(classifyFailure("x is null"), caps);
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  assert.deepEqual(m.plan.map(p => p.id), ["repro", "root-cause", "fix", "regression", "verify"]);
  assert.ok(m.crew.some(c => c.stage === "debug" && c.provider === "sp-debug"));
  assert.ok(m.recommendations.some(r => /wshobson/.test(r)));
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/diagnose.test.js`

- [ ] **Step 3: Implement `src/diagnose.js`**
```js
const CI_PATTERNS = [/\bFAIL\b/, /✗/, /Error:/, /\bassert/i, /exit code [1-9]/, /\bat .+:\d+/];

export function classifyFailure(input, opts = {}) {
  if (!input || !input.trim()) throw new Error("diagnose: empty failure input");
  const isCi = !!opts.ci || CI_PATTERNS.some(re => re.test(input));
  const firstLine = input.split("\n").map(s => s.trim()).filter(Boolean)[0] || input.trim();
  return { mode: isCi ? "ci" : "bug", signal: firstLine.slice(0, 200) };
}

function chosen(caps, role) {
  return (caps && caps.roles && caps.roles[role] && caps.roles[role].chosen) || { id: "inline", source: "inline" };
}

export function buildDiagnoseManifest(failure, caps = {}) {
  const stage = (role, rationale) => {
    const p = chosen(caps, role);
    return { stage: role, provider: p.id, source: p.source, rationale, evidence: `failure: ${failure.signal}`, fallback: "inline" };
  };
  const recs = [];
  for (const r of ["debug", "implement", "test-author", "code-review"])
    for (const rec of ((caps.roles && caps.roles[r] && caps.roles[r].recommendations) || []))
      if (!recs.includes(rec)) recs.push(rec);
  return {
    outcome: `Resolve: ${failure.signal}`,
    successCriteria: ["root cause identified", "fix applied", "regression test added", "suite green"],
    crew: [
      stage("debug", "systematic root-cause analysis"),
      stage("implement", "apply the minimal fix"),
      stage("test-author", "add a regression test"),
      stage("code-review", "review + verify the suite")
    ],
    recommendations: recs,
    degradations: [],
    plan: [
      { id: "repro", task: `reproduce: ${failure.signal}`, mode: "single", deps: [] },
      { id: "root-cause", task: "find root cause (hypothesis -> cheapest test -> root cause)", mode: "single", deps: ["repro"] },
      { id: "fix", task: "apply the minimal fix", mode: "single", deps: ["root-cause"] },
      { id: "regression", task: "add a regression test", mode: "single", deps: ["fix"] },
      { id: "verify", task: "review + run the suite", mode: "single", deps: ["regression"] }
    ]
  };
}
```

- [ ] **Step 4: Run → pass; `npm test` green. Commit**
```bash
git add src/diagnose.js test/diagnose.test.js
git commit -m "feat(diagnose): classifyFailure (ci/bug) + buildDiagnoseManifest (fix plan)"
```

---

## Task 3: CLI `muster diagnose`

**Files:** Modify `src/cli.js`

- [ ] **Step 1: Wire the branch** — add `import { classifyFailure, buildDiagnoseManifest } from "./diagnose.js";` (the catalog/harness/capabilities imports + `CATALOG_DIR`/`homedir` already exist). Add before the final `else`:
```js
  } else if (cmd === "diagnose") {
    const ciIdx = rest.indexOf("--ci");
    let input, ci = false;
    if (ciIdx >= 0) { ci = true; if (!rest[ciIdx + 1]) fail("diagnose --ci <file>: missing file"); input = await readFile(rest[ciIdx + 1], "utf8"); }
    else input = rest.join(" ");
    if (!input || !input.trim()) fail("diagnose <symptom> | --ci <file>: missing input");
    const failure = classifyFailure(input, { ci });
    const caps = resolveCapabilities(await loadCatalog(CATALOG_DIR), await readInstalled(homedir()));
    out({ mode: failure.mode, manifest: buildDiagnoseManifest(failure, caps) });
```
Update the usage string to include `diagnose <symptom>|--ci <file>`.

- [ ] **Step 2: Smoke (paste output)**
- `node src/cli.js diagnose "the login button sometimes does nothing"` → `mode: "bug"`, manifest with debug stage resolving to a builtin (sp-debug/wsh-debugging-strategies).
- `printf 'FAIL test/x.test.js\n at y.js:9\n' > /tmp/ci.txt && node src/cli.js diagnose --ci /tmp/ci.txt` → `mode: "ci"`.
- `node src/cli.js diagnose` → friendly error + exit 1.

- [ ] **Step 3: `npm test` green. Commit**
```bash
git add src/cli.js
git commit -m "feat(cli): muster diagnose (bug + --ci modes)"
```

---

## Task 4: diagnose skill + command

**Files:** Create `plugin/commands/diagnose.md`, `plugin/skills/diagnose/SKILL.md` (auto-discovered — no plugin.json edit)

- [ ] **Step 1: Create `plugin/commands/diagnose.md`**
```markdown
---
name: diagnose
description: Failure-first bug fix. Usage: /muster:diagnose <symptom>  (or paste failing test/CI output)
---

The failure: `$ARGUMENTS`

If empty, ask for a symptom or failing output and stop. Otherwise invoke the **diagnose** skill with it.
```

- [ ] **Step 2: Create `plugin/skills/diagnose/SKILL.md`**
```markdown
---
name: diagnose
description: Failure-first workflow — reproduce, find root cause via systematic debugging, fix, add a regression test, verify. No symptom-patching.
---

# Diagnose

Input: a failure (a freeform symptom, or pasted failing test/CI output).

1. **Seed**: `npx muster diagnose "<symptom>"` (or `--ci <file>` for pasted output) → `{mode, manifest}`.
   Write the manifest to `.muster/manifest.json`; validate (`npx muster manifest validate`).
2. **Reproduce** (plan: `repro`) — confirm the failure reproduces. If it can't be reproduced, report and stop.
3. **Root cause** (plan: `root-cause`, role `debug`) — dispatch the chosen `debug` provider (an installed
   wshobson/external debugger if present, else the built-in systematic-debugging). Produce a HYPOTHESIS
   TABLE → cheapest test first → the root cause. Record it in STATE. **Do not proceed without a root cause** (no symptom-patching).
4. **Fix** (plan: `fix`, role `implement`) — apply the minimal fix targeting the root cause.
5. **Regression** (plan: `regression`, role `test-author`) — add a test that fails before the fix and
   passes after (the proof). Outcome-anchored: a fix without a regression test is not done.
6. **Verify** (plan: `verify`, role `code-review`) — run the **review-gate** + the full suite; it must be green.
   Use `npx muster plan-checklist .muster/manifest.json --done <ids>` to tick progress into STATE.
7. Escalate if the root cause can't be found or the gate can't pass within the cap. Then present merge.

This reuses the orchestrator + review-gate; glass box records hypotheses, the chosen debug provider, and the root cause.
```

- [ ] **Step 3: Validate plugin still loads + commit**
Run: `node -e "JSON.parse(require('fs').readFileSync('plugin/.claude-plugin/plugin.json','utf8')); console.log('ok')"` (unchanged, still 3-field). `npm test` green.
```bash
git add plugin/commands/diagnose.md plugin/skills/diagnose/
git commit -m "feat(skills): diagnose skill + /muster:diagnose command"
```

---

## Task 5: Integration test + README

**Files:** Create `test/integration.slice6.test.js`; modify `README.md`

- [ ] **Step 1: Write the integration test**
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyFailure, buildDiagnoseManifest } from "../src/diagnose.js";
import { validateManifest } from "../src/manifest.js";
import { computeWaves } from "../src/wave.js";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { readInstalled } from "../src/harness.js";
import { tmpProject } from "./helpers.js";

test("a bug symptom seeds a valid, schedulable fix plan with a real debug provider", async () => {
  const home = await tmpProject({}); // bare machine
  const caps = resolveCapabilities(await loadCatalog(new URL("../catalog/", import.meta.url)), await readInstalled(home));
  // debug role resolves to a built-in, not inline
  assert.equal(caps.roles["debug"].chosen.source, "builtin");

  const m = buildDiagnoseManifest(classifyFailure("users report a null pointer on checkout"), caps);
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  const waves = computeWaves(m.plan).map(w => w.map(t => t.id));
  assert.deepEqual(waves, [["repro"], ["root-cause"], ["fix"], ["regression"], ["verify"]]);
  assert.equal(m.crew.find(c => c.stage === "debug").source, "builtin");
});
```

- [ ] **Step 2: Run full suite — paste summary (green)**

- [ ] **Step 3: README + commit**
Append to `README.md`:
```markdown

Diagnose (bug fix): `/muster:diagnose <symptom>` (or paste failing output) → reproduce → root cause (systematic debugging, via the best available `debug` provider) → fix → regression test → verify. `npx muster diagnose` seeds the fix plan. Design: `docs/design/2026-06-07-muster-v6-diagnose.md`
```
```bash
git add test/integration.slice6.test.js README.md
git commit -m "test(integration): bug symptom -> valid fix plan -> ordered waves w/ debug provider"
```

---

## Self-review (completed)
- **Spec coverage:** debug role (§3) → Task 1; classifyFailure (§4) + buildDiagnoseManifest (§5) → Task 2;
  CLI (§6) → Task 3; diagnose skill+command (§6) → Task 4; integration (§4-6) → Task 5. Deferred
  (tournament root-cause, CI-provider fetch) absent.
- **Placeholder scan:** deterministic steps carry full code; skills carry exact markdown. No TBD.
- **Type consistency:** buildDiagnoseManifest output matches the slice-1 manifest schema (validateManifest);
  plan task `{id,task,mode,deps}` consumed by computeWaves; `debug` role added to ROLES is consumed by
  resolveCapabilities + the manifest crew; classifyFailure `{mode,signal}` consumed by buildDiagnoseManifest.

## Notes for the executor
- Branch off `master` first.
- Task 1 edits the GENERATED `builtins.generated.yaml` directly (to avoid a full re-vendor/re-clone) AND
  the `vendor/manifest.yaml` source so a future `muster vendor` stays correct. Keep both in sync.
- Confirm `implement` role still resolves after adding `debug` to sp-debug (keep `implement` in its roles).
