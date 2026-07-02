// hook-guidance-selfcontained.test.js — ARCH guard
//
// cowork imports plugin/hooks/guidance.js and relies (unenforced) on it
// importing only node: specifiers. This test makes that invariant explicit and
// machine-checked: if a future change adds a bare package or a ./ sibling
// import it will break this test before it breaks the cowork integration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const GUIDANCE = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "plugin",
  "hooks",
  "guidance.js",
);

test("guidance.js: every import specifier starts with 'node:' (no ./ siblings, no bare packages)", () => {
  const src = readFileSync(GUIDANCE, "utf8");

  // Match all static import declarations: `import ... from "..."` / `import ... from '...'`
  // Also matches dynamic `import("...")` / `import('...')` in case any are added.
  const staticRe = /^\s*import\s+.*?\s+from\s+['"]([^'"]+)['"]/gm;
  const dynamicRe = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

  const specifiers = [];
  let m;
  while ((m = staticRe.exec(src)) !== null) specifiers.push(m[1]);
  while ((m = dynamicRe.exec(src)) !== null) specifiers.push(m[1]);

  assert.ok(
    specifiers.length > 0,
    "guidance.js must have at least one import for this guard to be meaningful",
  );

  for (const s of specifiers) {
    assert.ok(
      s.startsWith("node:"),
      `import specifier "${s}" must start with "node:" — guidance.js must be node:-only (cowork depends on this invariant)`,
    );
  }
});
