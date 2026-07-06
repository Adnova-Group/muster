# Mode-prompt eval harness

An empirical eval of the 6 mode prompts (`plugin/commands/*.md`: `run`, `autopilot`,
`sprint`, `runner`, `audit`, `diagnose`). Like `eval/router`, this measures **response
quality** against deterministic assertions, so future edits to a mode prompt get
regression-graded instead of only structurally linted (`muster prompt lint`).

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

A case whose behavior lives in one of those functions grades **directly against the real
code path** — no fixture, no manual step, the cheapest tier (code >> model >> human, per
`src/prompt-eval.js`'s stated order). A case whose behavior is genuinely the *model's*
output (the router's crew choice inside run/autopilot, a runner's actual claim/receipt
trail) grades a **checked-in fixture artifact** instead (see "Producing artifacts" below).

## Case shape

```jsonc
{
  "id": "run-parallel-manifest-fences",     // unique
  "mode": "run",                             // one of run|autopilot|sprint|runner|audit|diagnose
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
  they're computed purely from `outcome`.
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

To refresh the model-graded cases (`grading: "model"`): follow `eval/router/README.md`'s
"How to run" pattern (a subagent produces the artifact and/or a judge score) — out of
scope for this eval's automated path.

Note: the audit-manifest cases supply `givenPromptingSignal` directly — they grade `buildAuditManifest` construction, not prompting-signal detection (which is async fs work, covered end-to-end in `test/detect.test.js`).
