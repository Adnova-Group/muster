import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "../src/install.js";

const REPO = fileURLToPath(new URL("../", import.meta.url));

test("runInstall surfaces plugin registration without mutating ~/.claude", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-install-"));
  const r = await runInstall({ home, repoRoot: REPO });
  // The style ships in the plugin (force-for-plugin), so install copies nothing.
  assert.equal(r.outputStyle.source, "plugin");
  assert.equal(r.outputStyle.autoApplied, true);
  assert.deepEqual(await readdir(home), [], "install must not write under ~/.claude");
  // next steps cover plugin registration, and never the removed /output-style command
  assert.ok(r.nextSteps.some(s => /\/plugin install/.test(s)), "must tell the user to install the plugin");
  assert.ok(!r.nextSteps.some(s => /\/output-style/.test(s)), "must not reference the removed /output-style command");
});

test("the plugin ships the output style with force-for-plugin auto-apply", async () => {
  const style = await readFile(new URL("../plugin/output-styles/muster.md", import.meta.url), "utf8");
  assert.match(style, /force-for-plugin:\s*true/, "plugin style must auto-apply when enabled");
});

test("choice points are wired to the AskUserQuestion selection UI", async () => {
  // plan.md/go.md are the canonical homes now (run.md/autopilot.md are legacy alias
  // stubs — see the alias-shape/alias-guidance checks in test/mode-evals.test.js).
  const plan = await readFile(new URL("../plugin/commands/plan.md", import.meta.url), "utf8");
  assert.match(plan, /AskUserQuestion/, "plan approval must use the AskUserQuestion UI");
  const go = await readFile(new URL("../plugin/commands/go.md", import.meta.url), "utf8");
  assert.match(go, /AskUserQuestion/, "go merge decision must use the AskUserQuestion UI");
});

test("README documents installing muster", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /muster install/, "README quickstart must show the install command");
});
