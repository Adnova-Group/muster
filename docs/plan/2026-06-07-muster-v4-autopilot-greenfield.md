# Muster slice 4 — Autopilot + greenfield — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Tie slices 1–3 into hands-off full-lifecycle execution — deterministic project scaffold + checkbox-progress rendering in the CLI, plus autopilot + greenfield orchestration skills.

**Architecture:** New deterministic modules `src/setup.js` (`scaffoldProject`) and `src/checklist.js` (`renderPlanChecklist`) — unit-tested; wired as `muster setup` / `muster plan-checklist`. Orchestration is markdown skills (autopilot, greenfield) that drive the harness and reuse the slice-2 orchestrator + slice-1 router.

**Tech Stack:** Node ≥ 20 ESM, `node:test`, dep `yaml`. Apache-2.0.

**Source of truth:** `docs/design/2026-06-07-muster-v4-autopilot-greenfield.md`.

---

## File structure (additions)

```
src/setup.js                      # scaffoldProject(dir) -> {created,skipped}        (new)
src/checklist.js                  # renderPlanChecklist(plan, doneIds) -> md         (new)
src/cli.js                        # + setup / plan-checklist subcommands             (modify)
plugin/commands/autopilot.md      # /muster-autopilot <outcome>                      (new)
plugin/skills/autopilot/SKILL.md  # hands-off driver                                 (new)
plugin/skills/greenfield/SKILL.md # empty-dir bootstrap                              (new)
plugin/skills/orchestrator/SKILL.md # + tick checklist into STATE per wave           (modify)
plugin/.claude-plugin/plugin.json # register new command + skills                    (modify)
test/setup.test.js  test/checklist.test.js  test/integration.slice4.test.js
```

---

## Task 1: `scaffoldProject` + `muster setup`

**Files:** Create `src/setup.js`, `test/setup.test.js`; modify `src/cli.js`

- [ ] **Step 1: Failing test `test/setup.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "./helpers.js";
import { scaffoldProject } from "../src/setup.js";

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

test("scaffoldProject creates missing files on an empty dir", async () => {
  const dir = await tmpProject({});
  const r = await scaffoldProject(dir);
  assert.ok(r.created.includes("README.md"));
  assert.ok(r.created.includes(".gitignore"));
  assert.ok(r.created.includes("AGENTS.md"));
  assert.ok(await exists(join(dir, "docs/design")));
});

test("scaffoldProject never overwrites existing files", async () => {
  const dir = await tmpProject({ "README.md": "ORIGINAL" });
  const r = await scaffoldProject(dir);
  assert.ok(r.skipped.includes("README.md"));
  assert.equal(await readFile(join(dir, "README.md"), "utf8"), "ORIGINAL");
});

test("scaffoldProject is idempotent (second run creates nothing)", async () => {
  const dir = await tmpProject({});
  await scaffoldProject(dir);
  const r2 = await scaffoldProject(dir);
  assert.equal(r2.created.length, 0);
});
```

- [ ] **Step 2: Run → FAIL** — `node --test test/setup.test.js`

- [ ] **Step 3: Implement `src/setup.js`**

```js
import { mkdir, writeFile, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
const pexec = promisify(execFile);
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const SEEDS = {
  ".gitignore": "node_modules/\n.muster/\n*.log\n",
  "docs/design/.gitkeep": "",
  "docs/plan/.gitkeep": "",
  "README.md": "# Project\n\nScaffolded by muster.\n",
  "AGENTS.md": "# Agents\n\nThis repository is managed with muster.\n"
};

export async function scaffoldProject(dir) {
  const created = [], skipped = [];
  if (!(await exists(join(dir, ".git")))) {
    try { await pexec("git", ["init", "-q"], { cwd: dir }); created.push(".git"); } catch { /* git absent */ }
  } else skipped.push(".git");

  for (const [rel, content] of Object.entries(SEEDS)) {
    const abs = join(dir, rel);
    if (await exists(abs)) { skipped.push(rel); continue; }
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content);
    created.push(rel);
  }
  return { created, skipped };
}
```

- [ ] **Step 4: Wire `muster setup` in `src/cli.js`** — add `import { scaffoldProject } from "./setup.js";` and a branch before the final `else`:

```js
  } else if (cmd === "setup") {
    out(await scaffoldProject(rest[0] || process.cwd()));
```
Update the usage string to include `setup [dir]`.

- [ ] **Step 5: Run → 3 pass; `npm test` green. Commit**

```bash
git add src/setup.js src/cli.js test/setup.test.js
git commit -m "feat(setup): scaffoldProject + muster setup (create-if-missing)"
```

---

## Task 2: `renderPlanChecklist` + `muster plan-checklist`

**Files:** Create `src/checklist.js`, `test/checklist.test.js`; modify `src/cli.js`

- [ ] **Step 1: Failing test `test/checklist.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPlanChecklist } from "../src/checklist.js";

const plan = [
  { id: "a", task: "scaffold CRUD", mode: "single" },
  { id: "b", task: "token store", mode: "tournament" }
];

test("renders checkboxes; ticks done; annotates tournament", () => {
  const md = renderPlanChecklist(plan, ["a"]);
  assert.match(md, /- \[x\] a — scaffold CRUD/);
  assert.match(md, /- \[ \] b — token store \(tournament\)/);
});

test("no done ids -> all unchecked", () => {
  assert.match(renderPlanChecklist(plan), /- \[ \] a — scaffold CRUD/);
});

test("empty plan -> empty string", () => {
  assert.equal(renderPlanChecklist([]), "");
});
```

- [ ] **Step 2: Run → FAIL**

- [ ] **Step 3: Implement `src/checklist.js`**

```js
export function renderPlanChecklist(plan, doneIds = []) {
  const done = new Set(doneIds);
  return plan
    .map(t => `- [${done.has(t.id) ? "x" : " "}] ${t.id} — ${t.task}${t.mode === "tournament" ? " (tournament)" : ""}`)
    .join("\n");
}
```

- [ ] **Step 4: Wire `muster plan-checklist` in `src/cli.js`** — add `import { renderPlanChecklist } from "./checklist.js";` and a branch:

```js
  } else if (cmd === "plan-checklist") {
    if (!rest[0]) fail("plan-checklist <manifest.json> [--done a,b]: missing file path");
    const m = JSON.parse(await readFile(rest[0], "utf8"));
    const di = rest.indexOf("--done");
    const done = di >= 0 && rest[di + 1] ? rest[di + 1].split(",") : [];
    process.stdout.write(renderPlanChecklist(m.plan || [], done) + "\n");
```
Update the usage string to include `plan-checklist <file>`.

- [ ] **Step 5: Smoke**

Run: `node src/cli.js plan-checklist test/fixtures/plan.diamond.json --done a`
Expected: `- [x] a — A`, then `- [ ] b — B`, etc.

- [ ] **Step 6: Run → 3 pass; `npm test` green. Commit**

```bash
git add src/checklist.js src/cli.js test/checklist.test.js
git commit -m "feat(checklist): renderPlanChecklist + muster plan-checklist (ticking progress)"
```

---

## Task 3: Greenfield bootstrap skill

**Files:** Create `plugin/skills/greenfield/SKILL.md`

- [ ] **Step 1: Create `plugin/skills/greenfield/SKILL.md`**

```markdown
---
name: greenfield
description: Bootstrap a brand-new project when the target is empty — brainstorm, plan, scaffold, re-detect — before any implementation.
---

# Greenfield bootstrap

Use when `muster detect` reports `greenfield: true` (empty dir / no project).

1. **Brainstorm** the project to a short design. Prefer an installed superpowers brainstorming
   provider; else the built-in `sp-brainstorm`. Write the design to `docs/design/`.
2. **Plan** from the design — prefer installed `sp-plan`/superpowers; else built-in. Write a
   **checkbox plan** (`- [ ]` steps) to `docs/plan/`.
3. **Scaffold** the repo: `npx muster setup` (git init, docs/, .gitignore, README/AGENTS seeds —
   only what's missing). Report `{created, skipped}`.
4. **Re-detect**: `npx muster detect` — now non-greenfield — and hand back to the normal route/execute
   flow.

Iron rule: no implementation before a design + plan exist (same gate as superpowers/atomic).
```

- [ ] **Step 2: `npm test` (no code change → green). Commit**

```bash
git add plugin/skills/greenfield/
git commit -m "feat(skills): greenfield bootstrap (brainstorm->plan->setup->re-detect)"
```

---

## Task 4: Autopilot command + skill

**Files:** Create `plugin/commands/autopilot.md`, `plugin/skills/autopilot/SKILL.md`; modify `plugin/.claude-plugin/plugin.json`

- [ ] **Step 1: Create `plugin/commands/autopilot.md`**

```markdown
---
name: muster-autopilot
description: Hands-off full-lifecycle run on a stated outcome. Usage: /muster-autopilot <outcome>
---

The outcome: `$ARGUMENTS`

If empty, ask for the outcome and stop. Otherwise invoke the **autopilot** skill with this outcome.
```

- [ ] **Step 2: Create `plugin/skills/autopilot/SKILL.md`**

```markdown
---
name: autopilot
description: Drive a Muster run hands-off — branch, detect, greenfield-bootstrap if needed, route, orchestrate waves, commit per wave, then present merge. No pauses except the merge decision + escalations.
---

# Autopilot

Input: an `outcome` string. If absent, stop (outcome-anchored).

1. **Branch** — create a work branch off the base (never run on the base branch).
2. **Detect** — `npx muster detect`. If `greenfield: true`, run the **greenfield** skill, then re-detect.
3. **Route** — `npx muster capabilities` → invoke the **router** skill → validated Crew Manifest at
   `.muster/manifest.json` (`npx muster manifest validate` until ok).
4. **Show the plan** — `npx muster plan-checklist .muster/manifest.json` and display it.
5. **Orchestrate** — run the **orchestrator** skill over the manifest (waves, tournaments, review gate)
   **without pausing** at gates. After each green+reviewed wave:
   - commit the wave's changes (`feat(wave N): <summary>`),
   - re-render the checklist with the completed task ids (`--done …`) and append it to the run STATE.
6. **Escalation** — if a wave's review gate escalates (fix-loop cap) or a tournament has no passing
   candidate, STOP and report the unresolved items. Do not proceed. The branch stays intact.
7. **Finish** — after the last wave, present merge options (the finishing-a-development-branch skill).
   This is the single human decision. No auto-push.

Glass box: branch, each commit, escalations, and the ticking checklist are all recorded in STATE.
```

- [ ] **Step 3: Register in `plugin/.claude-plugin/plugin.json`**

Add `"commands/autopilot.md"` to `commands` and `"skills/autopilot/SKILL.md"`, `"skills/greenfield/SKILL.md"` to `skills`.

- [ ] **Step 4: Validate plugin.json + commit**

Run: `node -e "JSON.parse(require('fs').readFileSync('plugin/.claude-plugin/plugin.json','utf8')); console.log('ok')"`
`npm test` green.

```bash
git add plugin/
git commit -m "feat(autopilot): /muster-autopilot command + autopilot skill"
```

---

## Task 5: Orchestrator ticks the checklist into STATE

**Files:** Modify `plugin/skills/orchestrator/SKILL.md`

- [ ] **Step 1: Edit `plugin/skills/orchestrator/SKILL.md`** — in step 2d (the STATE append), add explicit checklist ticking. Replace the step-2d line with:

```markdown
   d. Append to the run STATE: the wave index, tasks, winners, and review result — AND the re-rendered
      plan checklist with completed tasks ticked (`npx muster plan-checklist .muster/manifest.json
      --done <comma-separated completed ids>`), so the STATE shows the plan progressing `- [ ]` -> `- [x]`.
```

- [ ] **Step 2: `npm test` green (markdown only). Commit**

```bash
git add plugin/skills/orchestrator/
git commit -m "feat(orchestrator): tick the plan checklist into STATE per wave"
```

---

## Task 6: Integration test + README

**Files:** Create `test/integration.slice4.test.js`; modify `README.md`

- [ ] **Step 1: Write the integration test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpProject } from "./helpers.js";
import { detectProject } from "../src/detect.js";
import { scaffoldProject } from "../src/setup.js";
import { renderPlanChecklist } from "../src/checklist.js";

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

test("greenfield dir becomes non-greenfield after scaffold", async () => {
  const dir = await tmpProject({});
  const before = await detectProject(dir);
  assert.equal(before.greenfield, true);
  await scaffoldProject(dir);
  const after = await detectProject(dir);
  assert.equal(after.greenfield, false);   // .git + files now exist
  assert.ok(await exists(join(dir, "docs/plan")));
});

test("checklist ticks as waves complete", async () => {
  const plan = [{ id: "a", task: "A", mode: "single" }, { id: "b", task: "B", mode: "tournament" }];
  assert.match(renderPlanChecklist(plan, []), /- \[ \] a/);
  assert.match(renderPlanChecklist(plan, ["a"]), /- \[x\] a/);
  assert.match(renderPlanChecklist(plan, ["a", "b"]), /- \[x\] b — B \(tournament\)/);
});
```

- [ ] **Step 2: Run full suite — paste summary (all green)**

- [ ] **Step 3: README + commit**

Append to `README.md`:
```markdown

Autopilot: `/muster-autopilot <outcome>` runs detect → (greenfield bootstrap) → route → waves → commit-per-wave → present merge. `npx muster setup` scaffolds a new repo; `npx muster plan-checklist <manifest>` renders ticking progress. Design: `docs/design/2026-06-07-muster-v4-autopilot-greenfield.md`
```

```bash
git add test/integration.slice4.test.js README.md
git commit -m "test(integration): greenfield->scaffold->non-greenfield + ticking checklist"
```

---

## Self-review (completed)

- **Spec coverage:** scaffoldProject/setup (§4) → Task 1; renderPlanChecklist (§5) → Task 2; greenfield
  skill (§3) → Task 3; autopilot command+skill (§6) → Task 4; orchestrator STATE ticking (§5) → Task 5;
  CLI setup/plan-checklist (§7) → Tasks 1–2; integration (§3,§5) → Task 6. Deferred (auto-push, remote,
  domains) absent.
- **Placeholder scan:** deterministic steps carry full code; skills carry exact markdown. No TBD.
- **Type consistency:** plan task `{id,task,mode}` consumed by renderPlanChecklist matches the slice-1/2
  manifest shape; scaffoldProject return `{created,skipped}` consistent across CLI + tests; detect
  `greenfield` (slice 1) consumed by the integration test.

## Notes for the executor
- Branch off `master` first.
- `git` is needed for scaffoldProject's `git init` (degrades: if git absent, skips `.git`, still seeds files).
- Skills (Tasks 3–5) are markdown the harness reads live — not unit-tested; the deterministic helpers
  (setup/checklist) are the tested core.
