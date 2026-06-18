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

## First run (2026-06-18)

Routing appropriateness was excellent (judge 8–9/10 across all 6 cases), but **every
manifest was structurally invalid**: the router skill's documented crew shape omitted the
`model` field that `validateManifest` requires, so the prompt reliably produced manifests
that fail validation. Code grade 0/10 → 0% pass despite great routing. This is a defect the
structural linter (which scored the router 15/15) could not catch.

**Fix (tune step):** the router skill now specifies `model` in the crew shape and the
glass-box field list, sourced from `roles[role].model`. Re-running against the fixed prompt
yields valid manifests.
