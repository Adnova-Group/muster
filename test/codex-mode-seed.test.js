import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCodexRelease } from "../src/codex-release.js";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;
const selectedPluginRoot = (await resolveCodexRelease(repoRoot)).pluginRoot;
const cli = join(repoRoot, "src", "cli.js");

async function configureCodex(project, plugins = []) {
  const home = join(project, "home");
  const bin = join(project, "bin");
  await mkdir(bin, { recursive: true });
  const executable = join(bin, "codex");
  const pluginJson = JSON.stringify({ installed: plugins });
  await writeFile(executable, `#!${process.execPath}\nconst command = process.argv[2];\nconsole.log(command === "plugin" ? ${JSON.stringify(pluginJson)} : "[]");\n`);
  await chmod(executable, 0o755);
  return { home, bin };
}

async function runMode(project, args, codex) {
  const { home, bin } = codex;
  const { stdout } = await execFile(process.execPath, [cli, ...args], {
    cwd: project,
    env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), PATH: `${bin}:${process.env.PATH || ""}` },
    timeout: 10_000,
    maxBuffer: 4 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

function crewMember(manifest, stage) {
  return manifest.crew.find(member => member.stage === stage);
}

test("Codex audit and diagnose seeds use bundled agents when live external providers are absent", async () => {
  const project = await mkdtemp(join(tmpdir(), "muster-codex-seed-bare-"));
  const codex = await configureCodex(project);
  const [audit, diagnose] = await Promise.all([
    runMode(project, ["audit", "--codex"], codex),
    runMode(project, ["diagnose", "--codex", "button does not respond"], codex)
  ]);
  assert.deepEqual(crewMember(audit, "architecture-review"), {
    stage: "architecture-review", provider: "muster-strategist", source: "builtin", model: "opus",
    rationale: "audit: system architecture, boundaries, coupling", evidence: "whole-codebase review", fallback: "inline"
  });
  assert.equal(crewMember(diagnose.manifest, "debug").provider, "wsh-debugger");
  assert.equal(crewMember(diagnose.manifest, "debug").source, "builtin");
});

test("Codex plugin detection ignores a same-named custom agent profile", async () => {
  const project = await mkdtemp(join(tmpdir(), "muster-codex-seed-profile-"));
  const agents = join(project, ".codex", "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(join(agents, "agents.toml"), "name = 'agents'\n");
  const codex = await configureCodex(project);
  const [audit, diagnose] = await Promise.all([
    runMode(project, ["audit", "--codex"], codex),
    runMode(project, ["diagnose", "--codex", "button does not respond"], codex)
  ]);
  assert.equal(crewMember(audit, "architecture-review").provider, "muster-strategist");
  assert.equal(crewMember(diagnose.manifest, "debug").provider, "wsh-debugger");
});

test("Codex audit and diagnose prefer a plugin only when live plugin JSON enables it", async () => {
  const project = await mkdtemp(join(tmpdir(), "muster-codex-seed-live-"));
  const agents = join(project, ".codex", "agents");
  await mkdir(agents, { recursive: true });
  await writeFile(join(agents, "agents.toml"), "name = 'agents'\n");
  const codex = await configureCodex(project, [{ name: "agents", installed: true, enabled: true }]);
  const [audit, diagnose] = await Promise.all([
    runMode(project, ["audit", "--codex"], codex),
    runMode(project, ["diagnose", "--codex", "button does not respond"], codex)
  ]);
  for (const stage of ["architecture-review", "tech-debt", "security-review"]) {
    assert.equal(crewMember(audit, stage).provider, "wshobson-agents", stage);
    assert.equal(crewMember(audit, stage).source, "installed", stage);
  }
  assert.equal(crewMember(diagnose.manifest, "debug").provider, "wshobson-agents");
  assert.equal(crewMember(diagnose.manifest, "debug").source, "installed");
});

test("generated Codex audit and diagnose commands seed manifests with live Codex inventory", async () => {
  const commands = join(selectedPluginRoot, "commands");
  const [audit, diagnose] = await Promise.all([
    readFile(join(commands, "audit.md"), "utf8"),
    readFile(join(commands, "diagnose.md"), "utf8")
  ]);
  assert.match(audit, /runtime\/muster\.mjs audit --codex/);
  assert.match(diagnose, /runtime\/muster\.mjs diagnose --codex/);
});

test("generated Codex audit batches every read-only dimension within worker capacity", async () => {
  const generatedPath = join(selectedPluginRoot, "commands", "audit.md");
  const sourcePath = join(repoRoot, "plugin", "commands", "audit.md");
  const [generated, source] = await Promise.all([readFile(generatedPath, "utf8"), readFile(sourcePath, "utf8")]);
  assert.match(generated, /six core dimensions remain independent and READ-ONLY/);
  assert.match(generated, /maximum available subset concurrently/);
  assert.match(generated, /barrier until every worker in that batch finishes/);
  assert.match(generated, /Repeat until all six core dimensions complete/);
  assert.match(generated, /CAPACITY-DEGRADED requested=6 available-worker-slots=<n> batches=<batch composition>/);
  assert.match(generated, /Do not claim full six-way concurrency/);
  assert.match(generated, /Consolidation is forbidden until all six core dimension receipts/);
  assert.doesNotMatch(generated, /dispatch the chosen provider per dimension CONCURRENTLY/);
  assert.match(source, /dispatch the chosen provider per dimension CONCURRENTLY/);
  assert.doesNotMatch(source, /CAPACITY-DEGRADED/);
});
