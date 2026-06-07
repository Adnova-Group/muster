import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";
import { readInstalled } from "../src/harness.js";

test("reads plugin ids from installed_plugins.json", async () => {
  const home = await tmpProject({
    ".claude/plugins/installed_plugins.json": {
      version: 2, plugins: { "superpowers@official": [{}], "serena@official": [{}] }
    }
  });
  const r = await readInstalled(home);
  assert.deepEqual(r.plugins.sort(), ["serena", "superpowers"]);
});

test("missing files degrade to empty, never throw", async () => {
  const home = await tmpProject({});
  const r = await readInstalled(home);
  assert.deepEqual(r, { plugins: [], skills: [], mcpServers: [] });
});

test("reads mcp servers from settings", async () => {
  const home = await tmpProject({
    ".claude/settings.json": { mcpServers: { serena: {}, context7: {} } }
  });
  const r = await readInstalled(home);
  assert.deepEqual(r.mcpServers.sort(), ["context7", "serena"]);
});
