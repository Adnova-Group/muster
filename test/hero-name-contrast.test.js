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
 * -- no browser, no build step -- so a future regression fails loudly here. Two
 * regression paths were proven by mutation during review and are guarded explicitly
 * below rather than left to the happy-path :root read alone: (a) a hardcoded
 * `background-clip`/`-webkit-text-fill-color` rule added elsewhere in the file,
 * bypassing the custom properties entirely, and (b) the gradient being reintroduced
 * only inside the `.dark` block, which a :root-only read would miss.
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

// Pulls the body out of a single `<selector> { ... }` block (e.g. `:root` or `.dark`),
// walking brace depth from the block's own opening brace so a `}` from a later block
// -- or a nested rule, should one ever appear here -- can never truncate the match.
// The lookaround around the selector keeps a bare ".dark" from matching inside some
// future ".dark-mode"-style selector.
function extractBlock(css, selector) {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const headerRe = new RegExp(`(?<![\\w-])${escaped}(?![\\w-])\\s*\\{`);
  const header = headerRe.exec(css);
  if (!header) throw new Error(`Could not find ${selector} block in custom.css`);

  const openBraceIndex = header.index + header[0].length - 1;
  let depth = 0;
  let i = openBraceIndex;
  for (; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0) throw new Error(`Unbalanced braces reading ${selector} block in custom.css`);
  return css.slice(openBraceIndex + 1, i);
}

function extractProp(block, name) {
  const re = new RegExp(`--${name}:\\s*([^;]+);`);
  const m = block.match(re);
  return m ? m[1].trim() : null;
}

// Fails if `block` (":root", ".dark", ...) overrides the hero-name tokens with
// anything that could reintroduce the gradient -- a literal background other than
// "transparent", or a color that isn't a var() reference to a theme-aware token.
function assertNoGradientOverride(block, blockLabel) {
  const bg = extractProp(block, "vp-home-hero-name-background");
  if (bg !== null) {
    assert.equal(
      bg,
      "transparent",
      `${blockLabel} overrides --vp-home-hero-name-background with a non-transparent value ` +
        `(possible reintroduced gradient): ${JSON.stringify(bg)}`,
    );
  }

  const color = extractProp(block, "vp-home-hero-name-color");
  if (color !== null) {
    assert.ok(
      /^var\(--[\w-]+\)$/.test(color),
      `${blockLabel} overrides --vp-home-hero-name-color with a literal value instead of a ` +
        `theme-aware var() reference: ${JSON.stringify(color)}`,
    );
  }
}

test("hero name is solid text: no gradient anywhere it could paint the hero name", async () => {
  const css = await read("website/.vitepress/theme/custom.css");

  // Whole-file guard: the fix relies on VitePress's built-in `.clip` rule reading our
  // (now transparent) custom properties, never on a hand-rolled clip-text rule in this
  // file. If one ever gets added here it bypasses every token-level check below, so
  // rule it out directly.
  assert.ok(
    !/background-clip\s*:/i.test(css),
    "custom.css must not define its own background-clip rule -- the hero name must stay " +
      "solid text painted through VitePress's default --vp-home-hero-name-* tokens",
  );
  assert.ok(
    !/-webkit-text-fill-color\s*:\s*transparent/i.test(css),
    "custom.css must not force -webkit-text-fill-color: transparent anywhere -- that is the " +
      "clip-text mechanism the original gradient-on-hero-name bug depended on",
  );

  const rootBlock = extractBlock(css, ":root");
  const darkBlock = extractBlock(css, ".dark");
  assertNoGradientOverride(rootBlock, ":root");
  assertNoGradientOverride(darkBlock, ".dark");

  assert.equal(
    extractProp(rootBlock, "vp-home-hero-name-background"),
    "transparent",
    "--vp-home-hero-name-background must be explicitly set to transparent in :root",
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

  // DESIGN.md cites these exact numbers in its Color-section prose; keep the doc's
  // claim from silently drifting away from what the shipped tokens actually compute to.
  const design = await read("DESIGN.md");
  const cited = /(\d\.\d{2}):1 light, (\d\.\d{2}):1 dark/.exec(design);
  assert.ok(cited, "DESIGN.md must cite the hero-name contrast ratios as 'X.XX:1 light, Y.YY:1 dark'");
  assert.equal(
    cited[1],
    lightRatio.toFixed(2),
    `DESIGN.md cites ${cited[1]}:1 for light theme but the shipped tokens compute to ${lightRatio.toFixed(2)}:1`,
  );
  assert.equal(
    cited[2],
    darkRatio.toFixed(2),
    `DESIGN.md cites ${cited[2]}:1 for dark theme but the shipped tokens compute to ${darkRatio.toFixed(2)}:1`,
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
