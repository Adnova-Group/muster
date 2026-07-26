import { test } from "node:test";
import assert from "node:assert/strict";
import { chmod, mkdtemp, mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { performance } from "node:perf_hooks";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { runCodexWave } from "../src/codex-wave-runner.js";
import { buildCodexPlugin } from "../scripts/build-codex.mjs";

const execFile = promisify(execFileCb);

async function fakeCodexFixture() {
  const root = await mkdtemp(join(tmpdir(), "muster-fake-codex-"));
  const command = join(root, "codex");
  await writeFile(command, `#!/usr/bin/env node
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(process.env.FAKE_CODEX_VERSION || "codex-cli 0.145.0\\n");
  process.exit(0);
}
if (args[0] === "exec" && args[1] === "--help") {
  process.stdout.write(process.env.FAKE_CODEX_HELP || "--json --ignore-user-config --strict-config --ephemeral --sandbox");
  process.exit(0);
}
if (args[0] === "--help") {
  process.stdout.write(process.env.FAKE_CODEX_ROOT_HELP || "--ask-for-approval");
  process.exit(0);
}
const required = ["exec", "--json", "--ignore-user-config", "--strict-config", "--ephemeral", "--sandbox", "workspace-write", "--ask-for-approval", "never"];
for (const token of required) {
  if (!args.includes(token)) {
    process.stderr.write("missing required flag: " + token);
    process.exit(64);
  }
}
if (args.indexOf("--ask-for-approval") > args.indexOf("exec")) {
  process.stderr.write("--ask-for-approval must be a root option before exec");
  process.exit(65);
}
const cwd = args[args.indexOf("-C") + 1];
const prompt = JSON.parse(args.at(-1));
setTimeout(() => {
  require("node:fs").writeFileSync(cwd + "/result.txt", prompt.value);
  process.stdout.write(JSON.stringify({ type: "turn.completed", usage: prompt.omitUsage ? undefined : { input_tokens: 7, output_tokens: 3 } }) + "\\n");
  process.exit(Number(prompt.exitCode || 0));
}, Number(prompt.delayMs || 0));
`);
  await chmod(command, 0o755);
  return { root, command };
}

function members(worktrees, delayMs = 0) {
  return worktrees.map((cwd, index) => ({
    id: `task-${index + 1}`,
    prompt: JSON.stringify({ value: basename(cwd), delayMs }),
    cwd,
    model: index === 0 ? "gpt-5.6-luna" : index === 1 ? "gpt-5.6-sol" : "gpt-5.6-terra",
    agentType: "muster-builder",
    writes: ["result.txt"],
  }));
}

test("runCodexWave: conflicting writers use hermetic parallel processes with usage and zero cross-worktree writes", async () => {
  const { root, command } = await fakeCodexFixture();
  const worktrees = [join(root, "a"), join(root, "b"), join(root, "c")];
  await Promise.all(worktrees.map(dir => mkdir(dir)));
  const wave = members(worktrees);
  wave[2].prompt = JSON.stringify({ value: "c", omitUsage: true });

  const result = await runCodexWave({ members: wave, codexCommand: command });

  assert.equal(result.mode, "exec-process");
  assert.deepEqual(result.results.map(row => row.usage), [
    { input_tokens: 7, output_tokens: 3 },
    { input_tokens: 7, output_tokens: 3 },
    "UNKNOWN",
  ]);
  assert.deepEqual(
    await Promise.all(worktrees.map(dir => readFile(join(dir, "result.txt"), "utf8"))),
    ["a", "b", "c"],
  );
});

test("runCodexWave: disjoint members dispatch live v1 Luna and v2 Sol/Terra packets", async () => {
  const packets = [];
  const wave = [
    { id: "luna", prompt: "one", model: "gpt-5.6-luna", agentType: "muster-surgeon", writes: ["a"] },
    { id: "sol", prompt: "two", model: "gpt-5.6-sol", agentType: "muster-builder", writes: ["b"] },
    { id: "terra", prompt: "three", model: "gpt-5.6-terra", agentType: "muster-investigator" },
  ];
  const result = await runCodexWave({
    members: wave,
    catalogVersions: { "gpt-5.6-luna": "v1", "gpt-5.6-sol": "v2", "gpt-5.6-terra": "v2" },
    dispatchAgent: async packet => {
      packets.push(packet);
      return { accepted: true };
    },
  });

  assert.equal(result.mode, "spawn_agent");
  assert.deepEqual(packets.map(packet => packet.tool), [
    "multi_agent_v1.spawn_agent",
    "collaboration.spawn_agent",
    "collaboration.spawn_agent",
  ]);
});

test("runCodexWave: rejects unsupported versions/features and propagates nonzero exits", async () => {
  const { root, command } = await fakeCodexFixture();
  const cwd = join(root, "worktree");
  await mkdir(cwd);
  const wave = members([cwd]);

  await assert.rejects(
    runCodexWave({ members: wave, forceProcess: true, codexCommand: command, env: { ...process.env, FAKE_CODEX_VERSION: "codex-cli 0.144.0" } }),
    /unsupported Codex version/,
  );
  await assert.rejects(
    runCodexWave({ members: wave, forceProcess: true, codexCommand: command, env: { ...process.env, FAKE_CODEX_HELP: "--json --ephemeral" } }),
    /unsupported Codex exec feature/,
  );
  await assert.rejects(
    runCodexWave({ members: wave, forceProcess: true, codexCommand: command, env: { ...process.env, FAKE_CODEX_ROOT_HELP: "--sandbox" } }),
    /unsupported Codex root feature/,
  );
  wave[0].prompt = JSON.stringify({ value: "failed", exitCode: 23, omitUsage: true });
  await assert.rejects(
    runCodexWave({ members: wave, forceProcess: true, codexCommand: command }),
    error => error.code === 23 && /task-1/.test(error.message),
  );
});

test("runCodexWave: process lane rejects duplicate canonical worktrees before launch", async () => {
  const { root, command } = await fakeCodexFixture();
  const cwd = join(root, "worktree");
  const alias = join(root, "alias");
  await mkdir(cwd);
  await symlink(cwd, alias, "dir");
  const wave = members([cwd, alias]);

  await assert.rejects(
    runCodexWave({ members: wave, forceProcess: true, codexCommand: command }),
    /same canonical cwd/,
  );
});

test("runCodexWave: representative parallel write wave is at least 30% faster than serial execution", async t => {
  const { root, command } = await fakeCodexFixture();
  const worktrees = [join(root, "p1"), join(root, "p2"), join(root, "p3")];
  await Promise.all(worktrees.map(dir => mkdir(dir)));
  const wave = members(worktrees, 180);

  const serialStart = performance.now();
  for (const member of wave) {
    await runCodexWave({ members: [member], forceProcess: true, codexCommand: command });
  }
  const serialMs = performance.now() - serialStart;

  const parallelStart = performance.now();
  await runCodexWave({ members: wave, codexCommand: command });
  const parallelMs = performance.now() - parallelStart;

  t.diagnostic(`benchmark serial=${serialMs.toFixed(1)}ms parallel=${parallelMs.toFixed(1)}ms reduction=${((1 - parallelMs / serialMs) * 100).toFixed(1)}%`);
  assert.ok(parallelMs <= serialMs * 0.70, `parallel=${parallelMs.toFixed(1)}ms serial=${serialMs.toFixed(1)}ms`);
});

test("CLI live path executes process waves and emits collaboration packets for agent waves", async () => {
  const { root, command } = await fakeCodexFixture();
  const repoRoot = new URL("..", import.meta.url).pathname;
  const generated = await buildCodexPlugin({ root: repoRoot, outDir: join(root, "generated") });
  const runtimeCli = join(generated.pluginRoot, "runtime", "muster.mjs");
  const orchestrator = await readFile(join(generated.pluginRoot, "internal-skills", "orchestrator", "SKILL.md"), "utf8");
  assert.match(orchestrator, /runtime\/muster\.mjs codex-wave/);
  assert.match(orchestrator, /--ignore-user-config/);
  assert.match(orchestrator, /--strict-config/);
  assert.match(orchestrator, /--ephemeral/);

  const processDir = join(root, "process");
  await mkdir(processDir);
  const processFile = join(root, "process-wave.json");
  await writeFile(processFile, JSON.stringify({ members: members([processDir]), forceProcess: true }));
  const processRun = await execFile(process.execPath, [runtimeCli, "codex-wave", processFile], {
    cwd: repoRoot,
    env: { ...process.env, MUSTER_CODEX_COMMAND: command },
  });
  assert.equal(JSON.parse(processRun.stdout).mode, "exec-process");

  const agentFile = join(root, "agent-wave.json");
  await writeFile(agentFile, JSON.stringify({
    members: [
      { id: "luna", prompt: "one", model: "gpt-5.6-luna", agentType: "muster-surgeon", writes: ["a"] },
      { id: "sol", prompt: "two", model: "gpt-5.6-sol", agentType: "muster-builder", writes: ["b"] },
    ],
    catalogVersions: { "gpt-5.6-luna": "v1", "gpt-5.6-sol": "v2" },
  }));
  const agentRun = await execFile(process.execPath, [runtimeCli, "codex-wave", agentFile], {
    cwd: repoRoot,
  });
  assert.deepEqual(
    JSON.parse(agentRun.stdout).results.map(row => row.packet.tool),
    ["multi_agent_v1.spawn_agent", "collaboration.spawn_agent"],
  );
});
