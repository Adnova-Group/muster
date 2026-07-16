# Performance pass (backlog item `muster-performance-pass`)

Seed context: "muster has gotten out of control... a massive beast that can't get out of its own
way and decimates LLM plan quotas." The codex-teardown run that surfaced this recorded three
concrete symptoms: an `npx -y` cold start on every single muster CLI call (10+/run), a fixed
orchestration pipeline depth regardless of task count, and 3 opus-tier gate dispatches for a
3-task plan. This item cuts orchestration overhead on exactly those three axes, with the review
and spec gates staying full-strength throughout — the levers are batching, deduplication, and a
resolve-once CLI invocation, never a softer pass bar.

## Criterion 1 — zero npx cold-starts in a run

**Before.** Every muster CLI call in `plugin/commands/*.md` and `plugin/skills/*/SKILL.md` was
written as `npx -y @adnova-group/muster ...`. `npx -y` re-verifies against the npm
registry/cache on EVERY invocation, so a run with a dozen-plus muster CLI calls paid a
dozen-plus avoidable round-trips.

**Measured, this machine, right now** (`eval/perf/replay-3task.mjs`, `node src/cli.js scope
<n>` vs `npx -y @adnova-group/muster scope <n>`, 10 sequential calls each, npx cache pre-warmed
so this is the steady-state per-call cost, not a one-time download):

```
npx -y @adnova-group/muster scope <n>: 10 calls in 2709.8ms (271.0ms/call)
node src/cli.js scope <n> (resolved local): 10 calls in 905.5ms (90.5ms/call)
```

~66% less wall-clock per call, resolved-local vs raw `npx -y`, on this sandbox. Actual savings
on a genuinely cold CI runner (no npx cache at all) are larger; this measurement is the
conservative, already-warm case.

**After.** `src/cli-resolve.js` resolves the invocation ONCE, in preference order: a vendored
plugin runtime (`${CLAUDE_PLUGIN_ROOT}/runtime/muster.mjs`, mirroring the Codex-side bundling in
`scripts/build-codex.mjs`), a local checkout (`./src/cli.js`, guarded by a
`./src/cli-resolve.js` marker check so an unrelated project's own `src/cli.js` is never mistaken
for a muster checkout), a local/global `muster` bin, and — only as a last resort — `npx -y`
(flagged `degraded: true` so the run's own glass-box STATE records the fact honestly instead of
silently eating the cost every run). `RESOLUTION_SHELL_SNIPPET` is the identical decision
expressed in plain shell (`test -f` / `command -v`, no CLI call, so the resolution step itself
never pays a cold start) — embedded verbatim at the top of `plugin/commands/go.md` and
`plugin/commands/go-backlog.md` (a consistency test, `test/hotpath-cli-resolution.test.js`,
asserts the two docs and `src/cli-resolve.js` cannot drift apart). Every muster CLI call for the
rest of that run — including the orchestrator, review-gate, and router skills a `go` run
invokes — reuses the resolved `$MUSTER_CLI`, never re-invoking `npx` directly.
`muster resolve-cli` exposes the same decision as JSON for a programmatic caller.

Two more call sites are captured-once/reused rather than re-invoked, mirroring the same
pattern: `capabilities` (captured once by `go.md` step 3 into `.muster/capabilities.json`,
reused by every wave's provider-kind lookup and by review-gate's own `AvailableCapabilities`
input, instead of being re-invoked once per wave) and `gate-cadence` itself (captured once by
`go.md` step 4 into `.muster/gate-cadence.json`, reused by `orchestrator/SKILL.md` step 2
instead of being recomputed there against the same static manifest). See criterion 4's call-count
table below for exactly how much this removes.

## Criterion 2 — pipeline depth proportional to task count, with a documented small-task fast path

**Before.** `plugin/commands/go.md`'s step 4 spec gate was already a single whole-plan
dispatch (skippable only for a single-task, no-parallel-wave plan) — so the literal "spec gate"
step was never actually >1 round. The real fixed-depth cost the seed evidence's "3 opus
spec-gate rounds for a 3-task plan" points at was the PER-WAVE review gate
(`plugin/skills/review-gate/SKILL.md`, invoked once per wave via
`plugin/skills/orchestrator/SKILL.md` step 4c): a 3-task plan with no declared parallelism
compiles to 3 sequential waves, so it paid 3 separate opus-tier review-gate dispatches even
though the whole plan was small enough to review as one cumulative diff.

**After.** `src/gate-cadence.js`'s `planGateCadence(waves)` is a pure, deterministic function
over the plan's dependency-ordered waves (the same shape `computeWaves`/`muster wave` already
produce): plans at or below `SMALL_TASK_THRESHOLD` (3) tasks default to ONE batched review-gate
pass across every wave instead of one dispatch per wave (`reviewGateBatches: 1`); a single
trivial task keeps the existing spec-gate skip; plans above the threshold keep depth
proportional to wave count (`reviewGateBatches` scales with `waveCount` — a growing plan is
never silently under-reviewed by forcing it into the fast path). `muster gate-cadence
<manifest.json>` exposes the decision; `plugin/commands/go.md` step 4 runs it once and captures
the result into `.muster/gate-cadence.json`, and `plugin/skills/orchestrator/SKILL.md` step 2
reads that once-captured file (not a fresh invocation — same dedup treatment as `capabilities`,
see criterion 1) before wave 1; step 4c/5 branch on `fastPath` to decide whether the review-gate
dispatch happens per-wave or once, deferred to after the last wave, over the full cumulative
diff.

Test evidence (`test/gate-cadence.test.js`): a 3-task plan across 3 sequential waves ->
`specGateRounds: 1, reviewGateBatches: 1`; a 10-task plan across 5 waves ->
`reviewGateBatches: 5` (proportional, not forced to 1).

## Criterion 3 — review and spec gates stay full-strength

Nothing about this item changes a gate's own pass bar, reviewer tier, or fix-loop cap:

- The review-gate's reviewer selection (`code-review`/`security-review`, or the built-in
  reviewer), its adversarial "refute the work" framing, its citation guard, its intent-vs-
  implementation check, and its **3-fix-iteration cap** (`REVIEW_GATE_MAX_ITERATIONS`,
  `src/loop.js`) are all unchanged — a batched pass gets the identical cap, just applied over a
  larger (cumulative) diff instead of a single wave's diff.
- The spec gate's architecture-review dispatch, its lazy-implementer/malicious-reader framing,
  and its file/symbol verification are unchanged; `gate-cadence` only ever reports the SAME
  `specGateRounds` the existing single-dispatch design already produced (0 for a single trivial
  task, 1 otherwise) — this item does not add a new lever there, only names and tests the
  existing one.
- The two levers this item actually uses are named explicitly in every doc change: **batching**
  (collapsing N per-wave review-gate dispatches into 1 for small plans) and **dedup**
  (capabilities resolved once per run into `.muster/capabilities.json`, reused by every wave's
  provider-kind lookup and by review-gate's own `AvailableCapabilities` input, instead of
  re-invoked per wave — the inventory does not change mid-run, so re-fetching it added cost with
  no correctness benefit).

## Criterion 4 — before/after comparison on a replayed 3-task run (`eval/perf/replay-3task.mjs`)

Per this item's stated pragmatics, this is a deterministic harness-level replay (CLI-call-count
× cold-start cost + gate-round count, before/after), not a live production run — recorded
honestly, no fabricated token numbers.

**Grounded call-count facts**, BEFORE this item (read off the pre-edit
`plugin/commands/go.md` + `plugin/skills/orchestrator/SKILL.md` +
`plugin/skills/review-gate/SKILL.md` prose for a 3-task sequential plan, i.e. 3 waves of 1 task
each — the seed evidence's exact shape):

| Source | Calls | What |
| --- | --- | --- |
| `go.md` preamble/finish | 6 | `scope`, `detect`, `assess`, `capabilities`, `manifest validate`, `plan-checklist` |
| `orchestrator/SKILL.md`, once | 1 | `wave` (compute waves) |
| `orchestrator/SKILL.md`, per wave × 3 | 3 | `capabilities` (provider-kind lookup, re-invoked every wave) |
| `orchestrator/SKILL.md`, per wave × 3 | 3 | `plan-checklist --done` (STATE rerender) |
| `review-gate/SKILL.md`, per wave × 3 | 3 | `tally` (verdicts, one review-gate pass per wave) |
| **Total BEFORE** | **16** | muster CLI calls for this run |

**AFTER this item** (same run, current prose) — the call COUNT itself drops too, not just its
per-call cold-start cost: the capabilities and gate-cadence dedup levers remove per-wave CLI
calls that existed before, and review-gate's batching collapses 3 `tally` calls into 1:

| Source | Calls | What |
| --- | --- | --- |
| `go.md` preamble/finish | 6 | `scope`, `detect`, `assess`, `capabilities` (captured once), `manifest validate`, `plan-checklist` |
| `go.md` step 4, once (NEW) | 1 | `gate-cadence` (captured once into `.muster/gate-cadence.json`) |
| `orchestrator/SKILL.md`, once | 1 | `wave` (compute waves) |
| `orchestrator/SKILL.md`, per wave × 3 | 0 | capabilities lookup now reads `.muster/capabilities.json` (deduped, no CLI call) |
| `orchestrator/SKILL.md`, per wave × 3 | 3 | `plan-checklist --done` (STATE rerender — unchanged; glass-box progress, not a gate) |
| `orchestrator/SKILL.md` step 2 | 0 | gate-cadence now reads `.muster/gate-cadence.json` (deduped, no CLI call) |
| `review-gate/SKILL.md`, batched once | 1 | `tally` (verdicts, ONE batched pass instead of 3) |
| **Total AFTER** | **12** | muster CLI calls for this run |

16 -> 12 calls (25% fewer calls), each remaining call also paying the criterion-1 cold-start
reduction. Gate rounds: 3 (per-wave review-gate dispatches) before, 1 (batched) after, per
`planGateCadence`.

**Replay output** (`node eval/perf/replay-3task.mjs`, run on this sandbox):

```
Performance-pass replay: 3-task /muster:go run, before vs after

Step 1 — REAL wall-clock cold-start measurement (this machine, right now):
  npx -y @adnova-group/muster scope <n>: 10 calls in 2709.8ms (271.0ms/call)
  node src/cli.js scope <n> (resolved local): 10 calls in 905.5ms (90.5ms/call)

Step 2 — grounded call-count/gate-round facts (read off the actual command/skill markdown):
  3-task sequential plan: gate-cadence = {"taskCount":3,"waveCount":3,"specGateRounds":1,"reviewGateBatches":1,"fastPath":true,"reason":"small plan (<=3 tasks): one spec-gate round, one batched review-gate pass across all 3 wave(s)"}
  muster CLI calls hit by this run: 16 before -> 12 after (capabilities + gate-cadence dedup also drop the call COUNT, not just its cost)
  review-gate rounds BEFORE (one per wave, seed evidence): 3
  review-gate rounds AFTER (gate-cadence fastPath batching): 1

Step 3 — before/after projection (src/perf-projection.js):
  before: 10336ms modeled
  after:  4087ms modeled
  reduction: 6249ms (60.5%)

  PASS — criterion 4 requires >=30% reduction
```

**60.5% reduction** — clears the 30% bar with a wide margin, from two independent, stacking
levers: the per-call cold-start reduction (criterion 1) AND the call-count reduction itself
(the dedup/batching levers in criterion 2/3). `src/perf-projection.js`'s `projectRunReduction()`
(the arithmetic combining the measured/grounded halves above, with `cliCallCountBefore`/
`cliCallCountAfter` modeled separately since the two are genuinely different counts) is pinned
by a deterministic unit test (`test/perf-projection.test.js`) using these same inputs, so the
>=30% claim is asserted by the always-green suite, not just narrated here.

**Model-call (token) reduction — a documented projection, not a measured count.** This item does
not run a live LLM-backed `/muster:go`, so no production token count is asserted. What IS
grounded: the review-gate dispatch count for a 3-task plan drops from 3 opus-tier calls to 1.
Applying the Artificial Analysis 2026-07 crew-lane pricing below to that 3->1 reduction, holding
the per-dispatch prompt/output size roughly constant (an approximation — a batched pass reviews
a larger cumulative diff, so its OWN token count is somewhat larger than one wave's; the
reduction is in call COUNT, not a claim that batched-call tokens equal single-wave-call tokens),
projects a majority reduction in opus-tier review-gate spend for small plans. This is named as a
projection, deliberately not dressed up as a measurement.

## Benchmark evidence recorded for crew model lanes

- **DeepSWE v1.1**: sol/medium 61.1% (best default), sol/high 69.4% (best hard-task value),
  luna/xhigh 56.9% (budget lane).
- **Artificial Analysis (2026-07)**, intelligence-index @ cost: Sonnet 5 high — 42 intel @ $427
  index; Opus 4.8 max — 56 intel @ $3753; Fable 5 max — 60 intel @ $5631.

These anchor the crew model-tiering lanes `src/model.js`/`modelForRole` already resolves against
(fable degrading to opus by default, per `plugin/skills/orchestrator/SKILL.md`'s Model bullet) —
recorded here per this item's evidence requirement, not modified by this item.

## Scope of this wave

This wave lands the core mechanism (CLI resolution, gate-cadence fast path, capabilities dedup)
on the highest-traffic hot path: `plugin/commands/go.md`, `plugin/commands/go-backlog.md`,
`plugin/skills/orchestrator/SKILL.md`, `plugin/skills/review-gate/SKILL.md`, and
`plugin/skills/router/SKILL.md`. Other entry points (`plan.md`, `plan-backlog.md`, `audit.md`,
`diagnose.md`, `capture.md`, and skills not on the `/muster:go` hot path) still use raw `npx -y`
and are follow-up candidates for the same treatment, noted in the item's return receipts.
