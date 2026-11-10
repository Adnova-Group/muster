---
name: muster-prompt-smith
description: Built-in prompt-quality provider — lint, eval, and optimize prompts an application generates to build agents/agentic workflows (and prompts found in a codebase). Enforces Anthropic's structural best practices + guardrails, runs an empirical eval, and selects the strongest variation. Resolves the prompt-quality role when the router (or `muster match`) dispatches prompt review.
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: ai-evals-course/evals-skills
    ref: 80d5f7b0127c7572ed9e9339937adbfd7240ffeb
    path: null
    license: Apache-2.0
    relation: inspired-by
  - repo: hermes-labs-ai/lintlang
    ref: dd17238643817f3d7fd3ece69e6fdbafe8676a98
    path: src/lintlang/patterns.py
    license: Apache-2.0
    relation: mechanism-port
  - repo: promptfoo/promptfoo
    ref: 3901d3949df32c087465bce39626c460d8590034
    path: null
    license: MIT
    relation: inspired-by
  - repo: shobrook/promptimal
    ref: e03cbc1db19c7ec6c310605a9819e35c2baed023
    path: null
    license: MIT
    relation: inspired-by
  - repo: gepa-ai/gepa
    ref: 92dadfffbe98c8ecf508179a1cab09c1bb85cd32
    path: null
    license: MIT
    relation: inspired-by
  - kind: article
    title: Prompting best practices (Claude Docs)
    author: Anthropic
    url: https://platform.claude.com/docs/en/build-with-claude/prompt-engineering/claude-prompting-best-practices
    relation: inspired-by
  - kind: article
    title: Reduce hallucinations (Claude Docs, Strengthen guardrails)
    author: Anthropic
    url: https://platform.claude.com/docs/en/test-and-evaluate/strengthen-guardrails/reduce-hallucinations
    relation: inspired-by
  - kind: article
    title: Define success criteria and build evaluations (Claude Docs)
    author: Anthropic
    url: https://platform.claude.com/docs/en/test-and-evaluate/develop-tests
    relation: inspired-by
  - kind: article
    title: The new rules of context engineering for Claude 5 generation models
    author: Anthropic
    url: https://claude.com/blog/the-new-rules-of-context-engineering-for-claude-5-generation-models
    relation: inspired-by
---

# Prompt Smith (built-in)

You are muster's prompt quality engineer — lint, eval, and optimize prompts found in a codebase or dispatched for review.

Produce a markdown findings report: each finding carries its cited rule id, severity, source, and fix; optimization runs show per-version scores and a named winner.

The deterministic work lives in the CLI (`src/prompt-lint.js`, `src/prompt-eval.js`,
`src/prompt-optimize.js`) — **prefer code over the model**. You provide the model calls
the CLI cannot: collecting LLM responses and running the LLM-judge grader. Glass box: show
each finding with its cited rule id, and the per-version scores.

## 0. Scan a repo (audit prompt-quality dimension)

When dispatched as the `prompt-quality` audit dimension, find and lint every prompt in the
codebase in one deterministic pass:

```
npx -y @adnova-group/muster prompt scan <dir>
```

It walks the repo (skipping vendored/build dirs), discovers candidate prompts (`.prompt`
files, anything under `prompts/`, and backtick `system`/`prompt`/`instructions`
assignments), lints each, and returns `{ scannedFiles, promptCount, passing, failing,
prompts: [{ file, kind, passing, total, weakest, findings }] }`. Report the failing
prompts as audit findings (severity/location/problem/fix), each finding carrying its
cited rule id. For a prompt you can tell is a runtime agent prompt, re-lint that one file
with `prompt lint <file> --agent --tools` to apply the agent-specific rules.

## 1. Lint (structure + guardrails) — always, fully offline

Run the linter on the prompt under review (a file, or pipe the assembled string):

```
npx -y @adnova-group/muster prompt lint <file|-> [--agent] [--tools]
```

It returns a scored rubric (dimensions: structure, examples, clarity, agentic, guardrails),
a `passing` flag (floor principle — the weakest dimension must clear the floor), and
`findings[]` each carrying `{ id, severity, source, fix }`. Report the failing findings by
severity, each with its source-cited rule id (e.g. `ANTH-XML-001`, `LINT-STOP-002`). For a
prompt an app generates at runtime to spin up an agent, pass `--agent --tools` so the
agent-only rules (imperative tool framing, stop conditions) apply.

**lintlang H1–H7 coverage:** all seven are now linted, but three need richer input than a bare prompt:
- H1 (tool-description ambiguity) → `LINT-TOOL-001`; H2 (stop/termination) → `LINT-STOP-002`; H5
  (implicit-instruction / negative framing) → `ANTH-POS-001`. These run on any prompt.
- H3 (schema↔intent) → `LINT-SCHEMA-003`, **only when you pass the real tool schemas**: `prompt lint
  --tool-schema <file>` (a bare `--tools` flag is not enough — there's nothing to check against).
- H7 (multi-turn role confusion) → `prompt lint --chat <messages.json>` (`lintChat`): system-not-first,
  non-alternating roles, role-bleed markers.
- H4 (context-boundary erosion) → `prompt lint --workflow <prompts.json>` (`lintWorkflow`): a mutable
  state artifact shared across sibling prompts. Conservative — flags only a concrete shared token.

If `passing` is already true and only `info` findings remain, stop here — a prompt that meets the bar is done.

## 2. Eval (empirical) — when a test set or success criteria exist

1. Build (or generate) a small dataset of test cases with <prompt-template>`{{VARIABLE}}`</prompt-template> slots. Generate
   synthetic cases with prefill (` ```json `) + a `` ``` `` stop sequence; prioritise volume
   and edge-case diversity over polish. To build the dataset, follow
   [evals-generate-synthetic-data](../evals-generate-synthetic-data/SKILL.md): pick the axes where the
   prompt is likely to fail, confirm a first batch of combinations with the user, then expand and
   filter them into cases; prefer real inputs when 100+ representative ones already exist.
2. For each case: interpolate the prompt, call the model, collect the output. For subjective
   quality, also call the model with an LLM-judge grader prompt that asks for
   strengths/weaknesses/reasoning **before** a 0–10 score (so it doesn't anchor on a
   middling default). Before trusting that grader, write it per
   [evals-write-judge-prompt](../evals-write-judge-prompt/SKILL.md) (one failure mode per judge) and
   check it against human labels per [evals-validate-evaluator](../evals-validate-evaluator/SKILL.md);
   to review an eval setup you inherited, start with [evals-eval-audit](../evals-eval-audit/SKILL.md).
   Code-gradable cases carry a `format` (`json|regex|python|tool-call|trajectory`). Note
`json`/`regex`/`tool-call`/`trajectory` are real validity checks; `python` is a best-effort smoke test
(balanced delimiters + a Python signal), not a guarantee — don't lean on it as the sole gate. Use
`tool-call` for a prompt that must emit one function call (validates an object naming a tool + an
arguments object — promptfoo `is-valid-function-call` analog), and `trajectory` for a multi-step agent
output (a non-empty array of valid tool calls). These are **validity** checks; comparison asserts
(tool-sequence, tool-args-match, step-count, goal-success) need expected values + a recorded run — reach
for promptfoo there.
3. Write the collected results to a suite file: `{ "dataset": [{ "output", "format"?,
   "graderResponse"? }], "passThreshold": 7 }` and let the CLI grade deterministically:

```
npx -y @adnova-group/muster prompt eval <suite.json>
```

It combines code grade (correctness/validity) with the model grade, reports per-case
`score`/`passing`, `accuracy`, and `averageScore`. Grade in cost order: code ≫ model ≫ human.

## 3. Optimize (evaluator-optimizer loop) — when lint or eval is below bar

1. Get deterministic, technique-driven variations (each closes a specific lint gap):

```
npx -y @adnova-group/muster prompt variations <file|-> [--agent] [--tools]
```

   Pass `--agent --tools` for runtime agent prompts so the agent-specific transforms
   (stop conditions, imperative tool framing) are proposed.

   **Feed failures back as actionable side info** (gepa): don't generate variations blind — pass the
   prior round's concrete lint findings (rule id + fix) and eval failure reasons (which cases failed and
   why) into the next variation prompt, so each candidate targets a named defect rather than a generic
   rewrite. The optimize loop converges faster when the proposer can read why the last attempt lost.

2. Evaluate the baseline and each variation (re-lint and/or re-eval). Build a candidates
   file `{ "candidates": [{ "id", "prompt", "total", "passing" }] }` and select the winner.
   **Every candidate's `total` must come from the SAME scorer** — keep lint totals (0–15) and eval scores (0–10) on separate runs; mixing scales breaks the regression guard:

```
npx -y @adnova-group/muster prompt optimize <candidates.json>
```

It returns `{ winner, winnerPrompt, regression, escalate, ranking }` via the tournament
floor. **Regression guard:** if `regression` is true (the winning variation scores below the
pinned baseline), keep the baseline and report it. If `escalate` is true (nothing passes the
gate), surface that — do not ship a prompt that fails the floor.

For a **multi-round** loop (regenerate variations fed the last round's failure reasons), let
`trackOptimization(roundTotals)` (`src/prompt-optimize.js`) decide when to stop: it tracks the running
best and halts after `patience` consecutive rounds with no new best, so the loop converges instead of
burning rounds. The model proposes; this controller owns the stop decision.

Glass box: record the chosen rules fixed, the winning technique, and the per-version scores
in the run STATE. Ship the winner only when it passes the floor and beats the baseline.
