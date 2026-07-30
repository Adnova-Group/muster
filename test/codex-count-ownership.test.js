import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot } from "../test-support/codex-helpers.js";

test("Codex bundle counts belong to inventory, not the model adapter", async () => {
  const [adapter, inventory, check, doctor] = await Promise.all([
    readFile(join(repoRoot, "src", "codex.js"), "utf8"),
    readFile(join(repoRoot, "src", "codex-inventory.js"), "utf8"),
    readFile(join(repoRoot, "scripts", "check-codex.mjs"), "utf8"),
    readFile(join(repoRoot, "src", "codex-doctor.js"), "utf8")
  ]);

  assert.doesNotMatch(adapter, /\bCODEX_COUNTS\b/);
  assert.match(inventory, /export const CODEX_COUNTS = Object\.freeze\(/);
  assert.match(check, /import \{ CODEX_COUNTS \} from "\.\.\/src\/codex-inventory\.js";/);
  assert.match(doctor, /import \{ CODEX_COUNTS, codexAvailable, readCodexInventory \} from "\.\/codex-inventory\.js";/);
});
