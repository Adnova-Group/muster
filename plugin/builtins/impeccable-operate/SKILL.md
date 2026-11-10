---
name: impeccable-operate
description: "Impeccable's operate reference (vendored): Extended guidance for Operate surfaces (app UI, dashboards, tools) and Read surfaces (docs)."
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: pbakaus/impeccable
    ref: 035c8f319edd019936525a062fe99e83ca8d12c6
    path: plugin/skills/impeccable/reference/operate.md
    license: Apache-2.0
    relation: adapted
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, ANTH-POS-001, GUARD-IDK-001, GUARD-CITE-002: pinned upstream Impeccable playbook, loaded by a muster design-workflow packet that supplies the role, output format and evidence rules; the upstream text stays unedited so `muster vendor update` can 3-way merge it. -->

> **Muster adaptation.** Vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable) `plugin/skills/impeccable/reference/operate.md` at `035c8f319edd019936525a062fe99e83ca8d12c6` (skill-v4.8.2), Apache-2.0, Copyright 2025 Paul Bakaus. The upstream text below is unchanged except that links to references muster vendors point at their `impeccable-*` builtins. In muster, run it through the design workflow (`muster design run <workflow>`; read `/impeccable <command>` as that). The DESIGN.md that `design run` resolves is the canonical context, and DESIGN.md is written only through muster's confirmed `design init --content-file` flow. Muster does not ship Impeccable's `scripts/impeccable` binary, live browser or hooks: skip any step that runs them (`context`, `detect`, `critique-storage`, `live-server`, `concept-seed`, `surface-brief`, `build-phase`, `pin`, `hooks`, `doctor`) and continue as upstream's "launcher unavailable" path describes. Links to references muster does not vendor (`init.md`, `new-work.md`, `live.md`, `generate.md`, the native `*.native.md`, `ios.md` and `android.md`, and the other engine references) name upstream files for context only.

# Operate mode depth (and Read notes)

When design SERVES the product: app UIs, admin dashboards, settings panels, data tables, tools, authenticated surfaces, anything where the user is in a task. The essentials live in SKILL.md's modes and [impeccable-craft-floor](../impeccable-craft-floor/SKILL.md); this file is extended depth, written for Operate surfaces. Read surfaces (docs, guides, long-form) take SKILL.md's Read mode plus this file's typography and consistency rules; their prose measure and navigation matter more than component density.

## The product slop test

Familiarity is often a feature here. The test is whether a category-fluent user can trust the interface immediately or must pause at every subtly-off component.

Product UI's failure mode isn't flatness, it's strangeness without purpose: over-decorated buttons, mismatched form controls, gratuitous motion, display fonts where labels should be, invented affordances for standard tasks. The bar is earned familiarity. The tool should disappear into the task.

## Typography

- **One family is often right.** Product UIs don't need display/body pairing. A well-tuned sans carries headings, buttons, labels, body, data.
- **Fixed rem scale, not fluid.** Clamp-sized headings don't serve product UI. Users view at consistent DPI, and a fluid h1 that shrinks in a sidebar looks worse, not better.
- **Tighter scale ratio.** 1.125–1.2 between steps is typical. More type elements here than on brand surfaces; exaggerated contrast creates noise.
- **Line length still applies for prose** (65–75ch). Data and compact UI can run denser; tables at 120ch+ are fine.

## Color

Product defaults to Restrained. A single surface can earn Committed (a dashboard where one category color carries a report, an onboarding flow with a drenched welcome screen), but Restrained is the floor.

- State-rich semantic vocabulary: hover, focus, active, disabled, selected, loading, error, warning, success, info. Standardize these.
- Accent color used for primary actions, current selection, and state indicators only, not decoration.
- A second neutral layer for sidebars, toolbars, and panels (slightly cooler or warmer than the content surface).

## Layout

- Responsive behavior is structural (collapse sidebar, responsive table, breakpoint-driven columns), not fluid typography.

## Components

Every interactive component has: default, hover, focus, active, disabled, loading, error. Don't ship with half of these.

- Skeleton states for loading, not spinners in the middle of content.
- Empty states that teach the interface, not "nothing here."
- Consistent affordances across the surface. Same button shape. Same form-control vocabulary. Same icon style.
- Overlays escape their container. An absolutely positioned dropdown inside an `overflow: hidden` or `overflow: auto` ancestor gets clipped; reach for `<dialog>`, the popover API, `position: fixed`, or a portal.

## Motion

- 150–250 ms on most transitions. Users are in flow; don't make them wait for choreography.
- Motion conveys state, not decoration. State change, feedback, loading, reveal: nothing else.
- No orchestrated page-load sequences. Product loads into a task; users don't want to watch it load.

## Product constraints

- Decorative motion that doesn't convey state.
- Inconsistent component vocabulary across screens. If the "save" button looks different in two places, one is wrong.
- Display fonts in UI labels, buttons, data.
- Reinventing standard affordances for flavor (custom scrollbars, weird form controls, non-standard modals).
- Heavy color or full-saturation accents on inactive states.
- Modal as first thought. Modals are usually laziness. Exhaust inline / progressive alternatives first.

## Product permissions

Product can afford things brand surfaces can't.

- System fonts and familiar sans defaults.
- Standard navigation patterns: top bar + side nav, breadcrumbs, tabs, command palettes.
- Density. Tables with many rows, panels with many labels, dense information when users need it.
- Consistency over surprise. The same visual vocabulary screen to screen is a virtue; delight is saved for moments, not pages.
