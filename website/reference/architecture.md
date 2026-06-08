# Architecture

Muster is a glass-box, multi-runtime, multi-domain agentic orchestrator. It runs on bare Claude Code, with no extra services and no separate model API. This page is the source-level map. For the gentler tour, start with [Concepts](/reference/concepts).

## Two layers

Muster is split into two layers with a hard boundary between them.

| Layer | Lives in | Runtime | Talks to a model? |
| --- | --- | --- | --- |
| Deterministic CLI | `src/*.js` | Plain Node ESM | No |
| Model-facing | `plugin/` (commands, skills, agents) | Claude Code | Yes |

The **CLI layer** is ordinary Node. It has a single runtime dependency (`yaml`), requires Node 20 or newer, and makes no LLM calls of any kind. It does the deterministic work: detecting the project, resolving roles to providers, ranking candidates by token overlap, scoring artifacts against a gate, computing prioritization math, loading and validating pipelines. Anything that can be answered by code is answered by code.

The **model-facing layer** is what Claude Code loads as a plugin. It is markdown: slash commands, skills, and agents. These files instruct the model how to drive a run. They call the CLI for every deterministic decision, then use Claude Code's built-in subagent dispatch to do the judgment work. The split is deliberate. Routing, scoring, and validation are reproducible because code owns them. Drafting, reviewing, and classifying are the model's job.

## The capability and domain router

The router is the novel core. The problem it solves: you have an outcome and a pile of tools (some you installed, some Muster ships), and you need to pick the right tool for each piece of work, predictably.

Muster names a fixed vocabulary of **roles**, the kinds of work a crew might need. There are 21 of them (`src/roles.js`): `implement`, `code-review`, `test-author`, `debug`, `refactor`, `architecture-review`, `security-review`, `author`, `research`, `score`, `humanize`, and more. Roles are the stable interface. Pipelines and commands ask for a role, not for a specific tool.

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
| opus | the tournament `judge`, `architecture-review` | Heavy judgment |

The model comes back as `roles[<role>].model` from `muster capabilities`, and the orchestrator passes it as the dispatch model override when it spawns a subagent. So quota spend tracks the difficulty of the work.

## Provider kinds

A provider resolves to one of four kinds, which decides how the orchestrator dispatches it:

- **agent**: a subagent definition, dispatched by `subagent_type`.
- **skill**: a markdown skill injected into a generic subagent.
- **mcp**: an installed MCP server, surfaced as a tool.
- **inline**: no specialist; the model does the work directly.

Dispatch honors `chosen.kind`: an agent routes by `subagent_type`, anything else gets a generic subagent with the relevant skill injected. If an agent type is not yet dispatchable in the running session, the orchestrator falls back to a generic subagent with the provider's brief injected. The model override from per-role selection always applies, regardless of kind.

## Pipelines

A pipeline is a phased, gated recipe for producing one kind of artifact. Each declares a `domain`, an ordered list of `phases` (each phase names a `role`), and a `gate` (`src/pipeline.js` validates the shape). Routing is deterministic: `muster route` matches the outcome against each pipeline's `match` keywords on word boundaries, falling back to the domain default.

Gating uses a **floor principle** (`src/score.js`): the weakest dimension must clear the gate's floor, and the total must clear `pass_total`. A strong average cannot rescue one weak dimension. The model only estimates the per-dimension scores; the code decides pass or fail.

See [Pipelines](/reference/pipelines) for the full set and the prioritization models.

## Execution model

Muster runs on the interactive Claude Code subscription. Model work goes through Claude Code's built-in subagent dispatch, not through `claude -p` and not through the Agent SDK. The CLI itself makes no model calls. The practical consequences:

- Muster draws normal interactive subscription quota. It does not hit the separate Agent-SDK credit pool.
- Fan-out spends that same quota faster, since parallel subagents are parallel quota.
- There is no separate runtime to deploy or key to manage.

Orchestration loops until done via a Ralph-style primitive (`src/loop.js`). Each wave re-runs implement, review, and fix until the gate passes or the iteration cap escalates, so subagents drive toward the success criteria rather than stopping after one pass.

Driving Muster remotely uses Claude Code's own features, not a transport Muster ships. A Routine can fire `/muster:autopilot` as a scheduled cloud run. Channels deliver steering events (approve, stop, status, retarget) to a running session. Remote Control hands phone or web access to a running local session.

## Session hook

Muster's always-on guidance is delivered by a plugin-native `SessionStart` hook in `plugin/hooks/` rather than a global `CLAUDE.md`. A plugin cannot auto-load a `CLAUDE.md`, but a `SessionStart` hook can return `additionalContext`, which Claude Code prepends to the session. The hook script is self-contained (only Node builtins) and emits the working principles, the four verbs, and a dependency-free project sniff. Because it is declared in the plugin, it activates when Muster is enabled and is removed when Muster is disabled. It never writes to your `~/.claude` files, and it is fail-safe: any error returns a minimal valid result so a session always starts.

## Vendoring

Muster ships a curated set of built-in skills and agents, imported from upstream projects rather than hand-copied. `vendor/manifest.yaml` lists every source (repository, license, ref) and the items pulled from each, mapped to the Muster roles they serve. `muster vendor` generates the built-ins into `plugin/` and writes provenance into `NOTICE`. See [Credits](/about/credits) for the sources.
