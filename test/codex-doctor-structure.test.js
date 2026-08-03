import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexDoctor } from "../src/codex-doctor.js";

const doctorSourceUrl = new URL("../src/codex-doctor.js", import.meta.url);
const expectedPhases = [
  "initializeDoctorRun",
  "addPluginTreeChecks",
  "addScopeConfigChecks",
  "addHandshakeAndInstallChecks",
  "createHookInspectionState",
  "inspectHookScope",
  "inspectHookScopes",
  "addHookHealthChecks",
  "addHookTrustCheck",
  "addPluginCacheAndInventoryChecks",
  "runCodexDoctor"
];

// Mutant-kill receipt (2026-08-03): add 13 padding lines to inspectHookScope,
// then run this file. The guard failed with `inspectHookScope spans 151 lines;
// maximum is 150` (2 pass, 1 fail). Removing the padding produced 3 pass /
// 0 fail. `sha256sum src/codex-doctor.js` was byte-identical before and after:
// 25fee5a32f61268f1e9e0a940139bf5361fd0efb46f1bbc937d43fdf39dbad8a.

test("Codex doctor stays decomposed into named phases of at most 150 lines", async () => {
  const source = await readFile(doctorSourceUrl, "utf8");
  const starts = [...source.matchAll(/^(?:export )?async function ([A-Za-z0-9_]+)\(|^function ([A-Za-z0-9_]+)\(/gm)]
    .map(match => ({ name: match[1] || match[2], line: source.slice(0, match.index).split("\n").length }))
    .filter(entry => expectedPhases.includes(entry.name));

  assert.deepEqual(starts.map(entry => entry.name), expectedPhases);
  for (let index = 0; index < starts.length; index++) {
    const end = starts[index + 1]?.line ?? source.split("\n").length + 1;
    assert.ok(end - starts[index].line <= 150,
      `${starts[index].name} spans ${end - starts[index].line} lines; maximum is 150`);
  }
});

test("runCodexDoctor is an orchestration-only phase", async () => {
  const source = await readFile(doctorSourceUrl, "utf8");
  const body = source.slice(source.indexOf("export async function runCodexDoctor"));
  for (const phase of expectedPhases.filter(phase => phase !== "inspectHookScope").slice(0, -1)) {
    assert.match(body, new RegExp(`\\b${phase}\\(`), `runCodexDoctor must call ${phase}`);
  }
});

test("decomposed doctor phases preserve the public check ordering", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "muster-doctor-phases-"));
  const cwd = join(fixture, "project");
  const codexHome = join(fixture, "home", ".codex");
  await mkdir(cwd, { recursive: true });
  const absent = async () => { throw new Error("codex absent in focused phase test"); };
  const report = await runCodexDoctor({
    root: new URL("../", import.meta.url), cwd, codexHome, execFile: absent,
    mcpRunner: async () => ({ initialized: true, tools: [], toolCallOk: true })
  });

  assert.deepEqual(report.checks.map(check => check.name), [
    "codex-cli",
    "codex-config-retirements",
    "codex-path-shadow",
    "codex-plugin",
    "codex-agents",
    "codex-runtime",
    "codex-managed-scopes",
    "codex-thread-limits",
    "codex-hook-state",
    "codex-mcp-handshake",
    "codex-install-generation",
    "codex-hooks",
    "codex-hooks-overlap",
    "codex-hook-interpreter",
    "codex-hook-trust",
    "codex-plugin-cache-hooks",
    "codex-policy-limitations"
  ]);
});
