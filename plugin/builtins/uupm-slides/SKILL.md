---
name: uupm-slides
description: "Strategic HTML presentations: deck strategies, layout patterns, copywriting formulas and Chart.js templates."
argument-hint: "[topic] [slide-count]"
muster_builtin: true
license: MIT
upstream:
  - repo: nextlevelbuilder/ui-ux-pro-max-skill
    ref: 4f2dbb67e64969a9a30ab00742f2d55d66ddec2b
    path: .claude/skills/slides/SKILL.md
    license: MIT
    relation: adapted
---

# Slides

> **In muster.** A builtin read by path, not a slash command. Its directory is `${CLAUDE_PLUGIN_ROOT}/builtins/uupm-slides`; where `CLAUDE_PLUGIN_ROOT` is unset (a subagent's shell), the plugin root is two levels above this file. Sibling uupm builtins sit beside it (`../uupm-<name>/`). Upstream slash commands such as `/slides:create` or `/brand:update` do not exist in muster: read the matching reference instead. The project's `DESIGN.md`, owned by `/muster:design`, governs; when sources disagree: `DESIGN.md`, then accessibility/WCAG, then impeccable, then this skill.

Strategic HTML presentation design with data visualization.

## When to Use

- Marketing presentations and pitch decks
- Data-driven slides with Chart.js
- Strategic slide design with layout patterns
- Copywriting-optimized presentation content

## Subcommands

| Subcommand | Description | Reference |
|------------|-------------|-----------|
| `create` | Create strategic presentation slides | `references/create.md` |

## Script Paths

Script paths in this skill and its `references/` are relative to the directory that contains this SKILL.md, not to the project: `scripts/<file>` is this skill's own `scripts/` folder, and `../uupm-<skill>/scripts/<file>` is a sibling uupm builtin beside it. Build the full path from that directory (`${CLAUDE_PLUGIN_ROOT}/builtins/<this builtin>` in muster) and keep the working directory at the project root — the scripts read and write project files such as `docs/brand-guidelines.md`, `assets/design-tokens.json` or `src/` relative to it.

## References (Knowledge Base)

| Topic | File |
|-------|------|
| Layout Patterns | `references/layout-patterns.md` |
| HTML Template | `references/html-template.md` |
| Copywriting Formulas | `references/copywriting-formulas.md` |
| Slide Strategies | `references/slide-strategies.md` |

## Routing

1. Parse subcommand from `$ARGUMENTS` (first word)
2. Load corresponding `references/{subcommand}.md`
3. Execute with remaining arguments
