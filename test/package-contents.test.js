// What the npm package ships (docs/ship-checklist.md, "Package inspection"). Maintainer-only data
// stays in the source checkout: the vendor/upstream/ base copies (3-way merge bases, ~5.5 MB),
// the build/test/probe scripts the runtime never imports, and the test, eval and docs trees.
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCb);
const root = fileURLToPath(new URL("../", import.meta.url));
// Measured 15.6 MB unpacked (1,195 files) after vendor/upstream/ left the package (21.3 MB and
// 1,778 files before). The ceiling keeps ~9% headroom; raising it is a reviewed decision.
const UNPACKED_CEILING = 17_000_000;
// Imported at install time (build-codex, check-codex via src/codex-install.js) or run by users
// from the package (the Cowork and ChatGPT Work probes, documented in cowork/README.md and
// website/guides/chatgpt-work.md).
const SHIPPED_SCRIPTS = ["scripts/build-codex.mjs", "scripts/chatgpt-work-native-probe.mjs", "scripts/check-codex.mjs", "scripts/cowork-probe.mjs"];

test("the npm package ships runtime files only and stays under its size ceiling", async () => {
  const { stdout } = await execFile("npm", ["pack", "--dry-run", "--json"], { cwd: root, maxBuffer: 8 * 1024 * 1024 });
  const [packed] = JSON.parse(stdout);
  const paths = packed.files.map(f => f.path);
  assert.deepEqual(paths.filter(p => p.startsWith("vendor/")).sort(), ["vendor/impeccable.json", "vendor/manifest.yaml"], "no vendor/upstream/ base copies, no vendor/reports/");
  assert.deepEqual(paths.filter(p => p.startsWith("scripts/")).sort(), SHIPPED_SCRIPTS);
  // Running the suite leaves uupm's search.py bytecode beside it; .gitignore does not apply to `files`.
  assert.deepEqual(paths.filter(p => /(^|\/)__pycache__\/|\.pyc$/.test(p)), [], "no Python bytecode");
  for (const dir of ["test/", "test-support/", "eval/", "docs/", "website/", ".github/"])
    assert.ok(!paths.some(p => p.startsWith(dir)), `${dir} is maintainer-only`);
  for (const p of ["src/cli.js", "src/upstream-watch.js", "plugin/runtime/cli/bin/muster.mjs", "codex/frozen/agents/muster-runner.md", "codex/skill-assets", "vendor/manifest.yaml"])
    assert.ok(paths.some(q => q === p || q.startsWith(`${p}/`)), `${p} is needed at runtime or install time`);
  assert.ok(packed.unpackedSize <= UNPACKED_CEILING, `unpacked ${packed.unpackedSize} bytes, over the ${UNPACKED_CEILING}-byte ceiling`);
});
