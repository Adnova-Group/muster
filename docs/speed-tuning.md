# Speed tuning (backlog item `muster-speed-tuning`)

Seed context: weight-reduction (`docs/weight-reduction.md`) landed the single-agent fast path,
diff-scaled review-gate reviewer counts, and cli-resolve wiring for the remaining raw-npx verbs
— but its own criterion 3 replay measured the fast path consuming 39.8% of full-pipeline tokens
against a ≤25%-consumption target, an honest, documented miss. This item is a second
performance/efficiency pass: measure token budgets per verb, audit and cut the largest skill
footprints, lint subagent brief/return discipline, measure end-to-end latency, and push the
fast-path consumption figure toward that 25% line — all proportionality levers, no gate/review
strength reduction (criterion 5, hard constraint). Five criteria, five sections below.

## Criterion 1 — bare `/muster:plan` token budget (≤15k tokens)

**Method.** `eval/perf/replay-plan-budget.mjs` executes the REAL CLI-call sequence a bare
`/muster:plan` takes on a fast-path-eligible 1-task outcome (`scope`, `assess`, `fast-path`
score, `detect`, `capabilities --roles-only`, `fast-path --capabilities` to build the manifest,
`memory read`, `manifest validate`), measuring the actual byte size of every call's stdout and
`plugin/commands/plan.md`'s own prompt size — all REAL, read/measured live, never hardcoded.
The only MODELED figure is a small per-call narration constant (documented, not measured — no
live LLM session backs it). `src/plan-token-budget.js`'s `projectPlanTokenBudget()` combines
both, pinned by `test/plan-token-budget.test.js` with fixed inputs.

**Finding along the way.** weight-reduction wired the single-agent fast path into `go.md` step 3
only; `/muster:plan` (the approve-first entry point) still always paid the full router
crew-assembly pass. Wired the identical pre-router check into `plan.md` (criterion 1, first
commit) — the not-eligible branch is unchanged (still invokes the router, criterion 5).

**A bigger finding.** Even after that wiring, a bare `capabilities` dump measured **77,747
chars (~19.4k tokens)** on this checkout — already over the whole 15k budget before any other
cost counts, since `src/fast-path.js`'s `buildFastPathManifest` only ever reads
`roles.implement`/`roles["code-review"]` out of it. Wired the eligible branch to the
already-existing `capabilities --roles-only` flag instead (measured 20,646 chars, ~73%
smaller) — functionally verified end-to-end (piped into `fast-path --capabilities`, produces a
manifest that validates cleanly). `go.md`'s own step 3 re-captures the full inventory
unconditionally on hand-off, so this narrower planning-time capture never starves execution.

**Measured result** (`node eval/perf/replay-plan-budget.mjs`, this checkout):
```
command-prompt tokens: 2773
CLI-output tokens (8 real calls): 5738
modeled narration tokens: 320
TOTAL tokens: 8831
PASS -- criterion 1 asks for <=15000 total tokens; measured 8831
```
**PASS**, comfortably — the `--roles-only` narrowing is what makes this land: the bare full
`capabilities` dump alone would have blown the budget before any other cost was counted.

## Criterion 4 — plan-to-manifest wall-clock (≤60s)

Measured in the same harness/run as criterion 1 (the CLI-call sequence's real wall-clock,
summed by `src/plan-token-budget.js`'s `totalLatencyMs()`):
```
TOTAL plan-to-manifest wall-clock: 805.8ms
PASS -- criterion 4 asks for <=60000ms wall-clock; measured 805.8ms
```
**PASS**, by two orders of magnitude. Caveat (honest, not fabricated): this measures the
deterministic CLI-call portion of the cycle only — the model's own turn latency between calls,
which no live LLM session in this environment can produce, is not included; a real invocation's
wall-clock includes both.

## Criterion 2 — skill prompt-size audit (5 largest, ≥40% cut each)

**Method.** `src/skill-footprint.js` (pure `computeSkillFootprint`/`rankSkillFootprints`/
`reductionPct`/`meetsReductionTarget`, pinned by `test/skill-footprint.test.js`) plus
`eval/perf/skill-size-audit.mjs` (the REAL `fs.readFileSync` measurement over every
`plugin/skills/*/SKILL.md`) identified the 5 largest, before any cut:

```
coordination               40754 chars
orchestrator               26764 chars
review-gate                 9193 chars
router                      7881 chars
advisor                     6427 chars
```

Each was cut for load-bearing-preserving size, verified after every single cut by the full
contract-test suite (`corpus-contradiction`, `docs-binding-interface`, `prompt-scan`,
`mode-evals`) staying green, `check-codex` staying `ok:true`, and the full `node --test` suite
staying green — never a bulk edit-then-verify-once.

| Skill | Before | After | Reduction | Target |
|---|---|---|---|---|
| review-gate | 9,193 | 5,435 | **40.9%** | met |
| router | 7,881 | 4,654 | **40.95%** | met |
| advisor | 6,427 | 3,823 | **40.5%** | met |
| orchestrator | 26,764 | 13,828 | **48.3%** | met |
| coordination | 40,754 | 28,279 | **30.6%** | **missed** |

**review-gate/router/advisor/orchestrator (all ≥40%).** Trimmed narrative/rationale
(explanatory "why" paragraphs, repeated parentheticals, historical justification) while
preserving every literal a test or the codex build depends on byte-for-byte: the surface
taxonomy enum and gate-name mappings, the severity vocabulary, the fix-iteration cap sentence,
the `AvailableCapabilities` capture sentence, the `chosen.kind`/`isolation: "worktree"`/"one
implementer agent...as BRIEF" Codex-adaptation anchors, `loopState`/`classifySteer`/`<channel>`
integration-test dependencies, and more (see each cut's own commit message for the full list).
orchestrator's single biggest lever: its own "Enforcement model: gates vs conventions" section
is wholesale-discarded by `build-codex.mjs`'s Codex adaptation regardless of Claude-side
content, and duplicates `docs/architecture.md`'s own fuller version almost verbatim — compressed
to a cross-reference plus the one operative rule the orchestrator itself must still act on.

**coordination — an honest miss (30.6%, not 40%).** This file is qualitatively different from
the other 4: three parallel, correctness-critical multi-runner protocol bindings (GitHub
issues, backlog.md, Linear), each carrying real claim-race algorithms, authorizer-identity
security validation (a GitHub login / Linear displayName must be confirmed as an active
collaborator/member before being recorded as an authorizer — adversarial item/issue text must
never be able to forge one), and hostile-input handling (shell-quoting hazards, scratch-file
writes). Most of its bulk IS the protocol, not narrative to trim. Cutting further within this
cycle's remaining budget was judged a worse trade than risking a subtle protocol defect in a
distributed-coordination system for the sake of a arbitrary percentage. Every load-bearing
literal is preserved verbatim (see the commit message), and the file is 30.6% smaller with zero
loss of protocol coverage — a real, substantial, honestly-reported reduction, just short of the
40% bar the other 4 files cleared.

**Update (backlog item `coordination-footprint`):** the remaining gap closed without cutting a
single rule — the lever this item found was genuine de-duplication, not further narrative
trimming. All four bindings (a fourth, Hermes kanban, landed via `hermes-kanban-binding` after
this doc was written) restated the SAME CLAIM/RECEIPTS/BLOCKED/HUMAN-HOLD/DONE/FAILED/YIELD/
LEDGER protocol in each binding's own vocabulary; extracting that shared machinery into one
canonical "Protocol states" section, then reducing each binding to only its own state-to-
primitive mapping, cut the file to 24,438 chars — 40.04% off this table's 40,754 baseline. Every
protocol state and resume rule (including the authenticated- vs unauthenticated-resume-channel
split this doc's own honest-miss reasoning was built on) survives, just stated once instead of
up to four times; contract tests (`corpus-contradiction`, `docs-binding-interface`,
`coordination-preflight`, `mode-evals`) re-verified green.

## Criterion 3 — subagent brief/return discipline lint (≤2k/≤1k tokens)

`src/brief-lint.js` is a deterministic lint over skill/agent/command prose: it scans for an
explicit inline marker pair around a dispatch brief's or return contract's canonical template —
`<!-- muster-brief-template:start/end -->` and `<!-- muster-return-template:start/end -->` (the
same "reviewable, machine-readable directive" discipline `src/prompt-lint.js`'s
`prompt-lint-disable` comment already uses) — and measures ONLY the marked span against this
item's stated budgets (≤2000 tokens/brief, ≤1000 tokens/return contract), flagging any marked
span that exceeds its own budget.

Marked up the two canonical templates already in the corpus: `plugin/agents/muster-runner.md`'s
Dispatch contract (brief: 666 chars/~167 tokens; return receipts: 444 chars/~111 tokens) and
`plugin/skills/orchestrator/SKILL.md`'s Return contract section (already capped at ≤2000/1500
chars per return in its own prose, well inside the 1k-token budget). Both comfortably pass —
`test/prompt-scan-brief-lint.test.js` scans the real repo tree and asserts every marked span
found stays in budget.

## Fast-path consumption (weight-reduction's own criterion 3, re-measured)

The brief's explicit sub-goal: re-run `eval/perf/replay-fast-path.mjs` after the skill-size
cuts and report the new consumption figure against weight-reduction's 25%-consumption target
(39.8% measured then).

```
router cost (before only): 1564 tokens (skill 1164 + output 400)
per-reviewer-dispatch cost: 3659 tokens (skill 1359 + diff 2000 + output 300)
before: 8881 tokens modeled (router once + 2x reviewer dispatch)
after:  3659 tokens modeled (router skipped + 1x reviewer dispatch)
reduction: 5222 tokens (58.8% reduction, fast path consumes 41.2% of full-pipeline tokens)

MISS -- criterion 3 asks for fast-path consumption <=25% of full-pipeline tokens; measured 41.2%
```

**The real, non-fabricated figure is 41.2% — WORSE than weight-reduction's own 39.8%, despite
both router (−41%) and review-gate (−41%) being cut hard.** This is a genuine, counter-intuitive
result worth explaining honestly rather than burying: the consumption ratio is
`x / (r + 2x)` where `x` is the per-reviewer-dispatch cost (review-gate skill + a fixed diff
allotment + a fixed output allotment) and `r` is the router's one-time cost (router skill + a
fixed output allotment). Router tokens appear ONLY in the "before" denominator, never in
"after" — so shrinking the router skill (which the fast path never even loads) mechanically
**raises** the consumption ratio, even though it is a real, absolute token saving elsewhere.
Shrinking review-gate's skill size lowers the ratio, but its effect is capped by the fixed diff
(2000 tokens) and output (300 tokens) allotments baked into `x` — once the skill text itself is
a smaller fraction of `x` than those fixed constants, further skill-text cuts have diminishing
leverage on the ratio. Net, on this checkout, the router-shrink effect outweighed the
review-gate-shrink effect and the ratio moved the wrong way.

**What this means for the target.** The 25%-consumption target cannot be reached by shrinking
skill PROSE alone, regardless of how aggressively — the fixed diff/output allotments in the
model dominate `x` at any realistic skill size, and the router's one-sided appearance in the
ratio actively fights further router cuts. Closing the gap needs the SAME lever
`docs/weight-reduction.md`'s own criterion-3 writeup already named as a follow-up: a
lighter-weight single-reviewer prompt for a trivial/small diff (skip the citation-guard and
mutant-kill-gate instructions entirely when neither's trigger class is present in the diff,
rather than loading the full `review-gate/SKILL.md` regardless of diff content), and/or a
cheaper model tier for the fast path's single reviewer — both still out of scope for this
item's cycle, same as weight-reduction's own honest deferral.

**Update (backlog item `fast-path-token-gap`):** both levers named above landed —
`docs/fast-path-token-gap.md` has the full writeup. Re-measured consumption: 28.4% (down from
this doc's own 41.2%), driven by lever 1 (a real, measured ~73%-smaller reviewer brief); lever
2 (a cheaper reasoning tier) is real and wired-through-CLI but honestly credited with zero
measured tokens, since neither harness has a verified per-call consumption mechanism for it
today (see that doc's lever-2 section). A real improvement that still misses the 25% target,
with the remaining gap mechanism (the fixed diff-token allotment, unchanged by this item)
explained there.

## Criterion 5 — no gate/review strength reduction (proportionality only)

Every lever above is additive/scoped, never a softening of an existing gate for real multi-task
work or a real security/correctness guarantee:

- **Skill-size cuts (criterion 2)** removed narrative/rationale prose only. Every numbered gate
  (review-gate's 3 surface-type gates + the mutant-kill gate), every fix-iteration cap, every
  reviewer-selection rule, and coordination's full claim-race/authorizer-validation logic
  across all three bindings are preserved byte-for-byte or functionally identical — verified by
  the full contract-test suite staying green after every single cut, and by re-running each
  cut's specific drift guards (`test/mode-evals.test.js`'s mutant-kill-rule fixture,
  `test/coordination-preflight.test.js`'s fingerprint-set checks, `test/hook-pre-tool-use-action-fence.test.js`'s
  fence-lifecycle checks) rather than a bulk diff review.
- **The `--roles-only` capabilities narrowing (criterion 1)** only ever applies to the
  fast-path-eligible branch, which already carries zero specialist search / skill binding
  (`buildFastPathManifest`'s crew is fixed at implement+review); the not-eligible branch keeps
  the full capabilities dump unchanged, and `go.md`'s own execution phase always re-captures the
  full inventory regardless of what planning-time narrowed.
- **The brief/return-contract lint (criterion 3)** is a measurement/lint only — it flags, never
  weakens, and the two templates it currently covers both already comfortably clear their
  budgets without any content removed to make them fit.
- Enforcement stack (the one action fence + one border invitation) is untouched — no file under
  `plugin/hooks/` was edited by this item.

## Scope of this cycle

This item lands the /muster:plan token-budget + latency measurement harness (both PASS), the
`--roles-only` capabilities narrowing that makes the token-budget PASS land comfortably, the
skill-size audit + 5 cuts (4 of 5 at ≥40%, coordination an honest 30.6% miss with full rationale
recorded above), the brief/return-contract lint (both currently-marked templates comfortably in
budget), and the re-measured fast-path consumption figure (41.2%, an honest report of a
counter-intuitive regression from weight-reduction's 39.8%, with the mechanism explained).
Follow-ups explicitly named, not landed here: a lighter-weight single-reviewer review-gate
prompt for trivial diffs and/or a cheaper model tier for the fast path's reviewer (the lever
that would actually move the 25%-consumption target, per the analysis above), and a further,
more time-intensive pass at coordination/SKILL.md's remaining ~10-point gap to 40% (would need
either restructuring the three bindings to share more text via cross-reference, or accepting
some risk to the protocol's own correctness prose that this cycle judged not worth taking).
