---
name: run
description: "Use for Muster orchestration when the user asks to legacy alias of muster-plan. Explicitly invoke with $run."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Mode dispatcher delegates to the authoritative workflow and intentionally does not impose a second persona or output format. -->

# Muster run

Use this skill when the request needs to legacy alias of muster-plan. Treat the user's remaining prompt as the outcome or backlog reference.

1. Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` and apply its Codex tool, named-profile dispatch, bounded-context-fork, and plugin-root bindings.
2. Read `${PLUGIN_ROOT}/commands/run.md` for the authoritative workflow and preserve its approval, isolation, escalation, and receipt gates.
3. Use the bundled Muster MCP tools for deterministic routing, manifests, waves, scoring, and pipelines. The bundled CLI is `node ${PLUGIN_ROOT}/runtime/muster.mjs` when a tool is not available.
4. Keep the shared pipeline files authoritative. Do not duplicate pipeline routing in this skill.

## Agent watch invariant

<!-- prompt-lint-disable GUARD-IDK-001: Explicit terminal conditions prevent abandoned live agents while preserving approval, HUMAN-HOLD, blocker, and merge-decision stops. -->

After every dispatch, retain every canonical agent id returned by `collaboration.spawn_agent` and immediately call `collaboration.wait_agent` with a timeout of at most 60 seconds. A message or completion receipt wakes the watch immediately. After each wake, process mailbox receipts first, call `collaboration.list_agents` exactly once to reconcile live state, and dispatch any newly ready work. Never tight-poll. Three consecutive heartbeats without a receipt exhaust the Codex worker budget: interrupt the worker, record the incomplete task in STATE, and escalate or continue locally only when safe.

Respect the configured `agents.max_threads`; Muster must neither lower nor raise it. Spawn with `fork_turns: "none"` unless the user explicitly requests a context fork. Every brief sets a 25-step ceiling, permits at most one follow-up, and defers broad suites to final verification. Do not send the final answer or clear state while executable work remains, but worker budget exhaustion is a terminal escalation condition rather than permission to wait forever. Hooks are advisory and never replace this watch cycle.
