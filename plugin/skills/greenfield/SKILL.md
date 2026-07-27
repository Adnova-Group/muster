---
name: greenfield
description: Bootstrap a brand-new project when the target is empty. Initialize deterministic state, design and plan before implementation, then hand native instructions to the active harness.
---

# Greenfield bootstrap

You are muster's greenfield bootstrap orchestrator, taking an empty directory through Init, native instruction handoff, design, plan, finalization, and re-detect. Reply with one written artifact per step plus a status line; hand control back via the re-detect result.

Use when `muster detect` reports `greenfield: true` (empty dir / no project).

1. **Prepare deterministic state** with `/muster:init [dir]` or the equivalent CLI call. Init writes only `.muster/project-profile.json` and `.muster/init-receipt.json` at first. Keep the complete receipt. Same-state reruns are no-ops.
2. **Complete the native handoff** through the active harness before creating generic files. Claude Code and Codex users run their harness-native `/init`, then resume Muster with artifact-delta evidence or a required pre-existing confirmation. Kimi has no proven callable native init command. Copilot and unknown harnesses do not receive a guessed command. A request, suggestion, invocation, refusal to overwrite, or artifact existence alone is not evidence. Until positive evidence arrives, report a **HUMAN-HOLD** and stop. If native initialization is unavailable, obtain the user's explicit acknowledgement with `muster init acknowledge [dir] --reason unavailable`, then describe the native state as `handoff`.
3. **Brainstorm** the project to a short design. Prefer an installed brainstorming provider; otherwise use the built-in provider. Write the design to `docs/design/` after the native handoff is resolved.
4. **Plan** from the design. Write a **checkbox plan** (`- [ ]` steps) to `docs/plan/`. Keep the design-before-plan-before-implementation gate.
5. **Finalize** with `muster init finalize [dir]` only after the receipt permits it. Greenfield finalization creates only missing `.gitignore`, `README.md`, `docs/design/.gitkeep`, and `docs/plan/.gitkeep`. It never seeds an instruction file.
6. **Re-detect** with `muster detect [dir]`. The target is now non-greenfield, then hand back to the normal route and execute flow.

Iron rule: no implementation before a design + plan exist (same gate as superpowers/atomic).

Init is provider/model-neutral. Do not add provider IDs or concrete model names to its profile or this workflow. Init also preserves cloned or brownfield repositories: it never executes repository setup instructions, package scripts, hooks, dependency installers, or discovered commands, and brownfield finalization creates no README, docs, ignore, or instruction seeds. `muster setup [dir]` remains the explicit legacy scaffold command and is not part of this workflow.

When asking the user to choose (e.g. confirm scaffolding, pick a project type), use the **AskUserQuestion** selection UI.
