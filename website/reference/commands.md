# CLI commands

The `muster` CLI is plain Node ESM. It makes **no model calls**. Every verb does deterministic work and prints JSON you can read or pipe. This is the layer that makes routing reproducible.

```sh
npx @adnova-group/muster <command> [args]
```

## Routing and capabilities

| Command | What it does |
| --- | --- |
| `detect` | Sniff the current project: languages, shape, greenfield flag. |
| `capabilities` | Walk the resolution ladder for every role; report the winner, full fallback chain, recommendations, and model. Use `capabilities --codex` to report the live Codex plugin, MCP, skills, and agents inventory. |
| `match <task>` | Rank every catalog provider against a free-text task by deterministic token overlap. |
| `match --skills <task> [--stack <csv>]` | Skills mode: rank the live skills inventory against the task text, and separately suggest stack→skill mappings (`{ranked, suggested}`). Signals for the suggestions default to tokens parsed from the task text; `--stack <csv>` (e.g. `--stack nextjs,supabase`) overrides them. Each suggestion carries a `missing` flag (present in the live inventory or not) — deterministic, no LLM calls. |
| `route <outcome>` | Resolve which pipeline an outcome routes to. |
| `domain <outcome>` | Classify an outcome into a domain (pm, business, content, ops, software). |
| `pipeline <id\|domain>` | Show the resolved pipeline definition. |

## Planning and orchestration

| Command | What it does |
| --- | --- |
| `manifest validate <file>` | Validate a Crew Manifest's shape. |
| `wave <file>` | Compute dependency-ordered execution waves from a manifest. |
| `next <manifest.json> [--done a,b]` | Single-agent driver: given completed task ids, return the next runnable task (and the full ready frontier). |
| `resolve-cli` | Resolve how to invoke the muster CLI without paying an `npx -y` cold start on every call: a vendored plugin runtime (`$CLAUDE_PLUGIN_ROOT/runtime/muster.mjs`), a local checkout (`./src/cli.js`), a local/global `muster` bin, or an `npx` fallback (`degraded: true`) as a last resort. Meant to run ONCE per run; the caller reuses the answer for every later call. See docs/performance-pass.md. |
| `gate-cadence <manifest.json> [--changed-lines N]` | The small-task fast path: given the manifest's dependency-ordered waves, report how many spec-gate rounds and review-gate batches this run defaults to (`{taskCount, waveCount, specGateRounds, reviewGateBatches, fastPath, reason}`). Plans at or below the small-task threshold (3 tasks) batch the per-wave review gate into a single pass instead of one dispatch per wave; larger plans keep depth proportional to wave count. `--changed-lines N` additionally folds in `reviewerCount` (1 below the diff-size threshold, 2 at/over it — default 200 changed lines, `MUSTER_REVIEW_DIFF_THRESHOLD` env override): a diff-size lever, independent of the task-count one, so a large multi-task diff always keeps both reviewers. Both are batching/scaling levers only — the gate's own pass bar and fix-loop cap are unchanged. See docs/performance-pass.md and docs/weight-reduction.md. |
| `wave-dispatch [--agent-teams\|--no-agent-teams]` | Capability check + fallback-selection for the orchestrator's wave dispatch mechanism (`{mode: "native"\|"prose", agentTeams, reason}`). Claude Code's agent-teams surface exposes a native, deterministic Workflow tool for wave fan-out + barrier, reachable only in agent-teams/background-agent mode — undetectable from outside a running session, so it's a DECLARED capability: `--agent-teams`/`--no-agent-teams` is the orchestrator's own self-observed signal (does its tool list carry `Workflow` this session?), falling back to the `MUSTER_AGENT_TEAMS` env var when omitted. Absent any declaration, `mode` is always `"prose"` — the wave loop's unconditional floor on every harness without the surface (Codex, Cowork, plain Claude Code CLI/Desktop single-session). See docs/native-workflow-dispatch.md. |
| `worktree-isolation --harness <claude-code\|claude-desktop\|hermes\|codex>` | Per-harness native worktree isolation selection (`{harness, mechanism, receiptRequired}`), a declared (not auto-probed) choice: `claude-code` → the Agent tool's own `isolation: "worktree"` parameter; `claude-desktop` → the automatic per-session worktree under `<root>/.claude/worktrees/`; `hermes` → `hermes -w` / kanban `worktree` workspaces; `codex` → `receipts-only` (no cwd field on subagent dispatch, so there is no mechanism to select). `receiptRequired` is always `true` — every harness records the same base-SHA provenance receipt regardless of which mechanism (or none) isolated the work. An unrecognized/missing `--harness` fails loud rather than guessing. See docs/strategy/native-delegation.md #10. |
| `receipt-verify <sha> --cwd <repo>` | Real verification of a base-SHA receipt, not just format validation: resolves `<sha>` against the git-backed default verifier (`makeGitShaVerifier`, `src/wave-dispatch.js`) — "reachable" means the SHA resolves to a real commit object in the repository at the explicit `--cwd` (`git rev-parse --verify --quiet <sha>^{commit}`), never `process.cwd()` (Codex's `spawn_agent` has no cwd field, so the caller must always state the repo). Prints `{sha, cwd, verified, mechanism}` and exits `0` verified / `2` not verified / `1` on a missing `sha` or `--cwd`. This is the executable consumer `buildBaseShaReceipt`'s injected `verify` records `verified`/`verificationMechanism` against; see "Worktree isolation per harness + base-SHA receipts" in `plugin/skills/orchestrator/SKILL.md`. |
| `fast-path <outcome> [--capabilities <file>]` | Pre-router single-agent fast path: score an outcome's raw text for whether it's small/single-task enough to skip crew assembly (the router dispatch) and the spec gate entirely (`{eligible, wordCount, reason}`). With `--capabilities <file>` and `eligible: true`, also emits the minimal Crew Manifest directly (`manifest`: one task, a builder, and ONE reviewer — no LLM dispatch). Deterministic, conservative by design — any cross-cutting-scope signal, multi-deliverable separator, chained imperative verbs, or a long outcome disqualifies it, so genuine multi-task work never mis-scores eligible. See docs/weight-reduction.md. |
| `review-brief --reviewer-count <n> [--diff-files <file>] [--diff-text-file <file>]` | Fast-path-token-gap lever 1's eligibility check: whether a `reviewerCount: 1` (sub-threshold diff) dispatch may use the lighter `plugin/skills/review-gate/fast-path-brief.md` instead of the full `review-gate/SKILL.md` (`{eligible, triggers: {mutantKill, citation, surface, any}}`). `--diff-files <file>` (one changed path per line, e.g. `git diff --name-only` output) and `--diff-text-file <file>` (the diff's own text, for the citation-in-text signal) are both optional; `reviewerCount` other than `1`, or any trigger firing, is never eligible. See docs/fast-path-token-gap.md. |
| `sprint-waves <backlog.md>` | Parse a markdown checklist backlog (`- [ ]` items with `{id}`/`{deps}`/`{disposition}`/`{escalated}` annotations) into dependency-ordered execution waves. An item without `{deps}` implicitly depends on every item above it; `{deps: none}` opts out. |
| `plan-checklist <file>` | Render the plan as a checklist (`--done <ids>` ticks completed tasks). |
| `tally <file>` / `pick <file>` | Tally tournament votes; pick selects the single best candidate (fallback ranker -- fuse is the default synthesis path). |
| `fuse <candidates.json> <fusion-map.json>` | Fusion decision engine: validates the debate map, applies the agreement gate, and either selects top-K candidates for synthesis (mode `fuse`) or falls back to the single best candidate (mode `fallback`). Deterministic, no LLM calls. |
| `advise <advice-request.json>` | Validate an advice request and emit the structured advisor dispatch input (`advisorModel` + `request`). Deterministic, no LLM calls. The advisor role resolves to the peak tier (fable, degrading to opus when fable is disabled). |
| `scope [text]` | Deterministic backlog-vs-item scope detection for the `plan`/`go` verb family: a parseable backlog ref, a named file that looks like a backlog checklist, or a live default `.muster/backlog.md` on a bare invocation all resolve to `backlog`; a non-empty outcome sentence resolves to `item`; empty text with no live backlog is `ambiguous`. Returns `{scope, signals}` — `signals` are human-readable strings a caller can echo in a confirm question. Deterministic, no LLM calls. |

## Scoring and prioritization

| Command | What it does |
| --- | --- |
| `score <file>` | Score an artifact against a gate using the floor principle. |
| `humanize-score <file> [--threshold N]` | Deterministic 0–100 AI-tell score for human-facing text (no LLM); the CI-gateable measure behind the humanizer rewrite. Reads stdin when the arg is `-` or absent. |
| `citation-check <file>` | Citation guard for research/content artifacts: verifies every inline `[src: anchor]` resolves against a trailing `## Sources` list (`- anchor: url-or-file+line`). Reports `danglingAnchors` and `malformedCitations` (both fail, exit 2), `uncited` paragraph line numbers (a reviewer's judgment call, not auto-failed), and non-fatal `warnings` (e.g. duplicate source anchors). Reads stdin when the arg is `-` or absent. |
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
| `install [home]` | Copy Muster's output style to `[home]/.claude/output-styles/muster.md` (default: your home directory) and print the plugin-install steps. |
| `uninstall [home]` | Print the plugin-removal steps and clean up legacy style files. |
| `setup [dir]` | Scaffold Muster files into a target directory. |
| `vendor` | Generate built-in agents and skills from `vendor/manifest.yaml`. |
| `doctor` | Health-check the installation. |
| `doctor --codex` | Health-check the Codex CLI, generated profiles, plugin runtime, lifecycle hooks, live inventory, and advisory policy limitations. |
| `codex-conformance [YYYY/MM/DD] [--cwd <substr>]` | Audit a day's Codex session rollouts (default: today) for subagent model conformance: each spawned thread's actual per-turn model vs its Muster profile TOML pin, flagging MISMATCH and generic-inheritance threads; exits nonzero on any mismatch. |
| `install codex [--scope project-or-user] [--dry-run]` | Install Muster-managed Codex profiles and lifecycle hooks in the project or user scope, preserving unrelated hook groups, and register the Muster marketplace when Codex is available. |
| `uninstall codex [--scope project-or-user] [--dry-run]` | Remove only Codex profiles, hook groups, and hook runtime files recorded in Muster's managed-install manifests, then remove the plugin when Codex is available. |
| `profile` | Report the resolved provider profile. |
| `signals [dir]` | Surface project signals for the target directory and persist the same JSON to `[dir]/.muster/signals.json` (default: the current directory). |
| `help [command]` | Print CLI usage without dispatching the named command. `muster <command> --help` is equivalent and is safe for mutating verbs. |
| `scratchpad <runId>` | Read a run's scratchpad. |
| `memory read` / `memory write ...` | Read and write Muster's memory store. |
| `hygiene [--reap] [--json] [--backlog <file>] [--worktree-threshold N] [--zombie-stale-min N] [--claim-stale-min N]` | Burn-hygiene guards so a dead run can't strand machine state: detects zombie provider CLI (codex/claude) processes (an orphaned process -- parent dead/1 -- is reap-eligible; a merely stale-started one with a live parent is report-only, never killed), offers a stale-worktree sweep once live worktrees exceed the threshold (report-only, never deletes), and auto-releases a backlog `{claimed: runner@ts}` annotation once its heartbeat exceeds the stale-claim threshold (default 60 min). Report-only by default; `--reap` opts into killing reap-eligible zombies and rewriting the backlog to release stale claims. |

::: tip
Run `muster help`, `muster help <command>`, or `muster <command> --help` to see usage without executing the command. The CLI fails loud with a clear message on bad input.
:::
