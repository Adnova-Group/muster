---
name: muster-prompt-smith
description: Built-in prompt-quality provider — lint, eval, and optimize prompts an application generates to build agents/agentic workflows (and prompts found in a codebase). Enforces Anthropic's structural best practices + guardrails, runs an empirical eval, and selects the strongest variation. Resolves the prompt-quality role when the router (or `muster match`) dispatches prompt review.
muster_builtin: true
adapted_from: Anthropic prompt-engineering + test/eval docs; lintlang taxonomy; promptfoo/promptimal patterns
license: Apache-2.0
---

# Prompt Smith (built-in)

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

If `passing` is already true and only `info` findings remain, stop here — do not churn a
prompt that meets the bar.

## 2. Eval (empirical) — when a test set or success criteria exist

1. Build (or generate) a small dataset of test cases with `{{VARIABLE}}` slots. Generate
   synthetic cases with prefill (` ```json `) + a `` ``` `` stop sequence; prioritise volume
   and edge-case diversity over polish.
2. For each case: interpolate the prompt, call the model, collect the output. For subjective
   quality, also call the model with an LLM-judge grader prompt that asks for
   strengths/weaknesses/reasoning **before** a 0–10 score (so it doesn't anchor on a
   middling default). Code-gradable cases carry a `format` (`json|regex|python`). Note `json`/`regex` are real
validity checks; `python` is a best-effort smoke test (balanced delimiters + a Python
signal), not a guarantee — don't lean on it as the sole gate.
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

2. Evaluate the baseline and each variation (re-lint and/or re-eval). Build a candidates
   file `{ "candidates": [{ "id", "prompt", "total", "passing" }] }` and select the winner.
   **Every candidate's `total` must come from the SAME scorer** — don't mix a lint total
   (0–15) with an eval score (0–10), or the regression guard compares different scales:

```
npx -y @adnova-group/muster prompt optimize <candidates.json>
```

It returns `{ winner, winnerPrompt, regression, escalate, ranking }` via the tournament
floor. **Regression guard:** if `regression` is true (the winning variation scores below the
pinned baseline), keep the baseline and report it. If `escalate` is true (nothing passes the
gate), surface that — do not ship a prompt that fails the floor.

Glass box: record the chosen rules fixed, the winning technique, and the per-version scores
in the run STATE. Ship the winner only when it passes the floor and beats the baseline.
