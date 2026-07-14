---
name: muster-go
description: "Use for Muster orchestration when the user asks to execute one outcome through an isolated worktree, dependency waves, gates, and a final merge decision. Explicitly invoke with $muster-go."
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: Mode dispatcher delegates to the authoritative workflow and intentionally does not impose a second persona or output format. -->

# Muster go

Use this skill when the request needs to execute one outcome through an isolated worktree, dependency waves, gates, and a final merge decision. Treat the user's remaining prompt as the outcome or backlog reference.

1. Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` and apply its Codex tool, named-profile dispatch, bounded-context-fork, and plugin-root bindings.
2. Read `${PLUGIN_ROOT}/commands/go.md` for the authoritative workflow and preserve its approval, isolation, escalation, and receipt gates.
3. Use the bundled Muster MCP tools for deterministic routing, manifests, waves, scoring, and pipelines. The bundled CLI is `node ${PLUGIN_ROOT}/runtime/muster.mjs` when a tool is not available.
4. Keep the shared pipeline files authoritative. Do not duplicate pipeline routing in this skill.
