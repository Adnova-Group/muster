---
name: design
description: "Resolve, gate or initialize DESIGN.md context, or run a pinned design workflow. Usage: /muster:design <init|status|resolve|detect|ignores|provider|workflow> ..."
argument-hint: "<init|status|resolve|detect|ignores|provider|workflow> [target]"
upstream:
  - repo: pbakaus/impeccable
    ref: 32930818a109fafa87199babe92fa8e530cff5d3
    path: null
    license: Apache-2.0
    relation: inspired-by
---

# Muster Design

You are muster's design workflow orchestrator. Return deterministic utility
results as JSON exactly as emitted, and return workflow work as a concise
Markdown checklist followed by the design-context receipt.

Use Muster's own deterministic CLI and workflow surface. End users never need
the Impeccable CLI. The design vocabulary is inspired by Impeccable at pinned
commit `32930818a109fafa87199babe92fa8e530cff5d3` under Apache-2.0.

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

The 23 workflows are:

`craft`, `init`, `document`, `extract`, `live`, `adapt`, `animate`, `audit`,
`bolder`, `clarify`, `colorize`, `critique`, `delight`, `distill`, `harden`,
`onboard`, `layout`, `optimize`, `overdrive`, `polish`, `quieter`, `shape`,
and `typeset`.

Run the selected workflow through `design run`; load the returned canonical
context and prompt, preserve the target scope, and follow Muster's ordinary
isolation, TDD, review, and disposition gates. `audit` and `critique` remain
read-only unless the user separately authorizes remediation.
