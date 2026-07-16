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
  assert.equal(hash.digest("hex"), "6ed598acff708439473ad4051707333ab5baa67f276c9e7c5f3b4483eed4e38c");
});
