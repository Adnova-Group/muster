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
if (args[0] === "exec" && args[1] === "--help") return process.stdout.write("--json --ignore-user-config --strict-config --ephemeral --sandbox\\n");
const cwd = args[args.indexOf("-C") + 1];
const payload = JSON.parse(args.at(-1));
fs.appendFileSync(${JSON.stringify(launches)}, "worker-start:" + require("node:path").basename(cwd) + "\\n");
setTimeout(() => {
  fs.writeFileSync(cwd + "/result.txt", payload.value);
  process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:7,output_tokens:3}}) + "\\n");
  fs.appendFileSync(${JSON.stringify(launches)}, "worker-end:" + require("node:path").basename(cwd) + "\\n");
}, payload.delayMs);
`);
  await chmod(codex, 0o755);
  return { root, repo, worktreeA, worktreeB, launches, codex };
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

test("runCodexWave rejects symlink-equivalent duplicate worktrees before Codex execution", async t => {
  const fixture = await waveFixture(t);
  const alias = join(fixture.root, "member-a-alias");
  await symlink(fixture.worktreeA, alias, "dir");
  await assert.rejects(
    runCodexWave({
      members: [member("a", fixture.worktreeA), member("alias", alias)],
      codexCommand: fixture.codex,
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

  const waveFile = join(fixture.root, "wave.json");
  await writeFile(waveFile, JSON.stringify({
    members: [member("a", fixture.worktreeA), member("b", fixture.worktreeB)],
  }));
  const result = await execFile(process.execPath, [runtime, "codex-wave", waveFile], {
    env: { ...process.env, MUSTER_CODEX_COMMAND: fixture.codex },
  });
  assert.equal(JSON.parse(result.stdout).mode, "exec-process");
});
