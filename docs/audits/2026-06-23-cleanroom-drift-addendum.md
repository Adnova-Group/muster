# Clean-Room Drift Addendum — muster's own assets vs their inspiration

_Companion to `2026-06-23-upstream-drift-ledger.md`. The first ledger diffed **vendored** files textually; this addendum does the **conceptual** diff the outcome actually asked for: does the source material that muster's clean-room assets were inspired by now contain patterns the reimplementations are missing?_

## Provenance (corrected)

- The 5 `muster-*` agents declare `inspired_by: "atomic-claude role concept"` (Apache-2.0). **atomic-claude is the inspiration for the clean-room agents** — it is not a vendored source, which is why the first ledger wrongly dismissed it. atomic-claude is a published methodology (`atomic.alonso.network`), not a cloneable repo, so these are concept ports, not text ports.
- The clean-room **skills** (`orchestrator, router, review-gate, interview, greenfield, …`) have no explicit `inspired_by`; their conceptual sources are superpowers (subagent-driven-dev, code-review, brainstorming) and gsd (plan/execute/verify-phase). Those skill-level gaps are findings #2–#3 in the first ledger.

## atomic-claude role map

| atomic-claude role | muster equivalent | Status |
|---|---|---|
| Implementer/Builder (isolates in `.worktrees/`) | `muster-builder` + `muster-surgeon` | partial — **no worktree isolation** (CR-3) |
| Reviewer ("never grades own homework", fix every finding) | `muster-reviewer` + `review-gate` | aligned (maker≠checker, loop-until-clean) |
| Strategist (read-only, dispatched when "stuck twice") | `muster-strategist` | partial — **no auto-escalation trigger** (CR-2) |
| Improve-Agent (retrospective, self-sharpening) | — | **missing entirely** (CR-1) |
| (n/a) | `muster-investigator` | muster addition, no upstream |

## New findings (impact × effort × fit)

### CR-1. ADOPT — no self-improvement / retrospective agent · impact HIGH · effort MED · fit STRONG
atomic-claude's **Improve-Agent** mines recent session history for friction and proposes edits to rules/skills (user-approved) — its "self-sharpening loop." Muster has the `memory/` system but **no agent role that closes the loop**: nothing reviews a run's STATE/escalations and proposes skill or rule refinements.
→ Add a `muster-improver` agent (read-only over run STATE + transcripts → proposes skill/CLAUDE.md edits, user-gated). This is muster's biggest clean-room gap vs its stated inspiration.

### CR-2. ADOPT — no "stuck twice → strategist" auto-escalation · impact MED · effort LOW · fit EXACT
atomic dispatches the Strategist on repeated failure ("stuck twice on the same error"). `muster-strategist` exists but is only routed for the `architecture-review` role — it is never auto-dispatched when an implement/review fix-loop keeps failing on the same error. The orchestrator currently jumps from fix-loop-cap straight to human escalation.
→ Add an orchestrator step: on N consecutive failed fix iterations against the same error, dispatch `muster-strategist` for root-cause **before** escalating to the human. Target: `plugin/skills/orchestrator/SKILL.md`.

### CR-3. ADAPT — parallel builders aren't worktree-isolated · impact MED · effort MED · fit STRONG
atomic isolates each parallel implementer in `.worktrees/` so concurrent branches don't collide. Muster's orchestrator dispatches **all wave tasks concurrently** sharing one workspace; `/muster:autopilot` step 1 creates a single run-level worktree, not one per concurrent task. Independent same-wave tasks that touch overlapping files can collide.
→ Give each concurrently-dispatched builder its own `.worktrees/<task-id>/` (the harness Agent tool supports `isolation: "worktree"`). Target: `plugin/skills/orchestrator/SKILL.md` dispatch step.

### CR-4. NOTE — fix-every-finding posture · impact LOW · fit PARTIAL
atomic: "every finding, blocking or not, gets fixed in-iteration." Muster's `review-gate` loops "until clean or escalate" but likely defers non-blocking findings. This is a deliberate posture choice, not clearly a defect — flagged for a decision, not adoption.

## Net recommendation
The clean-room **agents** are sound but miss two atomic-claude capabilities worth adopting: a self-improvement loop (CR-1, the standout gap) and stuck-escalation to the strategist (CR-2), plus per-task worktree isolation for parallel safety (CR-3). Combined with skill-level findings #1–#5, the highest-value adoptions across both ledgers are **CR-1 (self-improver agent)** and **#2 (pre-flight plan review)**.
