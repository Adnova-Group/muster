import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { runCodexWave } from "../src/codex-wave-runner.js";
import { buildCodexPlugin } from "../scripts/build-codex.mjs";

const execFile = promisify(execFileCb);

async function git(cwd, ...args) {
  return execFile("git", args, { cwd });
}

async function waveFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "muster-codex-wave-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = join(root, "repo");
  const worktreeA = join(root, "member-a");
  const worktreeB = join(root, "member-b");
  await mkdir(repo);
  await git(repo, "init", "-b", "main");
  await git(repo, "config", "user.email", "test@example.com");
  await git(repo, "config", "user.name", "Test");
  await writeFile(join(repo, "seed.txt"), "seed\n");
  await git(repo, "add", "seed.txt");
  await git(repo, "commit", "-m", "seed");
  const baseSha = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  await git(repo, "worktree", "add", "-b", "member-a", worktreeA, "HEAD");
  await git(repo, "worktree", "add", "-b", "member-b", worktreeB, "HEAD");

  const launches = join(root, "launches.log");
  const codex = join(root, "codex");
  await writeFile(codex, `#!/usr/bin/env node
const fs = require("node:fs");
fs.appendFileSync(${JSON.stringify(launches)}, process.argv.slice(2).join(" ") + "\\n");
const args = process.argv.slice(2);
if (args[0] === "--version") return process.stdout.write("codex-cli 0.145.0\\n");
if (args[0] === "--help") return process.stdout.write("--ask-for-approval\\n");
if (args[0] === "exec" && args[1] === "--help") return process.stdout.write("--json --ignore-user-config --ignore-rules --strict-config --ephemeral --sandbox\\n");
const cwd = args[args.indexOf("-C") + 1];
const payload = JSON.parse(args.at(-1));
fs.appendFileSync(${JSON.stringify(launches)}, "worker-start:" + require("node:path").basename(cwd) + "\\n");
fs.appendFileSync(${JSON.stringify(launches)}, "env-secret:" + String(process.env.SUPER_SECRET) + "\\n");
if (payload.outputBytes) process.stdout.write("x".repeat(payload.outputBytes));
setTimeout(() => {
  if (payload.swapGitTarget && payload.swapGitSource) fs.copyFileSync(payload.swapGitSource, payload.swapGitTarget);
  fs.writeFileSync(cwd + "/result.txt", payload.value);
  if (!payload.omitTurn) process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:7,output_tokens:3}}) + "\\n");
  fs.appendFileSync(${JSON.stringify(launches)}, "worker-end:" + require("node:path").basename(cwd) + "\\n");
}, payload.delayMs);
`);
  await chmod(codex, 0o755);
  return { root, repo, baseSha, worktreeA, worktreeB, launches, codex };
}

function member(id, cwd) {
  return {
    id,
    cwd,
    prompt: JSON.stringify({ value: basename(cwd), delayMs: 80 }),
    writes: ["result.txt"],
  };
}

async function assertRejectedBeforeCodex(fixture, cwd, pattern) {
  await assert.rejects(
    runCodexWave({
      members: [member("bad", cwd)],
      forceProcess: true,
      codexCommand: fixture.codex,
      repositoryRoot: fixture.repo,
      baseSha: fixture.baseSha,
    }),
    pattern,
  );
  await assert.rejects(readFile(fixture.launches, "utf8"), { code: "ENOENT" });
}

test("runCodexWave rejects absent worktree paths before Codex execution", async t => {
  const fixture = await waveFixture(t);
  await assertRejectedBeforeCodex(fixture, join(fixture.root, "absent"), /does not exist|worktree/i);
});

test("runCodexWave rejects a nested/wrong path instead of silently accepting its parent worktree", async t => {
  const fixture = await waveFixture(t);
  const nested = join(fixture.worktreeA, "nested");
  await mkdir(nested);
  await assertRejectedBeforeCodex(fixture, nested, /exact worktree root/i);
});

test("runCodexWave rejects the base checkout before Codex execution", async t => {
  const fixture = await waveFixture(t);
  await assertRejectedBeforeCodex(fixture, fixture.repo, /base checkout|linked worktree/i);
});

test("runCodexWave rejects an existing but unregistered worktree path before Codex execution", async t => {
  const fixture = await waveFixture(t);
  const rogue = join(fixture.root, "rogue");
  await mkdir(rogue);
  await writeFile(join(rogue, ".git"), "gitdir: /definitely/not/a/registered/worktree\n");
  await assertRejectedBeforeCodex(fixture, rogue, /registered linked git worktree/i);
});

test("runCodexWave rejects a registered path whose .git pointer is swapped to a sibling worktree", async t => {
  const fixture = await waveFixture(t);
  const siblingPointer = await readFile(join(fixture.worktreeB, ".git"), "utf8");
  await writeFile(join(fixture.worktreeA, ".git"), siblingPointer);
  await assertRejectedBeforeCodex(fixture, fixture.worktreeA, /git directory|registry|backpointer/i);
});

test("runCodexWave rejects symlink-equivalent duplicate worktrees before Codex execution", async t => {
  const fixture = await waveFixture(t);
  const alias = join(fixture.root, "member-a-alias");
  await symlink(fixture.worktreeA, alias, "dir");
  await assert.rejects(
    runCodexWave({
      members: [member("a", fixture.worktreeA), member("alias", alias)],
      codexCommand: fixture.codex,
      repositoryRoot: fixture.repo,
      baseSha: fixture.baseSha,
    }),
    /same canonical cwd/,
  );
  await assert.rejects(readFile(fixture.launches, "utf8"), { code: "ENOENT" });
});

test("runCodexWave keeps two concurrent conflicting writers isolated in registered worktrees", async t => {
  const fixture = await waveFixture(t);
  const result = await runCodexWave({
    members: [member("a", fixture.worktreeA), member("b", fixture.worktreeB)],
    codexCommand: fixture.codex,
    repositoryRoot: fixture.repo,
    baseSha: fixture.baseSha,
    env: { ...process.env, SUPER_SECRET: "should-not-leak" },
  });

  assert.equal(result.mode, "exec-process");
  assert.deepEqual(
    await Promise.all([
      readFile(join(fixture.worktreeA, "result.txt"), "utf8"),
      readFile(join(fixture.worktreeB, "result.txt"), "utf8"),
    ]),
    ["member-a", "member-b"],
  );
  const events = (await readFile(fixture.launches, "utf8")).trim().split("\n");
  const starts = [events.indexOf("worker-start:member-a"), events.indexOf("worker-start:member-b")];
  const ends = [events.indexOf("worker-end:member-a"), events.indexOf("worker-end:member-b")];
  assert.ok(starts.every(index => index >= 0) && ends.every(index => index >= 0));
  assert.ok(Math.max(...starts) < Math.min(...ends), "both writers must start before either writer completes");
  assert.ok(events.filter(line => line === "env-secret:undefined").length === 2, "ambient secrets must not reach workers");
});

test("runCodexWave bounds process batches by desired, configured, and available thread ceilings", async t => {
  const fixture = await waveFixture(t);
  const result = await runCodexWave({
    members: [member("a", fixture.worktreeA), member("b", fixture.worktreeB)],
    codexCommand: fixture.codex,
    repositoryRoot: fixture.repo,
    baseSha: fixture.baseSha,
    maxConcurrentThreadsPerSession: 8,
    configuredThreadCeiling: 2,
    availableThreadLimit: 1,
  });

  assert.equal(result.effectiveCeiling, 1);
  const events = (await readFile(fixture.launches, "utf8")).trim().split("\n");
  assert.ok(
    events.indexOf("worker-end:member-a") < events.indexOf("worker-start:member-b"),
    "available capacity 1 must finish the first writer before launching the second",
  );
});

test("runCodexWave rejects worktrees from an unrelated repository before Codex execution", async t => {
  const trusted = await waveFixture(t);
  const unrelated = await waveFixture(t);
  await assert.rejects(
    runCodexWave({
      members: [member("foreign", unrelated.worktreeA)],
      forceProcess: true,
      codexCommand: trusted.codex,
      repositoryRoot: trusted.repo,
      baseSha: trusted.baseSha,
    }),
    /trusted repository|common git directory/i,
  );
  await assert.rejects(readFile(trusted.launches, "utf8"), { code: "ENOENT" });
});

test("runCodexWave rejects unsafe policy before probes and rejects an exit-zero run without a terminal turn", async t => {
  const fixture = await waveFixture(t);
  await assert.rejects(
    runCodexWave({
      members: [member("unsafe", fixture.worktreeA)],
      forceProcess: true,
      codexCommand: fixture.codex,
      repositoryRoot: fixture.repo,
      baseSha: fixture.baseSha,
      sandbox: "danger-full-access",
    }),
    /danger-full-access|sandbox/i,
  );
  await assert.rejects(readFile(fixture.launches, "utf8"), { code: "ENOENT" });

  const noTurn = member("no-turn", fixture.worktreeA);
  noTurn.prompt = JSON.stringify({ value: "unused", delayMs: 0, omitTurn: true });
  await assert.rejects(
    runCodexWave({
      members: [noTurn],
      forceProcess: true,
      codexCommand: fixture.codex,
      repositoryRoot: fixture.repo,
      baseSha: fixture.baseSha,
    }),
    /turn\.completed/i,
  );
});

test("runCodexWave rejects NUL-bearing command inputs before every Codex probe", async t => {
  const fixture = await waveFixture(t);
  const nul = member("nul", fixture.worktreeA);
  nul.prompt = "unsafe\0prompt";
  await assert.rejects(runCodexWave({
    members: [nul], forceProcess: true, codexCommand: fixture.codex,
    repositoryRoot: fixture.repo, baseSha: fixture.baseSha,
  }), /NUL/i);
  await assert.rejects(readFile(fixture.launches, "utf8"), { code: "ENOENT" });

  const oversizedPrompt = member("oversized-prompt", fixture.worktreeA);
  oversizedPrompt.prompt = "p".repeat(16 * 1024 + 1);
  await assert.rejects(runCodexWave({
    members: [oversizedPrompt], forceProcess: true, codexCommand: fixture.codex,
    repositoryRoot: fixture.repo, baseSha: fixture.baseSha,
  }), /prompt exceeds/i);
  await assert.rejects(readFile(fixture.launches, "utf8"), { code: "ENOENT" });
});

test("runCodexWave aborts and settles active writers when a queued member fails prelaunch revalidation", async t => {
  const fixture = await waveFixture(t);
  const worktreeC = join(fixture.root, "member-c");
  await git(fixture.repo, "worktree", "add", "-b", "member-c", worktreeC, "HEAD");
  const slow = member("slow", fixture.worktreeA);
  slow.prompt = JSON.stringify({ value: "slow", delayMs: 5000 });
  const tamper = member("tamper", fixture.worktreeB);
  tamper.prompt = JSON.stringify({
    value: "tamper", delayMs: 0,
    swapGitTarget: join(worktreeC, ".git"),
    swapGitSource: join(fixture.worktreeB, ".git"),
  });
  const queued = member("queued", worktreeC);
  const started = Date.now();
  await assert.rejects(runCodexWave({
    members: [slow, tamper, queued], forceProcess: true, codexCommand: fixture.codex,
    repositoryRoot: fixture.repo, baseSha: fixture.baseSha,
    maxConcurrentThreadsPerSession: 2, configuredThreadCeiling: 2,
  }), /git directory|registry|backpointer|changed/i);
  assert.ok(Date.now() - started < 3000, "active slow writer must be cancelled and settled before returning");
  const events = await readFile(fixture.launches, "utf8");
  assert.match(events, /worker-start:member-a/);
  assert.match(events, /worker-start:member-b/);
  assert.doesNotMatch(events, /worker-start:member-c/);
});

test("runCodexWave rejects executable project config and bounds members, duration, and captured output", async t => {
  const configured = await waveFixture(t);
  await mkdir(join(configured.worktreeA, ".codex"));
  await writeFile(join(configured.worktreeA, ".codex", "config.toml"), "[mcp_servers.evil]\ncommand = 'evil'\n");
  await assert.rejects(
    runCodexWave({
      members: [member("configured", configured.worktreeA)],
      forceProcess: true,
      codexCommand: configured.codex,
      repositoryRoot: configured.repo,
      baseSha: configured.baseSha,
    }),
    /executable project Codex configuration/i,
  );
  await assert.rejects(readFile(configured.launches, "utf8"), { code: "ENOENT" });

  const oversized = await waveFixture(t);
  await assert.rejects(
    runCodexWave({
      members: Array.from({ length: 65 }, (_, index) => member(`member-${index}`, oversized.worktreeA)),
      forceProcess: true,
      codexCommand: oversized.codex,
      repositoryRoot: oversized.repo,
      baseSha: oversized.baseSha,
    }),
    /members exceeds limit/i,
  );
  await assert.rejects(readFile(oversized.launches, "utf8"), { code: "ENOENT" });

  const timed = await waveFixture(t);
  const slow = member("slow", timed.worktreeA);
  slow.prompt = JSON.stringify({ value: "slow", delayMs: 200 });
  await assert.rejects(
    runCodexWave({
      members: [slow], forceProcess: true, codexCommand: timed.codex,
      repositoryRoot: timed.repo, baseSha: timed.baseSha, workerTimeoutMs: 20,
    }),
    /timeout/i,
  );

  const noisy = await waveFixture(t);
  const loud = member("loud", noisy.worktreeA);
  loud.prompt = JSON.stringify({ value: "loud", delayMs: 200, outputBytes: 5 * 1024 * 1024 });
  await assert.rejects(
    runCodexWave({
      members: [loud], forceProcess: true, codexCommand: noisy.codex,
      repositoryRoot: noisy.repo, baseSha: noisy.baseSha,
    }),
    /output exceeded/i,
  );

  const schemaFixture = await waveFixture(t);
  const oversizedSchema = join(schemaFixture.worktreeA, "schema.json");
  await writeFile(oversizedSchema, "x".repeat(1024 * 1024 + 1));
  const schemaMember = member("schema", schemaFixture.worktreeA);
  schemaMember.schemaPath = oversizedSchema;
  await assert.rejects(runCodexWave({
    members: [schemaMember], forceProcess: true, codexCommand: schemaFixture.codex,
    repositoryRoot: schemaFixture.repo, baseSha: schemaFixture.baseSha,
  }), /unsafe regular file|too-large|schema/i);
  await assert.rejects(readFile(schemaFixture.launches, "utf8"), { code: "ENOENT" });

  const fifoFixture = await waveFixture(t);
  const fifoSchema = join(fifoFixture.worktreeA, "schema.pipe");
  await execFile("mkfifo", [fifoSchema]);
  const fifoMember = member("fifo-schema", fifoFixture.worktreeA);
  fifoMember.schemaPath = fifoSchema;
  await assert.rejects(runCodexWave({
    members: [fifoMember], forceProcess: true, codexCommand: fifoFixture.codex,
    repositoryRoot: fifoFixture.repo, baseSha: fifoFixture.baseSha,
  }), /regular file|schema/i);
  await assert.rejects(readFile(fifoFixture.launches, "utf8"), { code: "ENOENT" });
});

test("generated Codex runtime and orchestrator expose only the hermetic process-wave production lane", async t => {
  const fixture = await waveFixture(t);
  const generated = await buildCodexPlugin({
    root: new URL("..", import.meta.url).pathname,
    outDir: join(fixture.root, "generated"),
  });
  const runtime = join(generated.pluginRoot, "runtime", "muster.mjs");
  const orchestrator = await readFile(
    join(generated.pluginRoot, "internal-skills", "orchestrator", "SKILL.md"),
    "utf8",
  );
  assert.match(orchestrator, /runtime\/muster\.mjs codex-wave/);
  assert.match(orchestrator, /registered linked worktree/);
  assert.match(orchestrator, /native-review shadow benchmark rejected adoption/);

  const oversizedWave = join(fixture.root, "oversized-wave.json");
  await writeFile(oversizedWave, " ".repeat(1024 * 1024 + 1));
  await assert.rejects(execFile(process.execPath, [runtime, "codex-wave", oversizedWave]), /unsafe regular file|too-large/i);

  const waveFile = join(fixture.root, "wave.json");
  await writeFile(waveFile, JSON.stringify({
    members: [member("a", fixture.worktreeA), member("b", fixture.worktreeB)],
  }));
  const result = await execFile(process.execPath, [
    runtime, "codex-wave", waveFile,
    "--repository-root", fixture.repo,
    "--base-sha", fixture.baseSha,
  ], {
    env: { ...process.env, MUSTER_CODEX_COMMAND: fixture.codex },
  });
  assert.equal(JSON.parse(result.stdout).mode, "exec-process");

  await writeFile(join(fixture.repo, "packet-a.txt"), "a\n");
  await writeFile(join(fixture.repo, "packet-b.txt"), "b\n");
  const packetFile = join(fixture.root, "packet-wave.json");
  await writeFile(packetFile, JSON.stringify({
    members: [
      { id: "one", prompt: "one", model: "gpt-5.6-luna", agentType: "muster-investigator", writes: ["packet-a.txt"] },
      { id: "two", prompt: "two", model: "gpt-5.6-sol", agentType: "muster-reviewer", writes: ["packet-b.txt"] },
    ],
    catalogVersions: { "gpt-5.6-luna": "v1", "gpt-5.6-sol": "v2" },
    maxConcurrentThreadsPerSession: 2,
    availableThreadLimit: 1,
  }));
  const untrustedHomeFile = join(fixture.root, "untrusted-home-wave.json");
  await writeFile(untrustedHomeFile, JSON.stringify({
    codexHome: join(fixture.root, "attacker-codex-home"),
    members: [{ id: "one", prompt: "one", model: "gpt-5.6-luna", agentType: "muster-investigator", readOnly: true }],
    catalogVersions: { "gpt-5.6-luna": "v1" },
  }));
  await assert.rejects(execFile(process.execPath, [runtime, "codex-wave", untrustedHomeFile]), /trusted out-of-band|codexHome/i);
  const packets = await execFile(process.execPath, [
    runtime, "codex-wave", packetFile,
    "--repository-root", fixture.repo,
    "--base-sha", fixture.baseSha,
  ]);
  const packetResult = JSON.parse(packets.stdout);
  assert.equal(packetResult.effectiveCeiling, 1);
  assert.deepEqual(packetResult.batches.map(batch => batch.length), [1, 1]);
  assert.deepEqual(packetResult.results.map(row => row.packet.tool), [
    "multi_agent_v1.spawn_agent",
    "collaboration.spawn_agent",
  ]);

  const fifoHome = join(fixture.root, "fifo-home");
  await mkdir(fifoHome);
  await execFile("mkfifo", [join(fifoHome, "config.toml")]);
  await assert.rejects(execFile(process.execPath, [runtime, "codex-wave", packetFile], {
    env: { ...process.env, CODEX_HOME: fifoHome },
    timeout: 2000,
  }), /regular file|unsafe/i);
});
