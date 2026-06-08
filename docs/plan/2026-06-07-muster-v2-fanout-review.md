# Muster slice 2 — Concurrent fan-out + adversarial review — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Turn the slice-1 Crew Manifest plan into concurrent, self-checking execution — a deterministic wave scheduler, review tally, and tournament winner-pick in the CLI, plus orchestration skills that drive wave-based fan-out (single + tournament) and an adversarial review gate.

**Architecture:** Extend the existing Node ESM CLI with pure TDD-able functions (`computeWaves`, `tallyReview`, `pickWinner`, run-record helpers) and wire them as subcommands. Add orchestration skills (markdown) that drive the harness Agent tool per wave. Tournaments score candidates against the run's success criteria; the review gate blocks on any blocker with a capped fix-loop.

**Tech Stack:** Same as slice 1 — Node ≥ 20 ESM, `node:test`, dep `yaml`. No new deps. Apache-2.0.

**Source of truth:** `docs/design/2026-06-07-muster-v2-fanout-review.md`. Builds on slice-1 modules in `src/`.

**Plan location note:** `docs/plan/` (parallels `docs/design/`).

---

## File structure (additions)

```
src/
  wave.js          # computeWaves(plan) -> waves[][]            (new)
  review.js        # tallyReview(verdicts) -> {blocked,...}     (new)
  tournament.js    # pickWinner(candidates) -> {winner,...}     (new)
  memory.js        # + appendState(), appendFollowup()          (extend)
  manifest.js      # + id/deps validation on plan tasks         (extend)
  cli.js           # + wave/tally/pick subcommands              (extend)
plugin/skills/
  orchestrator/SKILL.md   # wave executor                       (new)
  tournament/SKILL.md     # N approaches -> judge -> pick       (new)
  review-gate/SKILL.md    # parallel reviewers -> tally -> loop (new)
plugin/skills/router/SKILL.md   # emit id + deps on plan tasks  (extend)
test/
  wave.test.js  review.test.js  tournament.test.js
  runrecord.test.js  manifest.slice2.test.js  integration.slice2.test.js
```

**Shared shapes (slice 2):**
```js
// plan task (manifest):     { id: string, task: string, mode: "single"|"tournament", deps?: string[], note?: string }  // deps optional; omitted == []
// wave output:              waves: Array<Array<planTask>>   // wave k: all deps satisfied by waves < k
// reviewer verdict:         { reviewer: string, findings: [{ severity: "blocker"|"risk"|"nit", note: string }] }
// tally output:             { blocked: boolean, blockers: [{reviewer,note}], counts: {blocker,risk,nit} }
// tournament candidate:     { id: string, scores: {[criterion]: number}, total: number, passing: boolean }
// pick output:              { winner: string|null, escalate: boolean, ranking: [{id,total,passing}] }
```

---

## Task 1: Manifest — validate plan task `id` + `deps`

**Files:** Modify `src/manifest.js`; Create `test/manifest.slice2.test.js`

- [ ] **Step 1: Write failing test `test/manifest.slice2.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";

const base = {
  outcome: "x", successCriteria: ["c"],
  crew: [{ stage: "s", provider: "p", source: "builtin", rationale: "r", evidence: "e", fallback: "inline" }],
  recommendations: [], degradations: []
};

test("accepts multi-task plan with unique ids + valid deps", () => {
  const m = { ...base, plan: [
    { id: "a", task: "A", mode: "single", deps: [] },
    { id: "b", task: "B", mode: "tournament", deps: ["a"] }
  ]};
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});

test("rejects duplicate ids", () => {
  const m = { ...base, plan: [
    { id: "a", task: "A", mode: "single", deps: [] },
    { id: "a", task: "B", mode: "single", deps: [] }
  ]};
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /duplicate id/.test(e)));
});

test("rejects deps referencing unknown id", () => {
  const m = { ...base, plan: [{ id: "a", task: "A", mode: "single", deps: ["ghost"] }] };
  const r = validateManifest(m);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /unknown dep/.test(e)));
});

test("slice-1 back-compat: single task without id/deps still valid", () => {
  const m = { ...base, plan: [{ task: "only", mode: "single" }] };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/manifest.slice2.test.js`
Expected: FAIL (duplicate/unknown-dep not yet enforced).

- [ ] **Step 3: Extend `src/manifest.js` plan validation**

Replace the existing `plan` validation block with:

```js
  if (!Array.isArray(m.plan) || m.plan.length === 0) errors.push("plan: required non-empty array");
  else {
    const ids = new Set();
    const multi = m.plan.length > 1;
    m.plan.forEach((p, i) => {
      if (!p.task) errors.push(`plan[${i}].task: required`);
      if (!MODES.has(p.mode)) errors.push(`plan[${i}].mode: must be single|tournament`);
      if (multi && !p.id) errors.push(`plan[${i}].id: required when plan has multiple tasks`);
      if (p.id) { if (ids.has(p.id)) errors.push(`plan[${i}].id: duplicate id "${p.id}"`); ids.add(p.id); }
      if (p.deps !== undefined && !Array.isArray(p.deps)) errors.push(`plan[${i}].deps: must be an array`);
    });
    // deps must reference existing ids
    m.plan.forEach((p, i) => {
      for (const d of (p.deps || [])) if (!ids.has(d)) errors.push(`plan[${i}].deps: unknown dep "${d}"`);
    });
  }
```

(Keep the rest of `validateManifest` unchanged.)

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/manifest.slice2.test.js` → 4 pass. Then `npm test` (full suite green; slice-1 manifest tests still pass).

- [ ] **Step 5: Commit**

```bash
git add src/manifest.js test/manifest.slice2.test.js
git commit -m "feat(manifest): validate plan task id + deps (slice-1 back-compat)"
```

---

## Task 2: `computeWaves` — deterministic wave scheduler

**Files:** Create `src/wave.js`, `test/wave.test.js`

- [ ] **Step 1: Write failing test `test/wave.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeWaves } from "../src/wave.js";

const ids = waves => waves.map(w => w.map(t => t.id));

test("no deps -> single wave", () => {
  const w = computeWaves([{ id: "a", deps: [] }, { id: "b", deps: [] }]);
  assert.deepEqual(ids(w), [["a", "b"]]);
});

test("linear chain -> one task per wave", () => {
  const w = computeWaves([{ id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["b"] }]);
  assert.deepEqual(ids(w), [["a"], ["b"], ["c"]]);
});

test("diamond -> middle pair shares a wave", () => {
  const w = computeWaves([
    { id: "a", deps: [] }, { id: "b", deps: ["a"] }, { id: "c", deps: ["a"] }, { id: "d", deps: ["b", "c"] }
  ]);
  assert.deepEqual(ids(w), [["a"], ["b", "c"], ["d"]]);
});

test("cycle -> throws", () => {
  assert.throws(() => computeWaves([{ id: "a", deps: ["b"] }, { id: "b", deps: ["a"] }]), /cycle/i);
});

test("missing dep -> throws", () => {
  assert.throws(() => computeWaves([{ id: "a", deps: ["ghost"] }]), /unknown dep/i);
});

test("missing deps field defaults to no deps", () => {
  const w = computeWaves([{ id: "a" }, { id: "b" }]);
  assert.deepEqual(ids(w), [["a", "b"]]);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/wave.test.js` → FAIL (module missing).

- [ ] **Step 3: Implement `src/wave.js`**

```js
// Group tasks into dependency-ordered waves (Kahn-style level assignment).
// Input: tasks [{ id, deps?: string[] , ... }]. Output: Array<Array<task>> preserving input order within a wave.
export function computeWaves(tasks) {
  const byId = new Map();
  for (const t of tasks) byId.set(t.id, t);
  for (const t of tasks) for (const d of (t.deps || [])) {
    if (!byId.has(d)) throw new Error(`unknown dep "${d}" referenced by "${t.id}"`);
  }

  const done = new Set();
  const waves = [];
  let remaining = tasks.slice();

  while (remaining.length) {
    const ready = remaining.filter(t => (t.deps || []).every(d => done.has(d)));
    if (ready.length === 0) throw new Error("cycle detected in task deps");
    waves.push(ready);
    for (const t of ready) done.add(t.id);
    remaining = remaining.filter(t => !done.has(t.id));
  }
  return waves;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/wave.test.js` → 6 pass.

- [ ] **Step 5: Commit**

```bash
git add src/wave.js test/wave.test.js
git commit -m "feat(wave): deterministic dependency-ordered wave scheduler"
```

---

## Task 3: `tallyReview` — review-gate decision

**Files:** Create `src/review.js`, `test/review.test.js`

- [ ] **Step 1: Write failing test `test/review.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tallyReview } from "../src/review.js";

test("no blockers -> not blocked, counts tallied", () => {
  const r = tallyReview([
    { reviewer: "x", findings: [{ severity: "nit", note: "n" }, { severity: "risk", note: "r" }] }
  ]);
  assert.equal(r.blocked, false);
  assert.deepEqual(r.counts, { blocker: 0, risk: 1, nit: 1 });
});

test("any blocker (single reviewer) -> blocked, lists it", () => {
  const r = tallyReview([
    { reviewer: "a", findings: [{ severity: "nit", note: "n" }] },
    { reviewer: "b", findings: [{ severity: "blocker", note: "boom" }] }
  ]);
  assert.equal(r.blocked, true);
  assert.deepEqual(r.blockers, [{ reviewer: "b", note: "boom" }]);
  assert.equal(r.counts.blocker, 1);
});

test("empty verdicts -> not blocked, zero counts", () => {
  assert.deepEqual(tallyReview([]), { blocked: false, blockers: [], counts: { blocker: 0, risk: 0, nit: 0 } });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/review.test.js` → FAIL.

- [ ] **Step 3: Implement `src/review.js`**

```js
// Adversarial gate: ANY blocker (from any reviewer) blocks. Not majority.
export function tallyReview(verdicts) {
  const counts = { blocker: 0, risk: 0, nit: 0 };
  const blockers = [];
  for (const v of verdicts) {
    for (const f of (v.findings || [])) {
      if (counts[f.severity] !== undefined) counts[f.severity] += 1;
      if (f.severity === "blocker") blockers.push({ reviewer: v.reviewer, note: f.note });
    }
  }
  return { blocked: blockers.length > 0, blockers, counts };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/review.test.js` → 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/review.js test/review.test.js
git commit -m "feat(review): adversarial tally — any blocker blocks the wave"
```

---

## Task 4: `pickWinner` — tournament winner selection

**Files:** Create `src/tournament.js`, `test/tournament.test.js`

- [ ] **Step 1: Write failing test `test/tournament.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { pickWinner } from "../src/tournament.js";

test("highest passing total wins", () => {
  const r = pickWinner([
    { id: "a", total: 7, passing: true },
    { id: "b", total: 9, passing: true },
    { id: "c", total: 10, passing: false }
  ]);
  assert.equal(r.winner, "b");
  assert.equal(r.escalate, false);
  assert.deepEqual(r.ranking.map(x => x.id), ["c", "b", "a"]); // ranking by total desc, all candidates
});

test("none passing -> escalate, no winner", () => {
  const r = pickWinner([{ id: "a", total: 3, passing: false }, { id: "b", total: 4, passing: false }]);
  assert.equal(r.winner, null);
  assert.equal(r.escalate, true);
});

test("empty -> escalate", () => {
  assert.deepEqual(pickWinner([]), { winner: null, escalate: true, ranking: [] });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/tournament.test.js` → FAIL.

- [ ] **Step 3: Implement `src/tournament.js`**

```js
// Pick the highest-scoring PASSING candidate. None passing -> escalate.
export function pickWinner(candidates) {
  const ranking = candidates
    .map(c => ({ id: c.id, total: c.total, passing: !!c.passing }))
    .sort((a, b) => b.total - a.total);
  const passing = ranking.filter(c => c.passing);
  if (passing.length === 0) return { winner: null, escalate: true, ranking };
  return { winner: passing[0].id, escalate: false, ranking };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/tournament.test.js` → 3 pass.

- [ ] **Step 5: Commit**

```bash
git add src/tournament.js test/tournament.test.js
git commit -m "feat(tournament): pick highest passing candidate, else escalate"
```

---

## Task 5: Run records — `appendState` + `appendFollowup`

**Files:** Modify `src/memory.js`; Create `test/runrecord.test.js`

- [ ] **Step 1: Write failing test `test/runrecord.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendState, appendFollowup } from "../src/memory.js";

async function dir() { return mkdtemp(join(tmpdir(), "muster-rr-")); }

test("appendState appends ordered lines to a run STATE file", async () => {
  const d = await dir();
  await appendState(d, "run1", "wave 0 started");
  await appendState(d, "run1", "wave 0 passed review");
  const md = await readFile(join(d, "run1.state.md"), "utf8");
  const lines = md.trim().split("\n");
  assert.match(lines[0], /wave 0 started/);
  assert.match(lines[1], /wave 0 passed review/);
});

test("appendFollowup records non-blocking findings", async () => {
  const d = await dir();
  await appendFollowup(d, "run1", { severity: "risk", note: "magic number" });
  const md = await readFile(join(d, "run1.followups.md"), "utf8");
  assert.match(md, /risk/);
  assert.match(md, /magic number/);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/runrecord.test.js` → FAIL (functions not exported).

- [ ] **Step 3: Add to `src/memory.js`** (append these exports; keep existing `writeMemory`/`readMemory`)

```js
import { appendFile } from "node:fs/promises";
// (existing imports already include mkdir, join)

export async function appendState(dir, runId, line) {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.state.md`), line.replace(/\n/g, " ") + "\n");
}

export async function appendFollowup(dir, runId, finding) {
  await mkdir(dir, { recursive: true });
  await appendFile(join(dir, `${runId}.followups.md`), `- [${finding.severity}] ${finding.note}\n`);
}
```

(If `appendFile`/`mkdir` aren't already imported at the top of `src/memory.js`, add them to the existing `node:fs/promises` import line rather than duplicating the import.)

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/runrecord.test.js` → 2 pass. Then `npm test` full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/memory.js test/runrecord.test.js
git commit -m "feat(memory): run-record STATE (append-only) + FOLLOWUPS helpers"
```

---

## Task 6: CLI subcommands `wave` / `tally` / `pick`

**Files:** Modify `src/cli.js`

- [ ] **Step 1: Add imports + branches to `src/cli.js`**

Add imports near the top (with the other `import` lines):

```js
import { computeWaves } from "./wave.js";
import { tallyReview } from "./review.js";
import { pickWinner } from "./tournament.js";
```

Add these branches inside the `try` dispatch (before the final `else`):

```js
  } else if (cmd === "wave") {
    if (!rest[0]) fail("wave <manifest.json>: missing file path");
    const m = JSON.parse(await readFile(rest[0], "utf8"));
    out(computeWaves(m.plan || []));
  } else if (cmd === "tally") {
    if (!rest[0]) fail("tally <verdicts.json>: missing file path");
    out(tallyReview(JSON.parse(await readFile(rest[0], "utf8"))));
  } else if (cmd === "pick") {
    if (!rest[0]) fail("pick <candidates.json>: missing file path");
    out(pickWinner(JSON.parse(await readFile(rest[0], "utf8"))));
```

Update the usage string in the final `else`'s `fail(...)` to include the new commands:
`Usage: muster <detect|capabilities|manifest validate <file>|wave <file>|tally <file>|pick <file>|memory read|write ...>`

- [ ] **Step 2: Smoke-run with fixtures**

Create `test/fixtures/plan.diamond.json`:
```json
{ "plan": [
  { "id": "a", "task": "A", "mode": "single", "deps": [] },
  { "id": "b", "task": "B", "mode": "single", "deps": ["a"] },
  { "id": "c", "task": "C", "mode": "tournament", "deps": ["a"] },
  { "id": "d", "task": "D", "mode": "single", "deps": ["b", "c"] }
] }
```
Run: `node src/cli.js wave test/fixtures/plan.diamond.json`
Expected: 3 waves — `[[a],[b,c],[d]]` (as arrays of task objects).
Run: `node src/cli.js wave; echo "exit=$?"` → friendly error + exit 1.

- [ ] **Step 3: Full suite green**

Run: `npm test` (no new unit tests for cli; existing all pass).

- [ ] **Step 4: Commit**

```bash
git add src/cli.js test/fixtures/plan.diamond.json
git commit -m "feat(cli): wave/tally/pick subcommands"
```

---

## Task 7: Orchestration skills + router emits id/deps

**Files:** Create `plugin/skills/orchestrator/SKILL.md`, `plugin/skills/tournament/SKILL.md`, `plugin/skills/review-gate/SKILL.md`; Modify `plugin/skills/router/SKILL.md`, `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Create `plugin/skills/orchestrator/SKILL.md`**

```markdown
---
name: orchestrator
description: Execute a validated Crew Manifest in dependency-ordered waves, with a barrier + adversarial review gate between waves. Glass-box: every wave/decision appended to the run STATE.
---

# Orchestrator (wave executor)

Inputs: a validated `.muster/manifest.json` and a `runId` (e.g. a slug of the outcome).

1. Compute waves: `npx muster wave .muster/manifest.json` → ordered list of waves.
2. For each wave, in order:
   a. Dispatch every task in the wave **concurrently** (use the harness Agent tool):
      - `mode: single` → one implementer agent, given the task + the Crew Manifest as BRIEF.
      - `mode: tournament` → invoke the **tournament** skill for that task.
   b. BARRIER: wait for all wave tasks to finish.
   c. Invoke the **review-gate** skill over the wave's changes.
   d. Append a STATE line: `npx muster memory write`-adjacent — append via the run STATE
      (`<runId>.state.md`) using the memory append; record wave index, tasks, winners, review result.
   e. If the review gate escalates, stop and report to the user (do not start the next wave).
3. After the last wave, summarize the run and ensure FOLLOWUPS are recorded.

Iron rules: never start wave k+1 before wave k passes the gate; never silently drop a failed task
(record it in STATE); keep the manifest the single source (spec-as-current-truth).
```

- [ ] **Step 2: Create `plugin/skills/tournament/SKILL.md`**

```markdown
---
name: tournament
description: Run a competing-solutions tournament for one high-uncertainty task — N approach agents, a judge scoring each against the run's success criteria, then deterministic winner selection.
---

# Tournament

Inputs: the task, the Crew Manifest (for `successCriteria`), and N (default 3).

1. Dispatch N implementer agents **concurrently**, each instructed to take a DISTINCT approach to the
   task (vary the angle: e.g. minimal, robust, performance-first).
2. Dispatch a judge agent: score EACH candidate against every item in `successCriteria`, evidence-cited
   (no bare ratings). Produce a candidates array: `[{ id, scores: {criterion: n}, total, passing }]`
   where `passing` means no criterion critically fails (the floor principle).
3. Write the candidates to `.muster/candidates.json` and run `npx muster pick .muster/candidates.json`.
4. If `escalate` is true (none passing), report to the orchestrator (do not ship a loser).
   Otherwise adopt the `winner`'s changes and discard the others.
5. Append the per-candidate scores + winner to the run STATE (glass box).
```

- [ ] **Step 3: Create `plugin/skills/review-gate/SKILL.md`**

```markdown
---
name: review-gate
description: Adversarial review gate for a completed wave — dispatch all available reviewers in parallel, tally verdicts, and loop fixes until clean or escalate.
---

# Review gate

Inputs: the wave's changes, and `AvailableCapabilities` (from `npx muster capabilities`).

1. Select reviewers: the chosen providers for roles `code-review` and `security-review`. If none are
   installed, use the built-in reviewer. Always at least one.
2. Dispatch reviewers **concurrently**, each adversarially prompted to REFUTE the work / find the worst
   real problem. Each returns findings: `[{ severity: "blocker"|"risk"|"nit", note }]`.
3. Write verdicts to `.muster/verdicts.json`; run `npx muster tally .muster/verdicts.json`.
4. If `blocked`: re-dispatch the implementer with the blocker notes, then re-review. Cap at 3
   iterations. If still blocked after the cap, ESCALATE to the human with the unresolved blockers.
5. Carry `risk`/`nit` findings to FOLLOWUPS (non-blocking). Return pass/escalate to the orchestrator.
```

- [ ] **Step 4: Update `plugin/skills/router/SKILL.md`** — make the router emit `id` + `deps`

In the router skill's "Plan annotations" rule and Output shape, change the plan task shape to include
`id` and `deps`. Replace the plan bullet with:

```markdown
- **Plan annotations.** Decompose the outcome into `plan` tasks; give each a short unique `id`, list
  its `deps` (ids it must follow), and tag `mode` `single` (well-known) or `tournament` (high-uncertainty
  / quality-critical). Independent tasks share `deps: []` so they run in the same wave.
```

And update the Output JSON example's plan to:
`"plan": [{ "id": "t1", "task": "...", "mode": "single", "deps": [] }]`

- [ ] **Step 5: Register the new skills in `plugin/.claude-plugin/plugin.json`**

Update the `skills` array to:
```json
  "skills": [
    "skills/router/SKILL.md",
    "skills/orchestrator/SKILL.md",
    "skills/tournament/SKILL.md",
    "skills/review-gate/SKILL.md"
  ]
```

- [ ] **Step 6: Sanity + commit**

Run: `npm test` (full suite still green — these are markdown/JSON, no code change).
Validate plugin.json parses: `node -e "JSON.parse(require('fs').readFileSync('plugin/.claude-plugin/plugin.json','utf8')); console.log('ok')"`

```bash
git add plugin/
git commit -m "feat(skills): orchestrator + tournament + review-gate; router emits id/deps"
```

---

## Task 8: Integration test (manifest -> waves -> tally/pick)

**Files:** Create `test/integration.slice2.test.js`

- [ ] **Step 1: Write the integration test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";
import { computeWaves } from "../src/wave.js";
import { tallyReview } from "../src/review.js";
import { pickWinner } from "../src/tournament.js";

test("a valid diamond manifest schedules into 3 waves", () => {
  const m = {
    outcome: "ship feature", successCriteria: ["tests green"],
    crew: [{ stage: "implement", provider: "muster-builder", source: "builtin",
             rationale: "r", evidence: "e", fallback: "inline" }],
    recommendations: [], degradations: [],
    plan: [
      { id: "a", task: "scaffold", mode: "single", deps: [] },
      { id: "b", task: "api", mode: "single", deps: ["a"] },
      { id: "c", task: "auth", mode: "tournament", deps: ["a"] },
      { id: "d", task: "wire", mode: "single", deps: ["b", "c"] }
    ]
  };
  assert.deepEqual(validateManifest(m), { ok: true, errors: [] });
  const waves = computeWaves(m.plan).map(w => w.map(t => t.id));
  assert.deepEqual(waves, [["a"], ["b", "c"], ["d"]]);
});

test("review gate blocks then a tournament resolves a winner", () => {
  const gate = tallyReview([
    { reviewer: "builtin", findings: [{ severity: "blocker", note: "missing validation" }] }
  ]);
  assert.equal(gate.blocked, true);

  const pick = pickWinner([
    { id: "approach-A", total: 6, passing: true },
    { id: "approach-B", total: 8, passing: true },
    { id: "approach-C", total: 9, passing: false }
  ]);
  assert.equal(pick.winner, "approach-B");
  assert.equal(pick.escalate, false);
});
```

- [ ] **Step 2: Run full suite**

Run: `npm test`
Expected: all slice-1 + slice-2 tests pass, 0 failures.

- [ ] **Step 3: Update README pointer + commit**

Append to `README.md` under the CLI line:
```markdown

Slice 2 (fan-out + review): `npx muster wave <manifest> | tally <verdicts> | pick <candidates>`
Design: `docs/design/2026-06-07-muster-v2-fanout-review.md`
```

```bash
git add test/integration.slice2.test.js README.md
git commit -m "test(integration): slice-2 manifest->waves + gate/tournament end-to-end"
```

---

## Self-review (completed)

- **Spec coverage:** `muster wave`/computeWaves (§4) → Task 2; `tally` (§4) → Task 3; `pick` (§4) →
  Task 4; run records (§4) → Task 5; manifest id/deps (§5) → Task 1; CLI wiring → Task 6;
  orchestration/tournament/review-gate skills (§6) → Task 7; glass-box STATE recording (§7) → skills
  in Task 7 + Task 5 helpers; degradation (§8: none-passing→escalate, any-blocker→block, cycle→throw)
  → Tasks 2/3/4. Deferred items (synthesis, autopilot, domains) intentionally absent.
- **Placeholder scan:** every code step has runnable code; commands show expected output. No TBD.
- **Type consistency:** plan task `{id,task,mode,deps}` consistent across manifest validator (Task 1),
  computeWaves (Task 2), router skill output (Task 7), and both integration tests. verdict/candidate
  shapes consistent across review.js/tournament.js and their tests. CLI imports match new module
  exports (`computeWaves`, `tallyReview`, `pickWinner`).

## Notes for the executor
- Branch off `master` before starting (do not implement on master).
- The skills (Task 7) are markdown the harness reads at runtime; they are not unit-tested — the
  deterministic functions they call (wave/tally/pick) are the tested core.
- Keep `tallyReview` adversarial (any blocker blocks) — do NOT switch to majority.
