---
name: muster-runner
description: "Use for Muster orchestration when the user asks to drive one claimed backlog item end-to-end in its own worktree. Explicitly invoke with $muster-runner."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Mode dispatcher delegates to the authoritative workflow and intentionally does not impose a second persona or output format. -->

# Muster runner

Use this skill when the request needs to drive one claimed backlog item end-to-end in its own worktree. Treat the user's remaining prompt as the outcome or backlog reference.

1. Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` and apply its Codex tool, named-profile dispatch, bounded-context-fork, and plugin-root bindings.
2. Read `${PLUGIN_ROOT}/commands/runner.md` for the authoritative workflow and preserve its approval, isolation, escalation, and receipt gates.
3. Use the bundled Muster MCP tools for deterministic routing, manifests, waves, scoring, and pipelines. The bundled CLI is `node ${PLUGIN_ROOT}/runtime/muster.mjs` when a tool is not available.
4. Keep the shared pipeline files authoritative. Do not duplicate pipeline routing in this skill.

## Agent watch invariant

<!-- prompt-lint-disable GUARD-IDK-001: Explicit terminal conditions prevent abandoned live agents while preserving approval, HUMAN-HOLD, blocker, and merge-decision stops. -->

After every dispatch, retain every canonical agent id returned by `collaboration.spawn_agent` and immediately call `collaboration.wait_agent` with a timeout of at most 60 seconds. A message or completion receipt wakes the watch immediately. After each wake, process the mailbox receipts first, call `collaboration.list_agents` exactly once to reconcile live state, dispatch any newly ready work whose dependencies are satisfied, and, while any agent remains live, immediately call `collaboration.wait_agent` again. A timeout is only a heartbeat: reconcile once and return to waiting; it is not completion. Never tight-poll `collaboration.list_agents` and never prompt the user merely because workers are still running.

Do not send the final answer, clear active run/wave state, or stop watching while live agents or executable steps remain. Stop only when all work is terminal, an explicit approval or HUMAN-HOLD requires user input, a proven blocker leaves no ready work, or a merge decision requires the user. Hooks are advisory and never replace this watch cycle.
