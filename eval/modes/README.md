# Mode-prompt eval harness

An empirical eval of the 6 mode prompts (`plugin/commands/*.md`: `run`, `autopilot`,
`sprint`, `runner`, `audit`, `diagnose`), the 10 skill-protocol skills they delegate to
(`plugin/skills/*` — `orchestrator`, `review-gate`, `coordination`, `interview`,
`tournament`, `domain-router`, `advisor`, `greenfield`, `prd-pipeline`,
`roadmap-prioritization`; `router` is excluded, it already has its own `eval:router`),
**and** 9 content-pipeline phase prompts (`pipelines/*.yaml` — `blog-post`, `social-post`,
`newsletter`, `case-study`, `lead-magnet`, `release-notes`, `video-content`,
`executive-summary`, `competitive-battlecard`; the knowledge/software pipelines like
`prd`/`epic` already have gate-achievability coverage from the skill-protocol layer above
and aren't duplicated here). Like `eval/router`, this measures **response quality**
against deterministic assertions, so future edits to a mode prompt, a skill, or a pipeline
phase get regression-graded instead of only structurally linted (`muster prompt lint`).

## Why (and how) this is code-gradeable without a model

`eval/router` grades a single artifact per case: the manifest a live router run produced.
The 6 modes don't reduce to one artifact each — but several of their steps are themselves
deterministic pipeline code, not model output:

| mode step | deterministic surface |
|---|---|
| run/autopilot step 0 (issue ref?) | `parseIssueRef` (`src/issue.js`) |
| run/autopilot info-gap check | `assessOutcome` (`src/interview.js`) |
| diagnose step 1 (seed) | `classifyFailure` + `buildDiagnoseManifest` (`src/diagnose.js`) |
| audit step 1 (seed) | `buildAuditManifest` (`src/audit.js`) |
| any manifest (run/autopilot/diagnose/audit) | `validateManifest` (`src/manifest.js`) |
| sprint's backlog consumption | `computeSprintWaves` (`src/sprint-waves.js`) |
| runner's disposition/commit conventions | regexes we own in `grade-lib.mjs` (`WAVE_COMMIT_RE`, `RECEIPT_PATTERNS`), encoding the literal grammar `coordination/SKILL.md` and `autopilot.md` document |

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
  "id": "run-parallel-manifest-fences",     // unique
  "mode": "run",                             // one of run|autopilot|sprint|runner|audit|diagnose, one of the 10 skill names (see SKILLS in test/mode-evals.test.js), OR one of the 9 content-pipeline ids (see CONTENT_PIPELINES) — a single field, all three layers share it (grade.mjs, frozen, calls `.padEnd()` on `row.mode` unconditionally)
  "outcome": "Add JWT auth to the API and update the docs, in parallel.", // the user input this case models (also the literal string fed to a pure fn, when `check` reads `outcome` directly)
  "check": "manifest",                       // which grade-lib.mjs grader to dispatch to
  "artifact": "fixtures/run/manifest-parallel.json", // OPTIONAL: path (relative to eval/modes/) to a checked-in fixture
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
  convention the 6-mode layer's `manifest` check already used — never inline `input` for
  `"json"` kind, to keep `dataset.json` free of hand-escaped JSON-in-JSON. The
  content-pipeline layer's `"json"`-kind checks (`gate-achievability`,
  `publish-packet-shape`, `audience-voice-jargon`) follow the same rule, under
  `fixtures/pipelines/<pipeline>/`; its `"text"`-kind checks (`citation-check`,
  `humanizer-score`, `evidence-table-shape`, `signal-diff-baseline`) use small
  markdown fixtures there too, mirroring `fixtures/audit/ledger.md`'s convention.
- `expect` fields are per-`check` (documented as comments beside each grader function in
  `grade-lib.mjs`); every field present adds one assertion. Every dataset case's `expect`
  is a **golden claim about correct behavior** (including cases whose correct behavior is
  rejection — e.g. `sprint-cycle-detected-stops-nothing-runs` expects `ok:false`). Pass/fail
  behavior of the *grader itself* (does it correctly flag a malformed fixture) is unit
  tested directly in `test/mode-evals.test.js`, not via dataset cases.
- `grading: "model"` cases carry a `rubric` (mirroring `eval/router`'s dataset shape) and
  an empty/absent `expect` — a subjective quality judgment (is this root cause *actually*
  right, is this routing *actually* sensible) that no code check can make. They are listed
  by `grade.mjs` but never graded by it, and `test/mode-evals.test.js` skips them entirely.

## Files

- `dataset.json` — the cases (see shape above).
- `grade-lib.mjs` — pure grader: `gradeCase(testCase, artifacts) -> { pass, checks: [{name, ok, detail}] }`, plus the `CHECKS`/`ARTIFACT_KIND` dispatch tables. No IO — callers load artifacts.
- `grade.mjs` — CLI report: loads `dataset.json`, resolves each code-graded case's artifacts, grades, prints the per-case + aggregate report (mirrors `eval/router/grade.mjs`).
- `fixtures/` — checked-in golden artifacts for the cases whose behavior is genuinely model-driven:
  - `run/manifest-parallel.json`, `run/manifest-single.json` — example valid Crew Manifests (parallel-with-fences, and single-task).
  - `sprint/backlog.md` + `sprint/waves.json` — an `{id}`/`{deps}`-annotated backlog and its `computeSprintWaves` output (the `waves.json` values are pinned into `dataset.json`'s `expect.waves` too, so a `computeSprintWaves` regression fails the eval, not just the fixture record).
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

As of this writing: 101 total cases (94 code-graded, 100% passing + 7 model-graded) — 40
6-mode cases, 40 skill-protocol cases, 21 content-pipeline cases (>= 2 per pipeline across
all 9: `blog-post` 3, `social-post` 2, `newsletter` 2, `case-study` 3, `lead-magnet` 2,
`release-notes` 2, `video-content` 2, `executive-summary` 2, `competitive-battlecard` 3).

To refresh the model-graded cases (`grading: "model"`): follow `eval/router/README.md`'s
"How to run" pattern (a subagent produces the artifact and/or a judge score) — out of
scope for this eval's automated path.

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
  encode `coordination/SKILL.md` Binding A's claim-window race rule directly in
  `grade-lib.mjs` — there is no `src/*.js` implementation of the GitHub-issue claim race
  (it's a documented protocol runners follow via `gh` CLI calls, not shipped code), same
  precedent `WAVE_COMMIT_RE`/`RECEIPT_PATTERNS` already set.

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
