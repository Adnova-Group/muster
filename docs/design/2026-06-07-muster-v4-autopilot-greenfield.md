# Muster slice 4 — Autopilot + greenfield

- Status: draft for review
- Date: 2026-06-07
- Builds on: slice 1 (router/detect), slice 2 (orchestrator/waves/review), slice 3 (native built-ins)

## 1. What slice 4 adds

Two run-mode capabilities that tie the existing pieces into hands-off, full-lifecycle execution:

- **Autopilot** — `muster autopilot <outcome>`: detect → (greenfield? bootstrap) → route → manifest →
  orchestrator waves (slice 2) → commit per green+reviewed wave → present merge. Non-interactive
  except the single human decision (how to merge) and escalations.
- **Greenfield** — when `detect.greenfield` is true (empty dir / no project), bootstrap first:
  brainstorm → plan → project setup → re-detect → continue. No code before a design + plan exist.

It also delivers the **checkbox progress** requirement: Muster renders the plan and run STATE as
`- [ ]` items that tick to `- [x]` as waves complete (glass-box live progress).

## 2. Goals / non-goals

**Goals**
1. `scaffoldProject(dir)` + `muster setup` — deterministic project bootstrap (git init, docs/, .gitignore,
   README/AGENTS seeds); only creates what is missing, never overwrites.
2. `renderPlanChecklist(plan, doneIds)` — deterministic markdown checkbox rendering of a manifest plan.
3. `muster autopilot <outcome>` command + **autopilot skill** — the hands-off driver.
4. **greenfield bootstrap skill** — empty dir → brainstorm (installed superpowers, else `sp-*` built-in)
   → plan → `muster setup` → re-detect → continue.
5. Commit per green+reviewed wave; end by presenting merge options (reuse finishing-a-development-branch).
6. STATE + plan rendered as ticking checkboxes.

**Non-goals (deferred)**
- Auto-push / auto-PR (needs a remote; autopilot stops at the merge decision).
- S5 remote control; S1 other-CLI adapters; ForceVue connector; non-software domains (S4 pipelines proper).
- Judge synthesis, speculative execution (already deferred).

## 3. Greenfield branch

`detect` already emits `greenfield` (slice 1). Autopilot / `/muster` consult it:

- **Existing project** → normal flow.
- **Greenfield** → bootstrap skill:
  1. Brainstorm the project — prefer an installed superpowers brainstorming provider; else the built-in
     `sp-brainstorm`. Produce a short design.
  2. Plan — `sp-plan` (or installed) → a checkbox plan written to `docs/`.
  3. `muster setup` — scaffold the repo (below).
  4. Re-run `muster detect` → now non-greenfield → continue into the normal route/execute flow.

## 4. Project setup (deterministic) — `scaffoldProject` / `muster setup`

`scaffoldProject(dir)` creates, **only if missing** (never overwrite):
- `git init` (if no `.git`)
- `.gitignore` (node defaults + `.muster/`)
- `docs/design/`, `docs/plan/` (gitkeep)
- `README.md` seed (project name placeholder + "scaffolded by muster")
- `AGENTS.md` seed (pointer: this repo is muster-managed)
Returns `{ created: string[], skipped: string[] }` so the action is auditable (glass box). Pure-ish I/O,
unit-tested against tmp dirs (creates on empty; skips existing; idempotent).

## 5. Checkbox progress (deterministic) — `renderPlanChecklist`

`renderPlanChecklist(plan, doneIds = [])` → markdown:
```
- [x] t1 — scaffold CRUD
- [ ] t2 — token-bucket store (tournament)
- [ ] t3 — tests
```
- `[x]` when `id ∈ doneIds`, else `[ ]`; tournament tasks annotated `(tournament)`.
- Used by the orchestrator/autopilot to render the live plan and to update STATE after each wave.
- Pure → unit-tested. Satisfies the "Muster plans/steps render as checkboxes" requirement.

The orchestrator (slice 2) appends, per wave, the re-rendered checklist to the run STATE via the
slice-2 `appendState`, so the run record shows the plan ticking off.

## 6. Autopilot (run mode) — command + skill

`muster autopilot <outcome>` is thin: it prints guidance / validates an outcome was given; the actual
drive is the **autopilot skill** (model-facing), which:
1. Requires an outcome (else stop — outcome-anchored).
2. Create a work branch (never run on the base branch).
3. `muster detect`; if greenfield → run the greenfield bootstrap skill, then re-detect.
4. `muster capabilities` → invoke the router skill → validated Crew Manifest (`.muster/manifest.json`).
5. Render the plan checklist (`muster plan-checklist`) and show it.
6. Run the **orchestrator skill** (slice 2) over the manifest — waves, tournaments, review gate —
   **without pausing** at gates; after each green+reviewed wave: commit + tick the wave's tasks in the
   checklist/STATE.
7. On escalation (review fix-loop cap, tournament all-fail), STOP and report — do not push past it.
8. After the final wave: present merge options (finishing-a-development-branch) — the one human decision.

## 7. CLI additions (deterministic, TDD-able)

- `muster setup [dir]` → runs `scaffoldProject`, prints `{created,skipped}` JSON.
- `muster plan-checklist <manifest.json> [--done id1,id2]` → prints `renderPlanChecklist`.

## 8. Glass-box / DNA fidelity

- Greenfield bootstrap, every commit, and the ticking checklist are recorded in STATE — the run is
  fully auditable. Autopilot never silently proceeds past an escalation. Outcome-anchored throughout.

## 9. Graceful degradation & error handling

- Greenfield with no installed brainstorm/plan provider → use built-in `sp-*`; with neither (shouldn't
  happen post-slice-3) → inline, recorded.
- `scaffoldProject` never overwrites; reports skips.
- Autopilot escalation (gate cap / tournament fail) → halt + report unresolved items, branch intact.
- No base-branch execution: autopilot always branches first.

## 10. Testing strategy
- `scaffoldProject` (TDD): empty dir → expected files created; pre-existing files → skipped, not
  overwritten; idempotent second run.
- `renderPlanChecklist` (TDD): done/undone mix; tournament annotation; empty plan.
- CLI `setup` / `plan-checklist` smoke.
- autopilot + greenfield **skills**: scenario-shape (markdown, not unit-tested) — assert the documented
  sequence (branch → detect → bootstrap-if-greenfield → route → orchestrate → commit-per-wave →
  present-merge) and the escalation stop.

## 11. Open questions
1. Exact AGENTS.md/README seed contents.
2. Whether `muster autopilot` should accept a GitHub issue number (atomic does) — deferred; outcome
   string only for now.
3. Commit message style per wave (reuse a simple `feat(wave N): …`); finalize in plan.

## Change log

### 2026-06-07 — Initial slice-4 draft
- **What changed:** First design for autopilot + greenfield. Deterministic `scaffoldProject` (muster
  setup) + `renderPlanChecklist` (checkbox progress); autopilot command + skill (branch → detect →
  greenfield-bootstrap → route → orchestrate waves → commit-per-wave → present-merge, non-interactive
  bar the merge decision + escalations); greenfield bootstrap skill (brainstorm→plan→setup→re-detect).
- **Why:** tie slices 1–3 into hands-off full-lifecycle execution, deliver greenfield first-run UX, and
  satisfy the checkbox-progress requirement — without auto-push (one human decision: how to merge).
