/**
 * Regression test for the website hero name's WCAG contrast (2026-08-04 design-ux
 * audit, P1): website/.vitepress/theme/custom.css used to paint the literal product
 * name ("Muster") with a two-stop gradient via VitePress's built-in
 * `.clip` rule (background-clip: text + -webkit-text-fill-color: transparent), and
 * one of those stops (#41b3ff) measured 2.30:1 against the light-theme page
 * background -- failing even the 3:1 large-text floor, let alone 4.5:1.
 *
 * DESIGN.md's own rule is explicit: "Gradients are decorative accents, not text
 * backgrounds for essential copy." This test pins the honest fix consistent with
 * that rule: the hero name now renders in a solid, theme-aware brand color
 * (`--vp-c-brand-1`) instead of the gradient. It recomputes the WCAG 2.2 relative
 * luminance / contrast ratio directly from the shipped CSS custom-property values
 * -- no browser, no build step -- so a future regression (re-attaching a gradient,
 * or drifting the brand-1 hex toward the page background) fails loudly here.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

// VitePress theme-default page background tokens (--vp-c-bg), confirmed against
// website/node_modules/vitepress/dist/client/theme-default/styles/vars.css.
const LIGHT_PAGE_BG = "#ffffff";
const DARK_PAGE_BG = "#1b1b1f";

const AA_NORMAL_TEXT_RATIO = 4.5;

// --- WCAG 2.2 relative luminance / contrast ratio (deterministic, no browser) -----

function srgbChannelToLinear(c8bit) {
  const c = c8bit / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function hexToRgb(hex) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(hex.trim());
  if (!m) throw new Error(`Not a 6-digit hex color: ${JSON.stringify(hex)}`);
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map(srgbChannelToLinear);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrastRatio(hexA, hexB) {
  const lA = relativeLuminance(hexA);
  const lB = relativeLuminance(hexB);
  const lighter = Math.max(lA, lB);
  const darker = Math.min(lA, lB);
  return (lighter + 0.05) / (darker + 0.05);
}

// --- minimal, targeted CSS custom-property extraction ------------------------------

// Pulls `--name: value;` out of a single `{ ... }` block (either `:root { ... }` or
// `.dark { ... }`), stopping at the block's own closing brace so declarations from
// later blocks in the same file never leak in.
function extractBlock(css, selector) {
  const re = new RegExp(`${selector.replace(/\./g, "\\.")}\\s*\\{([\\s\\S]*?)\\}`);
  const m = css.match(re);
  if (!m) throw new Error(`Could not find ${selector} block in custom.css`);
  return m[1];
}

function extractProp(block, name) {
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

test("hero name is solid text: --vp-home-hero-name-background carries no gradient", async () => {
  const css = await read("website/.vitepress/theme/custom.css");
  const rootBlock = extractBlock(css, ":root");
  const heroNameBackground = extractProp(rootBlock, "vp-home-hero-name-background");

  assert.ok(heroNameBackground, "--vp-home-hero-name-background must be set in :root");
  assert.equal(
    heroNameBackground,
    "transparent",
    "the hero name is essential copy per DESIGN.md's own rule (gradients are decorative " +
      "accents, not text backgrounds for essential copy) -- it must not carry a gradient " +
      `background-clip fill; got ${JSON.stringify(heroNameBackground)}`,
  );
});

test("hero name text color clears WCAG AA (4.5:1) against the page background in both themes", async () => {
  const css = await read("website/.vitepress/theme/custom.css");
  const rootBlock = extractBlock(css, ":root");
  const darkBlock = extractBlock(css, ".dark");

  const heroNameColor = extractProp(rootBlock, "vp-home-hero-name-color");
  assert.ok(heroNameColor, "--vp-home-hero-name-color must be set in :root");

  // Resolve the var() indirection to the token it actually points at, then read that
  // token's light/dark hex values so both themes are checked with real numbers.
  const varMatch = /^var\(--([\w-]+)\)$/.exec(heroNameColor);
  assert.ok(
    varMatch,
    `expected --vp-home-hero-name-color to reference a theme-aware brand token via var(), ` +
      `got ${JSON.stringify(heroNameColor)}`,
  );
  const tokenName = varMatch[1];

  const lightHex = extractProp(rootBlock, tokenName);
  const darkHex = extractProp(darkBlock, tokenName) ?? lightHex;
  assert.ok(lightHex, `:root must define --${tokenName}`);

  const lightRatio = contrastRatio(lightHex, LIGHT_PAGE_BG);
  const darkRatio = contrastRatio(darkHex, DARK_PAGE_BG);

  assert.ok(
    lightRatio >= AA_NORMAL_TEXT_RATIO,
    `light theme hero name (${lightHex} on ${LIGHT_PAGE_BG}) measures ${lightRatio.toFixed(2)}:1, ` +
      `below the ${AA_NORMAL_TEXT_RATIO}:1 AA floor`,
  );
  assert.ok(
    darkRatio >= AA_NORMAL_TEXT_RATIO,
    `dark theme hero name (${darkHex} on ${DARK_PAGE_BG}) measures ${darkRatio.toFixed(2)}:1, ` +
      `below the ${AA_NORMAL_TEXT_RATIO}:1 AA floor`,
  );
});

test("DESIGN.md's token table matches the shipped custom.css brand tokens", async () => {
  const css = await read("website/.vitepress/theme/custom.css");
  const design = await read("DESIGN.md");
  const rootBlock = extractBlock(css, ":root");
  const darkBlock = extractBlock(css, ".dark");

  const cssBrand1Light = extractProp(rootBlock, "vp-c-brand-1");
  const cssBrand1Dark = extractProp(darkBlock, "vp-c-brand-1");

  const row = design
    .split("\n")
    .find((line) => line.startsWith("| Brand primary"));
  assert.ok(row, "DESIGN.md must have a 'Brand primary' token row");

  assert.ok(
    row.includes(`\`${cssBrand1Light}\``),
    `DESIGN.md's Brand primary row must cite the shipped light value ${cssBrand1Light}; got: ${row}`,
  );
  assert.ok(
    row.includes(`\`${cssBrand1Dark}\``),
    `DESIGN.md's Brand primary row must cite the shipped dark value ${cssBrand1Dark}; got: ${row}`,
  );
  assert.ok(
    row.includes("hero name"),
    "DESIGN.md's Brand primary row must document that this token now carries the hero name text",
  );

  const gradientRow = design
    .split("\n")
    .find((line) => line.startsWith("| Gradient partner"));
  assert.ok(gradientRow, "DESIGN.md must have a 'Gradient partner' token row");
  assert.ok(
    !gradientRow.toLowerCase().includes("hero-name"),
    `DESIGN.md must not claim the gradient partner token still feeds the hero-name gradient; got: ${gradientRow}`,
  );
});
