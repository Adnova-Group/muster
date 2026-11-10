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
| `preflight <outcome> [--json] [--run <id>] [--model <model>]` | One call that replaces scope, assess, fast-path, detect, capabilities and memory. Prints a compact summary (under 2 KB): run id, scope, clarity, fast-path eligibility, the model and effort for each Workflow seat (planner, checker, executor, reviewer, verifier), top candidate specialists, and whether gsd-core and other lifecycle plugins are installed. `--json` prints the summary as JSON. The full detail goes to `.muster/runs/<id>/preflight.json`. `--model <model>` pins every Workflow seat to that model (effort unchanged), for cheap smoke runs or budget lanes. |
| `build-args <runId> [--base <sha>]` | Derive the exact `muster:build` Workflow arguments from the run's approved `PLAN.md` and write `.muster/runs/<id>/build-args.json` (`{runId, base, models, waves}`; models come from `preflight.json`). Tasks group by their `wave` attribute; each carries its id, name, files, agent hint and `<automated>` verify commands. Checkpoint tasks are listed as `humanNeeded` instead of becoming executor work. `--base` defaults to `HEAD`. Exits 1, writing nothing, when a task lacks an id, a wave or a verify command. The caller commits the file before building, because `merge-wave` trusts only the committed copy. |
| `merge-wave <runId> --result <build-result.json>` | Merge a `muster:build` Workflow result. The build result is agent output, so the task order and the commands to re-run come from the approved build args, committed at HEAD as `.muster/runs/<id>/build-args.json`. It first checks that every claimed commit exists, is the tip of its branch and is the commit the reviewer passed. Then it merges the branches `--no-ff` in plan order and re-runs each task's planned `verify` commands. Agent-reported `testsRun` is compared against the plan but never executed. On success it records `SUMMARY-<task>.md`, removes each worktree only when it is clean, under `.claude/worktrees/` and has the merged branch checked out, deletes merged branches with `branch -d`, and appends to `.muster/runs/<id>/STATE.md`. Any mismatch rolls HEAD back and exits non-zero. It refuses to run inside a `.claude/worktrees/` checkout. |
| `plan-lint <PLAN.md> [--json] [--root <dir>]` | Deterministic plan gates ported from gsd-core (failing direction, verify-command grounding, plan structure, dependencies and waves, duplicate threat IDs, no shared files within a wave, already passing at HEAD). Reads files only and never executes plan commands. Prints the CheckResult shape; exits 0 with no blockers, 1 with blockers, 2 when not evaluated. Format: `docs/plan-format.md`. |
| `book <init\|args\|record\|amend\|close\|status> <runId> ...` | Book runs, the deterministic half of `/muster:write-book`. `init <runId> --outline <file>` seeds `.muster/runs/<id>/book.json` (outline, chapters, canon facts) from the `muster:book` Workflow's outline result and renders `CANON.md` and `LEDGER.md`. `args <runId> [--limit N] [--beta N] [--model M]` writes `book-args.json`: the next dependency waves of chapters to draft, chapters to re-check (edited since the last record, or carrying open continuity debts), and which whole-book passes run; `--model` sets one model for every book seat. `record <runId> --result <file>` applies a pass: chapter states, word counts and hashes from disk, new canon facts, and a continuity debt for every unresolved issue. `amend <runId> <C-id> <fact>` supersedes a canon fact and opens a debt on every written chapter that relied on it; `close <runId> <D-id> <resolution>` closes a debt by hand; `status <runId>` prints the next action. Every write appends to `STATE.md`. Exits 0 ok, 1 refused, 2 usage. Contract: `plugin/builtins/book-run/SKILL.md`. |
| `next --run <id>` | Derive a run's position from the files in `.muster/runs/<id>/` (CONTEXT, PLAN, build-result, SUMMARY-*, VERIFICATION, continue-here), print the next action, and rewrite the derived head of that run's `STATE.md`. |
| `resolve-cli` | Resolve how to invoke the muster CLI without paying an `npx -y` cold start on every call: a vendored plugin runtime (`$CLAUDE_PLUGIN_ROOT/runtime/muster.mjs`), a local checkout (`./src/cli.js`), a local/global `muster` bin, or an `npx` fallback (`degraded: true`) as a last resort. Meant to run ONCE per run; the caller reuses the answer for every later call. See [docs/performance-pass.md](https://github.com/Adnova-Group/muster/blob/main/docs/performance-pass.md). |
| `gate-cadence <manifest.json> [--changed-lines N]` | The small-task fast path: given the manifest's dependency-ordered waves, report how many spec-gate rounds and review-gate batches this run defaults to (`{taskCount, waveCount, specGateRounds, reviewGateBatches, fastPath, reason}`). Plans at or below the small-task threshold (3 tasks) batch the per-wave review gate into a single pass instead of one dispatch per wave; larger plans keep depth proportional to wave count. `--changed-lines N` additionally folds in `reviewerCount` (1 below the diff-size threshold, 2 at/over it — default 200 changed lines, `MUSTER_REVIEW_DIFF_THRESHOLD` env override): a diff-size lever, independent of the task-count one, so a large multi-task diff always keeps both reviewers. Both are batching/scaling levers only — the gate's own pass bar and fix-loop cap are unchanged. See [docs/performance-pass.md](https://github.com/Adnova-Group/muster/blob/main/docs/performance-pass.md) and [docs/weight-reduction.md](https://github.com/Adnova-Group/muster/blob/main/docs/weight-reduction.md). |
| `wave-dispatch [--agent-teams\|--no-agent-teams]` | Capability check + fallback-selection for the orchestrator's wave dispatch mechanism (`{mode: "native"\|"prose", agentTeams, reason}`). Claude Code exposes a native, deterministic Workflow tool for wave fan-out + barrier; on current builds it sits in the plain single-session tool list (corrected 2026-07-29, live 2.1.220), but older builds and `--tools`-restricted sessions lack it, and only the session itself can see its own tool list — so it's a DECLARED capability, never probed from outside: `--agent-teams`/`--no-agent-teams` is the orchestrator's own self-observed signal (does its tool list carry `Workflow` this session?), falling back to the `MUSTER_AGENT_TEAMS` env var when omitted. Absent any declaration, `mode` is always `"prose"` — the wave loop's unconditional floor on every harness or session without the tool (Codex, Cowork, `--tools`-restricted or pre-Workflow Claude Code builds). See [docs/native-workflow-dispatch.md](https://github.com/Adnova-Group/muster/blob/main/docs/native-workflow-dispatch.md). |
| `codex-wave <wave.json> --fence-file <action-fence.json> --repository-root <repo> --base-sha <sha>` | Hermetic Codex wave execution and the sole production-wave route. Every member declares `agentType: "muster-runner"` and runs as a separately bounded `codex exec -C` process in a registered pristine linked worktree. The no-follow fence file maps every member id to validated fixed-vocabulary action classes; the runtime injects it separately from the user brief and receipts its digest alongside the installed runner policy, trusted Codex/Git executables, repository root, and exact base SHA. Each successful member result also carries a fix-loop binding for its exact `thread.started` UUID, canonical cwd, trusted base SHA, probed Codex version, and full resolved runner-policy fingerprint. |
| `worktree-isolation --harness <claude-code\|claude-desktop\|hermes\|codex>` | Per-harness native worktree-isolation selection. Codex subagent leaf dispatch has only a `receipts-only` native floor because its subagent API carries no cwd; Codex production waves therefore use `codex-wave`'s stronger registered-process-worktree boundary. `receiptRequired` is always `true`, and an unknown harness fails loud. See [docs/strategy/native-delegation.md](https://github.com/Adnova-Group/muster/blob/main/docs/strategy/native-delegation.md) #10. |
| `plan-surface <runtime>` | Per-harness plan-surface capability selection for the approve-first gate (`{runtime, surface, primitive, detail, cite}`), a declared (not auto-probed) choice: `claude-code` → native `ExitPlanMode`; `codex` → native `plan-skill+permission-mode`; `hermes` → native `plan-skill+goal-contract`; `cowork` → `prose` with no native primitive. Any unknown or missing runtime resolves to the universal `AskUserQuestion` prose fallback — never a thrown error, so an unrecognized harness still gets an approve-first gate. See `src/plan-surface.js`. |
| `desktop-harness <chatgpt-desktop\|codex-desktop\|gpt-work>` | Resolve an explicitly declared ChatGPT Desktop surface to its capability and Init contract. The shell alone requires an experience selection and exposes no native init; Codex Desktop selects `--codex` and hands off to native `/init` for `AGENTS.md`; GPT Work aliases ChatGPT Work, selects the MCP-or-inline `--work` lane, and records native init as unavailable. The command never guesses the app's selected experience from disk. |
| `codex-plan <outcome> [--cwd <dir>]` | From an interactive terminal, start a new `muster-plan` turn through Codex App Server with the live `collaborationMode/list` Plan preset. The command derives the schema-required settings from the preset plus `thread/start`, relays structured approval input to the terminal, leaves approval/reviewer/permissions/sandbox controls inherited, and reports activation only after effective thread settings confirm Plan. It cannot switch an already-running chat; non-interactive, unavailable, or unconfirmed control exits nonzero with explicit `/plan $muster-plan ...` guidance. |
| `backlog-receipts <backlog.md\|-> --release-ref <ref>` | Rejects every checked, non-withdrawn file-backlog item unless its single `{merge: <SHA>}` or `{done: <SHA>}` receipt is a full lowercase commit SHA reachable from the declared release ref. `-` reads staged bytes from stdin so the caller can validate exactly what it will publish. `{withdrawn: <reason>}` is the explicit exemption. Exits `0` only when all checked items pass, `2` with every rejected item otherwise; operational Git failures exit `1`. |
| `codex-wave-resume <receipt-id> --review-state <file>` | Authenticate an opaque process-wave receipt from the owner-only runtime store, independently re-derive executable/version, repository/worktree/base/HEAD, runner policy, and forbidden-action fence, then resume the exact persisted thread inside its private persistent Codex home and the original bubblewrap/hermetic limits. The real Codex home, global user-skill root, receipt store, and sibling sessions are masked; new reviewer findings are bounded untrusted data over stdin, and returned JSONL redacts the thread UUID. |
| `fast-path <outcome> [--capabilities <file>]` | Pre-router single-agent fast path: score an outcome's raw text for whether it's small/single-task enough to skip crew assembly (the router dispatch) and the spec gate entirely (`{eligible, wordCount, reason}`). With `--capabilities <file>` and `eligible: true`, also emits the minimal Crew Manifest directly (`manifest`: one task, a builder, and ONE reviewer — no LLM dispatch). Deterministic, conservative by design — any cross-cutting-scope signal, multi-deliverable separator, chained imperative verbs, or a long outcome disqualifies it, so genuine multi-task work never mis-scores eligible. See [docs/weight-reduction.md](https://github.com/Adnova-Group/muster/blob/main/docs/weight-reduction.md). |
| `review-brief --reviewer-count <n> [--diff-files <file>] [--diff-text-file <file>]` | Fast-path-token-gap lever 1's eligibility check, now used only by the frozen Codex lane: whether a `reviewerCount: 1` (sub-threshold diff) dispatch may use the lighter `codex/frozen/skills/review-gate/fast-path-brief.md` instead of the full frozen review-gate skill (`{eligible, triggers: {mutantKill, citation, surface, any}}`). `--diff-files <file>` (one changed path per line, e.g. `git diff --name-only` output) and `--diff-text-file <file>` (the diff's own text, for the citation-in-text signal) are both optional; `reviewerCount` other than `1`, or any trigger firing, is never eligible. See [docs/fast-path-token-gap.md](https://github.com/Adnova-Group/muster/blob/main/docs/fast-path-token-gap.md). |
| `codex-spawn-packet --task-id <id> --agent-type <id> [--message <text>\|--message-file <f>] [--version v1\|v2] [--fork-turns <none\|N>]` | Print the exact `spawn_agent` call JSON for an explicit non-wave leaf delegation (`src/codex-dispatch.js`): v2 → `collaboration.spawn_agent`; v1 → `multi_agent_v1.spawn_agent`. Version resolution fails closed to v1 when absent, and `"all"` is refused with a named `agent_type`. Production waves use `codex-wave`, never this packet. |
| `codex-wait-packet [--version v1\|v2] [--targets a,b] [--timeout-ms N]` | Print a mailbox wait descriptor for explicit non-wave leaf delegation only. Production waves use `codex-wave`'s process barrier. For a non-wave leaf, v1 waits on named targets; v2 takes no targets and wakes on any mailbox update. Neither is an all-barrier. |
| `codex-audit-provider --role <role> --task-id <id> --callable-apis <v1,v2> [--message <text>\|--message-file <f>]` | Resolve a read-only audit leaf against the manifest-ordered agent chain, live Codex inventory, per-model multi-agent API version, and APIs callable in the active session. It emits an exact non-wave leaf packet or a machine-readable inline degradation; production audit waves still use `codex-wave`. |
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
| `audit [--backlog] [path...]` | Drive the whole-codebase review and fix across six dimensions (architecture, tech-debt, coverage, simplification, readability, security). When the project builds prompts/agents (an LLM/agent SDK dependency is present), a seventh `prompt-quality` dimension is added, backed by `prompt scan`. One or more `path` arguments scope the sweep to those paths. `--backlog` switches to backlog mode: the sweep stays read-only and the ranked ledger is written to `.muster/backlog.md`, one item per finding-cluster, for `/muster:go .muster/backlog.md` to clear later, instead of fixing findings inline. |
| `issue <ref>` | Resolve a GitHub issue reference into an outcome (title + body). |
| `assess <outcome>` | Deterministic gap-check: is the outcome clear enough to route? |
| `steer <message>` | Classify a mid-run steering message (approve, stop, status, retarget). |

## Ops and setup

| Command | What it does |
| --- | --- |
| `design <init\|status\|resolve\|detect\|ignores\|provider\|gate\|workflows\|run> ...` | Own the first-class design surface: resolve monorepo-aware canonical `DESIGN.md`, emit SHA-256 context receipts, initialize only with attended confirmed content, manage ignore/provider state, run bounded evidence detection, enforce human-facing write gates, or dispatch one of 23 pinned Impeccable-inspired workflows. The optional detector requires Node 22.12+, while Muster itself remains Node 20+. |
| `install [home]` | Print the plugin-install steps (`/plugin marketplace add …`, `/plugin install …`) — the Claude Code actions a shell command cannot perform. It **mutates nothing under `~/.claude`**: the glass-box output style is plugin-native and opt-in (pick it under `/config`), so there is no file to copy and no style command to run. `[home]` (default: your home directory) only scopes the legacy-path checks. |
| `uninstall [home]` | Print the plugin-removal steps, then clean up after older Muster versions: a **legacy copied style** at `[home]/.claude/output-styles/muster.md` is removed, and a displaced original is restored from its `.bak`. This is the one path that writes under `~/.claude`; on a current install there is nothing there to remove. |
| `init [dir]` | Prepare a deterministic, provider/model-neutral repository profile and receipt at `.muster/project-profile.json` and `.muster/init-receipt.json`. For an empty greenfield directory, preparation may safely initialize `.git` before the owned pair. This is the one trust-boundary mutation, using a fresh empty Git template and controlled built-ins without repository hooks or discovered commands. The CLI learns bounded facts, captures the native-artifact baseline, and emits a complete receipt envelope. The active runtime owns instruction generation: use its native action when callable, then resume with positive artifact-delta, preexisting-confirmed, or attempt-bound call-result evidence. A suggestion, request, invocation, refusal to overwrite, or existing artifact alone is not completion. Copilot and unknown runtimes without a proven adapter remain unavailable; acknowledge with `init acknowledge [dir] --reason unavailable` when accepted. An unavailable handoff remains a HUMAN-HOLD until that acknowledgement; finalization keeps `nativeInit.state` as `handoff`. Same-state reruns are no-ops. Greenfield finalization can create only missing `.gitignore`, `README.md`, `docs/design/.gitkeep`, and `docs/plan/.gitkeep`; brownfield finalization creates none and preserves user files. Init never executes repository scripts, hooks, installers, or discovered commands. Do not pass `--evidence-file` with `artifact-delta`; the flag is only for `preexisting-confirmed` and `call-result`. |
| `init transition [dir] --to <handoff\|attempted>` | Record the native handoff or begin a proven callable attempt. Use `--reason <code> --expect <csv>` for `handoff`; use `--expect <csv>` for `attempted`. |
| `init transition [dir] --to completed --evidence artifact-delta` | Complete from a changed or newly created expected native artifact. This form takes no `--evidence-file`; the CLI compares the artifact hash with the immutable handoff baseline. |
| `init transition [dir] --to completed --evidence preexisting-confirmed --evidence-file <path>` | Complete from the required bounded confirmation JSON for expected artifacts that predated the handoff. The evidence file is required and must be separate from every expected native artifact. |
| `init transition [dir] --to completed --evidence call-result --evidence-file <path>` | Complete from a bounded native call-result JSON. The evidence file is required, the transition must start from `attempted`, and its `attemptId` must match the receipt. |
| `init acknowledge [dir] --reason unavailable` | Acknowledge an unavailable native handoff so finalization can continue. The receipt remains in native `handoff`, never `completed`. |
| `init finalize [dir]` | Finalize after native completion or an acknowledged unavailable handoff. Emits the complete receipt envelope and is idempotent. |
| `setup [dir]` | Legacy explicit scaffold command. It remains separate from Init and may seed its older Muster files. |
| `vendor` | Generate built-in agents and skills from `vendor/manifest.yaml`. |
| `provenance [--write]` | Check (default; exits 1 on drift) or rewrite every item's `upstream:` field, the catalog provenance summary, and NOTICE from `vendor/manifest.yaml`. Offline. |
| `doctor` | Health-check the installation. |
| `doctor --codex` | Health-check the Codex CLI, generated profiles, plugin runtime, lifecycle hooks, live inventory, advisory policy limitations, and a stale PATH-level `muster` shadowing this package's own bin. |
| `codex-conformance [YYYY/MM/DD \| --days N] [--cwd <substr>] [--current-pins-only]` | Audit Codex session rollouts for subagent model conformance: one UTC day (default: today), or an inclusive `--days N` range covering today and the preceding N-1 days. Compares each spawned thread's actual per-turn model with its Muster profile TOML pin, flags MISMATCH and generic-inheritance threads, and exits nonzero on any mismatch. Each MISMATCH row is stamped `pinsNewerThanRollout` (the rollout predates the newest profile TOML, i.e. a retier happened since) and the tally gains a `prePinMismatch` count; `--current-pins-only` excludes those pre-retier rows from the exit-code decision only -- rows stay listed and annotated either way, never hidden. |
| `install codex [--scope project-or-user] [--dry-run]` | Install Muster-managed Codex profiles and lifecycle hooks in the project or user scope, preserving unrelated hook groups, and register the Muster marketplace when Codex is available. |
| `uninstall codex [--scope project-or-user] [--dry-run]` | Remove only Codex profiles, hook groups, and hook runtime files recorded in Muster's managed-install manifests, then remove the plugin when Codex is available. |
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
| `muster_design` | `design` | Resolve/gate canonical design context or run a pinned design workflow across Cowork, ChatGPT Work full, Codex, and inline MCP lanes. |
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

The server injects Muster's principles, routing policy, and an execution protocol as its MCP instructions, so a host that has only tools still gets the orchestration discipline. It spawns the CLI as a child process, which can be blocked on Windows MSIX installs (virtualized bundle path) — verify with `scripts/cowork-probe.mjs` before relying on it there.

::: tip
Run `muster help`, `muster help <command>`, or `muster <command> --help` to see usage without executing the command. The CLI fails loud with a clear message on bad input.
:::
