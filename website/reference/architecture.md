# Architecture

Muster is a glass-box, multi-runtime, multi-domain agentic orchestrator. It runs on bare Claude Code, with no extra services and no separate model API. This page is the source-level map. For the gentler tour, start with [Concepts](/reference/concepts).

## Two layers

Muster is split into two layers with a hard boundary between them.

| Layer | Lives in | Runtime | Talks to a model? |
| --- | --- | --- | --- |
| Deterministic CLI | `src/*.js` | Plain Node ESM | No |
| Model-facing | `plugin/` (commands, skills, agents) | Claude Code | Yes |

The **CLI layer** is ordinary Node. It has a single runtime dependency (`yaml`), requires Node 20 or newer, and makes no model calls and no network calls -- the one carve-out is the `issue` verb, which shells out to `gh issue view` when the user passes a GitHub issue reference (opt-in; tests inject the exec dependency; cowork omits it). All other CLI verbs are local. It does the deterministic work: detecting the project, resolving roles to providers, ranking candidates by token overlap, scoring artifacts against a gate, computing prioritization math, loading and validating pipelines. Anything that can be answered by code is answered by code.

The **model-facing layer** is what Claude Code loads as a plugin. It is markdown: slash commands, skills, and agents. These files instruct the model how to drive a run. They call the CLI for every deterministic decision, then use Claude Code's built-in subagent dispatch to do the judgment work. The split is deliberate. Routing, scoring, and validation are reproducible because code owns them. Drafting, reviewing, and classifying are the model's job.

## The capability and domain router

The router is the novel core. The problem it solves: you have an outcome and a pile of tools (some you installed, some Muster ships), and you need to pick the right tool for each piece of work, predictably.

Muster names a fixed vocabulary of **roles**, the kinds of work a crew might need. There are 26 of them (`src/roles.js`): `implement`, `code-review`, `test-author`, `debug`, `refactor`, `architecture-review`, `security-review`, `author`, `research`, `score`, `humanize`, `prompt-quality`, `improve`, `image`, `video`, `lifecycle`, and more. Roles are the stable interface. Pipelines and commands ask for a role, not for a specific tool.

Each role resolves through a **ladder** of provider sources, best-available first:

1. An installed external provider (a plugin, agent, or MCP server you already have)
2. A Muster built-in agent
3. A Muster built-in skill
4. Inline (the model does it directly, with no specialist attached)

`muster capabilities` walks this ladder for every role. For each role you get `chosen` (the winning provider), `chain` (the full ordered fallback list, always ending in `inline`), `recommendations` (installable external providers that would beat the current fallback), and `model`. The resolution is a single deterministic pass over the catalog, sorted by rank (`src/capabilities.js`). Because the ladder always terminates at inline, every role resolves to something.

The role enum is fixed, but the set of providers is not, and that creates a reach problem: some specialists do not map cleanly onto a named role. The escape hatch is **description-search**. `muster match "<task>"` is a deterministic token-overlap ranker (`src/match.js`, no LLM call). It tokenizes the task, builds a weighted bag of searchable tokens for every catalog provider, scores each by overlap, and boosts installed providers so a present tool edges out an equal-scoring fallback.

## Per-role model selection

Each resolved role carries a model, picked to fit the work (`src/model.js`):

| Tier | Roles | Why |
| --- | --- | --- |
| haiku | `code-navigation`, `docs-research`, `research` | Mechanical: locating, gathering, scanning |
| sonnet | everything else (the default) | Implementation, review, authoring, scoring |
| fable | the tournament `judge`, `architecture-review`, `improve`, `advisor` | Heavy judgment |
| opus | fallback only (fable -> opus via `fallbackModelFor`) | Used when fable is unavailable on the plan |

The model comes back as `roles[<role>].model` from `muster capabilities`, and the orchestrator passes it as the dispatch model override when it spawns a subagent. So quota spend tracks the difficulty of the work. Set `MUSTER_MAX_TIER` to cap the highest tier Muster will use (e.g. `MUSTER_MAX_TIER=sonnet` keeps all work on sonnet and below). Fable is disabled by default because the tier can be disabled platform-wide -- `modelForRole` degrades it to opus deterministically unless `MUSTER_ENABLE_FABLE=1` is set.

## Provider kinds

A provider resolves to one of four kinds, which decides how the orchestrator dispatches it:

- **agent**: a subagent definition, dispatched by `subagent_type`.
- **skill**: a markdown skill injected into a generic subagent.
- **mcp**: an installed MCP server, surfaced as a tool.
- **inline**: no specialist; the model does the work directly.

Dispatch honors `chosen.kind`: an agent routes by `subagent_type`, anything else gets a generic subagent with the relevant skill injected. If an agent type is not yet dispatchable in the running session, the orchestrator falls back to a generic subagent with the provider's brief injected. The model override from per-role selection always applies, regardless of kind.

## Pipelines

A pipeline is a phased, gated recipe for producing one kind of artifact. Each declares a `domain`, an ordered list of `phases` (each phase names a `role`), an optional `optional_phases` list (run only when the outcome explicitly asks for it, e.g. a `publish` prep phase), and a `gate` (`src/pipeline.js` validates the shape). Routing is deterministic: `muster route` matches the outcome against each pipeline's `match` keywords on word boundaries and picks the earliest keyword hit position in the outcome text (ties break by longer phrase, then file order), falling back to the domain default when nothing matches.

Gating uses a **floor principle** (`src/score.js`): the weakest dimension must clear the gate's floor, and the total must clear `pass_total`. A strong average cannot rescue one weak dimension. The model only estimates the per-dimension scores; the code decides pass or fail.

See [Pipelines](/reference/pipelines) for the full set and the prioritization models.

## Execution model

Muster runs on the interactive Claude Code subscription. Model work goes through Claude Code's built-in subagent dispatch, not through `claude -p` and not through the Agent SDK. The CLI itself makes no model calls. The practical consequences:

- Muster draws normal interactive subscription quota. It does not hit the separate Agent-SDK credit pool.
- Fan-out spends that same quota faster, since parallel subagents are parallel quota.
- There is no separate runtime to deploy or key to manage.

Orchestration loops until done via a Ralph-style primitive (`src/loop.js`). Each wave re-runs implement, review, and fix until the gate passes or the iteration cap escalates, so subagents drive toward the success criteria rather than stopping after one pass. A pre-flight plan-conflict review runs before wave 1, the `muster-strategist` is dispatched for root-cause analysis when a review gate escalates (before any human prompt), and concurrent file-writing wave tasks each run in their own git worktree so parallel edits never collide.

Plan tasks may declare `owns`/`frozen` arrays -- opaque path-label strings, shape-validated only, never glob-matched or overlap-checked -- which the orchestrator copies verbatim into a dispatch brief as scope fences, dispatching same-wave tasks in parallel only when their `owns` sets are disjoint. A manifest or task may also declare `forbiddenActions` (`send`/`sign`/`submit`/`publish`/`purchase`/`delete-remote`); the orchestrator writes the run's effective set to `.muster/forbidden-actions` at start, copies it into each brief, and removes the file just before the run's declared merge disposition executes. Every dispatch brief also ends with a mandatory return contract: implementers return raw data (<=2000 chars), reviewers return a verdict first with <=1500 chars of findings, and the orchestrator reads each subagent result exactly once with no cross-wave accumulation. Immediately after each wave commit, the orchestrator attaches a `git notes --ref=muster` record of the wave's intent (decisions, review cycles, findings fixed/accepted); the review gate reads it back to check the implementation against recorded intent, not just the diff against the spec -- and runs `muster citation-check` on research/content artifacts before dispatching reviewers so a dangling citation travels in their briefs as a finding.

Before wave 1, autopilot's pre-wave spec gate dispatches a fresh strategist-tier agent to probe the validated manifest and plan as a lazy-or-malicious implementer; a `FAIL` loops the findings back to the router once, a second `FAIL` escalates, and the gate is skippable for trivial single-task plans. At finish, a manifest-declared `mergeDisposition` (`merge-local`/`merge-push`/`pr`/`keep`) executes without asking; absent or `ask` falls back to the interactive merge-decision prompt, and unattended (Routine) runs always downgrade `merge-local`/`merge-push` to `pr` rather than push to a base branch.

After a run, the `improve` role (the read-only `muster-improver` agent) mines the run STATE, escalations, and review-gate fix-loops for recurring friction and proposes user-gated edits to Muster's own skills, agents, and rules. It proposes; it never applies, and never edits during a run.

Tournament synthesis is tunable via two env vars: `MUSTER_FUSE_TOPK` (default 3) caps the number of candidates passed to the synthesizer; `MUSTER_FUSE_MIN_DISAGREEMENT` (default 1) is the minimum disagreement score required to activate fusion -- below this threshold `muster fuse` falls back to the single best candidate.

The `advisor` role lets a cheap-tier worker consult a stronger model (fable, degrading to opus) at a hard decision point. The worker returns a structured advice-request, a consult budget (`MUSTER_ADVISOR_MAX_CONSULTS`, default 3) bounds cost, the consult is logged to STATE (glass box), and the advice is fed back so the worker keeps the decision. The advisor informs; the worker decides. Native (Claude Code Agent-tool dispatch, no external server tools), autonomous-first (no human prompt).

Driving Muster remotely uses Claude Code's own features, not a transport Muster ships. A Routine can fire `/muster:go` as a scheduled cloud run. Channels deliver steering events (approve, stop, status, retarget) to a running session. Remote Control hands phone or web access to a running local session.

## Session hooks

Muster ships three plugin-native hooks in `plugin/hooks/`. All are declared in `plugin/hooks/hooks.json`, activate when Muster is enabled, and are removed when Muster is disabled. None write to your `~/.claude` files. Every hook is fail-safe: any error returns a minimal valid result and exits cleanly.

Enforcement follows the run's EXTERNAL effects, not the orchestrator's own in-repo edits: the action-class fence below is the only hard deny left anywhere in this stack. Everything else is a single warn-only "border invitation" (guidance.js: `CREW_INVITATION`) that sells the value of a crew run -- parallel dispatch, adversarial review, a receipts trail -- rather than commanding, once per crossing. Review gates remain Muster's actual quality enforcement.

**`SessionStart`** (`session-start.js`) injects a one-line pointer ("muster available; `/muster:plan` for orchestration-scale work") at the start of every session -- a Claude Code plugin cannot auto-load a `CLAUDE.md`, but a `SessionStart` hook can return `additionalContext`, which Claude Code prepends to the session. On a genuinely fresh session start it also clears any stale `.muster/wave-active`/`run-active` marker, the cumulative cross-turn drift counter, and the once-per-crossing directive-nudge marker, so a new session never inherits a crashed run's state; `/compact`/resume (mid-session) leave all of that intact.

**`UserPromptSubmit`** (`user-prompt-submit.js`) fires the ONLY prompt-time nudge: the isDirective-triggered border invitation. A directive-shaped prompt (an imperative verb like fix/build/implement, optionally after a polite lead-in; "Update:"/"Fix for" declaratives and questions are excluded) landing with no active Muster run injects the value-toned invitation immediately, once per crossing -- then stays silent until re-armed by a Muster run starting, `SessionStart`, or 60 minutes of inactivity.

**`PreToolUse`** (`pre-tool-use.js`) has a tiny decision order: (1) subagent calls always allowed, (2) writes into `.muster/` or `.claude/` always allowed (state bookkeeping and repo-local settings), (3) targets outside the cwd tree always allowed, (4) the action-class fence (below -- the only deny this hook can emit), (5) the border invitation (below -- warn-only), (6) allow.

**Action-class fence** (`action-guard.js`): when both `.muster/run-active` and `.muster/forbidden-actions` exist, the hook classifies the tool call (an `mcp__`-prefixed tool name against a `send`/`submit`/`publish`/`sign`/`purchase` keyword set, word-boundary matched; or a Bash command against a small high-confidence allowlist -- `git push`, `npm publish`, `gh release create`, `gh pr merge`, `curl -X POST`) and denies a match against the run's declared `forbiddenActions`, honouring `MUSTER_ACTION_GUARD` (`off`/`warn`/deny-by-default). Either file absent, or no class matching, is a no-op.

**Border invitation:** independent of the fence, an Edit/Write/NotebookEdit with a resolved target, or a high-confidence Bash file write, feeds a cumulative cross-turn distinct-file counter whenever no Muster run is active. Crossing `MUSTER_INLINE_SCALE` (default 3) for the first time this crossing window warns once (never a deny) with the value-toned copy; further files in the same crossing stay silent. A live Muster run resets the counter instead of recording (that work is tracked/dispatched, not drift).

## Vendoring

Muster ships a curated set of built-in skills and agents, imported from upstream projects rather than hand-copied. `vendor/manifest.yaml` lists every source (repository, license, ref) and the items pulled from each, mapped to the Muster roles they serve. `muster vendor` generates the built-ins into `plugin/` and writes provenance into `NOTICE`. See [Credits](/about/credits) for the sources.
