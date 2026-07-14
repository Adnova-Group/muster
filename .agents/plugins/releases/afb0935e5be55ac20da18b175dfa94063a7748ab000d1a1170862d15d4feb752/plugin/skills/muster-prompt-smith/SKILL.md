---
name: muster-prompt-smith
description: "Codex-compatible Muster workflow. Built-in prompt-quality provider — lint, eval, and optimize prompts an application generates to build agents/agentic workflows (and prompts found in a codebase). Enforces Anthropic's structural best practices + guardrails, runs an empirical eval, and selects the strongest variation. Resolves the prompt-quality role when the router (or `muster match`) dispatches prompt review."
license: Apache-2.0
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative.

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
node ${PLUGIN_ROOT}/runtime/muster.mjs prompt scan <dir>
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
node ${PLUGIN_ROOT}/runtime/muster.mjs prompt lint <file|-> [--agent] [--tools]
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
   and edge-case diversity over polish.
2. For each case: interpolate the prompt, call the model, collect the output. For subjective
   quality, also call the model with an LLM-judge grader prompt that asks for
   strengths/weaknesses/reasoning **before** a 0–10 score (so it doesn't anchor on a
   middling default). Code-gradable cases carry a `format` (`json|regex|python|tool-call|trajectory`). Note
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
node ${PLUGIN_ROOT}/runtime/muster.mjs prompt eval <suite.json>
```

It combines code grade (correctness/validity) with the model grade, reports per-case
`score`/`passing`, `accuracy`, and `averageScore`. Grade in cost order: code ≫ model ≫ human.

## 3. Optimize (evaluator-optimizer loop) — when lint or eval is below bar

1. Get deterministic, technique-driven variations (each closes a specific lint gap):

```
node ${PLUGIN_ROOT}/runtime/muster.mjs prompt variations <file|-> [--agent] [--tools]
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
node ${PLUGIN_ROOT}/runtime/muster.mjs prompt optimize <candidates.json>
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
