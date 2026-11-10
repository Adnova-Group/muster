---
name: impeccable-craft-floor
description: "Impeccable's craft-floor reference (vendored): Quality floor, absolute bans and verification checks to read immediately before any UI edit."
muster_builtin: true
license: Apache-2.0
upstream:
  - repo: pbakaus/impeccable
    ref: 035c8f319edd019936525a062fe99e83ca8d12c6
    path: plugin/skills/impeccable/reference/craft-floor.md
    license: Apache-2.0
    relation: adapted
---

<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, ANTH-POS-001, GUARD-IDK-001, GUARD-CITE-002: pinned upstream Impeccable playbook, loaded by a muster design-workflow packet that supplies the role, output format and evidence rules; the upstream text stays unedited so `muster vendor update` can 3-way merge it. -->

> **Muster adaptation.** Vendored from [pbakaus/impeccable](https://github.com/pbakaus/impeccable) `plugin/skills/impeccable/reference/craft-floor.md` at `035c8f319edd019936525a062fe99e83ca8d12c6` (skill-v4.8.2), Apache-2.0, Copyright 2025 Paul Bakaus. The upstream text below is unchanged except that links to references muster vendors point at their `impeccable-*` builtins. In muster, run it through the design workflow (`muster design run <workflow>`; read `/impeccable <command>` as that). The DESIGN.md that `design run` resolves is the canonical context, and DESIGN.md is written only through muster's confirmed `design init --content-file` flow. Muster does not ship Impeccable's launcher binary, live browser or hooks: skip any step that runs them (`context`, `detect`, `critique-storage`, `live-server`, `concept-seed`, `surface-brief`, `build-phase`, `pin`, `hooks`, `doctor`) and continue as upstream's "launcher unavailable" path describes. Links to references muster does not vendor (init, new-work, live, generate, the native-platform references for iOS and Android, and the other engine references) name upstream files for context only.

# Craft floor

Load this after the direction is settled, and build without announcing the checklist. A pinned brief or the committed visual world overrides anything here except a line marked as a ban; your own habit does not. When the design hook is active it already enforces the mechanical checks below as you edit: act on its findings instead of re-auditing each rule.

## Verify

Each of these is a check on the built result, not an intention. Run them together in each batched look at the render, not as separate screenshot trips; the checks share one render.

- **Contrast:** body and placeholder text ≥4.5:1, large text ≥3:1. On colored surfaces tint secondary text from that hue or the foreground; never gray.
- **Depth:** shadows carry an offset and a soft blur. A zero-offset colored halo is decoration.
- **Spacing:** tight groups, generous separation, more space above a heading than below it. Read the computed values.
- **Type:** body measure 65–75ch, display max 6rem, tracking floor -0.04em, balanced headings, obvious scale and weight steps. Run the real copy at every breakpoint and fix what overflows.
- **Motion:** one authored moment, not scattered effects and not one identical entrance on every section. Exponential ease-out from an already-visible default. Reach past transform and opacity: blur, backdrop-filter, clip-path, mask, and shadow belong to the palette when they stay smooth.
- **States:** hover, disabled, loading, error, empty. Plus real content, working controls, responsive composition, keyboard focus.
- **Browser surfaces:** the parts you did not draw still carry the design. Text selection, the caret, custom scrollbars, focus rings, underline offset, and the numerals in tabular data all ship with browser defaults that belong to no design system. Theme them from the palette. This is the cheapest signal that a page was built rather than assembled, and the one models skip most reliably.
- **Copy:** the product's own language. Controls name their action; errors name the problem and the recovery.
- **Coverage:** every brief requirement present and findable within seconds.

## Refuse

These are the category's defaults, not bans: the brief's own words can earn any of them. Reaching for one when the axis is free means you were not deciding; recognizing that means rewriting the element, not softening it.

Page scaffolds:

- Same-size cards of icon plus heading plus text as the page structure. Cards are the lazy container; nested cards are always wrong.
- The hero-metric template: big number, small label, supporting stats, accent.
- A kicker or eyebrow above a heading. This one is a ban, not a default: no brief earns it back. The heading carries its own weight; delete the label and let the heading speak.
- Section numbers (01 / 02 / 03) unless the sequence itself carries information the reader needs.
- A modal for a task that needs neither interruption nor protected focus.

Surface habits:

- Gradient text. Emphasis comes from weight or size.
- Glass and blur as decoration rather than as a specific effect.
- A colored `border-left` or `border-right` above 1px on cards, list items, callouts, or alerts.
- Hard offset shadows (`box-shadow: 4px 4px 0`) outside a world that is actually neobrutalist. The zero-blur block shadow is a costume, not a depth system; a world that did not choose it never earns it as a default.
- Sparklines, progress rings, and soft-shadowed rounded rectangles standing in for content.
- Monospace as a costume for "technical" rather than for code, data, or measurement.
- A system display face (Impact, Arial Black, the platform sans) as the display voice of an own-world page. Source and self-host a face whose character matches the approved lettering; the closest installed font is a failure, not a fallback.
- Unicode glyphs or emoji standing in for an icon system. Icons are drawn, from a real library or authored SVG, in one consistent stroke and weight.
- Geometric masks standing in for organic contours. A circle, polygon, or radial-gradient cutout approximating a photographic subject's edge is the cheap version of the effect and reads worse than omitting it. Derive an alpha matte from the actual image, or produce a cut-out asset.
- Light or dark picked by category. Pick it from the use scene: who, where, under what ambient light.

The floor holds the mechanics; it never picks the direction. With every check green, spend the page on the committed world, and when torn between refined and committed, commit.
