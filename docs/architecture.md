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

The **CLI layer** is ordinary Node. The published package has two runtime dependencies, `yaml` and `esbuild`, requires Node 20 or newer, and normally makes no model calls. Direct CLI verbs need no precompile, while tests, publishing, and adapter installation run the adapter build pipeline. Most verbs are fully local; five boundaries can use the network or active model account. `issue` shells out to `gh issue view` for an explicit issue reference. `vendor` fetches sources declared with `kind: github` in `vendor/manifest.yaml` (local sources stay offline). `doctor` verifies vendor note SHAs against pinned refs; if that remote check is unavailable, it reports the check as skipped offline, while a missing, unreadable, or invalid local vendor manifest still fails health. An opt-in adapter probe may perform an authenticated models request; omit the probe for an offline install. From an interactive terminal, `codex-plan` starts a new `codex app-server` model turn; non-interactive callers receive `/plan $muster-plan ...` guidance without starting one. The remaining deterministic verbs run without network access. The CLI handles project detection, provider resolution, token-overlap ranking, gate scoring, prioritization math, and pipeline loading and validation.

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

## The ten modes

Muster exposes ten primary entry points as slash commands under the `muster:` namespace: an approve-first/hands-off pair for a single outcome (`plan`/`go`), the same pair for a whole backlog (`plan-backlog`/`go-backlog`), five standalone verbs (`diagnose`, `audit`, `design`, `runner`, `capture`), and the repository initialization handoff (`init`). `run`, `autopilot`, and `sprint` still work -- each is a one-line heads-up followed by identical behavior under its new name (`plan`, `go`, and `go-backlog`); deprecated as of 2026-07-17 and retiring in muster 0.7.0, with behavior unchanged until then.

| Mode | Command | Shape |
| --- | --- | --- |
| Plan | `/muster:plan <outcome \| backlog text>` | Scope-confirmed, then plan and show; stop for approval |
| Go | `/muster:go <outcome \| backlog text>` | Scope-confirmed, then hands-off full lifecycle |
| Plan-backlog | `/muster:plan-backlog <backlog ref \| raw intent>` | Batch-plan every item up front, stop for approval |
| Go-backlog | `/muster:go-backlog <backlog ref>` | Batch Go over every backlog item, never interviewing mid-batch, one stop at the end |
| Diagnose | `/muster:diagnose <symptom>` | Failure-first single-bug fix |
| Audit | `/muster:audit [path]` | Breadth-first whole-codebase review and fix |
| Design | `/muster:design <action>` | Canonical design-context resolution, digest/write gates, and 23 design workflows |
| Runner | `/muster:runner [source]` | Unattended one-cycle work-picker, fired repeatedly by a Routine/cron: resume or claim exactly one item, run it force-coerced to `pr`, leave a receipt, stop |
| Capture | `/muster:capture [hint]` | Conversation-to-backlog generator: mines the session's discussion into approval-gated backlog items, then stops -- no crew, no waves |
| Init | `/muster:init [dir]` | Prepare deterministic project state, coordinate native instruction handoff, and finalize from positive evidence or an acknowledged unavailable handoff |

**Plan** is the approve-first router. A `muster scope` call first resolves whether the invocation is a single outcome or a backlog; whenever the signals are anything but a clear single item, scope is confirmed through the active harness's structured question surface, stating every signal verbatim -- never inferred silently. Plan then announces in one line what it's about to produce. For a single outcome, its front half is an assess-then-interview step: `muster assess` does a deterministic gap-check on the outcome (too short, vague, or no success criteria -- a bare percentage, a comparative quantifier like `at least 40`, and `N consecutive` all count as measurables alongside keywords and `by N`, but a digit embedded in an identifier like `file2.js` does not), and if the outcome is not clear, the interview skill runs an interactive requirements interview, one question at a time, behind an approval gate. Then it detects, routes, and shows the glass-box crew manifest plus the plan, and stops. Selecting Approve & run chains into Go in-session; Adjust and Cancel stay plan-only. On a confirmed backlog scope, Plan delegates straight to **Plan-backlog** for the batch form instead.

**Go** runs the whole lifecycle hands-off. It shares Plan's scope detection and confirm at invocation -- a confirmed backlog scope delegates to **Go-backlog** -- then, for a single outcome: branch, detect, route, run waves (parallel fan-out, tournaments with fusion synthesis, an adversarial review gate), commit per wave, then present the merge decision. It only stops for the scope confirmation, the merge decision, or an escalation. Tournaments synthesize rather than only pick one winner: the judge maps consensus, contradictions, partial coverage, and blind spots across candidates; `muster fuse` then grafts the best of the top-K via a synthesizer or falls back to the single best candidate when candidates already agree. Workers can also escalate up to a stronger model at a hard decision point via the advisor role; the advisor informs, the worker decides. It triggers the interview only on an actual information gap, and in unattended (Routine) mode it records the gap to the run report instead of blocking. A pre-wave **spec gate** dispatches a fresh strategist-tier agent to probe the validated plan as a lazy-or-malicious implementer before wave 1; a round-1 `FAIL` always loops the findings back to the router (amendment 1). A round-2 `FAIL` compares its itemized findings against round 1's: any repeated/unresolved round-1 finding hard-aborts, but if every round-2 finding is disjoint (genuinely new, not a restatement) the gate allows a second amendment (amendment 2, the final one) instead of escalating immediately -- the disjointness call is recorded in STATE. A round-3 `FAIL` always hard-aborts regardless of disjointness (rounds capped at 3: initial + 2 amendments), and the gate is skippable for trivial single-task plans. The finish step honors a manifest-declared `mergeDisposition` (`merge-local`/`merge-push`/`pr`/`keep`) by executing it without asking; absent or `ask` falls back to the interactive merge-decision prompt, and unattended (Routine) runs always downgrade `merge-local`/`merge-push` to `pr` rather than push to a base branch.

**Plan-backlog** is the declared-scope batch planner, reached either directly or through Plan's confirmed-backlog delegation. It routes every item in a backlog up front against one shared detect/capabilities context, never interviewing mid-batch (a `clear: false` item is flagged on its plan row instead), and renders ONE batch plan: per-item crew summaries, the run order (`sprint-waves` stays authoritative, so an annotated backlog previews its wave structure), and advisory cross-item conflict flags wherever two concurrent items' `plan[].owns` fences overlap on a path boundary (an unfenced item is listed, never guessed at). Given a raw intent instead of a resolvable backlog ref, it first decomposes the intent into candidate items via the interview skill's decomposition machinery and gates the write with a capture-style human approval, before rendering the batch plan over the freshly written backlog. Nothing executes before the approval gate: Approve & clear chains into **Go-backlog** in-session, Adjust re-routes the named items and re-renders the plan, Cancel exits with nothing executed.

**Go-backlog** is the batch counterpart to Go, reached either directly or through Go's confirmed-backlog delegation. It resolves a backlog -- `.muster/backlog.md`'s unchecked `- [ ]` items, each optionally carrying dependency and disposition annotations, or `issues:<label>`/`linear:<team>`. Plain and remote backlogs run sequentially; annotated file backlogs use the dependency-wave schedule below. Per item, the declared disposition executes directly, without the merge-decision prompt: `ask` or an absent annotation coerces to `pr`, and in unattended mode `merge-local`/`merge-push` downgrade to `pr`. An escalated item never aborts the batch -- it stays unchecked with an `{escalated}` annotation and go-backlog moves on to the next item. A per-item outcome that `muster assess` would normally send to interview never triggers one inside a batch, even in an attended session -- it proceeds with Go's Unattended (Routine) best-effort defaults, and the gap is recorded in STATE and the batch report instead; interviews belong at backlog-authoring time, not mid-batch. Go-backlog stops exactly once, attended, at the end: a batch report headlined "cleared N, escalated M."

A backlog with any `{id}`/`{deps}`-annotated item (the shape `/muster:audit backlog` and the interview skill's decomposition write emit by default) switches `/muster:go-backlog` from the flat sequential queue into **wave mode**. Every ready item, regardless of disposition, enters the isolated build/review schedule. The harness dispatches as many as the emitted `MUSTER_SPRINT_PARALLEL` bound permits (default 5, hard ceiling 10); there is no fixed three-runner cap. A harness that cannot dispatch parallel subagents executes the same schedule sequentially without changing dependency order.

The executable progress loop is reconcile, dispatch, then wait: after every completion wake, the adapter drains all currently available receipts into `sprint-reconcile`, dispatches every newly eligible implementation/review action, and reconciles again before an idle wait is allowed. Only a full wave-wide build/review barrier exposes the backlog-ordered disposition/integration lane, one item at a time; the next dependency wave waits for the post-barrier state. Duplicate or early receipts are retained idempotently, while failed, cancelled, or missing receipts do not unlock dependents. Wave mode only triggers off a file backlog; `issues:<label>` backlogs always stay sequential. After the current barrier and ordered lane complete, go-backlog re-resolves the file so newly added unchecked items join the run and a just-completed dependency is observed without a stale snapshot.

**Diagnose** is failure-first. Reproduce, find the root cause via systematic debugging on the best available debug provider, fix, add a regression test, verify. No symptom-patching.

**Audit** is the review-and-fix counterpart to diagnose: where diagnose is one bug, audit sweeps the whole codebase. It covers six read-only dimensions (architecture, tech-debt, coverage, simplification, readability, security), with a conditional seventh (prompt-quality) when the project builds prompts or agents. The active adapter may group them into three nonredundant read-only briefs: system quality, coverage, and security. Prompt-heavy scopes add a prompt-quality brief. Every required dimension must have a receipt before consolidation. Briefs dispatch concurrently when configured capacity permits, otherwise in dependency-free batches. Audit then fixes with TDD and verifies through the review gate. A `backlog` first token (`/muster:audit backlog [path]`) swaps the last two steps: no branch, no fixing, no merge. The ranked ledger is written to `.muster/backlog.md` instead, one item per finding-cluster, for `/muster:go-backlog` to clear later.

**Runner** is `/muster:runner`'s single-cycle counterpart to Go-backlog's batch clear: resolve the source, resume an answered BLOCKED or HUMAN-HOLD item (resume rules depend on the binding -- see the coordination skill) or claim exactly one available item, drive it through the full Go lifecycle with the merge disposition force-coerced to `pr`, leave a receipt, and stop -- one item per invocation, meant to be re-fired by a harness scheduler or cron rather than looped internally. Go-backlog and Runner both load the **coordination** skill when a backlog or `issues:<label>` may be worked by more than one runner at once: CLAIM an item before touching it, leave a RECEIPT on every state change, scan BLOCKED items for an answer before claiming new work, and keep one LEDGER heartbeat per runner. Coordination is orchestrator-level only -- wave mode's isolated per-item worktree runners never write coordination state themselves.

**Capture** is the third backlog generator, alongside the interview skill's decomposition check and audit's backlog mode: it turns a session's discussion into backlog items so none has to be hand-written. It extracts candidate items from the conversation (scoped by an optional hint) -- findings, decisions, review residuals, an explicit user directive -- each traced to a quoted fragment or named decision (glass box), excluding unactioned musings, work already shipped this session, items already on the backlog, superseded calls, and anything explicitly parked. More than 10 survivors are capped, presenting only the most recent/decision-weighted 10 with the holdback count stated. Every surviving candidate runs through the same `assess`-passable validation and `.muster/backlog.md` dedupe the interview and audit backlog modes use, capped at 2 reword attempts before an item is offered marked `UNMEASURABLE` rather than fabricating a metric. Nothing is written until an explicit structured approval -- Approve all, Edit (re-validates before re-offering), Drop, or Cancel (writes nothing) -- because capture's write is human-gated by design, the same way the interview decomposition's write is. Capture has no run-active lifecycle: it never assembles a crew or dispatches a subagent wave, so the wave-guard and scale-gate hooks have nothing to gate here -- a `run-active` marker would be inert boilerplate, deliberately omitted rather than copied from the other modes.

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

Orchestration loops until done via a Ralph-style primitive (`src/loop.js`). `loopState({ iteration, maxIterations, done })` returns an object `{ continue: bool, reason: "done" | "max-iterations" | "iterate" }`. The review-gate fix-loop uses the dedicated `reviewGateState` helper, which caps at `REVIEW_GATE_MAX_ITERATIONS = 3` regardless of the caller's `maxIterations`. Each wave re-runs implement, review, and fix until the gate passes (`reason: "done"`) or the iteration cap escalates (`reason: "max-iterations"`), so subagents drive toward the success criteria rather than stopping after one pass.

Plan tasks may also declare `owns`/`frozen` arrays -- opaque path-label strings validated by shape only, never by glob matching or overlap detection -- so the orchestrator can copy them into a dispatch brief as scope fences and dispatch same-wave tasks in parallel only when their `owns` sets are disjoint. A manifest (or an individual task) may also declare `forbiddenActions`, drawn from a fixed action-class vocabulary (`send`/`sign`/`submit`/`publish`/`purchase`/`delete-remote`); the orchestrator writes the run's effective (top-level union task-level) set to `.muster/forbidden-actions` at run start, copies it into each brief as a `FORBIDDEN ACTIONS:` line, and removes the file immediately before executing the run's declared merge disposition -- the fence guards the work phase, the disposition is the authorized exit. Every dispatch brief also ends with a mandatory return contract: implementers return raw data (<=2000 chars), reviewers return a verdict first with <=1500 chars of findings, and the orchestrator reads each subagent result exactly once with no accumulation between waves -- git history and the run STATE are the record. Immediately after each wave commit, the orchestrator attaches a `git notes --ref=muster` record of that wave's intent (decisions, review cycles, findings fixed and accepted); the review gate reads it back on later waves to check the implementation against recorded intent, not just the diff against the spec, and also runs `muster citation-check` on research/content artifacts before dispatching reviewers so a dangling citation or an ingestion-ledger gap travels in their briefs as a finding.

## Harness-specific bindings

### Claude Code and Codex adapter: model profiles

Both adapters translate the neutral agent manifest into native profiles. The
Codex adapter currently maps bounded implementation work to
`gpt-5.6-luna`/xhigh, read-only locator work to `gpt-5.6-terra`/high, ordinary
review and strategy to `gpt-5.6-sol`/high, and security to
`gpt-5.6-sol`/xhigh through its `peak` effort override. Its generator and
`check:codex` validate concrete TOML against the neutral manifest.

### Kimi adapter: optional network probe

`install kimi --probe` performs the fourth network-capable CLI operation: an
authenticated models request. Omit `--probe` to keep Kimi installation offline.

### Codex adapter: native Plan launcher

`codex-plan` is the fifth network-capable boundary. From an interactive terminal it starts a new App Server turn on the active Codex account, discovers the Plan preset, and relays structured approval input. It cannot change an ambient desktop or IDE chat. Non-interactive or unsupported callers fail closed with `/plan $muster-plan ...` guidance before claiming activation.

### Claude Code adapter: remote controls

Driving Muster remotely in Claude Code uses the harness's own features, not a transport Muster ships. A Routine can fire `/muster:go` as a scheduled cloud run. Channels deliver steering events (approve, stop, status, retarget) to a running session. Remote Control hands phone or web access to a running local session when a human wants to take over.

### Claude Code and Kimi adapters: dispatch lanes

Two adapter-specific dispatch lanes refine the wave fan-out picture. On Claude Code, a wave rides the native `Workflow` tool when the session's own tool list carries it -- a declared, self-observed capability, never probed from outside -- with the prose wave loop as the unconditional floor on every session or harness without it (`src/wave-dispatch.js`, `docs/native-workflow-dispatch.md`). On Kimi, model work goes through Kimi's own `Agent` dispatch: a leg may run foreground or background (`run_in_background`), a backgrounded leg returning a task id whose completion arrives as a later synthetic user message with an on-disk receipt under the session's `tasks/` dir -- and barrier-gated work never dispatches background (`src/kimi-dispatch.js`). The orchestrator's per-harness dispatch detail lives in `plugin/skills/orchestrator/references/` (split out of `SKILL.md`), e.g. `kimi-dispatch.md` and `codex-dispatch.md`.

## Claude Code adapter: session hooks

Muster ships four plugin-native hooks in `plugin/hooks/`. All are declared in `plugin/hooks/hooks.json`, activate when muster is enabled, and are removed when muster is disabled. None write to the user's `~/.claude` files. Every hook is fail-safe: any error returns a minimal valid result and exits cleanly. (`plugin/hooks/` also carries pure helper modules imported by the hooks above but not themselves registered in `hooks.json` -- `bash-write-target.js`, `inline-budget.js`, `env-util.js` (the hooks' self-contained mirror of `src/env-util.js`, imported by `inline-budget.js`), `guidance.js`, and `action-guard.js` (the action-class classifier the `PreToolUse` hook imports for the fence described below).)

Enforcement follows the run's EXTERNAL effects, not the orchestrator's own in-repo edits: the action-class fence (below) is the only DENY the `PreToolUse` hook can emit. A second, narrower hook-enforced block lives on a different event entirely -- `TaskCompleted` (below) -- ties the native task board's own completed tick to a recorded review-gate PASS, so the board can be the run's authoritative progress surface without a tick meaning "trust me." Everything else is a single warn-only "border invitation" (guidance.js: `CREW_INVITATION`) that sells the value of a crew run -- parallel dispatch, adversarial review, a receipts trail -- rather than commanding, once per crossing. Review gates (`review-gate/SKILL.md`) remain muster's actual quality enforcement.

**`SessionStart`** (`session-start.js`) injects a one-line pointer ("muster available; `/muster:plan` for orchestration-scale work") at the start of every session -- a Claude Code plugin cannot auto-load a `CLAUDE.md`, but a `SessionStart` hook can return `additionalContext`, which Claude Code prepends to the session. On a genuinely fresh session start (`source` is `"startup"`, `"clear"`, or absent -- old-style payload) it clears the cumulative cross-turn drift counter (`inline-budget.js`: `cumFile`) and once-per-crossing directive-nudge marker (`directiveFile`). Repository-global `.muster/wave-active`/`run-active` markers use one-hour activity leases: a fresh, linked, non-regular, or unreadable marker is preserved, and only a regular marker with a verifiably expired lease is recovered. `PreToolUse` renews live leases. `"compact"`/`"resume"` (mid-session) leave all of that intact.

**`UserPromptSubmit`** (`user-prompt-submit.js`) fires the ONLY prompt-time nudge: the isDirective-triggered border invitation. `isDirective()` (`guidance.js`) deterministically detects an imperative-verb prompt (optionally after a polite lead-in; "Update:"/"Fix for" declaratives and questions are excluded); with no active muster run (`.muster/run-active` absent) AND at least one distinct file already recorded this crossing by the `PreToolUse` cumulative counter (`inline-budget.js`: `isScaleCorroborated` -- a directive verb alone is opener detection, not scale, so a cold, isolated directive like "fix typo" with zero prior inline drift never invites), the first such prompt injects the value-toned invitation, once per crossing -- then stays silent until re-armed by a muster run starting (observed on any subsequent turn, independent of that turn's own prompt shape), `SessionStart`, or 60 minutes of inactivity (`inline-budget.js`: `isCrossingStale`), and even then only once the shared invite cooldown below has cleared.

**`PreToolUse`** (`pre-tool-use.js`) has a tiny decision order: (1) classify every payload through the action-class fence (below -- the only deny this hook can emit), (2) exempt subagent calls (`agent_id` present) from advisory drift accounting, (3) exempt writes into `.muster/` or `.claude/` from advisory drift accounting, (4) exempt targets outside the cwd tree from advisory drift accounting (GUARD-SCOPE), (5) run the warn-only border invitation, (6) allow. **Action-class fence** (`action-guard.js`): when both `.muster/run-active` and `.muster/forbidden-actions` exist, the hook classifies the tool call before any exemption -- an `mcp__`-prefixed tool name against a fixed keyword set (`send`/`submit`/`publish`/`sign`/`purchase`, word-boundary matched so "sign" never fires inside "assign"), or a Bash command against a small high-confidence allowlist (`git push` variants including `--delete`, `npm publish`, `gh release create`, `gh pr merge`, `curl -X POST`) -- and denies a match against the run's declared `forbiddenActions` set, honouring `MUSTER_ACTION_GUARD` (`off`/`warn`/deny-by-default). Delegation and metadata paths therefore never bypass a recognized forbidden external effect. Fail-open when either file is absent or unreadable, or no class matches. **Border invitation:** independent of the fence, an `Edit`/`Write`/`NotebookEdit` with a resolved target, or a Bash command `bashWriteTarget()` classifies as a high-confidence write, feeds a cumulative cross-turn distinct-file counter (`inline-budget.js`: `cumFile`/`recordCum`/`markNudged`) whenever no muster run is active. Crossing `MUSTER_INLINE_SCALE` (default 3) for the first time this crossing window, with the shared cooldown below not active, warns once (additionalContext, never a deny) with the value-toned copy; further files in the same crossing stay silent. If a muster run IS active, the counter resets instead (that work is tracked/dispatched, not drift). Re-arms the same way as the `UserPromptSubmit` signal: a muster run starting, `SessionStart`, or 60 minutes of inactivity.

**Hysteresis: the shared invite cooldown.** A crossing re-arming (run start, `SessionStart`, or 60 minutes of inactivity) only makes the next touch *eligible* to invite -- `inline-budget.js`'s `cooldownFile`/`isInCooldown`/`recordInvite` gate whether that eligible touch is actually spoken. Firing from *either* signal starts one shared, session-keyed cooldown (`MUSTER_INVITE_COOLDOWN_MS`, default 15 minutes -- shorter than the 60-minute crossing re-arm window so a long-lived session is never blocked by a stale cooldown, but long enough to absorb a rapid muster-run restart or a drift counter oscillating around the threshold without repeating the invite seconds apart). This is what keeps a noisy border from flapping: a re-armed crossing moments after the last invite stays silent; the next genuinely time-separated crossing still invites once, exactly the "at most one invitation per genuine crossing" behavior a long-lived (multi-day) session needs.

**`TaskCompleted`** (`task-completed-gate.js`) gates the native task board's own completion tick, not a tool call: `plugin/skills/orchestrator/SKILL.md`'s "Task board" section writes `.muster/task-board.json` (one entry per muster-created native task, `{manifestTaskId, reviewGate}`) at `TaskCreate` time and flips `reviewGate` to `"pass"` only once review-gate returns PASS for that task, before ever calling `TaskUpdate` to mark it completed. This hook denies (exit 2) a completion attempt on any tracked entry whose `reviewGate` isn't `"pass"` -- an escalated task included -- and fails open (allow) for anything the map doesn't track at all, including every harness-native task muster itself didn't create. `MUSTER_TASK_GATE=off` disables it.

## Claude Code adapter: enforcement model

Muster's `PreToolUse` hook enforces exactly one deterministic GATE on tool calls and leaves everything else about tool-call permission -- including what used to be three more mechanical gates -- to named conventions or a warn-only invitation. A second, narrower GATE lives on a different event (`TaskCompleted`, below) and gates a task-board tick, not a tool call. Principle: enforce where mechanically sound; a gameable gate that fails open, or one trained to be disabled by its own false positives, is worse than an honest, named convention.

Muster keeps a running ledger of caught failure classes in `docs/anti-patterns.md`: each entry names the symptom, the root cause, and the guard that now exists, so a fixed bug does not slip back in under a new name. The orchestrator's brief-construction prose and the `muster-improver` agent both read it.

### GATES (deterministic, hook-enforced -- these block)

**Action-class fence.** When both `.muster/run-active` and `.muster/forbidden-actions` exist, a tool call classified (`action-guard.js`) into a run-forbidden action class (`send`/`sign`/`submit`/`publish`/`purchase`/`delete-remote`) is denied. Either file absent, or no class matching, is a no-op (fail-open). Set `MUSTER_ACTION_GUARD=warn` to allow with a reminder, `off` to disable. This is the only hard deny the `PreToolUse` hook can emit.

**Meta-exempt roots.** `.muster/` and `.claude/` (in-cwd repo) are exempt from advisory drift accounting only after the action-class fence has classified the payload. A recognized forbidden external action cannot bypass the fence by carrying a metadata path. Paths outside the project cwd are likewise out of scope only for cwd-relative drift accounting after classification.

**Task-completion gate.** `plugin/hooks/task-completed-gate.js` denies (`TaskCompleted`, exit 2) a native task board completion tick for any task muster's own `.muster/task-board.json` tracks whose `reviewGate` isn't `"pass"` -- ties the board's authoritative "completed" tick to a real review-gate result. Fail-open for any task the map doesn't track (never gates a harness-native task muster didn't create). Set `MUSTER_TASK_GATE=off` to disable.

### THE BORDER INVITATION (warn-only; never blocks)

A cumulative counter of distinct inline-edited files (`PreToolUse`) and the isDirective prompt detector (`UserPromptSubmit`, gated on scale correlation -- `inline-budget.js`: `isScaleCorroborated` -- so a cold, isolated directive with no established inline drift never invites) both sell the value of a crew run -- parallel dispatch, adversarial review, a receipts trail -- once per crossing when their signal fires with no muster run active, then stay silent until a run starts, `SessionStart`, or 60 minutes of inactivity re-arms them. A shared invite cooldown (`MUSTER_INVITE_COOLDOWN_MS`, default 15 minutes) then still gates whether a re-armed crossing's warn is actually spoken, absorbing a noisy border (a rapid run restart, or a drift counter oscillating around the threshold) so it cannot flap a repeat invite -- a genuinely long-lived session still gets one invite per crossing once real time separates them. Set `MUSTER_INLINE_SCALE` to tune the file-count threshold (default 3).

### CONVENTIONS (not gate-able; enforced by SKILL discipline)

**Wave discipline, todo-driving, scale discipline.** Dispatching through the crew instead of editing inline mid-run, keeping a native todo list per plan step, and routing orchestration-scale work through a verb instead of the main loop are all now SKILL-level discipline (`plugin/skills/orchestrator/SKILL.md`), not hook-enforced. Field evidence moved them off the GATES list (see "Rejected/removed approaches" below): a hard main-loop file-write block trained agents to reach for its own kill switch on legitimate concurrent work, a per-turn deny fired on sessions/repos where muster had never run, and a transcript-scanned todo gate added dispatch-time latency for a visibility guarantee a throwaway todo could already defeat.

**Crew-owner/state-in-subject.** The `PreToolUse` hook cannot judge who owns a task or whether it is multi-step. That is runtime judgment, not a file-system observable.

**Verb selection.** Intent classification (bug fix vs feature vs sweep) is a model judgment call, not a deterministic signal the hook can test.

**Content through humanizer routing.** The routing decision is judgment. The output rules (no em-dash, no banned openers) are enforced post-hoc by contract tests on committed artifacts, not by a hook.

**Glass-box narration.** Narration is reply-text content, not a tool surface. There is no hook point where it can be blocked or required.

### Rejected/removed approaches

**Verb-routing run-active block.** Not built. Between-wave writes are already `.muster/`-exempt or `agent_id`-exempt; a block on absent run-active would add no enforcement power and would false-block trivial multi-file edits done outside a run.

**Wave-guard (removed).** Built in 0.2.3, denied any main-loop Edit/Write/NotebookEdit or high-confidence Bash write while `.muster/wave-active` existed. Removed: an unscopable deny path that repeatedly fired on legitimate concurrent work outside the run it was meant to gate, teaching agents to reach for its own kill-switch env var as routine practice rather than a narrow escape hatch (see CHANGELOG for the removed env's name).

**Post-run scale-gate (removed).** Built to close the post-run drift window a per-turn deny once the wave marker was gone, then patched with a session-engagement marker after a field case showed it denying a session/repo where muster had never run at all. Removed rather than patched again: replaced by the warn-only border invitation above, which needs no engagement heuristic because it never denies.

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

Alongside the vendored material, Muster ships its own clean-room specialists in `plugin/agents/`: `muster-surgeon` (1-2 file edits), `muster-builder` (a cohesive slice), `muster-reviewer` (verdict-emitting review), `muster-investigator` (read-only locator), `muster-strategist` (heavyweight reasoning), `muster-improver` (post-run retrospective that proposes user-gated edits to muster's own skills/rules), and `muster-runner` (single-item lifecycle driver: TDD build, explicit-PASS review gate, receipts-backed PR; the dispatchable subagent form of the runner mode, resolving the `lifecycle` role). These are authored fresh from the role concept. Every wshobson agent carries a searchable description, which is what makes description-search (`muster match`) reach the breadth without inventing a named role for each specialist.
