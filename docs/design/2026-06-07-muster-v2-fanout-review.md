# Muster slice 2 — Concurrent fan-out + adversarial review

- Status: draft for review
- Date: 2026-06-07
- Builds on: slice 1 (glass-box router) — `docs/design/2026-06-07-muster-v1-glass-box-router.md`

## 1. What slice 2 adds

Slice 1 produces a Crew Manifest with a `plan` of tasks tagged `single` | `tournament`, but runs the
lifecycle sequentially. Slice 2 makes execution **concurrent and self-checking**: the plan becomes a
task DAG executed in **waves**, where each wave runs all dependency-ready tasks at once — a `single`
task is one agent, a `tournament` task is a nested fan-out (N approaches → scored judge → winner) —
and each wave ends at a barrier where an **adversarial review gate** must pass before the next wave.

Design split (decided): the deterministic, testable core lives in the `muster` CLI (wave scheduler,
review tally, tournament winner selection, run-record I/O); the unavoidably model-facing parts
(dispatching agents, the approach-writers, judges, reviewers) live in orchestration **skills** that
drive the harness. This preserves slice 1's testable-core pattern.

## 2. Goals / non-goals

**Goals**
1. `muster wave` — deterministic scheduler: Crew Manifest `plan` (tasks + deps + mode) → ordered waves.
2. `muster tally` — deterministic review-gate decision from reviewer verdicts (any blocker → blocked).
3. `muster pick` — deterministic tournament winner from scored candidates (highest passing → win).
4. Run records — BRIEF / STATE (append-only) / FOLLOWUPS persisted via the slice-1 memory interface.
5. Orchestration skills — wave executor, tournament, review-gate — driving the Claude Code harness.
6. Extend the Crew Manifest `plan` task shape with `id` + `deps` (so waves can be computed).
7. Glass Box: waves, tournament scores, and review verdicts are all recorded in the run record.

**Non-goals (deferred)**
- Autopilot run mode + greenfield bootstrap (still later — see slice-1 §16).
- Non-software domains (S4), remote control (S5), other CLI adapters (S1), ForceVue connector.
- Judge *synthesis* of a best-of candidate (slice 2 picks a winner; synthesis is a later iteration).
- Cross-wave speculative execution / re-planning mid-run.

## 3. Execution model (concrete)

```
Crew Manifest.plan  (tasks: {id, task, mode, deps[]})
  → muster wave manifest.json   → waves: [[task,...], [task,...], ...]   (deterministic, topological)
  for each wave:
    dispatch all tasks concurrently (orchestration skill, via harness Agent tool):
      mode=single      → 1 implementer agent
      mode=tournament  → N approach agents → judge scores each vs successCriteria → muster pick → winner
    BARRIER (all wave tasks complete)
    review gate (review-gate skill):
      dispatch all available reviewers in parallel, adversarially prompted → verdicts
      muster tally verdicts.json → { blocked, blockers[] }
      if blocked: fix-loop (re-dispatch implementer with blockers) until clean or cap → escalate
    append wave result to STATE; carry non-blocking findings to FOLLOWUPS
  → final run record written to memory
```

Maps onto Claude Code's `Agent`/`Workflow` primitives (a wave = `parallel()` of single-agent and
nested-tournament thunks). Muster owns the *scheduling + tallying* (CLI, deterministic); the harness
owns the *dispatch* (skill).

## 4. CLI additions (deterministic, TDD-able)

### `muster wave <manifest.json>` → `computeWaves(plan)`
Topological grouping. Input plan tasks `{ id, task, mode, deps: string[], note? }`. Output ordered
waves where every task in wave _k_ has all `deps` satisfied by waves `< k`.
- Cycle → error (fail loud, no silent drop).
- Missing dep id → error.
- No deps → all tasks in wave 0.

### `muster tally <verdicts.json>` → `tallyReview(verdicts)`
Input: `[{ reviewer, findings: [{ severity: "blocker"|"risk"|"nit", note }] }]`.
Output: `{ blocked: boolean, blockers: [{reviewer, note}], counts: {blocker,risk,nit} }`.
Rule: `blocked = any finding with severity "blocker"` (across any reviewer — adversarial, not majority).

### `muster pick <scored.json>` → `pickWinner(candidates)`
Input: `[{ id, scores: { [criterion]: number }, total: number, passing: boolean }]` (judge-produced).
Output: `{ winner: id | null, escalate: boolean, ranking: [...] }`.
Rule: among `passing` candidates, highest `total` wins; if none passing → `winner:null, escalate:true`.

### Run records (extend `src/memory.js` usage, not a new backend)
Three entry kinds written via the existing memory interface (plain markdown, slice-1 LLM-Wiki):
- **BRIEF** — the Crew Manifest for the run (the single source for dispatched agents).
- **STATE** — append-only log; one entry appended per wave/step (checkpoint discipline). New
  function `appendState(dir, runId, line)`.
- **FOLLOWUPS** — ledger of non-blocking findings (severity risk/nit) carried across waves,
  dispositioned at finalize.

## 5. Manifest plan extension

Slice-1 plan task `{ task, mode, note? }` → slice-2 `{ id, task, mode, deps: string[], note? }`.
- `manifest.js` validator: require `id` (unique) and `deps` (array of existing ids) when present;
  keep `mode ∈ single|tournament`. Backward note: slice-1 manifests without `id/deps` are treated as
  a single dependency-free wave (validator allows missing `deps`, defaults to `[]`; missing `id`
  allowed only when there is a single task).
- Router skill (slice 1) updated to emit `id` + `deps`.

## 6. Orchestration skills (model-facing, not unit-tested)

- **`skills/orchestrator`** — the wave executor. Reads manifest, calls `muster wave`, and for each
  wave dispatches tasks via the harness, runs the barrier + review gate, appends STATE. Drives the
  whole slice-2 loop.
- **`skills/tournament`** — for a `tournament` task: dispatch N approach agents (default N=3, distinct
  angles), have a judge score each against `successCriteria` (evidence-cited), write scores to a temp
  file, call `muster pick`, return the winner. Records scores in STATE (glass box).
- **`skills/review-gate`** — dispatch all available reviewers (from `capabilities`: code-review +
  security-review providers; built-in reviewer if none installed), adversarially prompted to refute;
  collect verdicts, call `muster tally`; on `blocked`, re-dispatch the implementer with the blockers
  and re-review (cap: 3 iterations, then escalate to the human).

These compose installed providers per the slice-1 ladder; on a bare machine the review gate uses the
built-in reviewer and tournaments use built-in implementers — still functional, just less diverse.

## 7. Glass Box & DNA fidelity

- Every wave, every tournament's per-candidate scores, and every review verdict append to STATE →
  the run record shows *why* the winner won and *what* review caught. Recommendations from slice-1
  capabilities still surface (e.g. "install a security reviewer for a stronger gate").
- Outcome-anchored: tournament judging scores against the run's `successCriteria`; the review gate's
  definition of "blocker" is relative to those criteria.

## 8. Graceful degradation & error handling

- No installed reviewers → built-in reviewer only (gate still runs, single adversarial reviewer).
- Tournament with all candidates failing the criteria → `escalate` (don't silently ship a loser).
- `computeWaves` cycle / missing dep → hard error (fail loud).
- Fix-loop cap reached → escalate to human with the unresolved blockers (never silently proceed).
- A dispatched agent that dies → its task marked failed in STATE, not silently dropped; tournament
  with all approaches dead → fall back to a single sequential attempt, recorded.

## 9. Testing strategy

- **CLI (high value, TDD):** `computeWaves` (linear, diamond, cycle, missing-dep, no-deps),
  `tallyReview` (blocker present/absent, multi-reviewer, counts), `pickWinner` (clear winner, tie,
  none-passing→escalate), run-record `appendState`/FOLLOWUPS round-trips.
- **Manifest schema:** id uniqueness, deps reference existing ids, slice-1 back-compat default.
- **Skills (model-facing):** scenario fixtures asserting the *shape* of dispatch decisions (e.g.
  "tournament task → N candidate slots + 1 judge call + muster pick"), not LLM prose. Verify the gate
  loop calls `muster tally` and respects the cap.

## 10. Open questions
1. Default tournament N (proposed 3) — fixed or configurable per task in the manifest?
2. Fix-loop cap (proposed 3) — fixed or configurable?
3. Concurrency cap for a wave (harness limits apply; do we add our own ceiling?).
4. STATE entry format/granularity (one entry per wave vs per task).

## Change log

### 2026-06-07 — Initial slice-2 draft
- **What changed:** First design for slice 2 (concurrent fan-out + adversarial review), building on
  the slice-1 glass-box router. Decisions: CLI/skill split (CLI owns wave scheduler + review tally +
  tournament winner-pick + run-records; skills drive dispatch); tournaments scored against success
  criteria (highest passing wins, else escalate); review gate blocks on any blocker with a capped
  fix-loop; run records as BRIEF/STATE/FOLLOWUPS via the slice-1 memory backend; manifest plan tasks
  extended with `id` + `deps` for wave computation.
- **Why:** turn the slice-1 plan annotations into real concurrent, self-checking execution while
  keeping the deterministic core unit-testable, consistent with slice 1.
