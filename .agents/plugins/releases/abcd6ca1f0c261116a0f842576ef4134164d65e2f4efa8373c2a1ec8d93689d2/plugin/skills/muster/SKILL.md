---
name: muster
description: "Use for any glass-box Muster orchestration request: plan, implement, backlog, diagnose, audit, runner, capture, pipeline, crew, or wave workflow."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Root router delegates to a selected authoritative workflow and intentionally does not impose a second persona or output format. -->

# Muster

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before routing so named profiles, bounded context forks, plugin paths, and Codex-native tools are applied consistently.

Select the matching explicit skill when the request has a clear mode: $muster-plan, $muster-go, $muster-plan-backlog, $muster-go-backlog, $muster-diagnose, $muster-audit, $muster-runner, or $muster-capture. Use the legacy run, autopilot, and sprint skills only for compatibility.

Start with the bundled deterministic MCP tools: detect the project, resolve capabilities, assess the outcome, route the pipeline, validate the crew manifest, then execute dependency waves with receipts and gates. Write-capable waves require isolated worktrees.

## Agent watch invariant

<!-- prompt-lint-disable GUARD-IDK-001: Explicit terminal conditions prevent abandoned live agents while preserving approval, HUMAN-HOLD, blocker, and merge-decision stops. -->

After every dispatch, retain every canonical agent id returned by `collaboration.spawn_agent` and immediately call `collaboration.wait_agent` with a timeout of at most 60 seconds. A message or completion receipt wakes the watch immediately. After each wake, process mailbox receipts first, call `collaboration.list_agents` exactly once to reconcile live state, and dispatch any newly ready work. Never tight-poll. Three consecutive heartbeats without a receipt exhaust the Codex worker budget: interrupt the worker, record the incomplete task in STATE, and escalate or continue locally only when safe.

Respect the configured `agents.max_threads`; Muster must neither lower nor raise it. Spawn with `fork_turns: "none"` unless the user explicitly requests a context fork. Every brief sets a 25-step ceiling, permits at most one follow-up, and defers broad suites to final verification. Do not send the final answer or clear state while executable work remains, but worker budget exhaustion is a terminal escalation condition rather than permission to wait forever. Hooks are advisory and never replace this watch cycle.
