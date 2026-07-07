# Mode-prompt eval harness

An empirical eval of the 8 mode prompts (`plugin/commands/*.md`: `plan`, `plan-backlog`,
`go`, `go-backlog`, `runner`, `audit`, `diagnose`, `capture`) plus the 3 legacy alias
stubs that delegate to them (`run` -> `plan`, `autopilot` -> `go`, `sprint` ->
`go-backlog` — thin 8-line files graded structurally, not via dataset cases; see "Alias
stubs" below), the 10 skill-protocol skills they delegate to (`plugin/skills/*` —
`orchestrator`, `review-gate`, `coordination`,
`interview`, `tournament`, `domain-router`, `advisor`, `greenfield`, `prd-pipeline`,
`roadmap-prioritization`; `router` is excluded, it already has its own `eval:router`),
the 7 native-builtin pipeline-role providers (`plugin/builtins/muster-*/SKILL.md` —
`muster-research`, `muster-image`, `muster-video`, `muster-humanizer`, `muster-scorer`,
`muster-prompt-smith`, `muster-author`; the vendored `gsd-*`/`sp-*`/`wsh-*` builtins are
generic technique skills, not muster's own pipeline-role prompts, and are out of scope),
**and** all 20 pipeline phase prompts (`pipelines/*.yaml`), split into two layers: 9
content pipelines (`blog-post`, `social-post`, `newsletter`, `case-study`, `lead-magnet`,
`release-notes`, `video-content`, `executive-summary`, `competitive-battlecard`) and 11
knowledge/software pipelines (`ai-implementation-spec`, `ai-test-plan`, `book`,
`business-case`, `epic`, `launch-plan`, `okrs`, `prd`, `roadmap`, `runbook`,
`user-story`). Like `eval/router`, this measures **response quality** against
deterministic assertions, so future edits to a mode prompt, a skill, a native builtin, or
a pipeline phase get regression-graded instead of only structurally linted (`muster prompt
lint`).

## Why (and how) this is code-gradeable without a model

`eval/router` grades a single artifact per case: the manifest a live router run produced.
The modes don't reduce to one artifact each — but several of their steps are themselves
deterministic pipeline code, not model output:

| mode step | deterministic surface |
|---|---|
| plan/go step 0 (issue ref?) | `parseIssueRef` (`src/issue.js`) |
| plan-backlog step 0b (backlog ref? — batch-plan mode) | `parseBacklogRef` (`src/batch-plan.js`) |
| plan-backlog's conflict flags | `crossItemConflicts` (`src/batch-plan.js`) |
| plan-backlog's drain ordering | `computeSprintWaves` (`src/sprint-waves.js`), the same authoritative call go-backlog makes |
| plan/go info-gap check | `assessOutcome` (`src/interview.js`) |
| diagnose step 1 (seed) | `classifyFailure` + `buildDiagnoseManifest` (`src/diagnose.js`) |
| audit step 1 (seed) | `buildAuditManifest` (`src/audit.js`) |
| any manifest (plan/go/diagnose/audit) | `validateManifest` (`src/manifest.js`) |
| go-backlog's backlog consumption | `computeSprintWaves` (`src/sprint-waves.js`) |
| runner's disposition/commit conventions | regexes we own in `grade-lib.mjs` (`WAVE_COMMIT_RE`, `RECEIPT_PATTERNS`), encoding the literal grammar `coordination/SKILL.md` and `go.md` document |

(Historical note: these `check` names — `sprint-waves`, `sprint-one-attended-stop` in
`grade-lib.mjs`, and the `run`/`sprint` prefixes in some fixture paths carried over
before the vl-t6 mode migration — are unchanged grader/fixture identifiers, not mode
names; they still name the real deterministic functions/fixtures they always did.)

The skill-protocol layer extends the same rule — most skills wrap a deterministic
function too, reused directly rather than re-implemented as a fixture-only check:

| skill step | deterministic surface |
|---|---|
| review-gate's tally | `tallyReview` (`src/review.js`) — ANY blocker escalates, not majority |
| tournament's fusion decision | `validateFusionMap` + `fuse` (`src/fusion.js`) |
| domain-router's classify + route | `classifyDomain` (`src/domain.js`), `routePipeline`/`pickPipeline` (`src/pipeline.js`) |
| advisor's request/response/budget | `validateAdviceRequest`, `validateAdviceResponse`, `consultBudget` (`src/advisor.js`) |
| prd-pipeline's gate | `validatePipeline` (`src/pipeline.js`), `scoreArtifact` (`src/score.js`) — floor-principle math |
| roadmap-prioritization's ranking | `prioritizeRICE` (`src/prioritize.js`) — "code does the math, not the model" |
| interview's measurability gate | `assessOutcome` (`src/interview.js`), plus `computeSprintWaves` for the decomposition-check's per-item text |
| greenfield's checkbox plan | `computeSprintWaves` (`src/sprint-waves.js`) — same generic `- [ ]` grammar sprint.md consumes |
| orchestrator's brief contracts, review-gate's verdict shape, coordination's claim-window race | no `src/*.js` home (documented protocol/prose, not shipped code) — encoded directly in `grade-lib.mjs` as `orchestratorBriefCheck`/`reviewGateVerdictCheck`'s regexes and `MUSTER_RECEIPT_PATTERNS`/`computeClaimWindows`, the same precedent `WAVE_COMMIT_RE`/`RECEIPT_PATTERNS` already set for the 6-mode layer |
| greenfield's scaffold shape | `SCAFFOLD_SEED_FILES` in `grade-lib.mjs` — a literal copy of `src/setup.js`'s seed-file contract; `scaffoldProject` itself does real filesystem I/O and isn't callable from a no-IO grader (documented limitation beside the constant) |

The content-pipeline layer extends the rule a third time — every pipeline shares a real
`gate: {criteria, floor, pass_total}` and a `humanize` phase, so the SAME functions the
skill-protocol layer already reused parameterize over any of the 9 pipelines' own yaml,
not just prd's:

| pipeline step | deterministic surface |
|---|---|
| any pipeline's gate | `scoreArtifact` (`src/score.js`) — the identical floor-principle math `prd-gate-achievability` already used, now dispatched as `gate-achievability` and fed each pipeline's own real `gate` object (`release-notes`, `executive-summary`) |
| a research phase's inline claims | `checkCitations` (`src/citation-guard.js`) — `blog-post`'s E-E-A-T sources, `competitive-battlecard`'s "(cited)" competitor facts |
| the terminal humanize phase | `scoreHumanness` (`src/humanizer-score.js`) — `video-content`'s AI-tell floor |
| case-study's synthesis-phase evidence table | no `src/*.js` home (a pipeline-yaml-documented row schema, not shipped code) — `EVIDENCE_ROW_RE` in `grade-lib.mjs` encodes the yaml's own `{quote,metric,fact,decision,action}` row-type + column contract, same precedent as `LEDGER_LINE_RE` |
| newsletter's curate-phase cross-run signal diff | no `src/*.js` home — `SIGNAL_NEW_RE`/`SIGNAL_CHANGED_RE`/`SIGNAL_SUMMARY_RE` in `grade-lib.mjs` encode the yaml's documented "unchanged signals collapse to one summary line" rule |
| the optional publish phase's packet | no `src/*.js` home — `publishPacketShapeCheck` in `grade-lib.mjs` grades the artifact-path/image-prompts/metadata/visual-verify/checklist/action-fence shape the yaml documents (`lead-magnet`) |
| the resolved audience profile's banned-jargon list | no `src/*.js` home — `audienceVoiceJargonCheck` reuses the real `escapeRe` (`src/keyword.js`, the same helper `pickPipeline`'s own keyword matching relies on) to scan a draft against the profile's list (`social-post`) |

`capture` (the 7th mode prompt) extends the rule a fourth time — three of its five
documented rules reuse a REAL function already imported above, and the other two (no
`src/*.js` home, protocol prose) are encoded directly, same precedent as `WAVE_COMMIT_RE`:

| capture.md step | deterministic surface |
|---|---|
| step 2's reword-cap → UNMEASURABLE surfacing | `assessOutcome` (`src/interview.js`) run over every reword attempt — the same gate run.md's own vague-outcome cases already grade |
| step 3's dedupe (annotations stripped generically) | no `src/*.js` home (`src/sprint-waves.js`'s own `stripAnnotations` isn't exported) — `stripAnnotationsForDedupe` in `grade-lib.mjs` copies its documented grammar literally |
| step 1's exclusions block + cap-10 holdback arithmetic, step 4's approval-precedes-write ordering | no `src/*.js` home (documented protocol, not shipped code) — `captureExclusionsCheck`/`captureCapHoldbackCheck`/`captureApprovalOrderCheck` in `grade-lib.mjs` |

The native-builtin layer (`plugin/builtins/muster-*/SKILL.md`, the 7 built-in
pipeline-role providers) extends the rule a fifth time — most of these are assembled
prose with no `src/*.js` home (graded structurally, same tier as `orchestrator-brief`),
but two genuinely reuse real code:

| builtin | deterministic surface |
|---|---|
| muster-research's document-ingestion fact ledger | reuses `evidence-table-shape` directly — its `{fact, anchor, confidence, needs_review}` row IS a `fact`-typed evidence-table row, same schema `EVIDENCE_ROW_RE` already encodes |
| muster-scorer's stated 0–3 score contract | `scorerVerdictShapeCheck` adds the integer-range check `scoreArtifact` (`src/score.js`) alone doesn't enforce, then delegates the floor-principle pass/fail to that same REAL function |
| muster-prompt-smith's `muster prompt optimize` proposal shape | `selectWinner` (`src/prompt-optimize.js`) — the exact function the CLI wraps, graded directly for its `{winner, winnerPrompt, regression, escalate, ranking}` shape |
| muster-image's prompt-set shape, muster-video's shot-list rows, muster-humanizer's voice-profile-precedes-generic ordering, muster-author's framework+CTA shape | no `src/*.js` home (assembled prose) — `imagePromptSetShapeCheck`/`videoShotListShapeCheck`/`humanizerPrecedenceCheck`/`authorDraftShapeCheck` in `grade-lib.mjs` |

The knowledge-pipeline layer (`pipelines/*.yaml`'s remaining 11 — the ones not already in
the content-pipeline layer above) reuses `gate-achievability` for every pipeline's own
real gate, plus one structural check per pipeline where its own yaml pins something
deterministic (several reuse a function already established above rather than adding a
new grader):

| pipeline | structural surface |
|---|---|
| epic's breakdown phase (story-splitting sequenced by risk+dependency) | reuses `sprint-waves`/`computeSprintWaves` directly — the same generic `{id}`/`{deps}` checkbox grammar greenfield's plan already reuses |
| okrs's key-results phase ("Verb + Metric from X to Y by Date") | reuses `assess`/`assessOutcome` directly — a real KR line clears the same measurability gate run.md's vague-outcome cases grade |
| roadmap's prioritize phase ("run the deterministic RICE scorer") | reuses `roadmap-rice`/`prioritizeRICE` directly — the same real function the roadmap-prioritization skill layer already grades |
| prd's intake phase (`{decision\|action\|fact, owner, deadline, source-anchor}` rows) | reuses `evidence-table-shape` directly — the unowned-action-flagging rule is prd.yaml's own words, verbatim |
| runbook's steps phase (numbered, copy-pasteable, expected-output-per-step) | no `src/*.js` home — `runbookStepPairsCheck` |
| book's continuity-ledger chapter manifest (sequential, status-tracked) | no `src/*.js` home — `bookChapterManifestCheck` |
| ai-test-plan's cases phase (risk-tiered happy/boundary/negative/security table) | no `src/*.js` home — `aiTestPlanCaseTableCheck` |
| user-story's acceptance phase (Given/When/Then Gherkin, happy + 2 edge/negative) | no `src/*.js` home — `userStoryGherkinShapeCheck` |
| ai-implementation-spec's adr phase (MADR 4.0 status lifecycle) | no `src/*.js` home — `adrStatusLifecycleCheck` |
| business-case, launch-plan | **skipped honestly** — gate-achievability is graded, but neither pipeline's phase prose pins a literal row/table grammar beyond its gate criteria names (business-case's financials/roi are numeric asks with no fixed shape; launch-plan names "RACI" only as a gate-criterion label, never a documented table format) — see the coverage table below |

A case whose behavior lives in one of those functions grades **directly against the real
code path** — no fixture, no manual step, the cheapest tier (code >> model >> human, per
`src/prompt-eval.js`'s stated order). A case whose behavior is genuinely the *model's*
output (the router's crew choice inside run/autopilot, a runner's actual claim/receipt
trail, an orchestrator's rendered dispatch brief, a reviewer's rendered verdict, a
coordination comment thread) grades a **checked-in fixture artifact** instead (see
"Producing artifacts" below).

## Case shape

```jsonc
{
  "id": "plan-parallel-manifest-fences",     // unique
  "mode": "plan",                            // one of the 8 mode prompts (MODES, incl. capture — NEVER an alias name; run/autopilot/sprint are graded structurally, see "Alias stubs" below), one of the 10 skill names (SKILLS), one of the 7 native-builtin names (BUILTINS), OR one of the 20 pipeline ids split across CONTENT_PIPELINES (9) and KNOWLEDGE_PIPELINES (11) — see test/mode-evals.test.js. A single field, all five layers share it (grade.mjs, frozen, calls `.padEnd()` on `row.mode` unconditionally)
  "outcome": "Add JWT auth to the API and update the docs, in parallel.", // the user input this case models (also the literal string fed to a pure fn, when `check` reads `outcome` directly)
  "check": "manifest",                       // which grade-lib.mjs grader to dispatch to
  "artifact": "fixtures/plan/manifest-parallel.json", // OPTIONAL: path (relative to eval/modes/) to a checked-in fixture
  "input": "…",                              // OPTIONAL: inline data in place of a fixture file (short backlog/receipts snippets)
  "expect": { "validates": true, "requireFences": true, "expectRoles": ["implement", "test-author"], "nonInline": true },
  "grading": "code"                          // OPTIONAL, default "code". "model" cases carry a `rubric` instead of a gradeable `expect` and are excluded from the CI path.
}
```

- `outcome` is always the human-readable "what the user typed" — for `check`s that read
  it directly (`diagnose-classify`, `diagnose-manifest`, `assess`, `issue-ref`) it IS the
  literal input to the pure function; for fixture/`input`-graded checks it documents the
  scenario the fixture represents.
- `artifact` XOR `input` supplies the concrete data for checks whose `ARTIFACT_KIND` (see
  `grade-lib.mjs`) is `"text"` or `"json"`; checks whose kind is `"none"` need neither —
  they're computed purely from `outcome`. The skill-protocol layer's `"json"`-kind checks
  (tournament/domain-router/advisor/prd-pipeline/roadmap-prioritization/interview) always
  use `artifact` (a small checked-in fixture file under `fixtures/skills/<skill>/`), same
  convention the mode layer's `manifest` check already used — never inline `input` for
  `"json"` kind, to keep `dataset.json` free of hand-escaped JSON-in-JSON. The
  content-pipeline layer's `"json"`-kind checks (`gate-achievability`,
  `publish-packet-shape`, `audience-voice-jargon`) follow the same rule, under
  `fixtures/pipelines/<pipeline>/`; its `"text"`-kind checks (`citation-check`,
  `humanizer-score`, `evidence-table-shape`, `signal-diff-baseline`) use small
  markdown fixtures there too, mirroring `fixtures/audit/ledger.md`'s convention.
- `expect` fields are per-`check` (documented as comments beside each grader function in
  `grade-lib.mjs`); every field present adds one assertion. Every dataset case's `expect`
  is a **golden claim about correct behavior** (including cases whose correct behavior is
  rejection — e.g. `go-backlog-cycle-detected-stops-nothing-runs` expects `ok:false`). Pass/fail
  behavior of the *grader itself* (does it correctly flag a malformed fixture) is unit
  tested directly in `test/mode-evals.test.js`, not via dataset cases.
- `grading: "model"` cases carry a `rubric` (mirroring `eval/router`'s dataset shape) and
  an empty/absent `expect` — a subjective quality judgment (is this root cause *actually*
  right, is this routing *actually* sensible) that no code check can make. They are listed
  by `grade.mjs` but never graded by it, and `test/mode-evals.test.js` skips them entirely.

## Files

- `dataset.json` — the cases (see shape above).
- `grade-lib.mjs` — the composing entry: `gradeCase(testCase, artifacts) -> { pass, checks: [{name, ok, detail}] }`, plus the merged `CHECKS`/`ARTIFACT_KIND` dispatch tables. No IO — callers load artifacts. Its per-check grading logic lives in four layer modules (below) plus `grade-core.mjs`'s cross-layer helpers (`rowFormatCheck`, `gateAchievabilityCheck`); `grade-lib.mjs` re-exports every name any layer module (or `src/coordination.js`) has ever publicly exported, so `grade.mjs`/`test/mode-evals.test.js` see one stable public API regardless of which module a check's implementation actually lives in.
  - `grade-core.mjs` — cross-layer helpers used by 2+ layer modules below.
  - `grade-modes.mjs` — the verb-prompt mode layer (diagnose/audit/plan/plan-backlog/go/go-backlog's deterministic steps — file/check names inside this module still say `run`/`sprint` in places, e.g. `sprint-waves`, since those are grader/fixture identifiers, not mode names; see the "Why (and how)" historical note above).
  - `grade-skills.mjs` — the skill-protocol layer (`plugin/skills/*`, router excluded).
  - `grade-pipelines.mjs` — the content-pipeline + knowledge-pipeline layers (`pipelines/*.yaml` phase prompts).
  - `grade-builtins.mjs` — the native-builtin layer (`plugin/builtins/muster-*/SKILL.md`).
- `grade.mjs` — CLI report: loads `dataset.json`, resolves each code-graded case's artifacts, grades, prints the per-case + aggregate report (mirrors `eval/router/grade.mjs`).
- `fixtures/` — checked-in golden artifacts for the cases whose behavior is genuinely model-driven:
  - `plan/manifest-parallel.json`, `plan/manifest-single.json` — example valid Crew Manifests (parallel-with-fences, and single-task); also reused by the `go` mode's own manifest case (`go-manifest-validates-non-inline`) — `go`'s hands-off manifest-validation step is the identical `plan`-front-half behavior, so it shares the fixture rather than duplicating it.
  - `plan-backlog/batch-owns-overlap.json`, `plan-backlog/batch-owns-disjoint.json` — `crossItemConflicts` inputs (an overlapping fence pair, and a disjoint set with one unfenced item).
  - `sprint/backlog.md` + `sprint/waves.json` — an `{id}`/`{deps}`-annotated backlog and its `computeSprintWaves` output (the `waves.json` values are pinned into `dataset.json`'s `expect.waves` too, so a `computeSprintWaves` regression fails the eval, not just the fixture record); shared by both `plan-backlog`'s drain-ordering case and `go-backlog`'s own wave case, since they exercise the exact same authoritative computation.
  - `sprint/state-batch-report.md` — a run STATE excerpt demonstrating the "one attended stop" protocol invariant.
  - `runner/receipts-claim-done.md`, `runner/receipts-blocked-resume.md` — `## Coordination` receipt trails.
  - `audit/ledger.md` — a findings ledger (severity/location/problem/fix).
  - `audit/backlog.md` — an audit backlog-mode write, checked for wave-parseability.
  - `skills/` — the skill-protocol layer's fixtures, two categories:
    - **Genuinely model-produced artifacts** (mirrors the categories above): `orchestrator/brief-*.md` (rendered dispatch briefs), `review-gate/verdict-*.md` (rendered reviewer verdict + findings), `coordination/claim-*.md` (Binding A GitHub-issue-style `MUSTER ...` comment threads), `greenfield/plan-*.md` + `greenfield/scaffold-report-*.json` (a bootstrap checkbox plan and a `muster setup` result).
    - **Deterministic function-input fixtures** (small, hand-authored to hit a specific branch of a real `src/*.js` function — same spirit as the 6-mode layer's inline `sprint-waves`/`runner-receipts` `input` snippets, just as checked-in files per the `"json"`-kind convention above): `tournament/*.json` (candidates + fusion maps for `fuse`), `domain-router/*.json` (`classifyDomain`/`routePipeline` inputs), `advisor/*.json` (request/response/budget shapes), `interview/enriched-outcome-approved.json`, `prd-pipeline/*.json` (a real-`prd.yaml`-shaped pipeline object + 3 gate-score scenarios), `roadmap-prioritization/*.json` (RICE item arrays).
  - `pipelines/` — the content-pipeline layer's fixtures, one **passing + one violating
    ("corrupt-twin") variant per graded property**, hand-authored to hit a specific pipeline
    phase's documented rule (no live pipeline run backs these, same posture as the
    deterministic function-input fixtures above):
    - `blog-post/citations-clean.md` + `citations-dangling-anchor.md`, `competitive-battlecard/citations-clean.md` + `citations-dangling-anchor.md` — research-phase `[src: x]` citations for `checkCitations`.
    - `social-post/audience-voice-clean.json` + `audience-voice-jargon-violation.json` — a resolved audience profile's `bannedJargon` list plus a clean/violating draft.
    - `newsletter/signal-diff-clean.md` + `signal-diff-violation.md` — the curate phase's cross-run diff report (dated NEW/CHANGED lines, one unchanged-summary line) vs. its violation (per-item unchanged re-reporting).
    - `case-study/evidence-table-clean.md` + `evidence-table-unowned-action.md` — the synthesis-phase evidence table (`{quote,metric,fact,decision,action}` rows) vs. an unowned/undated `action` row (flagged, not silently dropped).
    - `lead-magnet/publish-packet-clean.json` + `publish-packet-missing-checklist.json` — the optional publish phase's packet (artifact path + image prompts + metadata + visual-verify + checklist + action-fence stop) vs. an incomplete one that also fails to stop at the fence.
    - `video-content/humanized-pass.md` + `humanized-fail.md` — a clean script vs. one riddled with AI tells, for `scoreHumanness`.
    - `release-notes/gate-floor-insufficient.json` + `gate-passing.json`, `executive-summary/gate-floor-insufficient.json` + `gate-weakest-below-floor.json` — real per-pipeline `{scores, gate}` inputs for `scoreArtifact`, demonstrating the floor-principle math generalizes past prd.
    - The 11 knowledge pipelines each get `<pipeline>/gate-passing.json` (a real `{scores, gate}` pair clearing that pipeline's own live `pipelines/<pipeline>.yaml` gate), plus a clean/violating structural-property pair where one is graded: `epic/breakdown-story-waves.md` (sprint-waves), `okrs` (inline `assess` outcomes, no fixture needed), `roadmap/rice-rank-order.json` (roadmap-rice), `prd/intake-rows-clean.md` + `intake-rows-unowned-action.md` (evidence-table-shape), `runbook/steps-command-pairs.md` + `steps-missing-expected-output.md`, `book/chapter-manifest-sequential.md` + `chapter-manifest-gap.md`, `ai-test-plan/case-table-clean.md` + `case-table-missing-owner.md`, `user-story/acceptance-gherkin-scenarios.md` + `acceptance-gherkin-missing-then.md`, `ai-implementation-spec/adr-status-lifecycle-clean.md` + `adr-status-invalid.md`. `business-case` and `launch-plan` carry only their gate fixture (skipped honestly, see above).
  - `capture/` — the capture-layer's fixtures: `exclusions-candidates.json` + `exclusions-invalid-reason.json` (the 5 documented exclusion rules), `cap-holdback-under-cap.json` + `cap-holdback-over-cap.json` (the cap-10 holdback arithmetic), `reword-cap-becomes-clear.json` + `reword-cap-stays-unmeasurable.json` (the 2-reword cap → UNMEASURABLE surfacing, via real `assessOutcome`), `approve-then-write.md` + `cancel-skips-write.md` (approval-precedes-write ordering), `dedupe-candidates.json` (dedupe sans-annotation).
  - `builtins/` — the native-builtin layer's fixtures, one directory per `muster-*` provider: `muster-research/fact-ledger-clean.md` + `fact-ledger-missing-anchor.md`, `muster-image/prompt-set-clean.md` + `prompt-set-brand-file-punt.md`, `muster-video/shot-list-clean.md` + `shot-list-missing-rationale.md`, `muster-humanizer/precedence-voice-first-clean.md` + `precedence-order-reversed.md` (unit-test-only — see below) + `precedence-no-profile-baseline.md`, `muster-scorer/valid-scores-passing.json` + `invalid-range-score.json`, `muster-prompt-smith/optimize-improvement-no-regression.json` + `optimize-regression-detected.json`, `muster-author/draft-framework-cta-shape.md` + `draft-missing-framework-multiple-ctas.md`.
  - `skills/coordination/` also carries the HUMAN-HOLD extension's fixtures: `claim-human-hold-resets-floor.md` (a HUMAN-HOLD receipt floor-resets the claim window exactly like DONE/BLOCKED/FAILED), `human-hold-resume-wrong-party.md` + `human-hold-resume-authorized.md` (only the named `authorizer=<login>`'s reply resumes it, per `coordination/SKILL.md`'s stricter HUMAN-HOLD resume gate).

## Producing artifacts (honest limitation)

Unlike `eval:router`, there is no headless harness that fires a mode prompt end-to-end and
captures its artifacts. **Producing a fixture is manual/session-driven**: run the mode
(e.g. `/muster:run <outcome>`) in a real Claude Code session, then save the relevant
artifact(s) — the written `.muster/manifest.json`, the run STATE's `## Coordination`
section, an audit findings ledger or backlog write — into `eval/modes/fixtures/<area>/`,
add/update the matching `dataset.json` case, and re-run the grader.

**The CI test (`test/mode-evals.test.js`, gated by `npm test`) grades only the
CHECKED-IN fixtures + the pure-function cases** — it never re-runs a mode prompt or calls a
model. That is the same posture `eval/router`'s CI test takes with its golden `out/*.json`:
a regression guard on committed material, not a live re-run.

## How to run

```
node eval/modes/grade.mjs      # code-graded cases against dataset.json + fixtures/
node --test test/mode-evals.test.js
npm run eval:modes             # same as the first command, via package.json
```

As of this writing: 166 total cases (158 code-graded, 100% passing + 8 model-graded) — 58
mode-prompt cases across the 8 `MODES` (`plan`: 8, `plan-backlog`: 9 — its batch-plan form
carries the backlog-ref grammar, drain ordering reusing `sprint-waves`, conflict flags, and
a model-graded approval-gate rubric — `go`: 7, `go-backlog`: 6, `runner`: 6, `audit`: 6,
`diagnose`: 7, `capture`: 9), 45 skill-protocol cases (40 + 3 coordination HUMAN-HOLD
extension cases + 2 muster-runner dispatch-contract cases), 21 content-pipeline cases (>= 2 per pipeline across all 9), 14
native-builtin cases (2 per builtin across all 7), and 27 knowledge-pipeline cases (11
gate-achievability + 16 structural, across the 11 pipelines — see the coverage table below
for the exact per-pipeline breakdown, including the 2 pipelines with no structural case,
skipped honestly). The 3 legacy alias stubs (`run`/`autopilot`/`sprint`) carry zero dataset
cases by design — see "Alias stubs" in the coverage table below.

To refresh the model-graded cases (`grading: "model"`): follow `eval/router/README.md`'s
"How to run" pattern (a subagent produces the artifact and/or a judge score) — out of
scope for this eval's automated path.

## Coverage table

Every prompt surface this eval is responsible for, one row per file, its coverage tier,
and (for `empirical` rows) how many dataset cases grade it. `test/mode-evals.test.js`'s
"coverage-table surfaces match the actual file inventory" test asserts the per-category
row counts below against a live glob of each directory, so a new command/skill/
builtin/pipeline file added later fails that test instead of this table silently going
stale. Tiers: **empirical** (>=1 code-graded dataset case grades it directly),
**static** (covered only by `muster prompt lint`/`prompt scan` structural linting, not by
this eval), **deliberate-none** (out of scope for this eval, with a stated reason).

### Mode prompts (`plugin/commands/*.md`, 8 of the 11 files there — the other 3 are alias stubs, see below)

| surface | tier | cases |
|---|---|---|
| plan.md | empirical | 8 — the single-outcome front half (assess x2, issue-ref x3, manifest x2, a model-graded routing-appropriateness rubric); unchanged from run.md's own front half pre-migration |
| plan-backlog.md | empirical | 9 — the batch-plan form (backlog-ref grammar x5, drain ordering via `sprint-waves`, conflict flags x2, a model-graded approval-gate rubric); unchanged from run.md's own batch-plan form pre-migration |
| go.md | empirical | 7 |
| go-backlog.md | empirical | 6 |
| runner.md | empirical | 6 |
| audit.md | empirical | 6 |
| diagnose.md | empirical | 7 |
| capture.md | empirical | 9 — closed this pass (was zero-verification); `prompt scan plugin/commands` verdict: 7/7 passing as of the full prompt-improve pass (the earlier `ANTH-POS-001` finding on capture.md is resolved) |

### Alias stubs (`plugin/commands/*.md`, the remaining 3 of the 11 files there)

`run`, `autopilot`, and `sprint` are legacy names kept working for backward compatibility
— each is now an 8-line stub (frontmatter + one heads-up guidance line + a
Read-and-execute directive) with no behavior of its own left to grade empirically. They
carry **zero** `dataset.json` cases by design (see the DECISION comment beside
`MODES`/`ALIASES` in `test/mode-evals.test.js`) — coverage is a **structural alias-class
check** instead: alias-shape equivalence (the file is ONLY frontmatter + guidance line +
a Read-and-execute directive naming a target file that exists — pins the shape so a
future edit can't silently fatten an alias back into real logic) and alias-guidance (the
heads-up line names the correct replacement command).

| surface | tier | cases |
|---|---|---|
| run.md -> plan.md | structural (alias-class check) | 0 — no independent behavior to grade; see `test/mode-evals.test.js`'s "alias-shape equivalence"/"alias-guidance" tests |
| autopilot.md -> go.md | structural (alias-class check) | 0 — same alias-class check |
| sprint.md -> go-backlog.md | structural (alias-class check) | 0 — same alias-class check |

### Skill-protocol skills (`plugin/skills/*/SKILL.md`, 11: the 10 below + router)

| surface | tier | cases |
|---|---|---|
| orchestrator | empirical | 3 |
| review-gate | empirical | 3 |
| coordination | empirical | 9 (4 original + 3 HUMAN-HOLD extension + 2 muster-runner dispatch-contract: the brief a driver sends the lifecycle agent and the return receipts it demands back, graded against `fixtures/agents/*` — the protocol `plugin/agents/muster-runner.md`'s "Dispatch contract" section documents) |
| interview | empirical | 3 |
| tournament | empirical | 6 |
| domain-router | empirical | 4 |
| advisor | empirical | 6 |
| greenfield | empirical | 4 |
| prd-pipeline | empirical | 4 |
| roadmap-prioritization | empirical | 3 |
| router | empirical (separate suite) | see `eval/router` — not duplicated here |

### Native-builtin providers (`plugin/builtins/muster-*/SKILL.md`, 7)

| surface | tier | cases |
|---|---|---|
| muster-research | empirical | 2 |
| muster-image | empirical | 2 |
| muster-video | empirical | 2 |
| muster-humanizer | empirical | 2 (+ 1 unit-test-only violating fixture — `voicePrecedesGeneric` isn't expect-comparable) |
| muster-scorer | empirical | 2 |
| muster-prompt-smith | empirical | 2 |
| muster-author | empirical | 2 |

The `gsd-*`/`sp-*`/`wsh-*` builtins (39 dirs under `plugin/builtins/`) are
**deliberate-none**: vendored generic technique skills (superpowers/get-shit-done/
community workshop patterns), not muster's own pipeline-role providers — out of scope for
an eval whose whole premise is grading muster's own authored prompt contracts.

### Content pipelines (`pipelines/*.yaml`, 9)

| surface | tier | cases |
|---|---|---|
| blog-post | empirical | 3 |
| social-post | empirical | 2 |
| newsletter | empirical | 2 |
| case-study | empirical | 3 |
| lead-magnet | empirical | 2 |
| release-notes | empirical | 2 |
| video-content | empirical | 2 |
| executive-summary | empirical | 2 |
| competitive-battlecard | empirical | 3 |

### Knowledge/software pipelines (`pipelines/*.yaml`, 11)

| surface | tier | cases |
|---|---|---|
| epic | empirical | 2 (gate + sprint-waves-reused breakdown sequencing) |
| okrs | empirical | 3 (gate + assess-reused clear/vague KR pair) |
| runbook | empirical | 3 (gate + step-pairs clean/violating pair) |
| book | empirical | 3 (gate + chapter-manifest clean/violating pair) |
| ai-test-plan | empirical | 3 (gate + case-table clean/violating pair) |
| ai-implementation-spec | empirical | 3 (gate + adr-status clean/violating pair) |
| roadmap | empirical | 2 (gate + roadmap-rice-reused ranking) |
| user-story | empirical | 3 (gate + gherkin-shape clean/violating pair) |
| prd | empirical | 3 (gate + evidence-table-shape-reused intake-row clean/violating pair; distinct `mode` from the skill-protocol layer's own `prd-pipeline` cases above, which grade the same real gate via a different dispatch) |
| business-case | empirical (gate only) / **deliberate-none** (structural) | 1 — no literal row/table grammar is pinned in business-case.yaml's phase prose beyond gate-criteria names |
| launch-plan | empirical (gate only) / **deliberate-none** (structural) | 1 — "RACI" is named only as a gate-criterion label, never a documented table format |

Note: the audit-manifest cases supply `givenPromptingSignal` directly — they grade `buildAuditManifest` construction, not prompting-signal detection (which is async fs work, covered end-to-end in `test/detect.test.js`).

## Known limitations (skill-protocol layer)

- **`greenfield-scaffold-shape`** grades a checked-in `{created, skipped}` result against
  `SCAFFOLD_SEED_FILES` (`grade-lib.mjs`) — a literal copy of `src/setup.js`'s `SEEDS` seed
  list, not an import of it. `scaffoldProject` performs real filesystem writes (mkdir /
  writeFile / `git init`) and isn't a pure function this no-IO grader can call directly; a
  `SEEDS` edit in `src/setup.js` won't automatically fail this guard the way the sprint
  waves / prd.yaml drift guards do. Same honest-limitation posture as the audit-manifest
  `givenPromptingSignal` note above.
- **`prd-pipeline-shape-matches-real-yaml`** and the 3 `prd-gate-achievability` cases hardcode
  a copy of `pipelines/prd.yaml`'s `gate` — a drift guard (`test/mode-evals.test.js`) parses
  the live YAML and asserts these fixtures match it, so a `pipelines/prd.yaml` gate edit
  fails that guard instead of silently stranding the cases on stale numbers.
- **`coordination-claim-window`** and `computeClaimWindowWinner`/`computeClaimWindows`
  encode `coordination/SKILL.md` Binding A's claim-window race rule in `src/coordination.js`
  (imported and re-exported by `grade-lib.mjs`/`grade-skills.mjs`) — the single executable
  source shared by shipped runtime code and this eval, rather than a documented-only rule
  duplicated between the two.

## Known limitations (content-pipeline layer)

- **`evidence-table-shape`, `signal-diff-baseline`, `publish-packet-shape`,
  `audience-voice-jargon`** encode their respective pipeline-yaml-documented artifact
  shapes directly in `grade-lib.mjs` (`EVIDENCE_ROW_RE`, `SIGNAL_*_RE`,
  `publishPacketShapeCheck`, `audienceVoiceJargonCheck`) — none has a `src/*.js` home,
  since the underlying property (a markdown row schema, a diff-report format, a packet
  manifest, a banned-jargon list) is pipeline-prose, not shipped pipeline code. Same
  honest-limitation posture as `orchestrator-brief`/`review-gate-verdict` above: a
  `pipelines/*.yaml` phase-description edit that changes the documented shape won't
  automatically fail these graders the way a `src/*.js` drift guard would.
- **`gate-achievability`** (dispatched to the same `gateAchievabilityCheck` as
  `prd-gate-achievability`) is parameterized by each case's own `{scores, gate}` artifact,
  so it never drifts from `scoreArtifact` itself — but the `release-notes`/
  `executive-summary` gate *fixtures* still hardcode a copy of those pipelines' `gate`
  objects. A drift guard (`test/mode-evals.test.js`) parses the live
  `pipelines/release-notes.yaml`/`pipelines/executive-summary.yaml` and asserts the
  fixtures match, mirroring the prd gate drift guard above.
- **`citation-check`/`humanizer-score`** fixtures are hand-authored prose, not sampled
  from a real pipeline run — same "Producing artifacts" honest limitation as every other
  fixture in this eval (no headless harness fires a pipeline phase prompt end-to-end).

## Known limitations (capture layer)

- **`capture-approval-order`/`capture-exclusions`/`capture-cap-holdback`** encode
  capture.md's own documented protocol directly in `grade-lib.mjs` — none has a `src/*.js`
  home (capture is a conversation-mining workflow, not shipped pipeline code). Same
  honest-limitation posture as `orchestrator-brief` above.
- **`capture-dedupe`**'s `stripAnnotationsForDedupe` mirrors the trailing-only grammar of
  `src/sprint-waves.js`'s own (unexported) `stripAnnotations`, not an import of it — a
  future change to that grammar won't automatically fail this guard the way importing
  the real function would. Same posture as `SCAFFOLD_SEED_FILES` above.
- `node src/cli.js prompt scan plugin/commands`: 7/7 prompt files pass as of the full
  prompt-improve pass (the `ANTH-POS-001` clause-stacking finding capture.md carried when
  this eval layer first landed has since been resolved by the prompt author).

## Known limitations (native-builtin layer)

- **`muster-research`'s fact-ledger case** reuses `evidence-table-shape` verbatim (a
  `fact`-typed row) rather than a bespoke grader — deliberate: the document-ingestion
  contract's `{fact, anchor, confidence, needs_review}` row IS a subset of the same
  columns `EVIDENCE_ROW_RE` already encodes, so reusing it costs nothing and stays
  consistent with `prd`'s own research-phase description of the identical row shape.
- **`muster-humanizer`'s `voicePrecedesGeneric` check** is a hardcoded actual-vs-expected
  ordering assertion, not `expect`-compared — so (per this README's `expect`-is-a-golden-
  claim rule) a reversed-order fixture can't be a *passing* dataset case; it's graded only
  in `test/mode-evals.test.js` against the checked-in
  `fixtures/builtins/muster-humanizer/precedence-order-reversed.md`, same posture
  `audit-ledger`'s malformed-input rejection already takes.
- **`muster-author`**: the task line naming this layer read "muster-scorer/prompt-smith/
  improver," but `plugin/builtins/` ships exactly 7 `muster-*` `SKILL.md` providers —
  `author`, not `improver` (`muster-improver.md` is an agent under `plugin/agents/`, not a
  builtin `SKILL.md`, and outside this eval's stated "7 muster-* SKILL.mds" universe). This
  eval covers the 7 that actually exist; `muster-author`'s own stated contract (name the
  framework used, carry exactly one CTA) stood in for the unnamed 7th.
- **`muster-image`/`muster-video`/`muster-author`** shape checks encode assembled-prose
  output contracts directly in `grade-lib.mjs` — none has a `src/*.js` home. Same posture
  as `orchestrator-brief`/`evidence-table-shape` above.

## Known limitations (knowledge-pipeline layer)

- **`runbook-step-pairs`/`book-chapter-manifest`/`ai-test-plan-case-table`/
  `user-story-gherkin-shape`/`adr-status-lifecycle`** encode their respective
  pipeline-yaml-documented row/table/status grammars directly in `grade-lib.mjs` — none
  has a `src/*.js` home. Same posture as the content-pipeline layer's `EVIDENCE_ROW_RE`/
  `SIGNAL_*_RE` above.
- **`business-case`, `launch-plan`**: only gate-achievability is graded for these two —
  no structural case, and that omission is deliberate (see the coverage table above), not
  an oversight. Re-check if either pipeline's yaml phase descriptions gain a literal row
  grammar in a future edit.
- **`prd`'s knowledge-pipeline-layer cases** (`gate-achievability`, `evidence-table-shape`)
  grade the exact same real `pipelines/prd.yaml` gate and intake-row contract the
  skill-protocol layer's `prd-pipeline` mode already grades (`prd-gate-achievability`,
  and its own drift guard) — intentional double coverage under two different `mode`
  values (`prd` vs `prd-pipeline`), consistent with how this eval's three earlier layers
  never merged their own overlapping concerns into one bucket either.
- **The 11 knowledge-pipeline `gate-passing.json` fixtures** are single passing scenarios,
  not floor-met-but-short/weakest-below-floor pairs like `prd`/`release-notes`/
  `executive-summary` above — those two failure modes of the floor-principle math are
  already exhaustively covered there; the 11 new fixtures exist to prove
  `gate-achievability` parameterizes correctly over each pipeline's own real gate object,
  not to re-prove the math itself.
