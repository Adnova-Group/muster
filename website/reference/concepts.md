# Concepts

Muster is a glass-box, multi-runtime, multi-domain agentic orchestrator. This page covers the ideas that make it work. For the full source-level map, see [Architecture](/reference/architecture).

## Glass-box

Glass-box is the design constraint that shapes everything else. Every routing decision is inspectable: which role resolved to which provider, on which model, and why. Before any work starts, Muster shows a crew manifest and a plan. Nothing is hidden behind a single opaque prompt.

## Two layers

Muster is split into two layers with a hard boundary between them.

| Layer | Lives in | Runtime | Talks to a model? |
| --- | --- | --- | --- |
| Deterministic CLI | `src/*.js` | Plain Node ESM | No |
| Model-facing | `plugin/` (commands, skills, agents) | Claude Code | Yes |

The **CLI layer** is ordinary Node with a single runtime dependency. It does the deterministic work: detecting the project, resolving roles to providers, ranking candidates, scoring artifacts against a gate, computing prioritization math, validating pipelines. Anything that can be answered by code is answered by code.

The **model-facing layer** is markdown that Claude Code loads as a plugin. It instructs the model how to drive a run, calling the CLI for every deterministic decision and using Claude Code's subagent dispatch for the judgment work.

> Routing, scoring, and validation are reproducible because code owns them. Drafting, reviewing, and classifying are the model's job.

## Roles and the resolution ladder

Muster names a fixed vocabulary of **roles**, the kinds of work a crew might need (`implement`, `code-review`, `test-author`, `debug`, `security-review`, `author`, `research`, `score`, `humanize`, `prompt-quality`, `improve`, `image`, `video`, and more — 25 in all). Roles are the stable interface: pipelines and commands ask for a role, not for a specific tool.

Each role resolves through a **ladder** of provider sources, best available first:

1. An installed external provider (a plugin, agent, or MCP server you already have)
2. A Muster built-in agent
3. A Muster built-in skill
4. Inline (the model does it directly, no specialist attached)

Because the ladder always terminates at inline, **every role resolves to something**. Muster works on bare Claude Code and gets better as you install more tools.

```sh
npx @adnova-group/muster capabilities
```

For each role this reports `chosen` (the winner), `chain` (the full fallback list, always ending in `inline`), `recommendations` (installable providers that would beat the current fallback), and `model`.

## Description-search

The role enum is fixed, but the set of providers is not, and some specialists do not map cleanly onto a named role. The escape hatch is **description-search**: a deterministic token-overlap ranker, no LLM call.

```sh
npx @adnova-group/muster match "audit this code for security vulnerabilities"
```

It tokenizes the task, scores every catalog provider by overlap (id, roles, and keywords weighted high; the free-text description weighted low), and boosts installed providers so a present tool edges out an equal-scoring fallback. That is how a task surfaces the right specialist even when it never names a role.

## Per-role model selection

Each resolved role carries a model picked to fit the work, so quota spend tracks difficulty.

| Tier | Roles | Why |
| --- | --- | --- |
| haiku | `code-navigation`, `docs-research`, `research` | Mechanical: locating, gathering, scanning |
| sonnet | everything else (the default) | Implementation, review, authoring, scoring |
| fable | the tournament `judge`, `architecture-review`, `improve`, `advisor` | Heavy judgment |
| opus | fallback only (fable -> opus via `fallbackModelFor`) | Used when fable is unavailable on the plan |

The orchestrator passes the chosen model as the dispatch override when it spawns each subagent.

## Provider kinds

A provider resolves to one of four kinds, which decides how it is dispatched:

- **agent**: a subagent definition, dispatched by `subagent_type`.
- **skill**: a markdown skill injected into a generic subagent.
- **mcp**: an installed MCP server, surfaced as a tool.
- **inline**: no specialist; the model does the work directly.

When a role resolves to an agent whose type is not yet dispatchable in the running session (for example, plugin agents installed before a restart), the orchestrator falls back to a generic subagent with the resolved provider's brief injected. The model override still applies, so model selection is never lost on the fallback.

Next: [The six modes](/reference/modes).
