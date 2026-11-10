---
name: design-supporting-skills
description: Reference for /muster:design -- the vendored Impeccable playbook each design workflow follows, the supporting builtins and optional Mobbin references it reads, how, and in what precedence. Read on demand by the design workflow orchestrator; never dispatched standalone.
---

<!-- prompt-lint-disable ANTH-ROLE-001: reference table loaded ON DEMAND into the already
role-anchored /muster:design orchestrator; a second "You are..." opener would duplicate the persona. -->

# Design workflows: playbooks and supporting skills

Impeccable is the workflow engine and owns `DESIGN.md` as the canonical
context. Each of the 24 workflows follows its **primary** playbook: Impeccable's
own skill and references, vendored as `impeccable-*` builtins (Apache-2.0,
merge-tracked in `vendor/manifest.yaml`). The `design run` packet keeps only
muster's orchestration: the context gate, the confirmed `DESIGN.md` write flow
and the receipt. `impeccable-core` is always first; `impeccable-craft-floor`
is read immediately before any UI edit. The supporting skills are read on
demand by builtin id: a skill lives at `plugin/builtins/<id>/SKILL.md` and an
agent at `plugin/agents/<id>.md`. Muster references them and carries none of
their text. The data behind this table is `DESIGN_SUPPORT` in `src/design.js`.

Output: when a packet's skills need explaining, answer as a Markdown list
with one line per id: the id, its path, and how the workflow uses it. If a
skill is not in this file, say so rather than guessing a mapping.

When sources disagree: project DESIGN.md > accessibility/WCAG > Impeccable workflow guidance > supporting skills and references (uupm, typeui, intent, pfd, emil, gsap, taste, hallmark, anthropic, jk, elaya, addy, Mobbin).

## How each family is used

- **Impeccable (`impeccable-*`, primary).** The vendored playbooks. Steps that
  need Impeccable's binary, live browser or hooks are skipped, as each file's
  adaptation note says. `generate` and `live` have no vendored reference (both
  are live-browser plumbing upstream): `generate` writes its variants by the
  mapped direction's playbook, and `live` iterates with the picker skills below.
  `craft` and `init` run on `impeccable-core`; `init` reads
  `impeccable-document` for the DESIGN.md shape.
- **ui-ux-pro-max (`uupm-*`) is the searchable data layer**: styles, palettes,
  font pairings, UX guidelines, stack guidance, the rule-priority table and the
  pre-delivery checklist. Search with
  `plugin/builtins/uupm-ui-ux-pro-max/scripts/search.py` (`--design-system`,
  `--domain`, `--stack`). The `uupm` column says how a workflow uses it:
  - `query`: for a style, color, type, layout or motion choice, search for
    data-backed candidates, show them, let the user confirm, then write the
    confirmed choice into `DESIGN.md` through the workflow. Its `--persist`
    output is never design context.
  - `checklist`: apply its rule-priority table and the pre-delivery checklist
    in `references/pro-rules.md` beside Impeccable's guidance.
  - `lookup`: implementation guidance by domain or by the detected stack.
  - Without Python 3, read `references/quick-reference.md`,
    `references/pro-rules.md` and the `data/` files instead.
- **typeui** gives build and generation work curated design systems, UI
  prompts and layout variations. It needs the TypeUI MCP server and a sign-in;
  skip it when those tools are not in the session.
- **intent (`intent-*`)** gives the UX disciplines: strategy and framing, flows,
  wireframes, IA, UX writing, evaluation, edge-case hardening, accessibility,
  localization, platform transposition and success metrics. Its agents are
  optional specialists to dispatch for the larger workflows.
- **pfd**, Perception-First Design (skovalik/perception-first-design, CC BY-SA 4.0),
  is a perception, cognitive-load and decision lens for critique and for
  framing work. Reference it by id only; never quote or paraphrase its text
  into muster files.
- **Motion: `emil-*` and `gsap-*`.** Emil Kowalski's skills build, choreograph,
  review, trim and speed up motion, find where motion belongs, name effects,
  and make web apps feel native on phones; `emil-break-ui` and
  `emil-prototype` stress-test and prototype UI. The official GSAP skills
  (core, timeline, ScrollTrigger, plugins, React, other frameworks, utils,
  performance) apply only where the project uses GSAP; `emil-animate-expo` only
  for React Native and Expo.
- **Visual direction: `taste-*`, `hallmark`, `anthropic-frontend-design`.**
  Direction and redesign lenses for bold, high-end, minimalist, brutalist or
  Stitch-style work. Mapped by their stated purpose; the brief and DESIGN.md
  win over any style default they carry.
- **`jk-*` (Jakub Krehel's skills):** focused passes on UI polish, color,
  typography, layout, accessibility and interface copy, a ranked interface
  review, a review of what a branch changed, variant and state pickers, a
  stress page, and building from a Figma file or image.
- **`elaya-*` and `addy-*`:** landing-page and Figma design, frontend UI
  engineering, and browser testing with DevTools. Mapped by their stated
  purpose.
- **Mobbin (optional MCP, detect-and-use, never bundled).** Only when the
  session has tools from an MCP server whose name matches `/mobbin/i`, the
  workflows marked in the Mobbin column search Mobbin for real references
  before choosing a pattern, flow or screen structure: `search_flows` for
  multi-step flows (onboarding, checkout, paywalls), `search_screens` for single
  screens and empty states, `search_sections` for website sections. Cite the
  apps and screens used, then synthesize. When the tools are absent, skip the
  step silently. Never call its saved-content tools (`create_collection`,
  `save_content`, `add_comment`) from a workflow. Mobbin screens are
  third-party product screenshots used as reference only: never copy
  proprietary assets or brand elements into the user's product. Mobbin informs
  pattern choice and never overrides `DESIGN.md`.

## Workflow map

| Workflow | Primary | Skills | Agents | uupm | Mobbin |
|---|---|---|---|---|---|
| craft | impeccable-core, impeccable-craft-floor | uupm-ui-ux-pro-max, uupm-ui-styling, typeui, anthropic-frontend-design, taste-stitch-design-taste, hallmark, elaya-landing-page-design, elaya-figma-designer, jk-build-design, addy-frontend-ui-engineering, emil-pick-ui-library, impeccable-operate | | query | yes |
| init | impeccable-core | uupm-ui-ux-pro-max, uupm-brand, intent-intent, impeccable-document | | query | |
| document | impeccable-core, impeccable-document | uupm-design-system | | | |
| extract | impeccable-core, impeccable-extract, impeccable-craft-floor | uupm-design-system | | | |
| live | impeccable-core, impeccable-craft-floor | emil-prototype, jk-variant, jk-state-machine | | | |
| generate | impeccable-core, impeccable-craft-floor | typeui, uupm-ui-ux-pro-max, emil-prototype, jk-variant, taste-stitch-design-taste | | query | yes |
| adapt | impeccable-core, impeccable-adapt, impeccable-craft-floor | intent-transpose, uupm-ui-ux-pro-max, emil-mobile-native, jk-better-layout | | lookup | |
| animate | impeccable-core, impeccable-animate, impeccable-craft-floor | uupm-ui-ux-pro-max, emil-animate, emil-choreograph, emil-apple-design, emil-find-animation-opportunities, emil-animation-vocabulary, emil-animate-expo, gsap-core, gsap-timeline, gsap-scrolltrigger, gsap-plugins, gsap-react, gsap-frameworks, gsap-utils | | query | |
| audit | impeccable-core, impeccable-audit | uupm-ui-ux-pro-max, intent-evaluate, intent-include, jk-better-accessibility, addy-browser-testing-with-devtools | intent-vigil | checklist | |
| bolder | impeccable-core, impeccable-bolder, impeccable-craft-floor | uupm-ui-ux-pro-max, anthropic-frontend-design, taste-high-end-visual-design, taste-industrial-brutalist-ui, hallmark | | query | yes |
| clarify | impeccable-core, impeccable-clarify, impeccable-craft-floor | intent-articulate, uupm-brand, pfd, jk-better-writing | intent-wren | | |
| colorize | impeccable-core, impeccable-colorize, impeccable-craft-floor | uupm-ui-ux-pro-max, jk-better-colors | | query | |
| critique | impeccable-core, impeccable-critique | uupm-ui-ux-pro-max, intent-evaluate, pfd, jk-better-interface, jk-interface-review, emil-review-animations | intent-vigil | checklist | |
| delight | impeccable-core, impeccable-delight, impeccable-craft-floor | uupm-ui-ux-pro-max, intent-articulate, emil-design-eng, emil-find-animation-opportunities | | query | |
| distill | impeccable-core, impeccable-distill, impeccable-craft-floor | pfd, intent-organize, emil-remove-animations, taste-minimalist-ui | | | |
| harden | impeccable-core, impeccable-harden, impeccable-craft-floor | intent-fortify, intent-include, intent-localize, emil-break-ui, jk-break, jk-state-machine, jk-better-layout, jk-better-accessibility | intent-vigil | | |
| onboard | impeccable-core, impeccable-onboard, impeccable-craft-floor | intent-journey, intent-fortify, intent-articulate, intent-measure, pfd, jk-better-writing | intent-wren | | yes |
| layout | impeccable-core, impeccable-layout, impeccable-craft-floor | uupm-ui-ux-pro-max, intent-wireframe, typeui, jk-better-layout, impeccable-operate | | query | yes |
| optimize | impeccable-core, impeccable-optimize, impeccable-craft-floor | uupm-ui-ux-pro-max, emil-animation-performance, gsap-performance, addy-browser-testing-with-devtools | | lookup | |
| overdrive | impeccable-core, impeccable-overdrive, impeccable-craft-floor | uupm-ui-ux-pro-max, emil-choreograph, emil-apple-design, gsap-scrolltrigger, gsap-plugins, gsap-timeline, taste-high-end-visual-design, taste-industrial-brutalist-ui | | query | yes |
| polish | impeccable-core, impeccable-polish, impeccable-craft-floor | uupm-ui-ux-pro-max, emil-design-eng, emil-review-animations, jk-better-ui | | checklist | |
| quieter | impeccable-core, impeccable-quieter, impeccable-craft-floor | uupm-ui-ux-pro-max, emil-remove-animations, taste-minimalist-ui | | query | |
| shape | impeccable-core, impeccable-shape | intent-strategize, intent-journey, intent-wireframe, intent-measure, pfd, uupm-ui-ux-pro-max, anthropic-frontend-design | intent-ember | query | yes |
| typeset | impeccable-core, impeccable-typeset, impeccable-craft-floor | uupm-ui-ux-pro-max, jk-better-typography | | query | |

## Read but not mapped

These serve work outside the 24 workflows. Invoke them directly when the task
calls for them.

- `uupm-design`, `uupm-slides`, `uupm-banner-design`, `anthropic-canvas-design`:
  logos, identity programs, icons, presentations, banners and static visual
  art.
- `intent-blueprint`: service and system blueprints behind the interface.
- `intent-investigate`: planning and synthesizing user research.
- `intent-present`, `intent-storytelling`: presenting design work.
- `intent-specify`, agent `intent-rune`: build handoff packaging; muster's own
  review and disposition gates cover handoff.
- `intent-philosopher`, agent `intent-sage`: an open-ended exploration mode
  with no single workflow.
- agent `intent-noor`: Intent's own entry point and router; `/muster:design`
  routes instead.
