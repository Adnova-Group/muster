# Muster architecture

Muster is a glass-box, multi-runtime, multi-domain agentic orchestrator. It runs on bare Claude Code, with no extra services and no separate model API. Give it an outcome, and it detects your project, discovers the capabilities you already have installed, assembles a crew of specialists to do the work, and shows its reasoning before it acts.

"Glass-box" is the design constraint that shapes the rest. Every routing decision is inspectable: which role resolved to which provider, on which model, and why. "Multi-runtime" means it composes whatever tools are present (your installed plugins, agents, and MCP servers) and falls back to its own built-ins when nothing better is around. "Multi-domain" means the work is not limited to code. Product, business, content, and operations pipelines are first-class, not bolted on.

This document explains how the pieces fit together. It assumes you are reading the source and want a map.

## Two layers

Muster is split into two layers with a hard boundary between them.

| Layer | Lives in | Runtime | Talks to a model? |
| --- | --- | --- | --- |
| Deterministic CLI | `src/*.js` | Plain Node ESM | No |
| Model-facing | `plugin/` (commands, skills, agents) | Claude Code | Yes |

The **CLI layer** is ordinary Node. It has a single runtime dependency (`yaml`), requires Node 20 or newer, and makes no model calls and no network calls -- the one carve-out is the `issue` verb, which shells out to `gh issue view` when the user passes a GitHub issue reference (opt-in; tests inject the exec dependency; cowork omits it). All other CLI verbs are local. It does the deterministic work: detecting the project, resolving roles to providers, ranking candidates by token overlap, scoring artifacts against a gate, computing prioritization math, loading and validating pipelines. Anything that can be answered by code is answered by code. You can run every CLI verb except `issue` in a terminal without any network access.

The **model-facing layer** is what Claude Code loads as a plugin. It is markdown: slash commands (`plugin/commands/`), skills (`plugin/skills/`), and agents (`plugin/agents/`). These files instruct the model how to drive a run. They call the CLI for every deterministic decision, then use Claude Code's built-in subagent dispatch to do the judgment work. The split is deliberate. Routing, scoring, and validation are reproducible because code owns them. Drafting, reviewing, and classifying are the model's job.

## The capability and domain router

The router is the novel core. The problem it solves: you have an outcome and a pile of tools (some you installed, some Muster ships), and you need to pick the right tool for each piece of work, predictably.

Muster names a fixed vocabulary of **roles**, the kinds of work a crew might need. There are 23 of them (see `src/roles.js`): `implement`, `code-review`, `test-author`, `debug`, `refactor`, `architecture-review`, `security-review`, `author`, `research`, `score`, `humanize`, and so on. Roles are the stable interface. Pipelines and commands ask for a role, not for a specific tool.

Each role resolves through a **ladder** of provider sources, best-available first:

1. An installed external provider (a plugin, agent, or MCP server you already have)
2. A Muster built-in agent
3. A Muster built-in skill
4. Inline (the model does it directly, with no specialist attached)

`muster capabilities` walks this ladder for every role and reports the result. For each role you get `chosen` (the winning provider), `chain` (the full ordered fallback list, always ending in `inline`), `recommendations` (installable external providers that would beat the current fallback), and `model` (covered below). The resolution is a single deterministic pass over the catalog, sorted by rank, in `src/capabilities.js`. Because the ladder always terminates at inline, every role resolves to something. Muster works on bare Claude Code and gets better as you install more tools.

The role enum is fixed, but the set of providers is not, and that creates a reach problem: some specialists do not map cleanly onto a named role. The escape hatch is **description-search**. `muster match "<task>"` is a deterministic token-overlap ranker (`src/match.js`, no LLM call). It tokenizes the task, builds a weighted bag of searchable tokens for every catalog provider (id, roles, and keywords weighted high; the free-text description weighted low), scores each provider by overlap, and adds a small boost for installed providers so a present tool edges out an equal-scoring fallback. The router uses `match` as a candidate source when an outcome does not fit the role enum. That is how a task like "audit this code for security vulnerabilities" surfaces the right specialist even when it never names a role.

## Per-role model selection

Each resolved role carries a model, picked to fit the work (`src/model.js`):

| Tier | Roles | Why |
| --- | --- | --- |
| haiku | `code-navigation`, `docs-research`, `research` | Mechanical: locating, gathering, scanning |
| sonnet | everything else (the default) | Implementation, review, authoring, scoring |
| fable | the tournament `judge`, `architecture-review`, `improve`, `advisor` | Heavy judgment |
| opus | fallback only (fable -> opus via `fallbackModelFor`) | Used when fable is unavailable on the plan |

The model comes back as `roles[<role>].model` from `muster capabilities`, and the orchestrator passes it as the dispatch model override when it spawns a subagent. So quota spend tracks the difficulty of the work: cheap models do the cheap parts, the expensive model is reserved for the calls that need it.

## Provider kinds

A provider resolves to one of four kinds, which decides how the orchestrator dispatches it:

- **agent**: a subagent definition, dispatched by `subagent_type`.
- **skill**: a markdown skill injected into a generic subagent.
- **mcp**: an installed MCP server, surfaced as a tool.
- **inline**: no specialist; the model does the work directly.

Dispatch honors `chosen.kind`: an agent routes by `subagent_type`, anything else gets a generic subagent with the relevant skill injected. The model override from per-role selection always applies, regardless of kind.

## The five modes

Muster exposes five entry points as slash commands under the `muster:` namespace.

| Mode | Command | Shape |
| --- | --- | --- |
| Run | `/muster:run <outcome>` | Plan and show, then stop for approval |
| Autopilot | `/muster:autopilot <outcome>` | Hands-off full lifecycle |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first single-bug fix |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix |
| Sprint | `/muster:sprint <backlog ref>` | Batch autopilot over every backlog item, never interviewing mid-batch, one stop at the end |

**Run** is the interactive router. Its front half is an assess-then-interview step: `muster assess` does a deterministic gap-check on the outcome (too short, vague, or no success criteria -- a bare percentage, a comparative quantifier like `at least 40`, and `N consecutive` all count as measurables alongside keywords and `by N`, but a digit embedded in an identifier like `file2.js` does not), and if the outcome is not clear, the interview skill runs an interactive requirements interview, one question at a time, behind an approval gate. An outcome that decomposes into independent parts can instead be written, one assess-passable item per part, to the sprint backlog (`.muster/backlog.md`) for `/muster:sprint` to run as a batch. Then it detects, routes, and shows the glass-box crew manifest plus the plan, and stops. Selecting Approve & run chains into autopilot in-session; Adjust and Cancel stay plan-only.

**Autopilot** runs the whole lifecycle hands-off: branch, detect, route, run waves (parallel fan-out, tournaments with fusion synthesis, an adversarial review gate), commit per wave, then present the merge decision. It only stops for that merge decision or for an escalation. Tournaments synthesize rather than only pick one winner: the judge maps consensus, contradictions, partial coverage, and blind spots across candidates; `muster fuse` then grafts the best of the top-K via a synthesizer or falls back to the single best candidate when candidates already agree. Workers can also escalate up to a stronger model at a hard decision point via the advisor role; the advisor informs, the worker decides. It triggers the interview only on an actual information gap, and in unattended (Routine) mode it records the gap to the run report instead of blocking. A pre-wave **spec gate** dispatches a fresh strategist-tier agent to probe the validated plan as a lazy-or-malicious implementer before wave 1; a `FAIL` loops the findings back to the router once, a second `FAIL` escalates, and the gate is skippable for trivial single-task plans. The finish step honors a manifest-declared `mergeDisposition` (`merge-local`/`merge-push`/`pr`/`keep`) by executing it without asking; absent or `ask` falls back to the interactive merge-decision prompt, and unattended (Routine) runs always downgrade `merge-local`/`merge-push` to `pr` rather than push to a base branch.

**Diagnose** is failure-first. Reproduce, find the root cause via systematic debugging on the best available debug provider, fix, add a regression test, verify. No symptom-patching.

**Audit** is the review-and-fix counterpart to diagnose: where diagnose is one bug, audit sweeps the whole codebase. It fans out six read-only dimension reviews in parallel (architecture, tech-debt, coverage, simplification, readability, security), with a conditional seventh (prompt-quality) when the project builds prompts or agents, each on the best provider for its role, consolidates the findings into one ranked ledger, then fixes everything with TDD and verifies through the review gate before presenting the merge. A `backlog` first token (`/muster:audit backlog [path]`) swaps the last two steps: no branch, no fixing, no merge -- the ranked ledger is written to `.muster/backlog.md` instead, one item per finding-cluster, for `/muster:sprint` to run later.

A backlog with any `{id}`/`{deps}`-annotated item (the shape `/muster:audit backlog` and the interview skill's decomposition write emit by default) switches `/muster:sprint` from the flat sequential queue into **wave mode**: `pr`/`keep` items in a wave dispatch as parallel worktree-isolated runners (`MUSTER_SPRINT_PARALLEL`, default 3), `merge-local`/`merge-push` items serialize at the wave barrier, and a harness that cannot dispatch parallel subagents runs the same waves sequentially instead -- wave order is never sacrificed. Wave mode only triggers off a file backlog; `issues:<label>` backlogs always stay sequential.

## Pipelines

A pipeline is a phased, gated recipe for producing one kind of artifact. Each pipeline declares a `domain`, an ordered list of `phases` (each phase names a `role`), and a `gate` (`src/pipeline.js` validates the shape). Pipelines live as YAML in `pipelines/` and cover both software and knowledge work: PRD, business-case, epic, user-story, launch-plan, release-notes, executive-summary, OKRs, AI implementation spec, AI test plan, competitive-battlecard, blog-post, social-post, lead-magnet, newsletter, case-study, runbook, roadmap, and book.

Routing to a pipeline is deterministic. `muster route "<outcome>"` matches the outcome against each pipeline's `match` keywords on word boundaries; if nothing matches, it falls back to the domain default. `muster pipeline <id|domain>` shows the resolved pipeline.

Gating uses a **floor principle** (`src/score.js`): the weakest dimension must clear the gate's `floor`, and the total must clear `pass_total`. A strong average cannot rescue one weak dimension. Scoring is deterministic and fails loud on non-finite inputs. The model only estimates the per-dimension scores; the code decides pass or fail.

Human-facing pipelines end with a `humanize` phase. The `muster-humanizer` built-in strips em-dashes, banned AI-tell words, and robotic cadence. Machine-facing AI specs (the implementation-spec and test-plan pipelines) are exempt, to preserve technical precision.

Roadmap prioritization is one such pipeline worth calling out. Goals go in, a RICE-prioritized now/next/later roadmap comes out. The model estimates the RICE factors (reach, impact, confidence, effort) with evidence-backed rationale; `muster prioritize <file> --model rice` does the arithmetic, ranking by `(reach * impact * confidence) / effort` and failing loud on zero-effort or non-finite inputs. RICE is the default, but the same deterministic scorer also offers three more models, selectable with `--model`: `ice` (impact times confidence times ease), `wsjf` (cost-of-delay divided by job-size), and `weighted` (Aha-style weighted scorecard, the sum of weight times score across custom criteria). Each fails loud on the same non-finite and zero-denominator discipline.

## Execution model

Muster runs on the interactive Claude Code subscription. Model work goes through Claude Code's built-in subagent dispatch (the Task/Agent tool), not through `claude -p` and not through the Agent SDK. The CLI itself makes no model calls.

The practical consequences:

- Muster draws normal interactive subscription quota. It does not hit the separate Agent-SDK credit pool.
- Fan-out spends that same quota faster, since parallel subagents are parallel quota.
- There is no separate runtime to deploy or key to manage. If you can run Claude Code, you can run Muster.

Orchestration loops until done via a Ralph-style primitive (`src/loop.js`). `loopState({ iteration, maxIterations, done })` returns an object `{ continue: bool, reason: "done" | "max-iterations" | "iterate" }`. The review-gate fix-loop uses the dedicated `reviewGateState` helper, which caps at `REVIEW_GATE_MAX_ITERATIONS = 3` regardless of the caller's `maxIterations`. Each wave re-runs implement, review, and fix until the gate passes (`reason: "done"`) or the iteration cap escalates (`reason: "max-iterations"`), so subagents drive toward the success criteria rather than stopping after one pass.

Plan tasks may also declare `owns`/`frozen` arrays -- opaque path-label strings validated by shape only, never by glob matching or overlap detection -- so the orchestrator can copy them into a dispatch brief as scope fences and dispatch same-wave tasks in parallel only when their `owns` sets are disjoint. Every dispatch brief also ends with a mandatory return contract: implementers return raw data (<=2000 chars), reviewers return a verdict first with <=1500 chars of findings, and the orchestrator reads each subagent result exactly once with no accumulation between waves -- git history and the run STATE are the record. Immediately after each wave commit, the orchestrator attaches a `git notes --ref=muster` record of that wave's intent (decisions, review cycles, findings fixed and accepted); the review gate reads it back on later waves to check the implementation against recorded intent, not just the diff against the spec.

Driving Muster remotely uses Claude Code's own features, not a transport Muster ships. A Claude Code Routine can fire `/muster:autopilot` as a scheduled cloud run. Channels deliver steering events (approve, stop, status, retarget) to a running session. Remote Control hands phone or web access to a running local session when a human wants to take over.

## Session hooks

Muster ships four plugin-native hooks in `plugin/hooks/`. All are declared in `plugin/hooks/hooks.json`, activate when muster is enabled, and are removed when muster is disabled. None write to the user's `~/.claude` files. Every hook is fail-safe: any error returns a minimal valid result and exits cleanly.

**`SessionStart`** (`session-start.js`) delivers always-on guidance. A Claude Code plugin cannot auto-load a `CLAUDE.md`, but a `SessionStart` hook can return `additionalContext`, which Claude Code prepends to the session. The script emits the working principles, the four verbs, and a dependency-free project sniff of the current directory. It also clears any stale `.muster/wave-active` marker so a new session never inherits a crashed wave's state.

**`UserPromptSubmit`** (`user-prompt-submit.js`) implements two-tier drift reinforcement so sessions do not revert to default Claude behavior after compaction or a long run. It maintains a per-session turn counter and injects a short nudge every `MUSTER_NUDGE_EVERY` turns (default 3) and the full principles + verbs + routing policy every `MUSTER_NUDGE_EVERY * MUSTER_PRINCIPLES_EVERY` turns (default every 9 turns). Compaction re-fires `SessionStart` as a backstop. Layered on top, a directive-triggered nudge fires independently of that cadence: `isDirective()` (`guidance.js`) deterministically detects an imperative-verb prompt (optionally after a polite lead-in; "Update:"/"Fix for" declaratives and questions are excluded), and the first such prompt with no active muster run (`.muster/run-active` absent) injects the routing policy immediately, once per session -- superseding whatever the periodic tier chose that turn. `/clear` re-arms it for the next session.

**`PreToolUse`** (`pre-tool-use.js`) enforces the wave-guard iron rule. While `.muster/wave-active` exists, any Edit, Write, NotebookEdit, or high-confidence Bash file write originating from the orchestrator main loop (not from a crew subagent) is blocked. Decision order: (1) subagent calls always allowed, (2) writes into `.muster/` or `.claude/` always allowed (STATE bookkeeping and repo-local settings), (3) if no wave marker exists, apply the per-turn scale gate (see below, may deny), (4) same when `wave-active` is present but `.muster/run-active` is absent (primary crashed-wave signal), or when the marker is older than 60 minutes (fallback stale detection), (5) with an active wave, honour `MUSTER_WAVE_GUARD`: `off` = silent allow, `warn` = allow with a reminder, unset or `deny` = deny. For Bash the guard is deliberately conservative (fail-open): only `sed -i`, `tee` to a non-exempt target, and `>` / `>>` redirects to non-exempt targets are denied; everything else allows. The command classifier lives in `bash-write-target.js` (pure, unit-testable). Exempt targets: `/dev/*`, `/tmp/*`, `.muster/*`. **Post-run scale gate:** the marker-based guard is intra-wave only, so once a run completes and the marker is removed the guard is inactive. That is the window where the orchestrator drifts back to inline work, and the advisory `UserPromptSubmit` nudge can't stop it (it's `additionalContext`, not a block, and it habituates). So in the no-wave state the hook additionally applies a per-turn *scale* gate: the main loop may touch 1-2 distinct files per turn (trivial/surgical falls through, per the routing policy), but the Nth distinct file (`MUSTER_INLINE_SCALE`, default 3, matching the surgeon "refuses 3+ files" boundary) is denied and routed to a verb. Both `Edit`/`Write`/`NotebookEdit` targets and high-confidence Bash file writes (via `bashWriteTarget`) count toward the budget, so the shell-write path is not an escape hatch. Read-only Bash passes through. Per-turn state lives in `os.tmpdir()` keyed by session (no repo litter), reset on each `UserPromptSubmit`; the count logic is pure and unit-tested in `inline-budget.js`. **Cumulative cross-turn drift:** a second counter (`inline-budget.js`: `cumFile`/`recordCum`/`markNudged`/`resetCum`) tracks the same distinct-file keys across turns, without the per-turn reset, so drift spread carefully across many turns (1-2 files each, never tripping the per-turn gate) still triggers a one-time WARN (never a deny) once the running total reaches `MUSTER_INLINE_SCALE`. It is reset when a muster run starts (that work is dispatched/tracked, not drift) and at `SessionStart`, so it survives `/compact` and session resume otherwise. Honors the same `MUSTER_WAVE_GUARD` (`off`/`warn`/`deny`) override.

**`PreToolUse` on `Task`/`Agent`** (`todo-gate.js`) enforces the todo-driving gate. During a live muster run (`.muster/run-active` present), dispatching a subagent wave via the `Task` or `Agent` tool is denied unless a native todo list was written since the run started, so plan progress stays visible in Claude Code's todo UI -- current Claude Code renamed the dispatch tool from `Task` to `Agent`, so both the `hooks.json` matcher and the in-hook guard match a `DISPATCH_TOOLS` set of both names (the gate was silently inert on the old `Task`-only match until this was fixed). The hook tail-reads the session transcript (last 256 KB) for a `TodoWrite`/`TaskCreate`/`TaskUpdate` tool call with a timestamp at or after the `run-active` mtime, minus a 2s grace margin (absorbs sub-second ISO 8601 flooring and minor clock skew). The decision order biases HARD toward allow: a non-dispatch tool, no `run-active` marker, `MUSTER_TODO_GATE=off`, a missing/unreadable/unparseable transcript, or unreadable todo timestamps all allow (`warn` allows with a note); only a readable transcript with provably no qualifying todo write denies. Self-contained (node builtins only) and fail-open on any exception.

## Enforcement model: gates vs conventions

Muster's PreToolUse hooks enforce three deterministic GATES and leave four categories to named conventions. Principle: enforce where mechanically sound; a gameable gate that fails open is worse than an honest, named convention.

### GATES (deterministic, hook-enforced -- these block)

**Wave-guard.** While `.muster/wave-active` exists, any main-loop Edit, Write, NotebookEdit, or high-confidence Bash file write is denied. The scale-gate applies instead when the companion `.muster/run-active` is absent (orphaned or crashed wave). Set `MUSTER_WAVE_GUARD=warn` to allow with a reminder (useful when the guard hits a genuine false positive); set it to `off` to disable.

**Post-run scale-gate.** Once the wave marker is gone, the main loop may touch at most `MUSTER_INLINE_SCALE - 1` (default: 2) distinct files per turn; the Nth file triggers a deny and routes to a verb. This closes the post-run window where the advisory nudge alone cannot hold inline drift. A cumulative cross-turn counter layered on top warns once per session (never denies) once the running total of distinct inline-edited files across turns reaches the same threshold, catching drift that never crosses the per-turn limit; it resets at `SessionStart` and while a run is active.

**Todo-driving gate.** During a live run (`.muster/run-active` present), a `Task`/`Agent` subagent dispatch is denied unless a native todo list (`TodoWrite`/`TaskCreate`/`TaskUpdate`) was written since the run started -- both tool names are gated, since current Claude Code renamed the dispatch tool from `Task` to `Agent` and the gate was inert on the old name alone. Transcript-tail scan with a 2s grace margin, fail-open on every uncertainty. Set `MUSTER_TODO_GATE=warn` to allow with a note, `off` to disable.

**Meta-exempt roots.** `.muster/` and `.claude/` (in-cwd repo) are always allowed so orchestrator bookkeeping and repo-local settings are never blocked mid-wave. Paths outside the project cwd are already out of scope for the cwd-relative gate.

### CONVENTIONS (not gate-able; enforced by SKILL discipline)

**Crew-owner/state-in-subject.** The PreToolUse hook cannot judge who owns a task or whether it is multi-step. That is runtime judgment, not a file-system observable. (Todo-driving graduated from this list to a gate in 0.3.2 -- see above.)

**Verb selection.** Intent classification (bug fix vs feature vs sweep) is a model judgment call, not a deterministic signal the hook can test.

**Content through humanizer routing.** The routing decision is judgment. The output rules (no em-dash, no banned openers) are enforced post-hoc by contract tests on committed artifacts, not by a hook.

**Glass-box narration.** Narration is reply-text content, not a tool surface. There is no hook point where it can be blocked or required.

### Rejected approaches

**Verb-routing run-active block.** Not built. Between-wave writes are already `.muster/`-exempt or `agent_id`-exempt; a block on absent run-active would add no enforcement power and would false-block trivial multi-file edits done outside a run.

**Transcript-scan todo gate.** Rejected in 0.3.1 as fragile and gameable, then revisited and built in 0.3.2 (`todo-gate.js`) once narrowed to dispatch time only: scanning the transcript tail for a todo write since the `run-active` mtime is a bounded, mechanically checkable question, and the hard bias-to-allow decision order removes the fail-open objection (uncertainty allows; only a readable, provably todo-free transcript denies). It remains gameable with a throwaway todo -- the gate enforces visibility, not compliance -- which is an accepted trade.

## Vendoring

Muster ships a curated set of built-in skills and agents, imported from upstream projects rather than hand-copied. `vendor/manifest.yaml` lists every source (repository, license, ref) and the specific items pulled from each, mapped to the Muster roles they serve. `muster vendor` generates the built-ins into `plugin/` and writes provenance into `NOTICE`.

The upstream sources are:

| Source | License | Provides |
| --- | --- | --- |
| obra/superpowers | MIT | Brainstorming, planning, TDD, code-review, debugging, verification skills |
| wshobson/agents | MIT | Software and knowledge-work agents and skills across many specialties |
| open-gsd/gsd-core | MIT | Plan, execute, and verify workflow phases |

Alongside the vendored material, Muster ships its own clean-room specialists in `plugin/agents/`: `muster-surgeon` (1-2 file edits), `muster-builder` (a cohesive slice), `muster-reviewer` (verdict-emitting review), `muster-investigator` (read-only locator), `muster-strategist` (heavyweight reasoning), and `muster-improver` (post-run retrospective that proposes user-gated edits to muster's own skills/rules). These are authored fresh from the role concept. Every wshobson agent carries a searchable description, which is what makes description-search (`muster match`) reach the breadth without inventing a named role for each specialist.
