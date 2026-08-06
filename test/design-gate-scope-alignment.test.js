/**
 * Regression test for the design-gate scope alignment fix (2026-08-04 design-ux audit, P2):
 * DESIGN.md's own prose used to declare "This file is the canonical design context for Muster's
 * public documentation website... It governs `website/**`", but `design status .` / `design gate
 * . --outcome "..."` resolved `scopeRoot` at the repository root with no restriction -- a
 * qualifying human-facing outcome anywhere in the repo passed the gate under a file that
 * textually disclaimed authority there. See docs/decisions/design-gate-scope-alignment.md for the
 * full call-site evidence behind the resolution: DESIGN.md's prose was widened to match the
 * gate's actual (and, per docs/design.md, intentionally documented) non-monorepo behavior of
 * inheriting the root file repo-wide, rather than narrowing the machinery.
 *
 * This test pins the agreement both ways: it fails if the prose ever claims a scope narrower
 * than what the gate resolves (the original bug), and it fails if the gate is ever narrowed while
 * the prose still claims repo-wide authority (a regression on the alternative fix).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { designGate, designStatus, resolveDesignContext } from "../src/design.js";

const repoRoot = join(import.meta.dirname, "..");

// Parses DESIGN.md's own governs declaration into a scope claim: either explicit repo-wide
// authority (the "entire human-facing surface" phrase from the widened prose) or a narrower
// `` governs `dir/**` `` glob (the original, pre-fix prose shape).
function declaredGovernsScope(text) {
  if (/entire human-facing surface/i.test(text)) return { kind: "repo" };
  const m = /governs\s+`([^`]+)`/.exec(text);
  if (m) return { kind: "dir", dir: m[1].replace(/\/\*\*$/, "").replace(/\/+$/, "") };
  throw new Error("DESIGN.md's governs clause could not be parsed into a scope claim");
}

test("DESIGN.md's declared governs scope agrees with the design gate's resolved scopeRoot", async () => {
  const designText = await readFile(join(repoRoot, "DESIGN.md"), "utf8");
  const declared = declaredGovernsScope(designText);

  const context = await resolveDesignContext(repoRoot);
  const status = await designStatus(repoRoot);
  const gate = await designGate(repoRoot, { outcome: "improve the responsive layout" });

  if (declared.kind === "repo") {
    assert.equal(
      context.scopeRoot,
      context.repoRoot,
      "DESIGN.md declares repo-wide governance, but design gate resolved a narrower scopeRoot",
    );
  } else {
    const declaredRoot = join(context.repoRoot, declared.dir);
    assert.notEqual(
      context.scopeRoot,
      context.repoRoot,
      `DESIGN.md declares narrower governance (\`${declared.dir}/**\`) but design gate resolved the ` +
        "repo root -- a qualifying outcome anywhere in the repository would pass under a file that " +
        "textually disclaims authority there",
    );
    assert.equal(
      context.scopeRoot,
      declaredRoot,
      `resolved scopeRoot ${context.scopeRoot} must stay inside the declared \`${declared.dir}\` scope`,
    );
  }

  assert.equal(status.receipt.scopeRoot, context.scopeRoot);
  assert.equal(gate.receipt.scopeRoot, context.scopeRoot);
});
