import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

const execFileP = promisify(execFile);
const root = dirname(dirname(fileURLToPath(import.meta.url)));
const cli = join(root, "src/cli.js");
const run = (args, cwd = root) => execFileP(process.execPath, [cli, ...args], { cwd });
const DESIGN = "# Product Design\n\n## Direction\nClear and useful.\n";

test("cli wire: design exposes utilities and exactly 23 workflows", async () => {
  const workflows = JSON.parse((await run(["design", "workflows"])).stdout);
  assert.equal(workflows.workflows.length, 23);
  assert.equal(workflows.source.ref, "32930818a109fafa87199babe92fa8e530cff5d3");
  assert.match((await run(["help", "design"])).stdout, /design <init\|status\|resolve\|detect\|ignores\|provider\|gate\|workflows\|run>/);
});

test("cli wire: attended design init holds, then creates without silent overwrite", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-design-cli-"));
  const hold = JSON.parse((await run(["design", "init", cwd])).stdout);
  assert.equal(hold.status, "HUMAN-HOLD");
  const content = join(cwd, "design-answer.md");
  await writeFile(content, DESIGN);
  const created = JSON.parse((await run(["design", "init", cwd, "--content-file", content])).stdout);
  assert.equal(created.status, "created");
  await writeFile(content, DESIGN.replace("useful", "loud"));
  const existing = JSON.parse((await run(["design", "init", cwd, "--content-file", content])).stdout);
  assert.equal(existing.status, "exists");
  assert.equal(await readFile(join(cwd, "DESIGN.md"), "utf8"), DESIGN);
});

test("cli wire: design resolve/status/gate and workflow packets carry the same digest", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-design-cli-"));
  await writeFile(join(cwd, "DESIGN.md"), DESIGN);
  const resolved = JSON.parse((await run(["design", "resolve", cwd])).stdout);
  const status = JSON.parse((await run(["design", "status", cwd])).stdout);
  const gate = JSON.parse((await run(["design", "gate", cwd, "--outcome", "build responsive UI"])).stdout);
  const workflow = JSON.parse((await run(["design", "polish", cwd, "--target", "src/App.tsx"])).stdout);
  assert.equal(status.receipt.digest, gate.receipt.digest);
  assert.equal(status.receipt.digest, workflow.context.digest);
  assert.equal(resolved.designPath, join(cwd, "DESIGN.md"));
});

test("cli wire: provider install/check is internal and ignores are deterministic", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-design-cli-"));
  const installed = JSON.parse((await run(["design", "provider", "install", cwd])).stdout);
  assert.equal(installed.internal.installed, true);
  const checked = JSON.parse((await run(["design", "provider", "check", cwd])).stdout);
  assert.equal(checked.internal.source.license, "Apache-2.0");
  await run(["design", "ignores", cwd, "--add", "vendor/**"]);
  const ignores = JSON.parse((await run(["design", "ignores", cwd])).stdout);
  assert.deepEqual(ignores.ignores, ["vendor/**"]);
});

test("cli wire: audit-design-ux is conditional on evidence inside the audited scope", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "muster-design-audit-"));
  await writeFile(join(cwd, "package.json"), '{"name":"audit-fixture"}');
  await mkdir(join(cwd, "backend"));
  await writeFile(join(cwd, "backend/index.js"), "export const value = 1;\n");
  await mkdir(join(cwd, "ui"));
  await writeFile(join(cwd, "ui/App.tsx"), "export const App = () => <main>Hello</main>;\n");

  const backend = JSON.parse((await run(["audit", "backend"], cwd)).stdout);
  assert.ok(!backend.plan.some((task) => task.id === "audit-design-ux"));
  const ui = JSON.parse((await run(["audit", "ui"], cwd)).stdout);
  assert.ok(ui.plan.some((task) => task.id === "audit-design-ux"));
});
