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
  assert.equal(paths.length, 136);
  // Pin re-derived at the feat/codex-integration merge of the muster-performance-pass item:
  // INTENTIONAL edits to this same Claude surface (go.md/go-backlog.md/orchestrator/review-gate/
  // router SKILL.md -- CLI resolution + gate-cadence fast path, see docs/performance-pass.md --
  // plus the burn-hygiene and audit-hardening shared-surface remediations merged before it),
  // not the accidental Codex-side drift this guard exists to catch. File count unchanged (136).
  assert.equal(hash.digest("hex"), "a832dfafaf9694f309b6d2fd2affd2485034b271a10307682d050b92d5e68ba5");
});
