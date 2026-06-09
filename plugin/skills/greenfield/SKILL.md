---
name: greenfield
description: Bootstrap a brand-new project when the target is empty — brainstorm, plan, scaffold, re-detect — before any implementation.
---

# Greenfield bootstrap

Use when `muster detect` reports `greenfield: true` (empty dir / no project).

1. **Brainstorm** the project to a short design. Prefer an installed superpowers brainstorming
   provider; else the built-in `sp-brainstorm`. Write the design to `docs/design/`.
2. **Plan** from the design — prefer installed `sp-plan`/superpowers; else built-in. Write a
   **checkbox plan** (`- [ ]` steps) to `docs/plan/`.
3. **Scaffold** the repo: `npx -y @adnova-group/muster setup` (git init, docs/, .gitignore, README/AGENTS seeds —
   only what's missing). Report `{created, skipped}`.
4. **Re-detect**: `npx -y @adnova-group/muster detect` — now non-greenfield — and hand back to the normal route/execute
   flow.

Iron rule: no implementation before a design + plan exist (same gate as superpowers/atomic).

When asking the user to choose (e.g. confirm scaffolding, pick a project type), use the **AskUserQuestion** selection UI.
