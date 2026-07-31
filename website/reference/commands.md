# CLI commands

The `muster` CLI is plain Node ESM. It makes **no model calls**. Every verb does deterministic work and prints JSON you can read or pipe. This is the layer that makes routing reproducible.

```sh
npx -y @adnova-group/muster <command> [args]
```

## Routing and capabilities

Muster reports the conceptual ladder in ascending order: `scout`, `core`, `prime`, `apex`. Harness adapters map those tiers to concrete models.

<!-- legacy-tier-compat:start -->
Compatibility only: legacy input aliases `haiku`, `sonnet`, `opus`, and `fable` normalize to `scout`, `core`, `prime`, and `apex`; they are not a second conceptual ladder. `MUSTER_ENABLE_FABLE` remains an alias for `MUSTER_ENABLE_APEX`.
<!-- legacy-tier-compat:end -->

| Command | What it does |
| --- | --- |
| `detect` | Sniff the current project: languages, shape, greenfield flag. |
| `capabilities [--cowork] [--codex] [--role <role>] [--roles-only]` | Walk the resolution ladder for every role; report the winner, full fallback chain, recommendations, and model. `--role <role>` narrows the report to one role; `--roles-only` drops everything but the `roles` map (a lighter capture). `--cowork` reports the Cowork/MCP-host view (only registered MCP providers or inline execution resolve). `--codex` reports the live Codex plugin, MCP, skills, and agents inventory, and additionally stamps each **agent-backed** role with `codexModel: {model, effort}` — the exact Codex model and reasoning effort that role's chosen agent dispatches on (e.g. `security-review` → `{gpt-5.6-sol, xhigh}`), resolved from the same source as the committed `.codex/agents/<id>.toml` pins so the two can never diverge. |
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
| `resolve-cli` | Resolve how to invoke the muster CLI without paying an `npx -y` cold start on every call: a vendored plugin runtime (`$CLAUDE_PLUGIN_ROOT/runtime/muster.mjs`), a local checkout (`./src/cli.js`), a local/global `muster` bin, or an `npx` fallback (`degraded: true`) as a last resort. Meant to run ONCE per run; the caller reuses the answer for every later call. See [docs/performance-pass.md](https://github.com/Adnova-Group/muster/blob/main/docs/performance-pass.md). |
| `gate-cadence <manifest.json> [--changed-lines N]` | The small-task fast path: given the manifest's dependency-ordered waves, report how many spec-gate rounds and review-gate batches this run defaults to (`{taskCount, waveCount, specGateRounds, reviewGateBatches, fastPath, reason}`). Plans at or below the small-task threshold (3 tasks) batch the per-wave review gate into a single pass instead of one dispatch per wave; larger plans keep depth proportional to wave count. `--changed-lines N` additionally folds in `reviewerCount` (1 below the diff-size threshold, 2 at/over it — default 200 changed lines, `MUSTER_REVIEW_DIFF_THRESHOLD` env override): a diff-size lever, independent of the task-count one, so a large multi-task diff always keeps both reviewers. Both are batching/scaling levers only — the gate's own pass bar and fix-loop cap are unchanged. See [docs/performance-pass.md](https://github.com/Adnova-Group/muster/blob/main/docs/performance-pass.md) and [docs/weight-reduction.md](https://github.com/Adnova-Group/muster/blob/main/docs/weight-reduction.md). |
| `wave-dispatch [--agent-teams\|--no-agent-teams]` | Capability check + fallback-selection for the orchestrator's wave dispatch mechanism (`{mode: "native"\|"prose", agentTeams, reason}`). Claude Code exposes a native, deterministic Workflow tool for wave fan-out + barrier; on current builds it sits in the plain single-session tool list (corrected 2026-07-29, live 2.1.220), but older builds and `--tools`-restricted sessions lack it, and only the session itself can see its own tool list — so it's a DECLARED capability, never probed from outside: `--agent-teams`/`--no-agent-teams` is the orchestrator's own self-observed signal (does its tool list carry `Workflow` this session?), falling back to the `MUSTER_AGENT_TEAMS` env var when omitted. Absent any declaration, `mode` is always `"prose"` — the wave loop's unconditional floor on every harness or session without the tool (Codex, Cowork, `--tools`-restricted or pre-Workflow Claude Code builds). See [docs/native-workflow-dispatch.md](https://github.com/Adnova-Group/muster/blob/main/docs/native-workflow-dispatch.md). |
| `worktree-isolation --harness <claude-code\|claude-desktop\|hermes\|codex\|kimi>` | Per-harness native worktree isolation selection (`{harness, mechanism, receiptRequired}`), a declared (not auto-probed) choice: `claude-code` → the Agent tool's own `isolation: "worktree"` parameter; `claude-desktop` → the automatic per-session worktree under `<root>/.claude/worktrees/`; `hermes` → `hermes -w` / kanban `worktree` workspaces; `codex` and `kimi` → `receipts-only` (neither harness's subagent dispatch carries a cwd/isolation parameter, so there is no mechanism to select — muster supplies the worktree itself before dispatch). `receiptRequired` is always `true` — every harness records the same base-SHA provenance receipt regardless of which mechanism (or none) isolated the work. An unrecognized/missing `--harness` fails loud rather than guessing. See [docs/strategy/native-delegation.md](https://github.com/Adnova-Group/muster/blob/main/docs/strategy/native-delegation.md) #10. |
| `plan-surface <runtime>` | Per-harness plan-surface capability selection for the approve-first gate (`{runtime, surface, primitive, detail, cite}`), a declared (not auto-probed) choice: `claude-code` → native `ExitPlanMode`; `codex` → native `plan-skill+permission-mode`; `hermes` → native `plan-skill+goal-contract`; `kimi` → native `plan-mode-gate`; `cowork` → `prose` with no native primitive. Any unknown or missing runtime resolves to the universal `AskUserQuestion` prose fallback — never a thrown error, so an unrecognized harness still gets an approve-first gate. See `src/plan-surface.js`. |
| `receipt-verify <sha> --cwd <repo>` | Real verification of a base-SHA receipt, not just format validation: resolves `<sha>` against the git-backed default verifier (`makeGitShaVerifier`, `src/wave-dispatch.js`) — "reachable" means the SHA resolves to a real commit object in the repository at the explicit `--cwd` (`git rev-parse --verify --quiet <sha>^{commit}`), never `process.cwd()` (Codex's `spawn_agent` has no cwd field, so the caller must always state the repo). Prints `{sha, cwd, verified, mechanism}` and exits `0` verified / `2` not verified / `1` on a missing `sha` or `--cwd`. This is the executable consumer `buildBaseShaReceipt`'s injected `verify` records `verified`/`verificationMechanism` against; see "Worktree isolation per harness + base-SHA receipts" in `plugin/skills/orchestrator/SKILL.md`. |
| `fast-path <outcome> [--capabilities <file>]` | Pre-router single-agent fast path: score an outcome's raw text for whether it's small/single-task enough to skip crew assembly (the router dispatch) and the spec gate entirely (`{eligible, wordCount, reason}`). With `--capabilities <file>` and `eligible: true`, also emits the minimal Crew Manifest directly (`manifest`: one task, a builder, and ONE reviewer — no LLM dispatch). Deterministic, conservative by design — any cross-cutting-scope signal, multi-deliverable separator, chained imperative verbs, or a long outcome disqualifies it, so genuine multi-task work never mis-scores eligible. See [docs/weight-reduction.md](https://github.com/Adnova-Group/muster/blob/main/docs/weight-reduction.md). |
| `review-brief --reviewer-count <n> [--diff-files <file>] [--diff-text-file <file>]` | Fast-path-token-gap lever 1's eligibility check: whether a `reviewerCount: 1` (sub-threshold diff) dispatch may use the lighter `plugin/skills/review-gate/fast-path-brief.md` instead of the full `review-gate/SKILL.md` (`{eligible, triggers: {mutantKill, citation, surface, any}}`). `--diff-files <file>` (one changed path per line, e.g. `git diff --name-only` output) and `--diff-text-file <file>` (the diff's own text, for the citation-in-text signal) are both optional; `reviewerCount` other than `1`, or any trigger firing, is never eligible. See [docs/fast-path-token-gap.md](https://github.com/Adnova-Group/muster/blob/main/docs/fast-path-token-gap.md). |
| `kimi-goal-invocation <objective> [--stream-json]` | Print the descriptor (`{argv, env, exitCodes}`) for an unattended `kimi -p "/goal <objective>"` run — the Kimi-native run loop muster's `go`/`runner` modes drive instead of the prose Ralph loop (`src/kimi-dispatch.js`'s `kimiGoalInvocation`). `env` is an OVERRIDE pair (`KIMI_CODE_EXPERIMENTAL_FLAG=1` + `KIMI_SECONDARY_MODEL`, the lane bind) merged over the ambient env at spawn, never passed as the whole env; `exitCodes` maps **0 complete / 3 blocked / 6 paused**. Pass `--stream-json` whenever the run's token accounting needs the stream-json stdout. See "Kimi run loop" in `plugin/commands/go.md`. |
| `kimi-process-dispatch --brief <text> --agent-file <name\|path> --cwd <dir> --lane <primary\|secondary>` | Print the descriptor (`{argv, env, cwd, lane}`) for one intended headless `kimi -p <brief> --agent-file <path>` process. This command is descriptor-only and never spawns; do not manually execute the returned `argv`. `-m` is always emitted (omitting it silently falls to config `default_model`); `env` carries the primary/secondary override pair. A bare agent-file name resolves under the installed Kimi agents dir; an explicit path must exist. |
| `kimi-process-run --brief <text> --agent-file <name\|path> --cwd <dir> --lane <primary\|secondary>` | Report-only attended process lane. It currently exits nonzero before spawn or receipt setup on every platform because trusted immutable broker bootstrap is unavailable. There is no command, receipt path, or manual-descriptor bypass. Use Kimi's in-session subagent path or escalate the leg. |
| `kimi-session-usage <--session-dir <dir>\|--cwd <dir> [--stdout-file <f>]>` | Per-dispatch token accounting from a Kimi session's `agents/*/wire.jsonl` tree (`src/kimi-receipts.js`). `--session-dir` reads a KNOWN session dir (the in-session arm: the parent session's `dispatches` view attributes each subagent's tokens). `--cwd` resolves a `-p` leg's session first — `captureSessionId` on `--stdout-file`'s captured stream-json stdout when given, else the session-index fallback (`resolveSessionForCwd`) — printing `{resolution, usage}`, or `{resolution}` with `resolved: false` + reason when the session is UNKNOWN (a recorded outcome, exit stays 0). See `plugin/commands/go-backlog.md` step 4. |
| `kimi-summarize-receipts <items.json>` | Batch token accounting: one compact line per backlog item (`[{itemId, resolution \| resolutions}]`, resolutions from `kimi-session-usage`), summed per leg and labeled with each leg's resolution source (`captured`/`index-unique`/`index-newest`); an UNKNOWN resolution is an `UNKNOWN (<reason>)` line, never a throw. Transcribe into STATE next to each item's gate summary (`src/kimi-receipts.js`'s `summarizeItemReceipts`). |
| `codex-spawn-packet --task-id <id> --agent-type <id> [--message <text>\|--message-file <f>] [--version v1\|v2] [--fork-turns <none\|N>]` | Print the exact `spawn_agent` call JSON for the target model's Codex multi-agent API version (`src/wave-dispatch.js`'s `codexSpawnAgentCall`): v2 → `collaboration.spawn_agent` (`task_name`, `message`, `fork_turns`, `agent_type`), v1 → `multi_agent_v1.spawn_agent` (`message`, `fork_context: false`, `agent_type`; `fork_turns` is v2-only and refused at v1). Version resolution fails closed to v1 when `--version` is absent — never guessing v2 at a v1 model; `fork_turns` is a STRING and `"all"` is refused with a named `agent_type`. See `plugin/skills/orchestrator/references/codex-dispatch.md`. |
| `codex-wait-packet [--version v1\|v2] [--targets a,b] [--timeout-ms N]` | Print the wave-barrier `wait_agent` call JSON (`src/wave-dispatch.js`'s `codexWaitAgentCall`): v1 waits on the named `--targets` and returns on the first to finish, v2 takes no targets and wakes on any mailbox update. Neither is an all-barrier — loop until every dispatched member has settled; timeouts are bounded 10s..3600s, default 30s. |
| `sprint-waves <backlog.md> [--max-concurrent-threads-per-session N]` | Parse a markdown checklist backlog (`- [ ]` items with `{id}`/`{deps}`/`{disposition}`/`{escalated}` annotations) into dependency-ordered execution waves. An item without `{deps}` implicitly depends on every item above it; `{deps: none}` opts out. Codex adapters pass the effective canonical ceiling explicitly so higher-precedence config layers remain authoritative. |
| `sprint-reconcile <progress.json>` | Reconcile the complete emitted sprint plan, all currently available completion receipts, and the adapter's in-flight phases. Returns canonical item states, every newly eligible dispatch action, and whether the adapter must dispatch, may wait, has finished, or must escalate. |
| `backlog-publish <backlog.md> --expect <sha256\|absent>` | Compare-and-swap (CAS) publication for a complete staged backlog supplied on stdin. The relative path must remain symlink-free and contained under the run root. A shared heartbeat lock serializes the read/validate/atomic-rename transaction with `hygiene --reap`; stale dead-owner locks are identity-checked before reclamation. Existing file modes are preserved. If the expected digest loses to another writer, publication fails without changing the winner: reread, reapply the still-valid mutation, and retry. |
| `plan-checklist <file>` | Render the plan as a checklist (`--done <ids>` ticks completed tasks). |
| `tally <file>` / `pick <file>` | `tally` tallies adversarial review verdicts into a gate decision (ANY `severity: "blocker"` finding, from any reviewer, blocks -- not majority); a reviewer entry may instead carry `status: "exhausted"` / `"absent"` naming the WORKER's own failure to ever deliver a verdict (killed, ran out of budget, or never responded) -- that always forces `blocked: true` with a named reason in `blockedReasons`, never a silent skip and never counted as a real PASS or FAIL. `pick` selects the single best candidate (fallback ranker -- fuse is the default synthesis path). |
| `fuse <candidates.json> <fusion-map.json>` | Fusion decision engine: validates the debate map, applies the agreement gate, and either selects top-K candidates for synthesis (mode `fuse`) or falls back to the single best candidate (mode `fallback`). Deterministic, no LLM calls. |
| `advise <advice-request.json>` | Validate an advice request and emit the structured advisor dispatch input (`advisorModel` + `request`). Deterministic, no LLM calls. The advisor role resolves to apex, degrading to prime when apex is disabled; the runtime adapter maps that tier to its concrete dispatch value. |
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
npx -y @adnova-group/muster prioritize initiatives.json --model wsjf
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
your-app --print-agent-prompt | npx -y @adnova-group/muster prompt lint - --agent --tools
```

The linter enforces the structure (role, XML tags, multishot examples, explicit output format, positive framing) and the agent/guardrail rules (imperative tool framing, stop conditions, "I don't know" allowance, citations, input separation). Every finding cites the doc rule it comes from. Code in fenced/inline blocks is ignored across languages, so a `never` keyword or `${x}` in an example is not mistaken for an instruction.

The rubric is genre-aware: pass `--system` for an agent/skill *instruction* prompt (the action-verb-lead and multishot rules relax, and prohibitions are tolerated more) versus the default single-task rubric. A prompt that legitimately violates a rule can opt out inline with a comment — `<!-- prompt-lint-disable ANTH-POS-001: reason -->` — and the suppression is surfaced in the result. A prompt with zero findings scores a perfect 15/15.

## Failure-first and review

| Command | What it does |
| --- | --- |
| `diagnose <symptom>` | Structure a failure-first bug fix (`--ci <file>` to read CI output). |
| `audit [--backlog] [path...]` | Drive the whole-codebase review and fix across six dimensions (architecture, tech-debt, coverage, simplification, readability, security). When the project builds prompts/agents (an LLM/agent SDK dependency is present), a seventh `prompt-quality` dimension is added, backed by `prompt scan`. One or more `path` arguments scope the sweep to those paths. `--backlog` switches to backlog mode: the sweep stays read-only and the ranked ledger is written to `.muster/backlog.md`, one item per finding-cluster, for `/muster:go-backlog` to clear later, instead of fixing findings inline. |
| `issue <ref>` | Resolve a GitHub issue reference into an outcome (title + body). |
| `assess <outcome>` | Deterministic gap-check: is the outcome clear enough to route? |
| `steer <message>` | Classify a mid-run steering message (approve, stop, status, retarget). |

## Ops and setup

| Command | What it does |
| --- | --- |
| `install [home]` | Print the plugin-install steps (`/plugin marketplace add …`, `/plugin install …`) — the Claude Code actions a shell command cannot perform. It **mutates nothing under `~/.claude`**: the glass-box output style is plugin-native and force-applied (`force-for-plugin`) when the plugin is enabled, so there is no file to copy and no style command to run. `[home]` (default: your home directory) only scopes the legacy-path checks. |
| `uninstall [home]` | Print the plugin-removal steps, then clean up after older Muster versions: a **legacy copied style** at `[home]/.claude/output-styles/muster.md` is removed, and a displaced original is restored from its `.bak`. This is the one path that writes under `~/.claude`; on a current install there is nothing there to remove. |
| `init [dir]` | Prepare a deterministic, provider/model-neutral repository profile and receipt at `.muster/project-profile.json` and `.muster/init-receipt.json`. For an empty greenfield directory, preparation may safely initialize `.git` before the owned pair. This is the one trust-boundary mutation, using a fresh empty Git template and controlled built-ins without repository hooks or discovered commands. The CLI learns bounded facts, captures the native-artifact baseline, and emits a complete receipt envelope. The active runtime owns instruction generation: use its native action when callable, then resume with positive artifact-delta, preexisting-confirmed, or attempt-bound call-result evidence. A suggestion, request, invocation, refusal to overwrite, or existing artifact alone is not completion. Copilot, Kimi, and unknown runtimes without a proven adapter remain unavailable; acknowledge with `init acknowledge [dir] --reason unavailable` when accepted. An unavailable handoff remains a HUMAN-HOLD until that acknowledgement; finalization keeps `nativeInit.state` as `handoff`. Same-state reruns are no-ops. Greenfield finalization can create only missing `.gitignore`, `README.md`, `docs/design/.gitkeep`, and `docs/plan/.gitkeep`; brownfield finalization creates none and preserves user files. Init never executes repository scripts, hooks, installers, or discovered commands. Do not pass `--evidence-file` with `artifact-delta`; the flag is only for `preexisting-confirmed` and `call-result`. |
| `init transition [dir] --to <handoff\|attempted>` | Record the native handoff or begin a proven callable attempt. Use `--reason <code> --expect <csv>` for `handoff`; use `--expect <csv>` for `attempted`. |
| `init transition [dir] --to completed --evidence artifact-delta` | Complete from a changed or newly created expected native artifact. This form takes no `--evidence-file`; the CLI compares the artifact hash with the immutable handoff baseline. |
| `init transition [dir] --to completed --evidence preexisting-confirmed --evidence-file <path>` | Complete from the required bounded confirmation JSON for expected artifacts that predated the handoff. The evidence file is required and must be separate from every expected native artifact. |
| `init transition [dir] --to completed --evidence call-result --evidence-file <path>` | Complete from a bounded native call-result JSON. The evidence file is required, the transition must start from `attempted`, and its `attemptId` must match the receipt. |
| `init acknowledge [dir] --reason unavailable` | Acknowledge an unavailable native handoff so finalization can continue. The receipt remains in native `handoff`, never `completed`. |
| `init finalize [dir]` | Finalize after native completion or an acknowledged unavailable handoff. Emits the complete receipt envelope and is idempotent. |
| `setup [dir]` | Legacy explicit scaffold command. It remains separate from Init and may seed its older Muster files. |
| `vendor` | Generate built-in agents and skills from `vendor/manifest.yaml`. |
| `doctor` | Health-check the installation. |
| `doctor --codex` | Health-check the Codex CLI, generated profiles, plugin runtime, lifecycle hooks, live inventory, advisory policy limitations, and a stale PATH-level `muster` shadowing this package's own bin. |
| `codex-conformance [YYYY/MM/DD \| --days N] [--cwd <substr>] [--current-pins-only]` | Audit Codex session rollouts for subagent model conformance: one UTC day (default: today), or an inclusive `--days N` range covering today and the preceding N-1 days. Compares each spawned thread's actual per-turn model with its Muster profile TOML pin, flags MISMATCH and generic-inheritance threads, and exits nonzero on any mismatch. Each MISMATCH row is stamped `pinsNewerThanRollout` (the rollout predates the newest profile TOML, i.e. a retier happened since) and the tally gains a `prePinMismatch` count; `--current-pins-only` excludes those pre-retier rows from the exit-code decision only -- rows stay listed and annotated either way, never hidden. |
| `install codex [--scope project-or-user] [--dry-run]` | Install Muster-managed Codex profiles and lifecycle hooks in the project or user scope, preserving unrelated hook groups, and register the Muster marketplace when Codex is available. |
| `uninstall codex [--scope project-or-user] [--dry-run]` | Remove only Codex profiles, hook groups, and hook runtime files recorded in Muster's managed-install manifests, then remove the plugin when Codex is available. |
| `install kimi [--probe] [--dry-run]` | Install Muster's agents, builtin skills, and **verbs** (the `/muster-go`, `/muster-plan`, … entry points, installed as `muster-`-namespaced skills because Kimi surfaces skills as slash commands and already owns `/plan`) into the Kimi Code CLI data root (`$KIMI_CODE_HOME`, or `~/.kimi-code`) — Kimi loads Claude-Code-format agent `.md` files and `SKILL.md` skills natively, so this is a plain file copy (no hooks; the agent `model:` field is inert on Kimi, which has no per-subagent model). It also merges Muster's declarative action-class fence — a marker-delimited block of `[[permission.rules]]` deny rules (send/sign/submit/publish/purchase/delete-remote over Bash and `mcp__*` patterns) — into `config.toml`, Kimi's native hard-deny that needs no hook and survives `--yolo`/`-p`; user entries outside the markers are untouched. Idempotent: a reinstall overwrites owned files, prunes any the prior manifest no longer ships, and replaces the fence block in place. `--probe` runs a live, read-only `GET /v1/models` to confirm the managed plan's served models against Muster's Kimi tier policy (and flag a cheaper scout lane if one ever appears); `--dry-run` reports the plan (including the deny rules) without writing. |
| `uninstall kimi [--dry-run]` | Remove only the agents and skill files recorded in Muster's Kimi install manifest, strip Muster's marker-delimited `[[permission.rules]]` fence block from `config.toml` (deleting the file only when Muster created it — a pre-existing config round-trips byte-identical), then prune the now-empty Muster-created directories — a user's own agents/skills sharing those directories are left untouched. |
| `profile` | Report the resolved provider profile. |
| `signals [dir]` | Surface project signals for the target directory and persist the same JSON to `[dir]/.muster/signals.json` (default: the current directory). |
| `help [command]` | Print CLI usage without dispatching the named command. `muster <command> --help` is equivalent and is safe for mutating verbs. |
| `scratchpad <runId>` | Read a run's scratchpad. |
| `memory read` / `memory write ...` | Read and write Muster's memory store. |
| `hygiene [--reap] [--json] [--backlog <file>] [--worktree-threshold N] [--zombie-stale-min N] [--claim-stale-min N]` | Burn-hygiene report for orphaned/stale provider CLIs, excess/prunable worktrees, and stale backlog claims. Provider processes are always report-only: worktree location and filesystem dispatch receipts are same-user diagnostics, not signal authority. Worktrees are also never removed automatically. `--reap` can release eligible stale backlog claims, but it cannot signal provider processes or delete worktrees. |

### Init instruction authority

Claude Code and Codex Init use one canonical instruction pair: `AGENTS.md` is authoritative, and `CLAUDE.md` contains exactly:

```md
# Claude Code

@AGENTS.md
```

If conflicting instruction files existed at the preparation baseline, Init leaves a HUMAN-HOLD instead of overwriting or merging them.

## MCP tools

The same deterministic core is also exposed as a local MCP server. The canonical implementation is `mcp/server.mjs`; `cowork/mcp-server.mjs` is the explicit Cowork adapter declared in `cowork/manifest.json`, while `cowork/chatgpt-work-server.mjs` remains a compatibility entrypoint for older Work configurations. There are **30 tools: 29 CLI-wrapper tools plus `muster_sprint_protocol`**. The wrappers return the same deterministic JSON as the CLI. The protocol tool returns Cowork's backlog execution playbook and does not wrap a CLI verb.

| Tool | Wraps | What it does |
| --- | --- | --- |
| `muster_detect` | `detect` | Detect the project profile for a directory. |
| `muster_capabilities` | `capabilities` | Resolve every role to its best-available provider, chain, and model tier. |
| `muster_capabilities_roles` | `capabilities --roles-only` | The same resolution, returning only the `{roles}` map (a lighter capture). |
| `muster_match` | `match` | Rank catalog providers against a free-text task. |
| `muster_match_skills` | `match --skills` | Rank the live skills inventory against a task, plus stack-derived suggestions. |
| `muster_domain` | `domain` | Classify an outcome into a work domain. |
| `muster_route` | `route` | Route an outcome to its domain + pipeline. |
| `muster_pipeline` | `pipeline` | Load a pipeline definition by domain or id. |
| `muster_assess` | `assess` | Gap-check an outcome before running. |
| `muster_scope` | `scope` | Backlog-vs-item scope detection for the plan/go verb family. |
| `muster_fast_path` | `fast-path` | Score an outcome for the pre-router fast path; with capabilities, emit the minimal builder+reviewer manifest. |
| `muster_steer` | `steer` | Classify a mid-run steer message. |
| `muster_diagnose` | `diagnose` | Classify a failure symptom and build a diagnose manifest. |
| `muster_audit` | `audit` | Build the whole-codebase audit manifest. |
| `muster_manifest_validate` | `manifest validate` | Validate a Crew Manifest's shape and dependency graph. |
| `muster_plan_checklist` | `plan-checklist` | Render a manifest's plan array as a markdown checklist. |
| `muster_wave` | `wave` | Compute dependency-ordered execution waves. |
| `muster_next` | `next` | Single-agent driver: next runnable task given completed ids. |
| `muster_sprint_waves` | `sprint-waves` | Compute waves from a backlog file's `{id}`/`{deps}` annotations (`annotated: false` means the backlog is un-annotated). |
| `muster_sprint_reconcile` | `sprint-reconcile` | Reconcile completion receipts and in-flight phases into item states plus newly eligible implementation/review/integration actions. |
| `muster_backlog_publish` | `backlog-publish` | Bounded CAS publication of complete backlog content under an explicit project root; shares locking, containment, and retry semantics with the CLI. |
| `muster_sprint_protocol` | — | Return the Cowork-adapted sprint orchestration playbook: backlog resolution, wave execution, claim/receipt discipline. |
| `muster_gate_cadence` | `gate-cadence` | Compute review-gate cadence (spec-gate rounds, batched review passes, reviewer count) from a manifest's waves. |
| `muster_score` | `score` | Score an artifact against a gate (floor principle). |
| `muster_prioritize` | `prioritize` | Rank backlog items by RICE/ICE/WSJF/weighted. |
| `muster_pick` | `pick` | Pick the tournament winner from scored candidates. |
| `muster_tally` | `tally` | Tally adversarial review verdicts into a gate decision. |
| `muster_fuse` | `fuse` | Fusion decision engine: validate the debate map, apply the agreement gate, select top-K or fall back. |
| `muster_advise` | `advise` | Validate an advice request and resolve the advisor tier (apex degrades to prime; the active runtime adapter supplies any concrete model value). |
| `muster_receipt_verify` | `receipt-verify` | Verify a base-SHA is a real, resolvable git commit object in an explicit repo. |

The server injects Muster's principles, routing policy, and an execution protocol as its MCP instructions, so a host that has only tools still gets the orchestration discipline. It spawns the CLI as a child process, which can be blocked on Windows MSIX installs (virtualized bundle path) — verify with `scripts/cowork-probe.mjs` before relying on it there.

::: tip
Run `muster help`, `muster help <command>`, or `muster <command> --help` to see usage without executing the command. The CLI fails loud with a clear message on bad input.
:::
