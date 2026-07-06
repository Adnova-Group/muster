# Brand profile — muster

Read by `muster-image` (image-prompt authoring) and `muster-video` (video/script authoring) before
drafting any artifact. Keep this file the single source of brand truth for both roles — don't fork
brand rules into the skills themselves.

## Schema (fill in per-project when reusing this file for a client brand)

- **Palette**: primary/secondary/accent hex values, light + dark variants, one soft/tint value for
  backgrounds. Note *where* each derives from (a real asset) vs. is an editorial placeholder.
- **Typography feel**: the words a designer would use (not necessarily a specific font family) —
  weight, geometry, formality. Name the actual webfont only if one is confirmed in the codebase.
- **Style rules**: recurring visual motifs the brand always leans on. State them as positive
  instructions an image/video prompt can inline directly.
- **Negative rules**: clichés and off-brand tells to exclude from every prompt. These are the
  "never render this" list.
- **Voice** (optional, for video scripts): tone words that should carry into spoken cadence.
- **Archive**: append-only log of accepted prompts, one entry per line/block, newest last. Growing
  reference so future prompt sets can match what already shipped instead of re-deriving from scratch.

---

## muster brand (starter content — derived from `website/.vitepress/theme/custom.css` and
`website/.vitepress/config.js`; genuinely sourced, not placeholders, unless marked otherwise)

### Palette
- **Primary (indigo)**: `#5b4bd6`
- **Primary, hover/accent**: `#6d5ce7`
- **Primary, deep**: `#4f3fc4`
- **Soft tint (backgrounds)**: `rgba(109, 92, 231, 0.14)`
- **Gradient partner (sky)**: `#41b3ff` — the brand gradient runs indigo → sky
  (`linear-gradient(120deg, #6d5ce7 30%, #41b3ff)`), used for the hero name and a blurred
  (56px) glass backdrop behind hero art.
- **Dark-mode primary**: `#9b8cff`
- **Dark-mode accent**: `#8978ff`
- **Dark-mode deep**: `#7565f0`
- **Dark-mode soft tint**: `rgba(155, 140, 255, 0.16)`
- **Theme-color meta (browser chrome)**: `#6d5ce7`

### Typography feel
- **PLACEHOLDER — no custom webfont is declared in the site theme** (VitePress default system-ui /
  Inter-like sans stack). Treat as a placeholder to formalize, not a confirmed brand asset.
- Editorial feel to match until a real typeface is chosen: clean, geometric sans, no serif, no
  script/display faces — "engineered," not "friendly startup."

### Style rules (positive — inline these into every prompt)
- **Glass-box motif**: transparency, inspectability, visible mechanism. Favor imagery that shows the
  working parts (exposed gears, layered glass panes, visible wiring/routing diagrams) over sealed,
  opaque surfaces.
- **Indigo-to-sky gradient** as the signature color transition — use it for light sources, glows, or
  gradient fills rather than flat single-hue blocks.
- **Soft blur / glass depth**: a blurred, translucent backdrop (frosted-glass feel) behind sharper
  foreground elements — mirrors the site's blurred hero-image treatment.
- **Tight, "engineered" geometry**: crisp edges, grid-aligned composition, restrained ornamentation —
  the site's feature cards are deliberately tighter/more technical than a typical marketing page.
- **Deterministic / code-over-model sensibility**: when depicting the product conceptually, favor
  circuit-board-precise, blueprint, or schematic framing over painterly abstraction — the brand's
  core claim is "no LLM calls, reproducible by construction."

### Negative rules (never render)
- No generic "AI robot" imagery: no humanoid robots, glowing red eyes, robotic hands reaching toward
  a human hand, or any Terminator-style AI cliché.
- No black-box / opaque-machine imagery — it contradicts the glass-box positioning outright.
- No stock-photo business clichés: handshake close-ups, lightbulb-over-head, generic server-room
  racks with no relation to the actual product.
- No off-palette neon (pure red/green saturated tech-cliché colors) — stay within the indigo/sky
  gradient family plus neutral grays/whites/blacks.
- No dense, illegible circuit-board texture used purely as filler background noise.

### Voice (for video/script cadence)
Direct, technical, unhurried — short declarative sentences, confident without hype. Avoid marketing
breathlessness ("game-changing," "revolutionary"); match the copy tone already on the site
("Give it an outcome. It detects your project, assembles the right crew, and shows its reasoning
before it acts.").

### Archive
_(append accepted prompts below, one entry per artifact, newest last — do not delete history)_

<!-- Example entry shape (delete once real entries exist):
- 2026-07-06 | hero, blog-post "release-notes-launch" | "Isometric blueprint-style illustration of
  a glass panel..." | accepted
-->
