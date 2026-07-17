# Weight reduction (backlog item `muster-weight-reduction`)

Seed context: the performance pass (`docs/performance-pass.md`) cut orchestration overhead
on three axes (CLI cold-starts, review-gate batching, capabilities dedup) while keeping
every gate's own pass bar untouched. This item continues that lineage on the axis
performance-pass explicitly deferred: **make small work cheap by default**, proportionally
— never by softening a gate for real multi-task work. Five criteria, five sections below.

## Criterion 1 (flagship) — single-agent fast path

**Before.** Every outcome, including a one-line trivial fix, paid the router SKILL.md's
full crew-assembly pass: specialist search (`match`), per-task skill binding (`match
--skills`), surface assignment, and the gap protocol. `gate-cadence.js`'s existing
`SMALL_TASK_THRESHOLD` rule already skips the spec gate for a single-task plan, but that
decision runs on the manifest's computed waves — it cannot skip crew assembly itself,
because at that point the manifest already exists.

**After.** `src/fast-path.js`'s `scoreOutcomeForFastPath(text)` is a deterministic,
PRE-router heuristic over the raw outcome text (the same discipline as `src/interview.js`'s
`assessOutcome` and `src/scope.js`'s `detectScope` — regex signals only, no judgment call
smuggled in). An outcome is eligible only when it carries:

- no cross-cutting-scope signal (`across`, `throughout`, `overhaul`, `migrate`,
  `rewrite`/`redesign`, `every service`/`file`/`module`, `end-to-end`, …)
- no multi-deliverable separator (numbered/bulleted list markers, `also`, `and then`,
  `as well as`, a semicolon)
- no two independent imperative verbs chained by `and` (`add X and fix Y`)
- at most `FAST_PATH_MAX_WORDS` (25) meaningful (non-stopword) words

Conservative by construction: any one of those signals disqualifies it, so a genuine
multi-task outcome never mis-scores eligible (criterion 5). When eligible,
`buildFastPathManifest({ outcome, capabilities })` emits the minimal Crew Manifest
directly — one task, a builder, and ONE reviewer — from the SAME already-resolved
`capabilities` object `go.md` step 3 always captures (cheap, deterministic, no LLM); no
router dispatch happens at all.

`muster fast-path <outcome> [--capabilities <file>]` wires it through the CLI:
score-only without `--capabilities`, score + emitted manifest with it (only when
eligible). `plugin/commands/go.md` step 3 runs the check before invoking the router
skill: eligible → skip straight to the fast-path manifest (the spec gate at step 4 is
skipped "for free" by the existing single-trivial-task `gate-cadence` rule, since a
fast-path manifest is always exactly one task); not eligible → the full
capabilities → router → validate flow, unchanged.

**Routed example** (`test/fast-path.test.js`):

```
scoreOutcomeForFastPath("Fix the flaky login test")
  -> { eligible: true, wordCount: 5, reason: "single-task/small outcome ... fast path applies" }
buildFastPathManifest({ outcome: "Fix the flaky login test", capabilities })
  -> { crew: [implement, review] (length 2), plan: [{ task: "Fix the flaky login test", mode: "single", deps: [] }] }
  -> validateManifest(...) === { ok: true, errors: [] }
  -> planGateCadence(waves) === { specGateRounds: 0, reviewGateBatches: 1, fastPath: true }  // existing rule composes for free

scoreOutcomeForFastPath("Add rate limiting, migrate the auth module to the new session
  store, and update every affected test suite across the repo")
  -> { eligible: false }   // cross-cutting + multi-deliverable signals both fire
```

## Criterion 2 — review gates scale with diff size

**Before.** `review-gate/SKILL.md` step 1 always selected both `code-review` and
`security-review` (or the built-in reviewer if neither is installed) — two concurrent
adversarial passes over every wave's diff, regardless of size.

**After.** `src/gate-cadence.js` gains a second, independent proportionality axis:
`reviewerCountForDiff(changedLines, { threshold })` returns 1 reviewer for a diff under
`DEFAULT_REVIEW_DIFF_THRESHOLD` (200 changed lines, `MUSTER_REVIEW_DIFF_THRESHOLD`
env-overridable) and 2 (the unchanged default) at or over it.

**Threshold rationale (200 changed lines).** Small enough that a single reviewer can hold
the whole diff in working memory and give it genuine adversarial attention rather than
skim it; large enough that a real multi-file feature slice — not just a one-line fix —
still clears it and gets the default two-reviewer treatment. This is diff-SIZE scoped, not
task-count scoped: it is an independent axis from `gate-cadence`'s existing
`SMALL_TASK_THRESHOLD` (task-count) rule — a multi-task plan whose cumulative diff happens
to land under the threshold still only needs one reviewer for THAT diff, and a genuinely
large multi-task diff always lands at or above the threshold regardless of how the tasks
were counted (criterion 5 is preserved by construction, not by a special case).

Diff size, unlike task count, isn't knowable at plan time (before a wave's changes exist)
— `planGateCadence(waves, { changedLines, reviewDiffThreshold })`'s `changedLines` is
OPTIONAL: absent, the result is identical to before this item (no `reviewerCount` key at
all); present (review-gate/SKILL.md step 1, dispatched after a wave's changes exist), it
folds `reviewerCount` into the same result object. `muster gate-cadence <manifest.json>
--changed-lines <n>` wires it through the CLI, reading `MUSTER_REVIEW_DIFF_THRESHOLD` for
the threshold override.

`review-gate/SKILL.md` step 1 now measures the wave's (or, under `fastPath`, the
cumulative batched) diff via `git diff --stat`/`--numstat`, folds it into the gate-cadence
call, and dispatches only `code-review` when `reviewerCount: 1`, both `code-review` and
`security-review` when `reviewerCount: 2` — unchanged from before this item.

Test evidence (`test/gate-cadence.test.js`): a diff under 200 lines → `reviewerCount: 1`
regardless of task count (including a fastPath-eligible 3-task plan); a diff at/over 200
lines → `reviewerCount: 2`, including the unchanged-multiwave proof below.

## Criterion 3 — wave overhead token budget

Target: a replayed small-task run consumes **≤25% of the tokens** the same task cost on
the pre-teardown pipeline.

**Method, recorded honestly.** A true pre-teardown baseline is not reproducible in this
environment — that pipeline's code is gone, not just disabled, and no earlier commit in
this history runs it either. Per this item's own brief pragmatics, this instead measures
the **fast-path vs full-pipeline delta on the SAME small task**
(`eval/perf/replay-fast-path.mjs`), combining:

1. **REAL, live measurement** — the actual byte size of `plugin/skills/router/SKILL.md`
   and `plugin/skills/review-gate/SKILL.md`, read off disk at run time (never hardcoded).
   The full pipeline loads `router/SKILL.md` once for crew assembly; the fast path skips
   it entirely. Every reviewer dispatch independently loads `review-gate/SKILL.md`.
2. **REAL, grounded reviewer counts** — 2 before criterion 2's lever, 1 after, imported
   directly from `src/gate-cadence.js` rather than restated as a separate number.
3. **MODELED, clearly-labeled constants** for what this environment cannot measure live
   (no production LLM session backs these totals): the diff a reviewer reads (bounded by
   the SAME real `DEFAULT_REVIEW_DIFF_THRESHOLD`, at an assumed ~40 chars/line) and the
   output tokens each dispatch produces (300 for a reviewer's findings list, 400 for the
   router's fuller manifest JSON) — the same "named projection, not dressed up as a
   measurement" stance `docs/performance-pass.md` already took for its own model-call
   estimate.

`src/token-projection.js`'s `projectFastPathTokenReduction()` combines all three into a
before/after token model, pinned by `test/token-projection.test.js` with fixed inputs so
the arithmetic itself is asserted by the green suite.

**Measured result, this checkout** (`node eval/perf/replay-fast-path.mjs`):

```
before: 11567 tokens modeled (router once + 2x reviewer dispatch)
after:   4598 tokens modeled (router skipped + 1x reviewer dispatch)
reduction: 6969 tokens (60.2% reduction, fast path consumes 39.8% of full-pipeline tokens)

MISS -- criterion 3 asks for fast-path consumption <=25% of full-pipeline tokens; measured 39.8%
```

**Honest miss, with the gap reasoned through, not papered over.** 60.2% reduction is a
real, substantial cut, but it misses the 25%-consumption (≥75%-reduction) target. Why: the
diff-size reviewer-count lever (criterion 2) only ever cuts reviewer dispatches from 2 to
1 — at best a 50% cut on that axis alone — and the per-reviewer-dispatch cost (skill
instructions + diff + output) dominates the total, so halving it caps the achievable
reduction well under what a 25%-consumption target implies. The router-skip lever
(criterion 1) is a one-time saving on top of that, not enough by itself to close the
remaining gap. **What would close it:** a lighter-weight single-reviewer prompt for a
trivial/small diff (skip the citation-guard and mutant-kill-gate instructions entirely
when neither's trigger class is present in the diff, rather than loading the full
`review-gate/SKILL.md` for every dispatch regardless of content), and/or a cheaper model
tier for the fast path's single reviewer — both left as follow-ups, out of scope for this
item's cycle.

## Criterion 4 — remaining raw-npx verbs adopt cli-resolve

**Before.** `audit.md`, `diagnose.md`, `capture.md`, `plan.md`, and `plan-backlog.md` were
the standalone entry points performance-pass's own "Scope of this wave" section named as
follow-up candidates — still shelling `npx -y @adnova-group/muster ...` per call.

**After.** Each embeds the identical `$MUSTER_CLI` resolution snippet
`go.md`/`go-backlog.md` already carry (`src/cli-resolve.js`'s `RESOLUTION_SHELL_SNIPPET`),
and every call site routes through the resolved `$MUSTER_CLI` — the sole remaining literal
`npx -y @adnova-group/muster` string per file is the snippet's own last-resort fallback
branch. Where an existing test required the literal natural-language phrase `muster
<verb>` to appear in the body (`test/integration.issue.test.js`,
`test/integration.interview.test.js`, `test/integration.capture.test.js`,
`test/mode-evals.test.js`'s scope-confirm coverage), the wording follows the SAME
established convention `go.md` already uses for its own issue/assess steps: `` run `muster
<verb> "..."` (via `$MUSTER_CLI <verb> "..."`) `` — both the natural-language name and the
resolved invocation are legible in the same line.

`runner.md`, `autopilot.md`, `sprint.md`, and `run.md` were checked too: none shell a raw
`npx` call of their own (they delegate entirely to `go.md`/`go-backlog.md`'s own
instructions), so nothing to wire there.

`test/hotpath-cli-resolution.test.js`'s `ENTRY_POINT_FILES` list now covers all 7
standalone entry points (was 2), asserting each embeds the exact snippet and carries
exactly one literal npx-muster string.

## Criterion 5 — no gate weakens for multi-task runs (proportionality only)

Every lever above is additive/scoped, never a softening of an existing gate for real
multi-task work:

- **Fast path (criterion 1)** applies ONLY to outcomes `scoreOutcomeForFastPath` scores
  eligible — conservative by construction (any cross-cutting/multi-deliverable/chained-verb/
  long-outcome signal disqualifies it). `test/fast-path.test.js`'s routed example: `"Add
  rate limiting, migrate the auth module to the new session store, and update every
  affected test suite across the repo"` scores `eligible: false` — the full crew (router
  dispatch), spec gate, and 2-reviewer review gate all still apply, unchanged.
- **Diff-size reviewer scaling (criterion 2)** only ever drops to 1 reviewer BELOW the
  200-line threshold; at/over it, both `code-review` and `security-review` still dispatch,
  exactly as before this item.
- **Task-count-scaled cadence** (`gate-cadence.js`'s pre-existing `SMALL_TASK_THRESHOLD`
  rule) is untouched: `test/gate-cadence.test.js`'s unchanged-multiwave proof —

  ```
  planGateCadence(
    [["t1","t2"],["t3","t4"],["t5","t6"],["t7","t8"],["t9","t10"]],  // 10 tasks, 5 waves
    { changedLines: 1200 },                                          // over the diff threshold too
  ) -> {
    fastPath: false,        // never falls into the small-task fast path
    specGateRounds: 1,      // spec gate still runs
    reviewGateBatches: 5,   // review-gate cadence stays proportional to wave count
    reviewerCount: 2,       // both reviewers, unchanged
  }
  ```

- **Enforcement stack** (the one action fence + one border invitation) is untouched by
  this item — no file under `plugin/hooks/` was edited.

## Scope of this cycle

This item lands the fast path, the diff-size reviewer scaling, the measured (honestly
missed) token-budget replay, and the remaining cli-resolve wiring. Follow-ups explicitly
named, not landed here: a lighter-weight single-reviewer review-gate prompt for trivial
diffs (would help close criterion 3's gap), and extending the fast-path scorer beyond
regex heuristics if false-negative rate (a genuinely small outcome routed the slow way)
turns out to matter in practice — no evidence of that yet, and a false negative costs
only the pre-this-item overhead, never correctness.
