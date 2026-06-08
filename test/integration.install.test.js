import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { runInstall } from "../src/install.js";

const REPO = fileURLToPath(new URL("../", import.meta.url));

test("runInstall puts the output style under ~/.claude and returns next steps", async () => {
  const home = await mkdtemp(join(tmpdir(), "muster-install-"));
  const r = await runInstall({ home, repoRoot: REPO });
  assert.equal(r.style.action, "copied");
  const installed = await readFile(join(home, ".claude/output-styles/muster.md"), "utf8");
  const source = await readFile(join(REPO, "output-styles/muster.md"), "utf8");
  assert.equal(installed, source, "installed style must match the repo's output style");
  // next steps must cover both the style enable and the plugin registration
  assert.ok(r.nextSteps.some(s => /\/output-style muster/.test(s)), "must tell the user to enable the style");
  assert.ok(r.nextSteps.some(s => /\/plugin install/.test(s)), "must tell the user to install the plugin");
});

test("choice points are wired to the AskUserQuestion selection UI", async () => {
  const run = await readFile(new URL("../plugin/commands/run.md", import.meta.url), "utf8");
  assert.match(run, /AskUserQuestion/, "run approval must use the AskUserQuestion UI");
  const auto = await readFile(new URL("../plugin/commands/autopilot.md", import.meta.url), "utf8");
  assert.match(auto, /AskUserQuestion/, "autopilot merge decision must use the AskUserQuestion UI");
});

test("README documents installing muster", async () => {
  const readme = await readFile(new URL("../README.md", import.meta.url), "utf8");
  assert.match(readme, /Installing muster/, "README must have an install section");
  assert.match(readme, /muster install/, "README must show the install command");
});
