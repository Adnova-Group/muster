// The Claude plugin ships a bundled CLI runtime (plugin/runtime/cli/, scripts/build-plugin-runtime.mjs)
// so an installed plugin runs one `node` start per CLI call instead of an npx resolution. The tree
// is committed with the commands that call it, so it must never go stale silently: this file
// rebuilds it in memory and fails on any byte that differs from the committed copy.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkPluginRuntime, PLUGIN_RUNTIME_DIR } from "../scripts/build-plugin-runtime.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUNTIME = path.join(ROOT, PLUGIN_RUNTIME_DIR);
const json = (file) => JSON.parse(readFileSync(file, "utf8"));

test("plugin/runtime/cli matches a fresh build of its sources byte for byte", async () => {
  const { ok, stale } = await checkPluginRuntime(ROOT);
  assert.ok(ok, `plugin/runtime/cli is stale (${stale.join(", ")}): run \`npm run build:plugin\` and commit the result`);
});

test("the bundled runtime carries the package and plugin version and its source digest", () => {
  const runtime = json(path.join(RUNTIME, "package.json"));
  assert.equal(runtime.version, json(path.join(ROOT, "package.json")).version);
  assert.equal(runtime.version, json(path.join(ROOT, "plugin", ".claude-plugin", "plugin.json")).version);
  assert.match(runtime.sourceDigest, /^[0-9a-f]{64}$/);
  const head = readFileSync(path.join(RUNTIME, "bin", "muster.mjs"), "utf8").split("\n", 3);
  assert.equal(head[0], "#!/usr/bin/env node");
  assert.ok(head[1].includes(`muster ${runtime.version} plugin runtime`), "banner names the version");
  assert.ok(head[1].includes(`sha256:${runtime.sourceDigest}`), "banner carries the same source digest");
});
