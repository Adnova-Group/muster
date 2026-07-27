// Parity pin for the single-sourced catalog resolution in src/cli.js
// (loadEffectiveCatalog): every branch that resolves the catalog+inventory pair
// -- `capabilities`, `match --skills`, `match`, and `manifest validate` -- must
// apply the SAME --codex adaptation (codex inventory swap + adaptCatalogForCodex).
// The diagnose/audit consumers of resolveModeCapabilities are pinned separately
// by test/codex-mode-seed.test.js; this file pins the other three branches plus
// capabilities against one shared probe signal each.
//
// Probe signals:
//  - a project-local codex skill (zz-codex-probe) visible ONLY via the codex
//    inventory (<cwd>/.codex/skills) -- capabilities/match --skills/manifest
//    validate must see it with --codex and not without;
//  - the gsd-* -> muster-gsd-* id rewrite adaptCatalogForCodex applies --
//    `match` must emit the renamed id with --codex and the raw id without.
// Both signals are environment-independent: HOME points at an empty temp dir
// and a fake `codex` binary on PATH answers plugin/mcp list with empty JSON.

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
  const skillDir = join(project, ".codex", "skills", PROBE_SKILL);
  await mkdir(bin, { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(skillDir, "SKILL.md"), `---\nname: ${PROBE_SKILL}\ndescription: codex-only probe skill\n---\n`);
  const fakeCodex = join(bin, "codex");
  await writeFile(fakeCodex, `#!${process.execPath}\nconst command = process.argv[2];\nconsole.log(command === "plugin" ? '{"installed":[]}' : "[]");\n`);
  await chmod(fakeCodex, 0o755);
  const env = {
    ...process.env,
    HOME: home,
    CODEX_HOME: join(home, ".codex"),
    PATH: `${bin}:${process.env.PATH || ""}`,
  };
  const run = async (args) =>
    JSON.parse((await execFile(process.execPath, [cli, ...args], {
      cwd: project, env, timeout: 15_000, maxBuffer: 4 * 1024 * 1024,
    })).stdout);
  return { project, run };
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
