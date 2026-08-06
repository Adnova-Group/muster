# Muster design system

This file is the canonical design context for Muster's public documentation website. It governs
`website/**` and should be consulted before changing any public-facing layout, copy hierarchy,
visual asset, interaction, or responsive behavior. Product behavior remains authoritative in the
source and reference documentation; this file defines how that truth is presented.

## Direction

Muster should feel like an inspectable technical instrument: precise, calm, and open about how it
works. The visual metaphor is a glass box, expressed through layered translucent surfaces, visible
paths, and restrained indigo-to-sky light. Pages should prioritize comprehension over spectacle.
Avoid opaque AI imagery, decorative complexity, and claims that outrun verified harness behavior.

The home hero pairs concise copy with the faceted Muster mark. The mark represents one outcome
splitting into observable execution paths and returning to a verified result. Supporting surfaces
use crisp borders, modest radii, and a consistent line-icon family rather than emoji or stock art.

## Typography

- Use VitePress's system sans stack for interface and prose. It is fast, familiar, and requires no
  third-party font request.
- Use the platform monospace stack for commands, file names, receipts, and technical identifiers.
- Keep headings compact and declarative. Body copy should remain readable at 16px or larger with a
  line height near 1.7 and a comfortable maximum measure.
- Use weight and spacing for hierarchy. Do not rely on color alone or introduce display typefaces.

## Color

The shipped source of truth is `website/.vitepress/theme/custom.css`.

| Token | Light | Dark | Purpose |
| --- | --- | --- | --- |
| Brand primary | `#5b4bd6` | `#9b8cff` | Links, focus accents, primary actions, hero name text |
| Brand active | `#6d5ce7` | `#8978ff` | Hover and selected states |
| Brand deep | `#4f3fc4` | `#7565f0` | Pressed states and strong borders |
| Gradient partner | `#41b3ff` | `#41b3ff` | Mark asset and hero-image glow (decorative only) |
| Soft surface | `rgba(109, 92, 231, 0.14)` | `rgba(155, 140, 255, 0.16)` | Tinted panels and icon fields |

All foreground/background pairs must meet WCAG 2.2 AA contrast. Gradients are decorative accents,
not text backgrounds for essential copy: the hero name renders in the solid, theme-aware brand
primary color (6.14:1 light, 6.20:1 dark against the page background) rather than the brand
active/gradient-partner gradient, which stays confined to the decorative mark asset and the
blurred hero-image glow. Focus indicators use the primary color plus sufficient offset to remain
visible in both themes.

## Layout and responsive behavior

- Start with a single readable column, then enhance to grids when space permits.
- Keep the primary content measure within VitePress defaults. Use full-width regions only for
  comparisons that benefit from horizontal space.
- At narrow widths, decision cards and harness choices collapse to one column.
- Comparison tables live in labelled, keyboard-focusable scroll regions. The first column remains
  sticky on compact screens so row meaning stays visible while panning.
- Never encode meaning only through hover. Touch targets should be at least 44 by 44 CSS pixels.
- Avoid layout shifts: size brand imagery explicitly and keep animations to color, opacity, or
  transform. Respect `prefers-reduced-motion`.

## Accessibility

- Target WCAG 2.2 AA. Use semantic headings, lists, links, tables, and landmarks before ARIA.
- Decorative SVG icons use `aria-hidden="true"` and `focusable="false"`; adjacent visible titles
  provide their accessible names. Informative images require concise alternative text.
- Every keyboard-operable control needs a visible focus state. Do not remove browser outlines
  without an equivalent replacement.
- Link text must describe its destination without relying on surrounding prose.
- Status and support language must distinguish verified behavior, conditional capability, and
  unverified claims. ChatGPT Work is always labelled private/local and proof-gated.
- Do not use emoji as feature icons: rendering varies by platform and their spoken labels can add
  noise for screen-reader users.

## Component principles

- **Outcome first:** state the user's task before implementation detail.
- **Progressive disclosure:** quickstarts choose a lane and mode; reference pages hold exhaustive
  mechanics.
- **Truth in comparison:** use the same fields across harnesses and qualify conditional support in
  the cell where it matters.
- **One primary action:** a page may offer alternatives, but its first action should make the next
  decision obvious.
- **Reusable patterns:** harness cards, decision cards, notices, and icon fields share spacing,
  border, and focus behavior from the site stylesheet.
- **Static by default:** prefer semantic HTML and CSS over client JavaScript. This preserves fast
  rendering, low bundle cost, and dependable documentation navigation.

## Site provenance

- The site is a VitePress application in `website/`, built by `.github/workflows/docs.yml` and
  deployed to GitHub Pages at `https://adnova-group.github.io/muster/`.
- VitePress supplies the base theme and system font stack. Muster's theme extension is
  `website/.vitepress/theme/custom.css`; configuration and metadata live in
  `website/.vitepress/config.js`.
- The Muster logo, favicon, feature icons, and social preview are project-owned assets under
  `website/public/brand/`. Their geometry and palette are authored for this repository, not sourced
  from a third-party icon library.
- The palette and prompt-facing brand rules are mirrored in `docs/profiles/BRAND.md`. If this file,
  the stylesheet, and that profile disagree, update all three in the same change.
- Third-party agent and skill provenance is listed in `NOTICE` and `website/about/credits.md`.

## Change checklist

Before shipping a visual change, verify the production build, internal links and anchors, keyboard
navigation, light and dark contrast, and layouts near 320px, 768px, and desktop widths. Update this
file when a new enduring pattern or token is introduced.
