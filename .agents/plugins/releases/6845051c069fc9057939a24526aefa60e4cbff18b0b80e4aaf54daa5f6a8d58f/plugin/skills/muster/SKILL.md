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

After every dispatch, retain every canonical agent id returned by `collaboration.spawn_agent`. While any agent remains live, call `collaboration.list_agents`, process all completion and message receipts, dispatch any newly ready work whose dependencies are satisfied, then call `collaboration.wait_agent` with a timeout of at most 60 seconds. Repeat this watch cycle; a timeout or unchanged status is not completion.

Do not send the final answer, clear active run/wave state, or stop watching while live agents or executable steps remain. Stop only when all work is terminal, an explicit approval or HUMAN-HOLD requires user input, a proven blocker leaves no ready work, or a merge decision requires the user. Hooks are advisory and never replace this watch cycle.
