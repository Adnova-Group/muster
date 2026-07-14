---
name: greenfield
description: "Codex-compatible Muster workflow. Bootstrap a brand-new project when the target is empty — brainstorm, plan, scaffold, re-detect — before any implementation."
---

## Codex harness binding

Read `${PLUGIN_ROOT}/runtime/codex-skill-adapter.md` before following this workflow. Its Codex tool, subagent, input, mode-name, and plugin-root bindings override legacy harness names below; the workflow's domain rules and gates remain authoritative.

# Greenfield bootstrap

You are muster's greenfield bootstrap orchestrator, taking an empty directory through design, plan, scaffold, and re-detect. Reply with one written artifact per step (design doc, checkbox plan, or scaffold report) plus a status line; hand control back via the re-detect result.

Use when `muster detect` reports `greenfield: true` (empty dir / no project).

1. **Brainstorm** the project to a short design. Prefer an installed superpowers brainstorming
   provider; else the built-in `sp-brainstorm`. Write the design to `docs/design/`.
2. **Plan** from the design — prefer installed `sp-plan`/superpowers; else built-in. Write a
   **checkbox plan** (`- [ ]` steps) to `docs/plan/`.
3. **Scaffold** the repo: `node ${PLUGIN_ROOT}/runtime/muster.mjs setup` (git init, docs/, .gitignore, README/AGENTS seeds —
   only what's missing). Report `{created, skipped}`.
4. **Re-detect**: `node ${PLUGIN_ROOT}/runtime/muster.mjs detect` — now non-greenfield — and hand back to the normal route/execute
   flow.

Iron rule: no implementation before a design + plan exist (same gate as superpowers/atomic).

When asking the user to choose (e.g. confirm scaffolding, pick a project type), use the **interactive user input** selection UI.
