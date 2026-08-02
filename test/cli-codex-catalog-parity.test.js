// Parity pin for the single-sourced catalog resolution in src/cli.js
// (loadEffectiveCatalog): every branch that resolves the catalog+inventory pair
// -- `capabilities`, `match --skills`, `match`, and `manifest validate` -- must
// apply the SAME --codex adaptation (codex inventory swap + adaptCatalogForCodex).
// The diagnose/audit consumers of resolveModeCapabilities are pinned separately
// by test/codex-mode-seed.test.js; this file pins the other three branches plus
// capabilities against one shared probe signal each.
//
// Probe signals:
//  - an exact runtime skill (zz-codex-probe) visible ONLY via Codex app-server's
//    skills/list inventory -- capabilities/match --skills/manifest
//    validate must see it with --codex and not without;
//  - the gsd-* -> muster-gsd-* id rewrite adaptCatalogForCodex applies --
//    `match` must emit the renamed id with --codex and the raw id without.
// Both signals are environment-independent: HOME points at an empty temp dir
// and a fake `codex` binary on PATH implements the app-server + MCP protocol.

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;
const cli = join(repoRoot, "src", "cli.js");
const PROBE_SKILL = "zz-codex-probe";

async function setup(t) {
  const project = await mkdtemp(join(tmpdir(), "muster-codex-catalog-parity-"));
  t.after(() => rm(project, { recursive: true, force: true }));
  const home = join(project, "home");
  const bin = join(project, "bin");
  await mkdir(bin, { recursive: true });
  const fakeCodex = join(bin, "codex");
  await writeFile(fakeCodex, `#!${process.execPath}
const command = process.argv[2];
if (command === "app-server") {
  const { createInterface } = require("node:readline");
  let initialized = false;
  createInterface({ input: process.stdin }).on("line", line => {
    const message = JSON.parse(line);
    if (message.method === "initialized") { initialized = true; return; }
    if (message.method !== "initialize" && !initialized) {
      process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32000, message: "Not initialized" } }) + "\\n");
      return;
    }
    let result = {};
    if (message.method === "skills/list") result = { data: [{ cwd: process.env.CODEX_FAKE_WRONG_CWD || message.params.cwds[0], skills: [
      { name: "${PROBE_SKILL}", description: "codex-only probe skill", enabled: true, path: null },
      { name: "disabled-probe", description: "must stay hidden", enabled: false, path: null }
    ], errors: [] }] };
    if (message.method === "plugin/list") result = { marketplaces: [{ name: "remote", plugins: [
      { name: "supabase", id: "supabase@remote", remotePluginId: "plugin_supabase", installed: true, enabled: true, source: { type: "remote" } },
      { name: "disabled", id: "disabled@remote", remotePluginId: "plugin_disabled", installed: true, enabled: false, availability: "AVAILABLE", source: { type: "remote" } },
      { name: "blocked", id: "blocked@remote", remotePluginId: "plugin_blocked", installed: true, enabled: true, availability: "DISABLED_BY_ADMIN", source: { type: "remote" } }
    ] }], marketplaceLoadErrors: [], featuredPluginIds: [] };
    if (message.method === "plugin/read" && ["plugin_supabase", "plugin_blocked"].includes(message.params.pluginName)) result = { plugin: { skills: [
      { name: "supabase", description: "runtime remote skill", enabled: true, path: null },
      { name: "hidden", description: "disabled remote skill", enabled: false, path: null }
    ] } };
    process.stdout.write(JSON.stringify({ id: message.id, result }) + "\\n");
  });
} else {
  console.log("[]");
}
`);
  await chmod(fakeCodex, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: `${bin}:${process.env.PATH || ""}`,
  };
  const run = async (args, extraEnv = {}) =>
    JSON.parse((await execFile(process.execPath, [cli, ...args], {
      cwd: project, env: { ...env, ...extraEnv }, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    })).stdout);
  const runFailure = async (args) => {
    try { await run(args); }
    catch (error) { return JSON.parse(error.stdout); }
    assert.fail("expected command to fail");
  };
  return { project, run, runFailure };
}

function manifestBindingProbeSkill() {
  return JSON.stringify({
    outcome: "Add rate limiting",
    successCriteria: ["429 past N req/min", "tests green"],
    crew: [{ stage: "navigate", provider: "grep", source: "builtin", model: "sonnet", rationale: "no LSP", evidence: "no serena", fallback: "inline" }],
    recommendations: [], degradations: [],
    plan: [{ id: "t1", task: "middleware", mode: "single",
      skills: [{ id: PROBE_SKILL, rationale: "r" }] }],
  });
}

test("capabilities --codex and match --skills --codex resolve the same codex-only skill inventory", async (t) => {
  const { run } = await setup(t);
  const [capsCodex, capsPlain, skillsCodex, skillsPlain] = await Promise.all([
    run(["capabilities", "--codex"]),
    run(["capabilities"]),
    run(["match", "--skills", "zz codex probe", "--codex"]),
    run(["match", "--skills", "zz codex probe"]),
  ]);
  assert.ok(capsCodex.skills.some(s => s.id === PROBE_SKILL), "capabilities --codex must list the codex-only skill");
  assert.ok(!capsPlain.skills.some(s => s.id === PROBE_SKILL), "capabilities without --codex must not list it");
  assert.ok(skillsCodex.ranked.some(s => s.id === PROBE_SKILL), "match --skills --codex must rank the codex-only skill");
  assert.ok(!skillsPlain.ranked.some(s => s.id === PROBE_SKILL), "match --skills without --codex must not rank it");
  assert.ok(!capsCodex.skills.some(s => s.id.startsWith("blocked:")), "admin-disabled plugin skills must stay hidden");
});

test("Codex inventory fails incomplete instead of adopting a different cwd row", async (t) => {
  const { run } = await setup(t);
  const caps = await run(["capabilities", "--codex"], { CODEX_FAKE_WRONG_CWD: "/unrelated" });
  assert.equal(caps.installedRaw.skillInventory.complete, false);
  assert.ok(!caps.skills.some(skill => skill.id === PROBE_SKILL));
});

test("match applies the same gsd-* id rewrite as the shared codex adaptation", async (t) => {
  const { run } = await setup(t);
  const [codex, plain] = await Promise.all([
    run(["match", "gsd plan phase", "--codex"]),
    run(["match", "gsd plan phase"]),
  ]);
  assert.ok(plain.some(r => r.id === "gsd-plan-phase"), "match without --codex keeps the raw gsd- id");
  assert.ok(codex.some(r => r.id === "muster-gsd-plan-phase"), "match --codex must apply the muster-gsd- rewrite");
  assert.ok(!codex.some(r => r.id === "gsd-plan-phase"), "match --codex must not leak the unadapted id");
});

test("manifest validate --codex checks bindings against the same codex-adapted inventory", async (t) => {
  const { project, run } = await setup(t);
  const fixture = join(project, "manifest.probe-skill.json");
  await writeFile(fixture, manifestBindingProbeSkill());
  const [codex, plain] = await Promise.all([
    run(["manifest", "validate", fixture, "--codex"]),
    run(["manifest", "validate", fixture]),
  ]);
  assert.equal(codex.ok, true, "a binding resolvable in the codex inventory is valid under --codex");
  assert.ok(!("warnings" in codex), "resolved binding must produce no warnings under --codex");
  assert.equal(plain.ok, true, "an unresolved binding stays a warning (not an error) without --codex");
  assert.ok(plain.warnings?.some(w => w.includes(PROBE_SKILL)),
    `without --codex the codex-only skill must warn as unresolved, got ${JSON.stringify(plain.warnings)}`);
});

test("manifest validate --codex resolves exact remote runtime ids and rejects shadowed ids", async (t) => {
  const { project, run, runFailure } = await setup(t);
  const fixture = join(project, "manifest.remote-skill.json");
  const manifest = JSON.parse(manifestBindingProbeSkill());
  manifest.plan[0].skills[0].id = "supabase:supabase";
  await writeFile(fixture, JSON.stringify(manifest));
  assert.equal((await run(["manifest", "validate", fixture, "--codex"])).ok, true);

  manifest.plan[0].skills[0].id = "evil:supabase";
  await writeFile(fixture, JSON.stringify(manifest));
  const rejected = await runFailure(["manifest", "validate", fixture, "--codex"]);
  assert.equal(rejected.ok, false);
  assert.ok(rejected.errors.some(error => error.includes("evil:supabase")));
});
