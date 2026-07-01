# CLI commands

The `muster` CLI is plain Node ESM. It makes **no model calls**. Every verb does deterministic work and prints JSON you can read or pipe. This is the layer that makes routing reproducible.

```sh
npx @adnova-group/muster <command> [args]
```

## Routing and capabilities

| Command | What it does |
| --- | --- |
| `detect` | Sniff the current project: languages, shape, greenfield flag. |
| `capabilities` | Walk the resolution ladder for every role; report the winner, full fallback chain, recommendations, and model. |
| `match <task>` | Rank every catalog provider against a free-text task by deterministic token overlap. |
| `route <outcome>` | Resolve which pipeline an outcome routes to. |
| `domain <outcome>` | Classify an outcome into a domain (pm, business, content, ops, software). |
| `pipeline <id\|domain>` | Show the resolved pipeline definition. |

## Planning and orchestration

| Command | What it does |
| --- | --- |
| `manifest validate <file>` | Validate a Crew Manifest's shape. |
| `wave <file>` | Compute dependency-ordered execution waves from a manifest. |
| `next <manifest.json> [--done a,b]` | Single-agent driver: given completed task ids, return the next runnable task (and the full ready frontier). |
| `plan-checklist <file>` | Render the plan as a checklist (`--done <ids>` ticks completed tasks). |
| `tally <file>` / `pick <file>` | Tally tournament votes and pick a winner. |
| `fuse <candidates.json> <fusion-map.json>` | Fusion decision engine: validates the debate map, applies the agreement gate, and either selects top-K candidates for synthesis (mode `fuse`) or falls back to the single best candidate (mode `fallback`). Deterministic, no LLM calls. |

## Scoring and prioritization

| Command | What it does |
| --- | --- |
| `score <file>` | Score an artifact against a gate using the floor principle. |
| `humanize-score <file> [--threshold N]` | Deterministic 0–100 AI-tell score for human-facing text (no LLM); the CI-gateable measure behind the humanizer rewrite. Reads stdin when the arg is `-` or absent. |
| `prioritize <file> [--model rice\|ice\|wsjf\|weighted]` | Rank initiatives deterministically. See below. |

### Prioritization models

`prioritize` does the arithmetic; the model only supplies the factor estimates. Given the same inputs, the same ranking. Every model fails loud on non-finite, non-positive, or zero-denominator inputs.

| Model | Formula | Item fields |
| --- | --- | --- |
| `rice` (default) | `(reach × impact × confidence) / effort` | `reach`, `impact`, `confidence`, `effort` |
| `ice` | `impact × confidence × ease` | `impact`, `confidence`, `ease` |
| `wsjf` | `costOfDelay / jobSize` | `costOfDelay`, `jobSize` |
| `weighted` | `Σ (weightᵢ × scoreᵢ)` | `criteria: [{ weight, score }]` |

```sh
# rank a JSON file of initiatives with WSJF
npx @adnova-group/muster prioritize initiatives.json --model wsjf
```

The input file is either an array of items or `{ "items": [...], "model": "wsjf" }`. A `--model` flag overrides the file's `model`.

## Prompt evaluation

Lint, eval, and optimize prompts an application generates to build agents/agentic workflows (or prompts found in a codebase). The deterministic core runs offline; a skill (`muster-prompt-smith`, the `prompt-quality` role) supplies the model calls for empirical eval.

| Command | What it does |
| --- | --- |
| `prompt lint <file> [--agent] [--tools] [--system] [--tool-schema <f>] [--chat <f>] [--workflow <f>]` | Lint prompt structure + guardrails against Anthropic's best practices (no LLM). Returns a scored rubric and `findings[]` with source-cited rule ids. `--tool-schema` passes real tool schemas so the schema↔intent rule checks each tool + its required fields; `--chat` lints a multi-turn chat for role-ordering / role-bleed; `--workflow` lints a multi-prompt workflow for context-boundary erosion. Reads stdin when the file arg is `-` or absent. |
| `prompt variations <file> [--agent] [--tools] [--system]` | Emit deterministic, technique-driven prompt variations, each closing a specific lint gap. |
| `prompt eval <suite.json>` | Grade a suite of pre-collected outputs: code graders (`json`/`regex`/`python`/`tool-call`/`trajectory`) combined with the model-judge score; reports per-case `score`, `accuracy`, `averageScore`. |
| `prompt optimize <file.json>` | Select the winning variation from scored candidates via the tournament floor; flags a `regression` when no variation beats the pinned baseline. |
| `prompt scan <dir>` | Walk a repo for candidate prompts (`.prompt` files, `prompts/` dirs, backtick `system`/`prompt`/`instructions` assignments) and lint each. Returns per-prompt findings + a pass/fail summary. Powers the conditional `prompt-quality` audit dimension. |

```sh
# lint a runtime agent prompt piped from your app
your-app --print-agent-prompt | npx @adnova-group/muster prompt lint - --agent --tools
```

The linter enforces the structure (role, XML tags, multishot examples, explicit output format, positive framing) and the agent/guardrail rules (imperative tool framing, stop conditions, "I don't know" allowance, citations, input separation). Every finding cites the doc rule it comes from. Code in fenced/inline blocks is ignored across languages, so a `never` keyword or `${x}` in an example is not mistaken for an instruction.

The rubric is genre-aware: pass `--system` for an agent/skill *instruction* prompt (the action-verb-lead and multishot rules relax, and prohibitions are tolerated more) versus the default single-task rubric. A prompt that legitimately violates a rule can opt out inline with a comment — `<!-- prompt-lint-disable ANTH-POS-001: reason -->` — and the suppression is surfaced in the result. A prompt with zero findings scores a perfect 15/15.

## Failure-first and review

| Command | What it does |
| --- | --- |
| `diagnose <symptom>` | Structure a failure-first bug fix (`--ci <file>` to read CI output). |
| `audit` | Drive the whole-codebase review and fix across six dimensions (architecture, tech-debt, coverage, simplification, readability, security). When the project builds prompts/agents (an LLM/agent SDK dependency is present), a seventh `prompt-quality` dimension is added, backed by `prompt scan`. |
| `issue <ref>` | Resolve a GitHub issue reference into an outcome (title + body). |
| `assess <outcome>` | Deterministic gap-check: is the outcome clear enough to route? |
| `steer <message>` | Classify a mid-run steering message (approve, stop, status, retarget). |

## Ops and setup

| Command | What it does |
| --- | --- |
| `install [home]` | Copy the output style and print the plugin-install steps. |
| `uninstall [home]` | Print the plugin-removal steps and clean up legacy style files. |
| `setup [dir]` | Scaffold Muster files into a target directory. |
| `vendor` | Generate built-in agents and skills from `vendor/manifest.yaml`. |
| `doctor` | Health-check the installation. |
| `profile` | Report the resolved provider profile. |
| `signals [dir]` | Surface project signals. |
| `scratchpad <runId>` | Read a run's scratchpad. |
| `memory read` / `memory write ...` | Read and write Muster's memory store. |

::: tip
Run any verb with no arguments to see its usage. The CLI fails loud with a clear message on bad input.
:::
