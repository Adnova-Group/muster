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

**Third-harness datapoint (2026-07-27, kimi v0.29.1): Kimi DOES have a verified per-call
consumption mechanism -- the "either harness" claim above covers Claude Code and Codex only.**
Probed with real, minimal `kimi -p` runs (commands and captured shapes in
`docs/research/kimi-code-cli.md` sec 8's dated probe note): `kimi -p --output-format
stream-json` stdout carries NO usage fields, but every `agents/<agentId>/wire.jsonl` in the
session tree emits one `{"type":"usage.record","model":...,"usage":{"inputOther":N,"output":N,
"inputCacheRead":N,"inputCacheCreation":N},"usageScope":"turn",...}` per LLM step, and each
dispatched subagent gets its OWN wire file (state.json maps agent id -> type/parentAgentId),
so a subagent's wire sum IS that dispatch's token consumption. `src/kimi-receipts.js`
(`parseWireUsage`/`sumUsage`/`readSessionUsage`, fixture-tested in `test/kimi-receipts.test.js`
against trimmed real captures) parses exactly this shape and attributes tokens per dispatch --
so on Kimi the fast-path measurement is no longer model-only: a dispatched reviewer's actual
consumption is readable from the session receipts, and lever 2's cheaper-tier request CAN be
honestly credited there once a run is measured through it. (The remaining gap on Kimi is the
request side symmetric to Codex's: Kimi's per-call override is a two-lane `model` pick --
`src/kimi-dispatch.js`'s `kimiAgentCall` -- not a reasoning-effort dial.)

**Measured per-dispatch datapoint, v2 (2026-07-27, `node eval/kimi-reviewer-tier-probe.mjs`,
protocolVersion 2; results committed at `eval/results/kimi-reviewer-tier-probe-2026-07-27T08-46-46-268Z.json`):
the "once a run is measured through it" above is now measured on a BLINDED protocol, and the cost
hypothesis comes back NEGATIVE again.**

**v1 disclosure (why the first run was discarded).** The v1 run (same day,
`eval/results/kimi-reviewer-tier-probe-2026-07-27T08-01-15-334Z.json`, kept in git history) ran every
cell with cwd = the repo worktree, so the answer key was tool-reachable from inside the cell:
`git log`/`git show` in the cell's own cwd surfaced the follow-up fix commit 3cf6084, the harness's
pinned KNOWN_BLOCKERS sat readable in `eval/kimi-reviewer-tier-probe.mjs`, and prior cells' verdicts
sat in `eval/results/`. The v1 verdict texts show agents reading exactly those before answering (the
primary probe-1 cell opened with `git log --oneline -5 && git show --stat 9027136`; both spec-gate
cells grepped the repo for `model_preference`). v1's caught/missed signals -- and plausibly its token
sums, which include those exploration turns -- are therefore unusable as a measurement of review
ability, and v1 is recorded here only as the reason v2 exists.

**v2 protocol: blinded quarantine + mechanical contamination scan.** Same shape as v1 otherwise: 2
pinned probes x 2 lanes (primary `kimi-code/k3`, secondary `kimi-code/kimi-for-coding`), each cell one
headless `kimi -p --agent-file muster-reviewer.md` process via `kimiProcessDispatch`
(`src/kimi-dispatch.js`), verdicts read from stream-json stdout, tokens attributed per dispatch from
the session's wire.jsonl via `readSessionUsage` (`src/kimi-receipts.js`). What changed: each cell's
cwd is a FRESH temp dir containing ONLY the probe material as a file (probe 1: the full 9027136 diff
as `probe.patch`; probe 2: the synthetic manifest as `probe-manifest.json`), and the briefs -- pinned
constants, byte-identical across lanes -- name that file by relative name and instruct: review ONLY
this material, do not read other files, do not run git commands. After each cell its stream-json
stdout is mechanically scanned for contamination indicators (file reads outside the quarantine dir,
any git show/log/diff command, any path containing the repo name or `eval/results`); a contaminated
cell would be flagged `contaminated: true` in the results JSON and excluded from the quality
comparison (recorded, never hidden), with its tokens still recorded per the cost policy. **No
contamination recurred: all four cells scanned clean (0 indicators), and no cell needed the retry.**
Caught/missed below is HUMAN JUDGMENT applied to each cell's verbatim recorded verdictText against
the pinned rubric, never keyword matching.

| probe | lane | input | output | total | judgment |
| --- | --- | --- | --- | --- | --- |
| review-gate-diff | primary (k3) | 11,391 | 1,893 | 13,284 | MISSED |
| review-gate-diff | secondary (kimi-for-coding) | 10,659 | 5,438 | 16,097 | MISSED |
| spec-gate-manifest | primary (k3) | 9,203 | 1,217 | 10,420 | CAUGHT |
| spec-gate-manifest | secondary (kimi-for-coding) | 8,477 | 6,495 | 14,972 | CAUGHT |
| **lane sums** | primary | 20,594 | 3,110 | 23,704 | 1 of 2 |
| **lane sums** | secondary | 19,136 | 11,933 | 31,069 | 1 of 2 |

Quality, judged in substance against the pinned rubric (decisive quotes verbatim from each cell's
recorded verdictText):

- Probe 1 (review-gate pass over commit 9027136's diff; pinned known blocker: the env-merge
  semantics). BOTH lanes MISSED it. PRIMARY (k3) returned PASS with four MINORs and an explicit
  "All 17 regex assertions in the new test were cross-checked by hand against the exact paragraph
  text added to SKILL.md ... every one matches; no BLOCKER found" -- a careful review that never
  questioned the "spawned straight from the descriptor's `{ argv, env, cwd, lane }`" prose.
  SECONDARY (kimi-for-coding) returned a bare "PASS". Honest caveat on this cell: the pinned blocker
  is only partially verifiable from inside the quarantine -- the prose is flaggable as ambiguous on
  its face (it never states the merge rule), but confirming the failure mode requires knowing
  `kimiLaneEnv()` returns exactly two keys, which lives in `src/kimi.js`, deliberately out of reach.
  A blinded catch was possible; it happened in neither lane.
- Probe 2 (spec-gate pass over the synthetic manifest; expected FAIL naming the model_preference
  misattribution). BOTH lanes CAUGHT it, blinded, from the manifest alone. PRIMARY:
  "`model_preference` stamped on an `--agent-file` agent does NOT engage the `-p` process's model
  lanes ... the headless leg's model is chosen by the dispatcher via the `-m` flag." SECONDARY:
  "the model lane is selected by the `-m` flag, not by agent-file metadata; the dispatch must
  include `-m <model>` to run on the intended model."

Two MINOR disclosures, carried from this item's review and applying to every token comparison above:

- **Not effort-matched, and token-count is not price.** The secondary lane (kimi-for-coding) is
  always-thinking with no knob to reduce it, and primary (k3) ran at high -- the lanes are not
  effort-matched. And in v1 ~90% of the input delta was `inputCacheRead` (cache reads are not
  priced like fresh input), so v1's "~2.1x" was a token COUNT, never a price. The same applies to
  v2's "~1.3x" -- and in v2 the delta is not even input-side: secondary's input is slightly LOWER
  than primary's, and its extra ~7.4k total tokens are almost entirely OUTPUT (11,933 vs 3,110,
  i.e. thinking tokens).
- **Brief artifact possible on probe 1.** The probe brief is neutral ("review the diff for
  correctness and completeness"); the original catching review of this very blocker ran under a
  different, adversarial gate brief. Probe-1 catch/miss versus that original gate may therefore be
  a brief artifact, not a lane-capability difference.

n=1 caveat, recorded verbatim in the results JSON: each probe x lane cell ran exactly once (plus at
most one retry on failure, unused here). No statistical power; caught/missed and token deltas are
directional signals, not measurements of a distribution.

**ROUTING RECOMMENDATION: no gate legs move to the secondary lane -- unchanged from v1, and now
standing on uncontaminated data.** The execution lane was not cheaper on identical blinded briefs:
31,069 vs 23,704 total tokens (~1.3x), the delta driven almost entirely by thinking-side output.
Quality at n=1 was a dead wash: both lanes caught probe 2, both missed probe 1 blinded -- nothing
here argues for demoting judgment work to the execution lane, and nothing excuses the cost premium.
Lever 2's cheaper-tier request therefore stays honestly uncredited on Kimi too: the per-dispatch
measurement mechanism exists and demonstrably works (this datapoint IS that mechanism running end to
end), but the tier it would route to showed no token advantage in this probe. Follow-ups, named not
landed: (1) repeat the probe for statistical power before any retiering is reconsidered -- the
harness is rerunnable by construction; (2) probe 1's blinded miss in BOTH lanes says the pinned
env-merge blocker is hard to see without repo context -- if that bug class matters, the gate brief
should name the invariant to check rather than hope the reviewer infers it.

**Measured effort-setting datapoint (2026-07-27, `node eval/kimi-reviewer-tier-probe.mjs --mode effort`,
protocolVersion 2; results committed at `eval/results/kimi-reviewer-tier-probe-effort-2026-07-27T09-47-01-703Z.json`):
K3's effort knob IS per-call consumable, receipt-proven -- and at n=1, low shows quality parity with high
at ~7% fewer total tokens.** Same blinded quarantine protocol as the v2 tier datapoint above, but the two
pinned probes run on lane=primary (kimi-code/k3) ONLY, each TWICE -- once at thinking effort low, once at
high. Mechanism: there is no per-invocation effort flag; `KIMI_MODEL_THINKING_EFFORT` is read per-process
from env and overrides config `[thinking].effort`, so each cell sets it via the same spawnEnv merge rule
(`{...process.env, ...descriptor.env}` -- never wholesale). Because the override is conditional and can be
silently ignored, every cell PROVES its effort from receipts: the `thinkingEffort` field on the session
wire.jsonl `llm.request` records (`src/kimi-receipts.js`'s `readSessionThinkingEfforts`), and a cell is
valid only when EVERY step's receipt shows the intended effort. **All four cells receipt-proved their
intended effort (2/2 llm.request steps each: low/low on the low cells, high/high on the high cells), no
cell was invalid (effortValid:false), no cell needed the retry, and the contamination scan came back clean
on all four (0 indicators).** Caught/missed below is HUMAN JUDGMENT applied to each cell's verbatim
recorded verdictText against the pinned rubric, never keyword matching.

| probe | effort | input | output | total | effortValid | judgment |
| --- | --- | --- | --- | --- | --- | --- |
| review-gate-diff | low | 11,391 | 1,152 | 12,543 | valid (2/2 receipts low) | MISSED |
| review-gate-diff | high | 11,392 | 2,445 | 13,837 | valid (2/2 receipts high) | MISSED |
| spec-gate-manifest | low | 9,203 | 655 | 9,858 | valid (2/2 receipts low) | CAUGHT |
| spec-gate-manifest | high | 9,204 | 1,094 | 10,298 | valid (2/2 receipts high) | CAUGHT |
| **effort sums** | low | 20,594 | 1,807 | 22,401 | 2 of 2 | 1 of 2 |
| **effort sums** | high | 20,596 | 3,539 | 24,135 | 2 of 2 | 1 of 2 |

Quality, judged in substance against the pinned rubric (decisive quotes verbatim from each cell's
recorded verdictText):

- Probe 1 (review-gate pass over commit 9027136's diff; pinned known blocker: the env-merge semantics).
  MISSED at BOTH efforts, blinded -- the same blinded miss the v2 tier probe recorded at high. LOW returned
  PASS with two MINORs and an explicit "No correctness defects found in the diff" after hand-checking every
  test regex against the SKILL.md paragraph; HIGH returned PASS with three MINORs (a genuinely sharper
  surface read -- it flagged the new test's unshown `readFile` import and the unproven enclosing heading)
  and the same closing "No correctness defects found in the diff material." Neither effort questioned the
  "spawned straight from the descriptor's `{ argv, env, cwd, lane }`" prose -- consistent with the v2
  caveat that this blocker is only partially verifiable from inside the quarantine.
- Probe 2 (spec-gate pass over the synthetic manifest; expected FAIL naming the model_preference
  misattribution). CAUGHT at BOTH efforts, blinded, from the manifest alone. LOW: "misattributed mechanism:
  a model_preference stamped inside an agent file is advisory frontmatter for the agent definition, not a
  selector for the CLI process's model lane; a headless `-p` invocation without an explicit model flag
  falls back to the CLI's configured/default model." HIGH: "in headless `kimi -p` mode the session model is
  selected by CLI config / the `-m/--model` flag, and agent-file frontmatter does not re-lane the running
  process; the correct mechanism is to pass `-m <model>` explicitly." Both named the correct mechanism in
  substance; HIGH's verdict was the more falsifiability-minded of the two (it added the "probe cannot
  falsify its own hypothesis" BLOCKER), but the pinned rubric asks caught/missed, and both caught.

Cost: low spent 22,401 total tokens against high's 24,135 -- 1,734 fewer (~7.2%), and the delta is
ENTIRELY output-side (1,807 vs 3,539 output tokens, a ~49% cut in thinking-side output; input is a wash at
20,594 vs 20,596, the same briefs and quarantine material producing the same cache profile). Token-count is
not price, the same disclosure the tier datapoint carries -- ~5.6k of each cell's input is
`inputCacheRead`.

n=1 caveat, recorded verbatim in the results JSON: each probe x effort cell ran exactly once (no retry
used). No statistical power; caught/missed and token deltas are directional signals, not measurements of a
distribution.

**KEEP-OR-CHANGE RECOMMENDATION: KEEP `high` as the prime-tier (judgment lane) effort in `src/kimi.js`'s
KIMI_TIERS today -- not because low degraded (it did not), but because this probe contains no discriminating
cell.** Quality at n=1 was a dead wash: both efforts caught probe 2 with the correct mechanism named, both
missed probe 1 blinded -- so the data shows NO quality regression at low and a real ~7% token saving, which
makes retiering prime to low a legitimate candidate. But the one cell that could have demonstrated a
low-effort quality drop (probe 1, where a catch would discriminate) was missed at BOTH efforts, leaving no
observation of low failing where high succeeds -- and at n=1 the parity result is a directional signal, not
a measurement. The change itself, if a repeated probe confirms the parity, is a named FOLLOW-UP item (flip
`KIMI_TIERS.prime.effort` from `"high"` to `"low"` in `src/kimi.js`), not this one: this item records the
datapoint only. What this datapoint DOES settle: the effort knob is per-call consumable and receipt-provable
end to end (env var in, per-step `thinkingEffort` receipts out), so lever 2's cheaper-tier request now has
a verified consumption mechanism on the effort dimension, not just the two-lane model pick.

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
