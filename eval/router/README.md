# Router eval harness

An empirical eval of the **router** skill (`plugin/skills/router/SKILL.md`): given an
outcome, does it produce a *valid* and *well-routed* Crew Manifest? This measures **response
quality**, which the structural prompt linter (`muster prompt lint`) cannot see — the linter
checks the prompt's shape, this runs the prompt and grades its outputs.

## Why this prompt is evaluable

The router is a task prompt with a checkable output: a Crew Manifest JSON. That gives two
objective grading signals:

- **Code grade** (deterministic, `grade.mjs`): does the manifest pass `validateManifest`,
  is the crew non-inline, and does it cover the case's `expectRoles`?
- **Judge grade** (LLM-as-judge): is the routing *appropriate* for the task per the case
  `rubric` — right providers, sensible plan, correct review/verify/humanize gates?

Combined score = `(code + judge) / 2`; a case passes at `passThreshold` (7/10).

## Files

- `dataset.json` — the test cases: `task` (outcome), `expectRoles`, and a judge `rubric`.
- `out/<id>.json` — the manifest the router produced for each case (the model's output).
- `results.json` — the judge scores per case.
- `grade.mjs` — the deterministic grader; prints the per-case + aggregate report.

## How to run

The router needs a model, so the model-driven steps run via Claude Code subagents (muster's
model substrate); the deterministic grading runs in-process.

1. **Produce outputs.** For each case in `dataset.json`, have a subagent execute the router
   (run `muster detect` + `muster capabilities`, follow `plugin/skills/router/SKILL.md`) for
   that `task` and save the raw manifest JSON to `out/<id>.json`.
2. **Judge.** Have one subagent read each `out/<id>.json` against its `rubric` and emit
   `{ <id>: { score, reason } }`; record the scores in `results.json`.
3. **Grade.** `node eval/router/grade.mjs eval/router/results.json`.

## First run (2026-06-18): a defect the linter could not see

Routing appropriateness was excellent (judge 8–9/10 across all 6 cases), but **every
manifest was structurally invalid**: the router skill's documented crew shape omitted the
`model` field that `validateManifest` requires, so the prompt reliably produced manifests
that fail validation. Code grade 0/10 → **0% pass** despite great routing. The structural
linter scored the router 15/15 and could not catch this.

**Fix (tune step):** the router skill now specifies `model` in the crew shape and the
glass-box field list, sourced from `roles[role].model`. Re-running against the fixed prompt:
INVALID → VALID. The committed `out/*.json` are this **fixed, passing** run (100%, avg
9.42/10) — the golden expected outputs.

## CI

A PR runner cannot call the model, so CI does **not** re-run the router. It guards the
deterministic contract instead:

- **`test/router-eval.test.js`** (runs in `npm test`, so the existing CI gates it): every
  golden manifest validates + covers its expected roles + grades as passing, the grader
  works, and the router skill still documents the required `model` crew field — so the
  defect this eval found cannot silently regress.
- **`npm run eval:router`** prints the deterministic grade of the golden run (a CI-log step
  in `.github/workflows/ci.yml`).

The **full model-driven eval** (re-running the router + judge against the dataset) is a
separate manual/scheduled job: it needs a model and costs API calls, so it is not a
per-PR gate. Run it by repeating the "How to run" steps (e.g. periodically, or after a
material router-skill change) and committing the refreshed `out/` + `results.json`.
