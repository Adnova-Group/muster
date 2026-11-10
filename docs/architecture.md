# Muster architecture

Muster is a glass-box, multi-runtime, multi-domain agentic orchestrator. It runs through the active harness, with no extra service and no separate model API. Give it an outcome, and it detects your project, discovers the capabilities already installed, assembles a crew of specialists, and shows its reasoning before it acts.

"Glass-box" is the design constraint that shapes the rest. Every routing decision is inspectable: which role resolved to which provider, on which model, and why. "Multi-runtime" means it composes whatever tools are present (your installed plugins, agents, and MCP servers) and falls back to its own built-ins when nothing better is around. "Multi-domain" means the work is not limited to code. Product, business, content, and operations pipelines are first-class, not bolted on.

This document explains how the pieces fit together. It assumes you are reading the source and want a map.

## Shared architecture

### Two layers

Muster is split into two layers with a hard boundary between them.

| Layer | Lives in | Runtime | Talks to a model? |
| --- | --- | --- | --- |
| Deterministic CLI | `src/*.js` | Plain Node ESM | No |
| Model-facing | skills, commands, agents, and adapters | Active harness | Yes |

The **CLI layer** is ordinary Node. The published package has two runtime dependencies, `yaml` and `esbuild`, requires Node 20 or newer, and normally makes no model calls. Direct CLI verbs need no precompile, while tests, publishing, and adapter installation run the adapter build pipeline. Most verbs are fully local; four boundaries can use the network or active model account: `issue` performs explicit issue lookup, `vendor` fetches declared remote sources, `doctor` verifies pinned remote sources, and one adapter's native planning launcher begins a model turn. The remaining deterministic verbs run without network access. The CLI handles project detection, provider resolution, token-overlap ranking, gate scoring, prioritization math, and pipeline loading and validation.

The **model-facing layer** is a set of markdown commands, skills, agents, and adapter bindings. These files instruct the active harness how to drive a run. They call the CLI for every deterministic decision, then use the harness's dispatch primitive for judgment work. The split is deliberate. Routing, scoring, and validation are reproducible because code owns them. Drafting, reviewing, and classifying are the model's job.

### Initialization boundary

`muster init [dir]` is the deterministic project-onboarding verb. It learns bounded repository facts and owns exactly two files: `.muster/project-profile.json` and `.muster/init-receipt.json`. Both use schema version 1, recursively sorted canonical JSON, and stable bytes. The profile records `greenfield` or `brownfield` classification, languages, frameworks, package managers, source and test roots, bounded manifest and instruction facts, VCS facts, and a repository fingerprint. It is provider/model-neutral. Provider IDs, concrete model names, resolved roles, capability inventories, timestamps, and raw dependency maps never enter the profile.

For an empty greenfield directory, preparation may safely initialize `.git` before creating the owned pair. This is the one trust-boundary mutation: Git uses a fresh empty template and controlled built-ins, with no repository hooks or discovered commands. Preparation then creates the owned pair and a `not-requested` native state. The active runtime owns native instruction generation. A handoff records an immutable expected-artifact baseline and moves to `handoff`; a proven callable adapter must move to `attempted` before it can submit a call-result. Native completion requires positive evidence: a changed artifact hash, explicit confirmation of a pre-existing expected artifact, or a bounded call-result receipt tied to the attempt ID. A suggestion, request, command invocation, refusal to overwrite, or mere artifact existence is not evidence. A pending bare rerun only reports deterministic `observedNativeEvidence`; it does not rewrite state or the baseline. Same-state reruns are no-ops. Do not pass `--evidence-file` with `artifact-delta`; the flag is only for `preexisting-confirmed` and `call-result`.

The trust boundary is explicit. The target resolves to a real directory, owned files must be regular no-follow files with one link, and learning is bounded to regular files without symlink traversal. Init never executes or interprets repository setup instructions, package scripts, hooks, dependency installers, or discovered commands. A cloned or otherwise brownfield repository keeps its README, docs, ignore rules, instruction files, settings, hooks, and other user content. Brownfield finalization creates no generic seeds. Greenfield finalization may create only missing `.gitignore`, `README.md`, `docs/design/.gitkeep`, and `docs/plan/.gitkeep` after native completion or an explicitly acknowledged unavailable handoff. `muster setup [dir]` remains the explicit legacy scaffold command and is separate from Init.

### The capability and domain router

The router is the novel core. The problem it solves: you have an outcome and a pile of tools (some you installed, some Muster ships), and you need to pick the right tool for each piece of work, predictably.

Muster names a fixed vocabulary of **roles**, the kinds of work a crew might need. There are 26 of them (see `src/roles.js`): `implement`, `code-review`, `test-author`, `debug`, `refactor`, `architecture-review`, `security-review`, `author`, `research`, `score`, `humanize`, `image`, `video`, `lifecycle`, and so on. Roles are the stable interface. Pipelines and commands ask for a role, not for a specific tool.

Each role resolves through a **ladder** of provider sources, best-available first:

1. An installed external provider (a plugin, agent, or MCP server you already have)
2. A Muster built-in agent
3. A Muster built-in skill
4. Inline (the model does it directly, with no specialist attached)

`muster capabilities` walks this ladder for every role and reports the result. For each role you get `chosen` (the winning provider), `chain` (the full ordered fallback list, always ending in `inline`), `recommendations` (installable external providers that would beat the current fallback), and `model` (covered below). The resolution is a single deterministic pass over the catalog, sorted by rank, in `src/capabilities.js`. Because the ladder always terminates at inline, every role resolves to something. Muster works on a bare supported harness and gets better as you install more tools.

The role enum is fixed, but the set of providers is not, and that creates a reach problem: some specialists do not map cleanly onto a named role. The escape hatch is **description-search**. `muster match "<task>"` is a deterministic token-overlap ranker (`src/match.js`, no LLM call). It tokenizes the task, builds a weighted bag of searchable tokens for every catalog provider (id, roles, and keywords weighted high; the free-text description weighted low), scores each provider by overlap, and adds a small boost for installed providers so a present tool edges out an equal-scoring fallback. The router uses `match` as a candidate source when an outcome does not fit the role enum. That is how a task like "audit this code for security vulnerabilities" surfaces the right specialist even when it never names a role.

### Per-role model selection

Each resolved role carries a model, picked to fit the work (`src/model.js`):

| Tier | Roles | Why |
| --- | --- | --- |
| scout | `code-navigation`, `docs-research`, `research` | Mechanical locating, gathering, and scanning |
| core | everything else (the default) | Implementation, review, authoring, and scoring |
| prime | fallback for apex | Frontier judgment when apex is disabled |
| apex | the tournament `judge`, `architecture-review`, `improve`, `advisor` | Rare peak judgment |

The model comes back as `roles[<role>].model` from `muster capabilities`, and the orchestrator passes it as the dispatch model override when it spawns a subagent. So quota spend tracks the difficulty of the work: cheap models do the cheap parts, the expensive model is reserved for the calls that need it.

Apex is disabled by default, so `modelForRole` (`src/model.js`) degrades it to prime deterministically. Set `MUSTER_ENABLE_APEX=1` to enable it when the harness can serve it. `MUSTER_MAX_TIER` caps the highest conceptual tier Muster will use; `core` is the budget setting and `prime` excludes apex.

`catalog/agents.manifest.json` is the shared harness-neutral agent policy. Each profile declares a conceptual `tier`, optional `effort`, and `readOnly` boundary without naming a concrete provider model. Adapters translate that policy into their harness's concrete configuration.

<!-- legacy-tier-compat:start -->
Compatibility only: legacy input aliases `haiku`, `sonnet`, `opus`, and `fable` normalize to `scout`, `core`, `prime`, and `apex`; they are not a second conceptual ladder. `MUSTER_ENABLE_FABLE` remains an alias for `MUSTER_ENABLE_APEX`.
<!-- legacy-tier-compat:end -->

## Provider kinds

A provider resolves to one of four kinds, which decides how the orchestrator dispatches it:

- **agent**: a subagent definition, dispatched by the active harness's native agent identifier.
- **skill**: a markdown skill injected into a generic subagent.
- **mcp**: an installed MCP server, surfaced as a tool.
- **inline**: no specialist; the model does the work directly.

Dispatch honors `chosen.kind`: an agent routes by native agent identifier, anything else gets a generic subagent with the relevant skill injected. The model override from per-role selection always applies, regardless of kind.

## The seven modes

Muster exposes seven entry points as slash commands under the `muster:` namespace: an approve-first/hands-off pair (`plan`/`go`) that takes one outcome or a whole backlog, four standalone verbs (`diagnose`, `audit`, `design`, `capture`), and the repository initialization handoff (`init`).

| Mode | Command | Shape |
| --- | --- | --- |
| Plan | `/muster:plan <outcome \| backlog ref>` | Write and check PLAN.md, then stop for approval |
| Go | `/muster:go <outcome \| backlog ref>` | Plan, build in isolated worktrees, review, verify, then the merge decision |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first single-bug fix |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix |
| Design | `/muster:design <action>` | Canonical design-context resolution, digest/write gates, and 23 design workflows |
| Capture | `/muster:capture [hint]` | Conversation-to-backlog generator: mines the session's discussion into approval-gated backlog items, then stops -- no crew, no waves |
| Init | `/muster:init [dir]` | Prepare deterministic project state, coordinate native instruction handoff, and finalize from positive evidence or an acknowledged unavailable handoff |

**Plan** is the approve-first planner. One `muster preflight` call returns the run id, the scope (one item or a backlog), whether the outcome is clear (`muster assess`'s deterministic gap-check: too short, vague, or no success criteria), the per-seat models and candidate specialists; the full detail lands in `.muster/runs/<runId>/preflight.json`. Only an unclear outcome triggers questions, and the answers become numbered decisions (`D-NN`) in the run's `CONTEXT.md`. The `muster:plan` workflow then runs the planner and the plan checker (which runs `muster plan-lint`), revising at most three times and escalating when the binding-issue count stops falling or a checker issue contradicts a D-NN decision. Plan shows the verdict and a compact view of PLAN.md and stops; Approve & build continues as Go on the same branch without re-planning.

**Go** runs the whole lifecycle hands-off: the same preflight, questions only when unclear, and plan; then `muster build-args` writes the exact build arguments from PLAN.md and the main thread commits them; the `muster:build` workflow runs each wave as parallel executors in isolated worktrees, a reviewer with at most two fix rounds per task, and one verifier per run; `muster merge-wave` re-checks every claimed commit against the committed build args, merges the task branches in plan order, re-runs the planned verify commands and removes clean merged worktrees; Go then reports the verifier's PASS, GAPS or ABSTAIN and asks for the merge decision. It reaches the first executor in about five main-session turns, against about 14 + 2N before the revival. Unattended runs (a scheduled routine or a print-mode invocation) ask nothing, record gaps as assumptions, and never auto-merge or push to a base branch: they stop at a pull request, or a kept branch with no remote. Escalations (a stalled plan, a merge-wave refusal, a halted wave, a GAPS or ABSTAIN verdict) stop the run with their evidence.

Both verbs take a backlog too: each item gets its own preflight and plan, then one `muster:backlog` workflow builds the items sequentially, and `merge-wave` integrates them in backlog order. The run directory `.muster/runs/<runId>/` (CONTEXT, PLAN, build-args, SUMMARY-*, VERIFICATION, STATE) is committed on the work branch, and `muster next --run <runId>` derives a run's position from which of those files exist.

**Diagnose** is failure-first. Reproduce, find the root cause via systematic debugging on the best available debug provider, fix, add a regression test, verify. No symptom-patching.

**Audit** is the review-and-fix counterpart to diagnose: where diagnose is one bug, audit sweeps the whole codebase. It covers six read-only dimensions (architecture, tech-debt, coverage, simplification, readability, security), with a conditional seventh (prompt-quality) when the project builds prompts or agents. The active adapter may group them into three nonredundant read-only briefs: system quality, coverage, and security. Prompt-heavy scopes add a prompt-quality brief. Every required dimension must have a receipt before consolidation. Briefs dispatch concurrently when configured capacity permits, otherwise in dependency-free batches. Audit then fixes with TDD through `muster:build` and `merge-wave`, verifying with the reviewer and verifier verdicts. A `backlog` first token (`/muster:audit backlog [path]`) swaps the last two steps: no branch, no fixing, no merge. The ranked ledger is written to `.muster/backlog.md` instead, one item per finding-cluster, for `/muster:go .muster/backlog.md` to clear later.

**Capture** is the third backlog generator, alongside the interview skill's decomposition check and audit's backlog mode: it turns a session's discussion into backlog items so none has to be hand-written. It extracts candidate items from the conversation (scoped by an optional hint) -- findings, decisions, review residuals, an explicit user directive -- each traced to a quoted fragment or named decision (glass box), excluding unactioned musings, work already shipped this session, items already on the backlog, superseded calls, and anything explicitly parked. More than 10 survivors are capped, presenting only the most recent/decision-weighted 10 with the holdback count stated. Every surviving candidate runs through the same `assess`-passable validation and `.muster/backlog.md` dedupe the interview and audit backlog modes use, capped at 2 reword attempts before an item is offered marked `UNMEASURABLE` rather than fabricating a metric. Nothing is written until an explicit structured approval -- Approve all, Edit (re-validates before re-offering), Drop, or Cancel (writes nothing) -- because capture's write is human-gated by design, the same way the interview decomposition's write is. Capture has no run-active lifecycle: it never assembles a crew or dispatches a subagent wave, so the action fence has nothing to gate here -- a `run-active` marker would be inert boilerplate, deliberately omitted rather than copied from the other modes.

**Init** prepares a repository before greenfield work or adoption in a clone. The CLI learns bounded facts and writes the canonical `.muster/project-profile.json` and `.muster/init-receipt.json` pair. The profile is provider/model-neutral. Native instruction generation stays with the active runtime, so the command records a HUMAN-HOLD until artifact-delta, pre-existing confirmation, or a bound call-result provides positive evidence. An unknown harness, or any runtime with no proven callable native-init adapter, remains unavailable rather than receiving an invented command; acknowledge with `muster init acknowledge [dir] --reason unavailable` when the user accepts that limitation. Init preserves brownfield content, allows only four missing generic greenfield seeds at finalization, and never executes repository instructions or hooks. The legacy `setup` verb remains available for callers that explicitly need its scaffold behavior.

## Pipelines

A pipeline is a phased, gated recipe for producing one kind of artifact. Each pipeline declares a `domain`, an ordered list of `phases` (each phase names a `role`), an optional `optional_phases` list (run only when the outcome explicitly asks for that phase, e.g. a `publish` prep phase), and a `gate` (`src/pipeline.js` validates the shape). Pipelines live as YAML in `pipelines/` and cover both software and knowledge work: PRD, business-case, epic, user-story, launch-plan, release-notes (retitled Release Briefing), executive-summary, OKRs, AI implementation spec, AI test plan, competitive-battlecard, blog-post, social-post, lead-magnet, newsletter, case-study, runbook, roadmap, video-content, and book.

Routing to a pipeline is deterministic. `muster route "<outcome>"` matches the outcome against each pipeline's `match` keywords on word boundaries and picks the *earliest* keyword hit position in the outcome text (ties break by longer matched phrase, then file order) -- outcomes tend to name the artifact at the head and the subject at the tail, so this out-ranks a later, unrelated keyword match; if nothing matches, `route` falls back to the domain default. `muster pipeline <id|domain>` shows the resolved pipeline.

Gating uses a **floor principle** (`src/score.js`): the weakest dimension must clear the gate's `floor`, and the total must clear `pass_total`. A strong average cannot rescue one weak dimension. Scoring is deterministic and fails loud on non-finite inputs. The model only estimates the per-dimension scores; the code decides pass or fail.

Human-facing pipelines end with a `humanize` phase. The `muster-humanizer` built-in strips em-dashes, banned AI-tell words, and robotic cadence. Machine-facing AI specs (the implementation-spec and test-plan pipelines) are exempt, to preserve technical precision.

Several pipelines share a document-ingestion discipline: a phase that ingests source documents or raw notes builds a retrieval map before searching, then extracts a structured ledger (facts, or for meeting/brain-dump intake, `{decision|action|fact, owner, deadline, source-anchor}` rows) before synthesis, so downstream drafting reads the ledger rather than re-deriving claims. Case-study's synthesis phase specializes the same schema into an evidence table (quotes, metrics, facts, decisions/actions). Every anchored claim resolves under a trailing `## Sources` list, which `muster citation-check` (and the review gate's citation-guard integration, below) verifies deterministically. A `prd.yaml` review phase adds an assumption checker: every draft assumption is ranked load-bearing-times-evidence-strength, and the single riskiest is named as the "most dangerous assumption." Content pipelines (blog-post, social-post, newsletter) additionally resolve named profiles from `docs/profiles/` -- `AUDIENCES.md` (depth/jargon/altitude), `VOICE.md` (register/rhythm/anti-patterns), and `BRAND.md` (visual anchor for the `image`/`video` roles) -- creating or extending a profile on first use.

Roadmap prioritization is one such pipeline worth calling out. Goals go in, a RICE-prioritized now/next/later roadmap comes out. The model estimates the RICE factors (reach, impact, confidence, effort) with evidence-backed rationale; `muster prioritize <file> --model rice` does the arithmetic, ranking by `(reach * impact * confidence) / effort` and failing loud on zero-effort or non-finite inputs. RICE is the default, but the same deterministic scorer also offers three more models, selectable with `--model`: `ice` (impact times confidence times ease), `wsjf` (cost-of-delay divided by job-size), and `weighted` (Aha-style weighted scorecard, the sum of weight times score across custom criteria). Each fails loud on the same non-finite and zero-denominator discipline.

## Execution model

Muster uses the active harness's interactive model access and native dispatch surface. The CLI itself makes no model calls.

The practical consequences:

- Muster draws the active harness's normal interactive quota.
- Fan-out spends that same quota faster, since parallel subagents are parallel quota.
- There is no separate model runtime to deploy or key to manage.

Orchestration loops until done via progress-aware primitives in `src/loop.js`. `loopState` retains an optional explicit runaway cap but has no arbitrary default iteration stop. `progressAwareState`, `reviewGateState`, `specGateRecoveryState`, and `dispatchRetryState` compare deterministic outcome/candidate fingerprints: materially changed outcomes continue, while a configurable consecutive identical/no-progress streak stops deterministically. Each wave re-runs implement, independent review, repair, and replan until the gate passes or the progress controller reports a truthful terminal state.

Verdicts are evidence, not truth. Every workflow agent returns a schema-validated result carrying the evidence fields the main thread re-checks (`commit`, `commitReviewed`, `testsRun`, `testsPassed`), and `merge-wave` acts only on the commands in the committed build args, never on agent-reported ones. A run's fence is a fixed action-class vocabulary (`send`/`sign`/`submit`/`publish`/`purchase`/`delete-remote`): Go writes it to `.muster/forbidden-actions` with the `.muster/run-active` marker before building and removes both at the merge decision -- the fence guards the work phase, the merge decision is the authorized exit. The orchestrator skill holds the rules a run keeps after context compaction (dispatch, never work inline; evidence over verdicts; merge-wave as the only merge path; the marker lifecycle; the escalation stops) and gsd-core's context-budget rules, inside the 5,000-token budget a skill keeps after compaction.

## Harness-specific bindings

### Claude Code and Codex adapter: model profiles

Both adapters translate the neutral agent manifest into native profiles. The
Codex adapter currently maps bounded implementation work to
`gpt-5.6-luna`/xhigh, read-only locator work to `gpt-5.6-terra`/high, ordinary
review and strategy to `gpt-5.6-sol`/high, and security to
`gpt-5.6-sol`/xhigh through its `peak` effort override. Its generator and
`check:codex` validate concrete TOML against the neutral manifest.

### Codex adapter: native Plan launcher

`codex-plan` is the fourth boundary: it starts Codex App Server and begins a
model turn on the active Codex account. Other deterministic planning verbs stay offline.

### Claude Code adapter: remote controls

Driving Muster remotely in Claude Code uses the harness's own features, not a transport Muster ships. A Routine can fire `/muster:go` as a scheduled cloud run. Channels deliver steering events (approve, stop, status, retarget) to a running session. Remote Control hands phone or web access to a running local session when a human wants to take over.

### Claude Code adapter: dispatch lane

On Claude Code, plan and go call three plugin workflows by name: `Workflow({name:"muster:plan"})`, `Workflow({name:"muster:build"})` and `Workflow({name:"muster:backlog"})` (`plugin/workflows/`). The scripts own fan-out, worktree isolation, the review loop and its cap; they cannot run git or the CLI, so the deterministic steps (`build-args`, `merge-wave`, `next --run`) run in the main thread between workflow calls, and every human stop sits between workflows. Workflow consent is per run in manual and accept-edits modes; the named allow rules `Workflow(muster:plan)`, `Workflow(muster:build)` and `Workflow(muster:backlog)` skip the prompt (the un-namespaced form is denied). Resume uses `{name, resumeFromRunId}`. Where the Workflow tool is absent, the orchestrator skill's prose fallback dispatches the same agents with the Agent tool. Current models (the 5.x generation) have no native task board and the TaskOutput tool is gone, so progress lives in the run directory. The Codex lane is frozen: it builds unchanged from the pre-revival lifecycle prose in `codex/frozen/`, and `plugin/skills/orchestrator/references/codex-dispatch.md` stays the single source the Codex build extracts dispatch blocks from.

## Claude Code adapter: session hooks

Muster ships one plugin-native hook in `plugin/hooks/`, and it does nothing outside a muster run: a session that never invokes a verb pays no hook context and no nudge. It is declared in `plugin/hooks/hooks.json`, activates when muster is enabled, and is removed when muster is disabled. It never writes to the user's `~/.claude` files. Every hook is fail-safe: any error returns a minimal valid result and exits cleanly. (`plugin/hooks/` also carries two pure helper modules imported by the hooks but not themselves registered in `hooks.json`: `action-guard.js`, the action-class classifier the `PreToolUse` hook imports for the fence described below, and `guidance.js`, which holds the `emit()` helper plus the principles/verbs text the Cowork MCP server injects.) There is no `SessionStart` or `UserPromptSubmit` hook. `/muster:go` writes `.muster/run-active` before it builds and removes it at the merge decision; nothing renews or expires it, so a marker an interrupted run leaves behind stays until the next run overwrites it or someone deletes it.

Enforcement follows the run's EXTERNAL effects, not the orchestrator's own in-repo edits: the action-class fence (below) is the only DENY the `PreToolUse` hook can emit. The `muster:build` reviewer loop and `merge-wave`'s evidence checks remain muster's actual quality enforcement. The `TaskCompleted` gate went with the native task board in revival stage 2b: current models have no board to gate.

**`PreToolUse`** (`pre-tool-use.js`, matcher `Bash|PowerShell|mcp__.*`) is the action-class fence and nothing else. **Action-class fence** (`action-guard.js`): when both `.muster/run-active` and `.muster/forbidden-actions` exist, the hook classifies the tool call -- an `mcp__`-prefixed tool name against a fixed keyword set (`send`/`submit`/`publish`/`sign`/`purchase`, word-boundary matched so "sign" never fires inside "assign"), or a Bash or PowerShell command against a small high-confidence allowlist (`git push` variants including `--delete`, `npm publish`, `gh release create`, `gh pr merge`, `curl -X POST`) -- and denies a match against the run's declared `forbiddenActions` set, honouring `MUSTER_ACTION_GUARD` (`off`/`warn`/deny-by-default). There is no exemption: a delegated (`agent_id`) call is fenced like any other. Fail-open when either file is absent or unreadable, or no class matches.

## Claude Code adapter: enforcement model

Muster's `PreToolUse` hook enforces exactly one deterministic GATE on tool calls and leaves everything else about tool-call permission -- including what used to be four more mechanical gates -- to named conventions. Principle: enforce where mechanically sound; a gameable gate that fails open, or one trained to be disabled by its own false positives, is worse than an honest, named convention.

Muster keeps a running ledger of caught failure classes in `docs/anti-patterns.md`: each entry names the symptom, the root cause, and the guard that now exists, so a fixed bug does not slip back in under a new name. The orchestrator's brief-construction prose and the `muster-improver` agent both read it.

### GATES (deterministic, hook-enforced -- these block)

**Action-class fence.** When both `.muster/run-active` and `.muster/forbidden-actions` exist, a tool call classified (`action-guard.js`) into a run-forbidden action class (`send`/`sign`/`submit`/`publish`/`purchase`/`delete-remote`) is denied. Either file absent, or no class matching, is a no-op (fail-open). Set `MUSTER_ACTION_GUARD=warn` to allow with a reminder, `off` to disable. This is the only hard deny the `PreToolUse` hook can emit.

### CONVENTIONS (not gate-able; enforced by SKILL discipline)

**Wave discipline, todo-driving, scale discipline.** Dispatching instead of editing inline mid-run and routing orchestration-scale work through a verb instead of the main loop are SKILL-level discipline (`plugin/skills/orchestrator/SKILL.md`), not hook-enforced. Field evidence moved them off the GATES list (see "Rejected/removed approaches" below): a hard main-loop file-write block trained agents to reach for its own kill switch on legitimate concurrent work, a per-turn deny fired on sessions/repos where muster had never run, and a transcript-scanned todo gate added dispatch-time latency for a visibility guarantee a throwaway todo could already defeat.

**Crew-owner/state-in-subject.** The `PreToolUse` hook cannot judge who owns a task or whether it is multi-step. That is runtime judgment, not a file-system observable.

**Verb selection.** Intent classification (bug fix vs feature vs sweep) is a model judgment call, not a deterministic signal the hook can test.

**Content through humanizer routing.** The routing decision is judgment. The output rules (no em-dash, no banned openers) are enforced post-hoc by contract tests on committed artifacts, not by a hook.

**Glass-box narration.** Narration is reply-text content, not a tool surface. There is no hook point where it can be blocked or required.

### Rejected/removed approaches

**Verb-routing run-active block.** Not built. Between-wave writes are already `.muster/`-exempt or `agent_id`-exempt; a block on absent run-active would add no enforcement power and would false-block trivial multi-file edits done outside a run.

**Wave-guard (removed).** Built in 0.2.3, denied any main-loop Edit/Write/NotebookEdit or high-confidence Bash write while `.muster/wave-active` existed. Removed: an unscopable deny path that repeatedly fired on legitimate concurrent work outside the run it was meant to gate, teaching agents to reach for its own kill-switch env var as routine practice rather than a narrow escape hatch (see CHANGELOG for the removed env's name).

**Post-run scale-gate (removed).** Built to close the post-run drift window a per-turn deny once the wave marker was gone, then patched with a session-engagement marker after a field case showed it denying a session/repo where muster had never run at all. Removed rather than patched again: replaced by a warn-only border invitation, which needs no engagement heuristic because it never denies.

**Border invitation and session hooks (removed).** A warn-only nudge toward `/muster:go`, fed by a cumulative inline-file counter on `PreToolUse` and a directive-prompt detector on `UserPromptSubmit`, plus a `SessionStart` pointer line and a one-hour activity lease on the run markers. Removed: every session in every project paid for them (a node spawn on most tool calls, injected context, per-session temp files) whether or not muster was wanted, and a nudge fired on a one-file test fix. Muster now costs nothing until a verb is invoked.

**Task-completion gate (removed).** Built to deny a native task-board completion tick without a recorded review PASS. Removed in revival stage 2b: the task board is absent on current models, the new core tracks progress in the run directory, and the always-registered hook cost a node spawn per completion for nothing.

**Transcript-scan todo gate (removed).** Built in 0.3.2 (`todo-gate.js`) to deny a subagent-wave dispatch without a native todo list written since run start. Removed: still gameable with a throwaway todo (it enforced visibility, not compliance) and added dispatch-time latency for that guarantee; todo-driving is now `plugin/skills/orchestrator/SKILL.md` discipline.

## Multi-runtime: the binding interface

The shared architecture is harness-neutral: modes consume six primitives (dispatch, ask, enforce, isolate, receipts, and capability scan) rather than a named vendor API. `docs/binding-interface.md` maps each primitive to concrete harness mechanisms with file references and states the fallback when a harness lacks subagent dispatch or hooks. Adapter-only behavior is labeled in this document instead of being presented as the shared contract.

## Vendoring

Muster ships a curated set of built-in skills and agents, imported from upstream projects rather than hand-copied. `vendor/manifest.yaml` lists every source (repository, license, ref) and the specific items pulled from each, mapped to the Muster roles they serve. `muster vendor` generates the built-ins into `plugin/` and writes provenance into `NOTICE`.

The upstream sources are:

| Source | License | Provides |
| --- | --- | --- |
| obra/superpowers | MIT | Brainstorming, planning, TDD, code-review, debugging, verification skills |
| wshobson/agents | MIT | Software and knowledge-work agents and skills across many specialties |
| open-gsd/gsd-core | MIT | Plan, execute, and verify workflow phases |

Alongside the vendored material, Muster ships its own clean-room specialists in `plugin/agents/`: `muster-surgeon` (1-2 file edits), `muster-investigator` (read-only locator), `muster-strategist` (heavyweight reasoning), and `muster-improver` (post-run retrospective that proposes user-gated edits to muster's own skills/rules). These are authored fresh from the role concept. The stage-2 lifecycle seats are not clean-room: `muster-planner`, `muster-plan-checker`, `muster-executor` (which absorbed the former builder's one-slice scope contract), `muster-verifier` and `muster-reviewer` are adapted from gsd-core v1.20.1 agents, keep gsd's measured protocol text in marked verbatim regions, and are kept in sync by `muster vendor update gsd` (a 3-way merge against the base copies in `vendor/upstream/gsd/`). Every wshobson agent carries a searchable description, which is what makes description-search (`muster match`) reach the breadth without inventing a named role for each specialist.
