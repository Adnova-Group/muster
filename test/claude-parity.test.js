import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url).pathname;
// This is the audited 0.5.0 Claude surface, intentionally excluding
// release-version manifests. Codex-only work must not mutate Claude commands,
// skills (including builtins), agents, hooks, catalogs, pipelines, or the
// shared Cowork MCP definition. Update this pin only with separately reviewed
// shared-surface remediation.
const claudeSurface = [
  "plugin/agents",
  "plugin/builtins",
  "plugin/commands",
  "plugin/hooks",
  "plugin/skills",
  "cowork/mcp-server.mjs",
  "catalog",
  "pipelines"
];

async function files(path) {
  try {
    const entries = await readdir(join(root, path), { withFileTypes: true });
    return (await Promise.all(entries.map(entry => files(join(path, entry.name))))).flat();
  } catch {
    return [path];
  }
}

test("Claude orchestration surface remains byte-identical outside release metadata", async () => {
  const paths = (await Promise.all(claudeSurface.map(files))).flat().sort();
  const hash = createHash("sha256");
  for (const path of paths) {
    hash.update(path);
    hash.update("\0");
    hash.update(await readFile(join(root, path)));
    hash.update("\0");
  }
  assert.equal(paths.length, 135);
  // Pin re-derived at the reconcile/codex-to-main merge (feat/codex-integration -> main):
  // INTENTIONAL shared-surface changes from unifying main's enforcement-model redesign with the
  // Codex + performance-pass work -- main removed plugin/hooks/todo-gate.js entirely (136 -> 135
  // files, see CHANGELOG "Removed (breaking)") and rewrote the orchestrator/pre-tool-use
  // enforcement prose to the one-hard-deny + border-invitation model, on top of the Codex
  // performance-pass edits (go.md/go-backlog.md/orchestrator/review-gate/router SKILL.md -- CLI
  // resolution + gate-cadence fast path, see docs/performance-pass.md). This is the reviewed
  // reconciliation, not the accidental Codex-side drift this guard exists to catch.
  assert.equal(hash.digest("hex"), "0a5351ad6847ce8dd84260c0126e76f1d6d909fb35cde5dcfa208698a7a97c1d");
});
