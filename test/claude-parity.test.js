import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

const root = new URL("../", import.meta.url).pathname;
// This is the 0.4.1 Claude surface, intentionally excluding release-version
// manifests. Codex work must not mutate Claude commands, skills (including
// builtins), agents, hooks, catalogs, pipelines, or the shared Cowork MCP
// definition.
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
  // Pin re-derived for the muster-performance-pass item: an INTENTIONAL edit to this same
  // Claude surface (go.md/go-backlog.md/orchestrator/review-gate/router SKILL.md -- CLI
  // resolution + gate-cadence fast path, see docs/performance-pass.md), not the accidental
  // Codex-side drift this guard exists to catch. File count is unchanged (136); only content.
  assert.equal(hash.digest("hex"), "b35cae37ae8377bce8e0b0370bb6f4b84a2dd007b7aaa9b17800137c6da3de52");
});
