---
name: typeui
description: "TypeUI MCP context (project design skills, brand kits, UI prompts, layout variations); use only when the TypeUI MCP server is connected."
muster_builtin: true
license: MIT
upstream:
  - repo: bergside/typeui
    ref: efc5f21dff38692e4eaffc304fed465d7cb531e8
    path: plugins/grok/typeui/skills/typeui/SKILL.md
    license: MIT
    relation: adapted
---

# TypeUI for Claude Code

> **In muster.** A builtin read by path, not a slash command. It needs the TypeUI remote MCP server, a third-party service that requires sign-in; muster does not register it. If no `typeui` MCP tools are in the session, skip this builtin and use `uupm-ui-ux-pro-max` for design data. The project's `DESIGN.md`, owned by `/muster:design`, governs; when sources disagree: `DESIGN.md`, then accessibility/WCAG, then impeccable, then TypeUI context.

Use this skill when the user wants Claude Code to build, redesign, or refine UI with TypeUI context.

## What TypeUI Provides

- Project design skills for consistent visual direction.
- Brand kits with project name, logo, typography, and brand color tokens.
- UI prompt libraries for common interface sections and full-product flows.
- Layout variation guidance for producing better options before implementation.

## How to Use TypeUI

1. Prefer TypeUI MCP tools when they are available in the session.
2. Ask the user which TypeUI project or design skill to use if the request does not specify one.
3. Apply the selected project context before choosing colors, type, spacing, component tone, or page composition.
4. Treat brand kit values as brand parameters only: logo, project name, typography, and brand colors.
5. Treat the design skill as the source of UI style, component behavior, visual hierarchy, spacing, and interaction patterns.

## MCP Server

The TypeUI Claude Code plugin registers the TypeUI remote HTTP MCP server:

```text
https://mcp.typeui.sh/mcp
```

If the server is not available in the current Claude Code session, the user can install the TypeUI plugin:

```bash
claude plugin marketplace add bergside/typeui
claude plugin install typeui@bergside
```

## Prompt Examples

- Use my TypeUI project and build a landing page.
- Generate three pricing section variations with TypeUI.
- Redesign this dashboard using my TypeUI design skill.
- Pull the TypeUI context for this project before changing the UI.
