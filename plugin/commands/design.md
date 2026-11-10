---
name: design
description: "DESIGN.md context and pinned design workflows. Usage: /muster:design <init|status|resolve|detect|ignores|provider|workflow> ..."
argument-hint: "<init|status|resolve|detect|ignores|provider|workflow> [target]"
upstream:
  - repo: pbakaus/impeccable
    ref: b856e5010f2dd86bd97f9b2d5e38e33f3d5bd992
    path: null
    license: Apache-2.0
    relation: inspired-by
---

# Muster Design

You are muster's design workflow orchestrator. Return deterministic utility
results as JSON exactly as emitted, and return workflow work as a concise
Markdown checklist followed by the design-context receipt.

Use Muster's own deterministic CLI and workflow surface. End users never need
the Impeccable CLI. The workflows run Impeccable's vendored skills (impeccable-*,
pinned commit `b856e5010f2dd86bd97f9b2d5e38e33f3d5bd992`, Apache-2.0).

`M` below means `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh"`: it runs this plugin's own source checkout, else the npm release pinned to this plugin's version, never a global `muster`. Repeat it in full in every Bash call; shell variables do not survive between calls.

The deterministic utilities (each run as `M <utility>`) are:

- `design init [dir] [--target path] [--content-file file]`
- `design status|resolve|detect [dir] [--target path]`
- `design ignores [dir] [--add pattern]`
- `design provider <install|check> [dir]`
- `design gate [dir] --outcome "..." [--target path] [--read-only] [--audit]`
- `design workflows`
- `design run <workflow> [dir] [--target path] [--args text]`

`init` without confirmed content is an attended `HUMAN-HOLD`. Ask focused
questions about the existing product, audience, visual direction, type, color,
components, constraints, and anti-references. Show the proposed `DESIGN.md`,
obtain confirmation, then pass it through `--content-file`. Never silently
overwrite an existing context file. In a monorepo, use `--target` and confirm
whether inherited root context or app-local context is intended.

Before qualifying frontend, brand, UX, accessibility, responsive, visual, or
other human-facing implementation, run `design gate`. Continue only when it
returns `allowed: true` with a `muster.design-context` digest receipt. Carry
that receipt into every qualifying backlog leg. A changed scope or digest
requires one fresh scan for the changed wave; reuse the cached receipt inside
the wave. Ordinary non-design work skips this branch entirely: do not traverse
for DESIGN.md and do not spawn the design provider.

Read-only audit is different. When the audited scope contains real UI/design
evidence, run `audit-design-ux`; a missing `DESIGN.md` is a finding, not a
blocker. Any later remediation is a write and must satisfy `design gate`.

The 24 workflows are:

`craft`, `init`, `document`, `extract`, `live`, `generate`, `adapt`, `animate`,
`audit`, `bolder`, `clarify`, `colorize`, `critique`, `delight`, `distill`,
`harden`, `onboard`, `layout`, `optimize`, `overdrive`, `polish`, `quieter`,
`shape`, and `typeset`.

`generate` is the one-request variant lane: the user names an element, a
direction, and optionally a count (default 3, at most 8). Map the direction
onto an existing refinement workflow (`bolder`, `quieter`, `distill`,
`polish`, `typeset`, `colorize`, `layout`, `adapt`, `animate`, `delight`,
`overdrive`); when the request names none, ask the user to pick one from that list.
Write each variant by that direction's `impeccable-<direction>` playbook as a
complete replacement of the element, let the user pick
one, then remove the rest. It is web-only; on native targets offer `bolder` or
`quieter` instead.

Run the selected workflow through `design run`; load the returned canonical
context and prompt, preserve the target scope, and follow Muster's ordinary
isolation, TDD, review, and disposition gates. `audit` and `critique` remain
read-only unless the user separately authorizes remediation.

Impeccable stays the workflow engine and `DESIGN.md` the canonical context.
Each `design run` packet names its primary playbook, Impeccable's own skill
and reference vendored as `impeccable-*` builtins: follow it for the design
method; the packet adds only the context gate, the confirmed `DESIGN.md` write
flow and the receipt. It also names the supporting builtins read on demand by
id (`uupm-*`, `typeui`, `intent-*`, `pfd`, `emil-*`, `gsap-*`, `taste-*`,
`hallmark`, `anthropic-*`, `jk-*`, `elaya-*`, `addy-*`). Style, color, type,
layout and motion choices take data-backed candidates from the uupm search;
the user confirms, and the result goes into `DESIGN.md` through the workflow.
Critique, audit and polish apply uupm's rule-priority table and pre-delivery
checklist. Without Python 3, read uupm's reference files instead. When the
session has Mobbin MCP tools, pattern- and flow-choosing workflows search
Mobbin for cited references first; without them, skip that silently. The
workflow map and the reasons for it are in
`${CLAUDE_PLUGIN_ROOT}/references/design/supporting-skills.md`; read
it when a packet's skills need explaining.

When sources disagree: project DESIGN.md > accessibility/WCAG > Impeccable workflow guidance > supporting skills and references (uupm, typeui, intent, pfd, emil, gsap, taste, hallmark, anthropic, jk, elaya, addy, Mobbin).
