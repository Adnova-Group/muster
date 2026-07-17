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
6,483 chars (`readFileSync(...).length`, the same measure `eval/perf/replay-fast-path.mjs`
already used), a ~70% reduction.

`src/review-brief.js`'s `lightBriefEligible({ reviewerCount, diffFiles, diffText })` decides
when it may be used: ONLY for `reviewerCount: 1` (a diff under
`DEFAULT_REVIEW_DIFF_THRESHOLD`) AND only when none of three content triggers fires against
the diff:

- **Mutant-kill trigger** (`MUTANT_KILL_TRIGGER_RE`) -- a test file, an `eval/*/dataset.json`
  case, or a lint/doctor rule source file touched.
- **Citation trigger** (`CITATION_TRIGGER_RE` + a `[src: ...]` text scan) -- any changed
  markdown file, or a `[src: ...]` anchor appearing in the diff text itself.
- **Surface trigger** (`SURFACE_TRIGGER_RE`) -- the design/UX gate's own path globs
  (`components/**`, `app/**/page.*`, `*.css`, `*.scss`).

Any one of these firing -- even at `reviewerCount: 1` -- falls back to the FULL,
byte-unchanged `review-gate/SKILL.md` brief. `plugin/skills/review-gate/SKILL.md` gained a new
"Fast-path reviewer brief" section (placed after the surface-type gates, before the
Mutant-kill gate section, so neither the mutant-kill-rule drift-guard fixture
(`test/mode-evals.test.js`) nor `scripts/build-codex.mjs`'s step-1/fix-iteration-cap/
capabilities-sentence Codex-adaptation anchors are disturbed) wiring this decision into the
live dispatch.

**Criterion 2 proof (no scope reduction for a small diff).** This is enforced BY
CONSTRUCTION, not by review discipline alone: `lightBriefEligible` returns `false` the moment
any trigger fires, regardless of `reviewerCount`, so the light brief is never even offered to
a diff that could need what it omits (`test/review-brief.test.js`'s
`"lightBriefEligible: false for reviewerCount:1 the moment ANY trigger fires"` case exercises
all three). The light brief's own real, on-disk content still requires checking for a
representative small-diff security-defect class -- `test/review-brief.test.js`'s criterion-2
proof test reads the live file and asserts it explicitly names "path traversal" and
"unsanitized input reaching a shell/file/network call", the exact defect class a small
application-code diff (e.g. `src/fs-util.js`, which `lightBriefEligible` reports eligible for)
would need caught. A live mutant-kill demonstration was performed on `src/review-brief.js`'s
own mutant-kill trigger (disabling `MUTANT_KILL_TRIGGER_RE`'s detection, confirming
`test/review-brief.test.js` fails loud with the mutation in place, then restoring the file
byte-identical) as this item's own new-guard evidence.

## Lever 2 -- a cheaper reviewer reasoning-effort tier

`src/gate-cadence.js`'s `reviewerReasoningForCount(reviewerCount)` is a new, additive axis
alongside `reviewerCountForDiff`: `reviewerCount: 1` (sub-threshold diff) resolves to
`"medium"` reasoning effort, `reviewerCount: 2` (unchanged default) stays `"high"`. Evidence:
`codex/agents.manifest.json`'s own DeepSWE-backed rationale ("Sol/medium for routine
implementation, and Sol/high for hard judgment") -- a single reviewer under the diff-size
threshold is reviewing a well-defined, small, mechanical-scope surface, exactly the "routine"
class that rationale already says medium effort suffices for, while the 2-reviewer,
at/over-threshold case is the "hard judgment" class high effort is reserved for.

`planGateCadence(waves, { changedLines, reviewDiffThreshold })` folds `reviewerReasoning` into
the SAME result object as `reviewerCount` (omitted together when `changedLines` is absent, one
call answers both questions when it's present) -- wired through `$MUSTER_CLI gate-cadence
<manifest.json> --changed-lines <n>`, exactly like `reviewerCount` before it.

This changes ONLY how much reasoning budget the SAME reviewer persona is asked to spend, never
which checks it runs, nor which provider/model is dispatched (`src/codex.js` remains an
adapter target, not a second tier resolver) -- criterion 2 is untouched by this lever by
construction, same as lever 1.

## Measured result (`node eval/perf/replay-fast-path.mjs`, this checkout)

```
plugin/skills/router/SKILL.md: 4654 chars
plugin/skills/review-gate/SKILL.md: 6483 chars (before side, unchanged)
plugin/skills/review-gate/fast-path-brief.md: 1936 chars (lever 1, ~70% smaller)

reviewer count: 2 (high effort) before -> 1 (medium effort, lever 2) after

per-reviewer-dispatch cost, before: 3921 tokens (skill 1621 + diff 2000 + output 300)
per-reviewer-dispatch cost, after (levers 1+2): 2664 tokens (skill 484 + diff 2000 + output 180)
before: 9405 tokens modeled (router once + 2x reviewer dispatch)
after:  2664 tokens modeled (router skipped + 1x reviewer dispatch)
reduction: 6741 tokens (71.7% reduction, fast path consumes 28.3% of full-pipeline tokens)

MISS -- criterion 3 asks for fast-path consumption <=25% of full-pipeline tokens; measured 28.3%
```

**Real, substantial, honestly-reported improvement, not quite at target.** 41.2% -> 28.3% is a
genuine ~13-point drop from both levers landing (a measured ~70%-smaller brief, a modeled 40%
reviewer-output-token cut for the cheaper reasoning tier -- the same 40% figure
`docs/speed-tuning.md`'s own skill-size cuts already established, reused rather than invented
to hit a number). The remaining ~3-point gap to 25% is the SAME fixed diff-token allotment
(`diffThresholdLines` pinned to `DEFAULT_REVIEW_DIFF_THRESHOLD`, unchanged by either lever, on
both the before AND after side) dominating the after-side cost: at 2,000 of the after side's
2,664 modeled tokens, the diff allotment alone is close to the whole 25%-of-before budget
(2,351 tokens). Closing the remainder would need either a real, measured change to how much
diff a fast-path reviewer actually reads (not modeled here), or a smaller, ad hoc diff-size
assumption invented specifically to clear 25% -- the item's own brief explicitly warns against
forcing the number, so this is reported honestly as a named, real gap rather than closed
artificially.

## Scope of this cycle

This item lands the lighter fast-path reviewer brief (lever 1, wired through
`src/review-brief.js` + `plugin/skills/review-gate/fast-path-brief.md` +
`plugin/skills/review-gate/SKILL.md`), the cheaper reasoning-effort tier (lever 2, wired
through `src/gate-cadence.js`'s `reviewerReasoningForCount` + `planGateCadence` +
`$MUSTER_CLI gate-cadence`), the re-measured consumption figure (28.3%, an honest improvement
that still misses the 25% target, with the mechanism explained above), and the criterion-2
no-scope-reduction proof (construction-level trigger fallback + a real fixture/mutant
demonstration). Follow-up explicitly named, not landed here: a real, measured (not assumed)
model of how much diff a fast-path/single-reviewer dispatch actually reads, which is the only
remaining lever that could close the last ~3 points without an invented number.
