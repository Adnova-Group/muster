# Fast-path token gap (backlog item `fast-path-token-gap`)

Seed context: `docs/weight-reduction.md` (criterion 3) and `docs/speed-tuning.md` (its own
re-measurement) both named the same follow-up and both left it out of scope: the fast path's
single-reviewer dispatch consumes 41.2% of full-pipeline tokens against a <=25%-consumption
target, dominated by the per-reviewer-dispatch cost (`plugin/skills/review-gate/SKILL.md`'s
own prose, loaded in full by every dispatch regardless of diff content) -- and both docs named
the same two closing levers: a lighter reviewer prompt for the fast path, and/or a cheaper
reviewer model/effort tier. This item lands both, measures the result honestly, and proves the
lighter prompt does not drop what a small diff actually gets checked.

## Lever 1 -- a lighter reviewer brief for the fast path

`plugin/skills/review-gate/fast-path-brief.md` is a new, real, standalone brief (essential
correctness + security checks, the intent-vs-implementation check, and the unchanged verdict/
escalation contract) -- measured at 1,936 chars against the full `review-gate/SKILL.md`'s
7,272 chars (`readFileSync(...).length`, the same measure `eval/perf/replay-fast-path.mjs`
already used), a ~73% reduction.

`src/review-brief.js`'s `lightBriefEligible({ reviewerCount, diffFiles, diffText })` decides
when it may be used: ONLY for `reviewerCount: 1` (a diff under
`DEFAULT_REVIEW_DIFF_THRESHOLD`) AND only when none of three content triggers fires against
the diff:

- **Mutant-kill trigger** (`MUTANT_KILL_TRIGGER_RE`) -- a test file, an `eval/*/dataset.json`
  case (any depth under `eval/`), or a lint/doctor rule source file (any `src/*lint*.js` or
  `src/*doctor*.js`, e.g. `src/codex-doctor.js`, not just the literal `src/doctor.js`) touched.
- **Citation trigger** (`CITATION_TRIGGER_RE` + a `[src: ...]` text scan) -- any changed
  markdown file, or a `[src: ...]` anchor appearing in the diff text itself.
- **Surface trigger** (`SURFACE_TRIGGER_RE`) -- the design/UX gate's own path globs
  (`components/**`, `app/**/page.*`, `*.css`, `*.scss`).

Any one of these firing -- even at `reviewerCount: 1` -- falls back to the FULL,
byte-unchanged `review-gate/SKILL.md` brief. This decision is CODE-BACKED, not left to prose
discipline: `muster review-brief --reviewer-count <n> [--diff-files <file>] [--diff-text-file
<file>]` wraps `lightBriefEligible`/`detectReviewTriggers` (the same "code over model" CLI
pattern `gate-cadence`/`citation-check`/`fast-path` already established for a diff-content
decision). `plugin/skills/review-gate/SKILL.md` gained a new "Fast-path reviewer brief"
section (placed after the surface-type gates, before the Mutant-kill gate section, so neither
the mutant-kill-rule drift-guard fixture (`test/mode-evals.test.js`) nor
`scripts/build-codex.mjs`'s step-1/fix-iteration-cap/capabilities-sentence Codex-adaptation
anchors are disturbed) invoking this CLI command and wiring the decision into the live
dispatch.

**Criterion 2 proof (no scope reduction for a small diff).** This is enforced BY
CONSTRUCTION, not by review discipline alone: `lightBriefEligible` returns `false` the moment
any trigger fires, regardless of `reviewerCount`, so the light brief is never even offered to
a diff that could need what it omits (`test/review-brief.test.js`'s
`"lightBriefEligible: false for reviewerCount:1 the moment ANY trigger fires"` case exercises
all three, and the CLI wrapper is covered by its own `test/cli-wire-perf.test.js` cases). The
light brief's own real, on-disk content still requires checking for a representative
small-diff security-defect class -- `test/review-brief.test.js`'s "criterion 2 static proof"
test reads the live file and asserts it explicitly names "path traversal" and "unsanitized
input reaching a shell/file/network call". This is a static content-presence check, honestly
labeled as such -- it is NOT a live-LLM mutant demonstration (this environment has no live,
token-metered LLM session to actually dispatch a reviewer against a mutated fixture and
observe its verdict). What IS a real, run-and-observed mutant-kill demonstration: during this
item's development, `src/review-brief.js`'s own mutant-kill trigger detection was disabled
(`MUTANT_KILL_TRIGGER_RE`'s branch replaced with `false`), `test/review-brief.test.js` was
confirmed to fail loud with two clear assertion failures, and the file was then restored
byte-identical (`git status --short` clean) -- this item's own new test/eval guard, killed and
restored per review-gate/SKILL.md's own Mutant-kill gate discipline.

## Lever 2 -- a cheaper reviewer reasoning-effort tier (requested, honestly not yet consumed)

`src/gate-cadence.js`'s `reviewerReasoningForCount(reviewerCount)` is a new, additive,
deterministic decision alongside `reviewerCountForDiff`: `reviewerCount: 1` (sub-threshold
diff) resolves to `"medium"` reasoning effort, `reviewerCount: 2` (unchanged default) stays
`"high"`. Evidence: `codex/agents.manifest.json`'s own DeepSWE-backed rationale ("Sol/medium
for routine implementation, and Sol/high for hard judgment") -- a single reviewer under the
diff-size threshold is reviewing a well-defined, small, mechanical-scope surface, exactly the
"routine" class that rationale already says medium effort suffices for.
`planGateCadence(waves, { changedLines, reviewDiffThreshold })` folds `reviewerReasoning` into
the SAME result object as `reviewerCount`, wired through `$MUSTER_CLI gate-cadence
<manifest.json> --changed-lines <n>` exactly like `reviewerCount` before it -- a real,
tested, code-backed REQUEST for the cheaper tier, per this item's brief ("wire the fast path
to request the cheaper reviewer tier").

**Honest scoping: this request has no verified per-call consumption mechanism today, in
either harness, and this item does not claim otherwise.** Checked directly:

- Claude Code's Agent/Task tool dispatch has a real, demonstrated per-dispatch override --
  `plugin/skills/orchestrator/SKILL.md`: "always pass the crew member's `model` as the Agent
  tool's `model`" -- but no reasoning-effort parameter alongside it anywhere in this codebase.
- Codex's `model_reasoning_effort` is a STATIC per-agent-profile setting resolved at
  build/install time (`src/codex-release.js`'s `profileToml()`, "the profile TOML is treated
  as the authoritative model, reasoning, and sandbox boundary for a dispatched role" --
  `docs/research/codex-cli.md`), not a runtime, per-call override a diff-size decision could
  reach. `codex/agents.manifest.json`'s `muster-reviewer`/`wsh-code-reviewer` entries are
  already statically pinned to `"high"`; nothing in this item's diff retiers them, and doing
  so would apply to EVERY dispatch of that agent, not just a sub-threshold-diff one.

Given that, crediting lever 2 with a modeled token reduction (as an earlier draft of this
item's own eval script did, assuming a documented output-token cut for "medium" effort) would
be exactly the fabrication this item's brief warns against once a reviewer traced the claim
and found no real consumption path behind it. `eval/perf/replay-fast-path.mjs` now credits
lever 2 with ZERO measured tokens, prints its request explicitly, and states this reasoning
plainly rather than silently dropping the lever or overclaiming its effect. This lever remains
real, tested, wired-through-CLI infrastructure -- a genuine request recorded for a future
consumption path (or a human/Codex operator to apply today) -- not vaporware, just honestly
scoped as not-yet-active on the measured metric.

This changes ONLY how much reasoning budget the SAME reviewer persona is asked to spend, never
which checks it runs, nor which provider/model is dispatched (`src/codex.js` remains an
adapter target, not a second tier resolver) -- criterion 2 is untouched by this lever by
construction, same as lever 1.

## Measured result (`node eval/perf/replay-fast-path.mjs`, this checkout)

```
plugin/skills/router/SKILL.md: 4654 chars
plugin/skills/review-gate/SKILL.md: 7272 chars (before side, unchanged)
plugin/skills/review-gate/fast-path-brief.md: 1936 chars (lever 1, ~73% smaller)

reviewer count: 2 before -> 1 after (lever 2's "medium" reasoning-effort request is NOT
credited with any token reduction here -- see the honest-scoping note above)

per-reviewer-dispatch cost, before: 4118 tokens (skill 1818 + diff 2000 + output 300)
per-reviewer-dispatch cost, after (lever 1 only): 2784 tokens (skill 484 + diff 2000 + output 300)
before: 9800 tokens modeled (router once + 2x reviewer dispatch)
after:  2784 tokens modeled (router skipped + 1x reviewer dispatch, lighter brief)
reduction: 7016 tokens (71.6% reduction, fast path consumes 28.4% of full-pipeline tokens)

MISS -- criterion 3 asks for fast-path consumption <=25% of full-pipeline tokens; measured 28.4%
```

**Real, substantial, honestly-reported improvement from lever 1 alone, not quite at target.**
41.2% -> 28.4% is a genuine ~13-point drop from a measured ~73%-smaller reviewer brief. The
remaining ~3-point gap to 25% is the SAME fixed diff-token allotment (`diffThresholdLines`
pinned to `DEFAULT_REVIEW_DIFF_THRESHOLD`, unchanged by this item, on both the before AND
after side) dominating the after-side cost: at 2,000 of the after side's 2,784 modeled tokens,
the diff allotment alone is close to the whole 25%-of-before budget (2,450 tokens). Closing
the remainder would need either a real, measured change to how much diff a fast-path reviewer
actually reads (not modeled here), a real per-dispatch reasoning-effort consumption mechanism
to honestly credit lever 2, or a smaller, ad hoc diff-size assumption invented specifically to
clear 25% -- the item's own brief explicitly warns against forcing the number, so this is
reported honestly as a named, real gap rather than closed artificially.

## Scope of this cycle

This item lands the lighter fast-path reviewer brief (lever 1, wired through
`src/review-brief.js` + `plugin/skills/review-gate/fast-path-brief.md` +
`plugin/skills/review-gate/SKILL.md` + the new `muster review-brief` CLI command), the
cheaper reasoning-effort tier REQUEST (lever 2, wired through `src/gate-cadence.js`'s
`reviewerReasoningForCount` + `planGateCadence` + `$MUSTER_CLI gate-cadence`, honestly scoped
as not-yet-consumed by any verified dispatch mechanism), the re-measured consumption figure
(28.4%, an honest improvement that still misses the 25% target, with the mechanism explained
above), and the criterion-2 no-scope-reduction proof (construction-level trigger fallback, a
static content-presence check, and a real fixture/mutant demonstration on this item's own new
test guard). Follow-ups explicitly named, not landed here: (1) a real, verified per-dispatch
reasoning-effort override mechanism in either harness, which would let lever 2's real token
effect finally be honestly measured and credited; (2) a real, measured (not assumed) model of
how much diff a fast-path/single-reviewer dispatch actually reads, the only other remaining
lever that could close the last ~3 points without an invented number.
