import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { posixContainmentCall, runCodexWave as runCodexWaveImpl, terminateProcess } from "../src/codex-wave-runner.js";
import { buildCodexPlugin } from "../scripts/build-codex.mjs";

const execFile = promisify(execFileCb);

function runCodexWave(options) {
  const trustedActionFences = Object.fromEntries((options.members || []).map(member => [member.id, ["send", "purchase"]]));
  return runCodexWaveImpl({ ...options, trustedActionFences });
}

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
const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const worker = require("node:path").basename(fs.realpathSync("/proc/self/fd/3"));
if (payload.escapeProcessGroup) {
  require("node:child_process").spawn("setsid", ["sh", "-c", "sleep 0.3; printf escaped > /mnt/escaped.txt"], {detached:true,stdio:"ignore"}).unref();
}
fs.appendFileSync(${JSON.stringify(launches)}, "worker-start:" + worker + "\\n");
fs.appendFileSync(${JSON.stringify(launches)}, "env-secret:" + String(process.env.SUPER_SECRET) + "\\n");
if (payload.outputBytes) process.stdout.write("x".repeat(payload.outputBytes) + "\\n");
setTimeout(() => {
  if (payload.swapGitTarget && payload.swapGitSource) fs.copyFileSync(payload.swapGitSource, payload.swapGitTarget);
  if (payload.dirtyTarget) fs.writeFileSync(payload.dirtyTarget, "planted-after-admission\\n");
  fs.writeFileSync(cwd + "/result.txt", payload.value);
  if (!payload.omitTurn) process.stdout.write(JSON.stringify({type:"turn.completed",usage:{input_tokens:7,output_tokens:3}}) + "\\n");
  if (payload.fatal) process.exitCode = 1;
  fs.appendFileSync(${JSON.stringify(launches)}, "worker-end:" + worker + "\\n");
}, payload.delayMs);
`);
  await chmod(codex, 0o755);
  return { root, repo, baseSha, worktreeA, worktreeB, launches, codex };
}

test("terminateProcess uses Windows taskkill tree termination", () => {
  let invocation;
  const child = { pid: 4242, killed: false, kill: () => assert.fail("direct child kill must only be fallback") };
  terminateProcess(child, {
    platform: "win32",
    taskkill(command, argv, options, callback) {
      invocation = { command, argv, options };
      callback(null);
    },
  });
  assert.deepEqual(invocation, {
    command: "taskkill",
    argv: ["/pid", "4242", "/T", "/F"],
    options: { windowsHide: true },
  });
});

test("posix containment pins cwd through fd 3 and creates a non-escapable PID namespace", () => {
  const call = posixContainmentCall({ command: "codex", argv: ["exec", "--", "-"] });
  assert.equal(call.command, "/usr/bin/bwrap");
  assert.deepEqual(call.argv.slice(0, 4), ["--die-with-parent", "--unshare-pid", "--new-session", "--proc"]);
  assert.ok(call.argv.includes("/proc/self/fd/3"));
  assert.deepEqual(call.argv.slice(-4), ["codex", "exec", "--", "-"]);
});

function member(id, cwd) {
  return {
    id,
    agentType: "muster-runner",
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
  assert.deepEqual(result.rolePolicy, {
    id: "muster-runner",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    sandbox: "workspace-write",
    instructionsSha256: result.rolePolicy.instructionsSha256,
  });
  assert.match(result.rolePolicy.instructionsSha256, /^[a-f0-9]{64}$/);
  assert.match(result.actionFenceSha256, /^[a-f0-9]{64}$/);
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

test("runCodexWave defaults the desired ceiling to trusted configured capacity", async t => {
  const fixture = await waveFixture(t);
  const result = await runCodexWave({
    members: [member("a", fixture.worktreeA), member("b", fixture.worktreeB)],
    codexCommand: fixture.codex,
    repositoryRoot: fixture.repo,
    baseSha: fixture.baseSha,
    configuredThreadCeiling: 24,
  });

  assert.equal(result.effectiveCeiling, 24);
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

test("runCodexWave rejects dirty tracked, untracked, and ignored worktrees before Codex probes", async t => {
  for (const kind of ["tracked", "untracked", "ignored"]) {
    const fixture = await waveFixture(t);
    if (kind === "tracked") await writeFile(join(fixture.worktreeA, "seed.txt"), "dirty\n");
    else if (kind === "untracked") await writeFile(join(fixture.worktreeA, "planted.txt"), "attacker-controlled\n");
    else {
      await writeFile(join(fixture.worktreeA, ".gitignore"), "node_modules/\n");
      await git(fixture.worktreeA, "add", ".gitignore");
      await git(fixture.worktreeA, "commit", "-m", "ignore bootstrap");
      fixture.baseSha = (await git(fixture.worktreeA, "rev-parse", "HEAD")).stdout.trim();
      await git(fixture.worktreeB, "reset", "--hard", fixture.baseSha);
      await mkdir(join(fixture.worktreeA, "node_modules"));
      await writeFile(join(fixture.worktreeA, "node_modules", "poison.js"), "malicious\n");
    }
    await assert.rejects(runCodexWave({
      members: [member(kind, fixture.worktreeA)],
      codexCommand: fixture.codex,
      repositoryRoot: fixture.repo,
      baseSha: fixture.baseSha,
    }), /not pristine|tracked or untracked changes/i);
    await assert.rejects(readFile(fixture.launches, "utf8"), { code: "ENOENT" });
  }
});

test("runCodexWave rejects manifest role-policy overrides and hidden tracked changes", async t => {
  const policyFixture = await waveFixture(t);
  const policyMember = member("policy", policyFixture.worktreeA);
  await assert.rejects(runCodexWaveImpl({
    members: [policyMember], codexCommand: policyFixture.codex,
    repositoryRoot: policyFixture.repo, baseSha: policyFixture.baseSha,
  }), /action-fence map is required out of band/i);
  await assert.rejects(runCodexWaveImpl({
    members: [policyMember], codexCommand: policyFixture.codex,
    repositoryRoot: policyFixture.repo, baseSha: policyFixture.baseSha,
    trustedActionFences: { policy: ["teleport"] },
  }), /unknown action class/i);
  const overridden = { ...member("policy", policyFixture.worktreeA), model: "gpt-5.6-luna" };
  await assert.rejects(runCodexWave({
    members: [overridden], codexCommand: policyFixture.codex,
    repositoryRoot: policyFixture.repo, baseSha: policyFixture.baseSha,
  }), /untrusted policy fields.*model/i);
  await assert.rejects(readFile(policyFixture.launches, "utf8"), { code: "ENOENT" });

  for (const flag of ["--assume-unchanged", "--skip-worktree"]) {
    const fixture = await waveFixture(t);
    await git(fixture.worktreeA, "update-index", flag, "seed.txt");
    await writeFile(join(fixture.worktreeA, "seed.txt"), "hidden change\n");
    await assert.rejects(runCodexWave({
      members: [member(flag, fixture.worktreeA)], codexCommand: fixture.codex,
      repositoryRoot: fixture.repo, baseSha: fixture.baseSha,
    }), /assume-unchanged|skip-worktree|index/i);
    await assert.rejects(readFile(fixture.launches, "utf8"), { code: "ENOENT" });
  }
});

test("runCodexWave receipts a __proto__ member action fence as own data", async t => {
  const fixture = await waveFixture(t);
  const special = member("__proto__", fixture.worktreeA);
  const result = await runCodexWave({
    members: [special], codexCommand: fixture.codex,
    repositoryRoot: fixture.repo, baseSha: fixture.baseSha,
  });
  const expected = createHash("sha256")
    .update(JSON.stringify(Object.fromEntries([["__proto__", ["purchase", "send"]]])))
    .digest("hex");
  assert.equal(result.actionFenceSha256, expected);
});

test("runCodexWave kills a setsid descendant with the PID namespace", async t => {
  const fixture = await waveFixture(t);
  const escaping = member("escaping", fixture.worktreeA);
  escaping.prompt = JSON.stringify({ value: "escaping", delayMs: 20, escapeProcessGroup: true, fatal: true });
  await assert.rejects(runCodexWave({
    members: [escaping], codexCommand: fixture.codex,
    repositoryRoot: fixture.repo, baseSha: fixture.baseSha,
  }), /exited 1|fatal/i);
  await new Promise(resolve => setTimeout(resolve, 400));
  await assert.rejects(readFile(join(fixture.worktreeA, "escaped.txt"), "utf8"), { code: "ENOENT" });
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

test("runCodexWave repeats pristine-state validation immediately before a queued launch", async t => {
  const fixture = await waveFixture(t);
  const first = member("first", fixture.worktreeA);
  first.prompt = JSON.stringify({
    value: "first",
    delayMs: 100,
    dirtyTarget: join(fixture.worktreeB, "planted-after-admission.txt"),
  });
  await assert.rejects(runCodexWave({
    members: [first, member("second", fixture.worktreeB)],
    codexCommand: fixture.codex,
    repositoryRoot: fixture.repo,
    baseSha: fixture.baseSha,
    availableThreadLimit: 1,
  }), /not pristine|tracked or untracked changes/i);
  const events = await readFile(fixture.launches, "utf8");
  assert.match(events, /worker-start:member-a/);
  assert.doesNotMatch(events, /worker-start:member-b/);
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

  const tailed = await waveFixture(t);
  const chatty = member("chatty", tailed.worktreeA);
  chatty.prompt = JSON.stringify({ value: "chatty", outputBytes: 128 * 1024 });
  const tailedResult = await runCodexWave({
    members: [chatty], codexCommand: tailed.codex,
    repositoryRoot: tailed.repo, baseSha: tailed.baseSha,
  });
  assert.ok(Buffer.byteLength(tailedResult.results[0].stdout, "utf8") <= 64 * 1024);
  assert.equal(tailedResult.results[0].stdoutTruncated, true);
  assert.match(tailedResult.results[0].stdoutSha256, /^[a-f0-9]{64}$/);

  const aggregateTimed = await waveFixture(t);
  const firstSlow = member("first-slow", aggregateTimed.worktreeA);
  const secondSlow = member("second-slow", aggregateTimed.worktreeB);
  firstSlow.prompt = JSON.stringify({ value: "first-slow", delayMs: 200 });
  secondSlow.prompt = JSON.stringify({ value: "second-slow", delayMs: 200 });
  await assert.rejects(runCodexWave({
    members: [firstSlow, secondSlow], codexCommand: aggregateTimed.codex,
    repositoryRoot: aggregateTimed.repo, baseSha: aggregateTimed.baseSha,
    workerTimeoutMs: 300, availableThreadLimit: 1,
  }), /wave exceeded .*deadline/i);

  const aggregateNoisy = await waveFixture(t);
  const firstLoud = member("first-loud", aggregateNoisy.worktreeA);
  const secondLoud = member("second-loud", aggregateNoisy.worktreeB);
  firstLoud.prompt = JSON.stringify({ value: "first-loud", outputBytes: 3 * 1024 * 1024 });
  secondLoud.prompt = JSON.stringify({ value: "second-loud", outputBytes: 3 * 1024 * 1024 });
  await assert.rejects(runCodexWave({
    members: [firstLoud, secondLoud], codexCommand: aggregateNoisy.codex,
    repositoryRoot: aggregateNoisy.repo, baseSha: aggregateNoisy.baseSha,
    configuredThreadCeiling: 2,
  }), /wave output exceeded/i);

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
  assert.match(orchestrator, /Every production wave MUST first run through/);
  assert.match(orchestrator, /never choose or invoke `spawn_agent` from a wave manifest/);
  assert.match(orchestrator, /production waves are process-only/i);
  assert.doesNotMatch(orchestrator, /disjoint or read-only members use Codex's subagent collaboration protocol/);
  assert.match(orchestrator, /registered linked worktree/);
  assert.match(orchestrator, /native-review shadow benchmark rejected adoption/);

  const oversizedWave = join(fixture.root, "oversized-wave.json");
  await writeFile(oversizedWave, " ".repeat(1024 * 1024 + 1));
  await assert.rejects(execFile(process.execPath, [runtime, "codex-wave", oversizedWave]), /unsafe regular file|too-large/i);

  const waveFile = join(fixture.root, "wave.json");
  await writeFile(waveFile, JSON.stringify({
    members: [member("a", fixture.worktreeA), member("b", fixture.worktreeB)],
  }));
  const fenceFile = join(fixture.root, "action-fence.json");
  await writeFile(fenceFile, JSON.stringify({ members: { a: ["send"], b: ["purchase"] } }));
  const fakeGitMarker = join(fixture.root, "fake-git-ran");
  const fakeGit = join(fixture.root, "git");
  await writeFile(fakeGit, `#!/bin/sh\nprintf invoked > ${JSON.stringify(fakeGitMarker)}\nexit 99\n`);
  await chmod(fakeGit, 0o755);
  await assert.rejects(execFile(process.execPath, [
    runtime, "codex-wave", waveFile,
    "--fence-file", fenceFile,
    "--repository-root", fixture.repo,
    "--base-sha", fixture.baseSha,
  ], {
    env: { ...process.env, PATH: `${fixture.root}:/usr/bin:/bin`, MUSTER_CODEX_COMMAND: fixture.codex },
  }), /no trusted Codex executable/i);
  await assert.rejects(readFile(fakeGitMarker, "utf8"), { code: "ENOENT" });

  await assert.rejects(execFile(process.execPath, [runtime, "codex-wave", waveFile, "--fence-file", fenceFile]), /repositoryRoot is required/i);
  await assert.rejects(execFile(process.execPath, [
    runtime, "codex-wave", waveFile, "--repository-root", fixture.repo,
    "--fence-file", fenceFile,
  ]), /baseSha must be a full/i);

  const untrustedHomeFile = join(fixture.root, "untrusted-home-wave.json");
  await writeFile(untrustedHomeFile, JSON.stringify({
    codexHome: join(fixture.root, "attacker-codex-home"),
    members: [{ id: "one", prompt: "one", model: "gpt-5.6-luna", agentType: "muster-investigator", readOnly: true }],
    catalogVersions: { "gpt-5.6-luna": "v1" },
  }));
  await assert.rejects(execFile(process.execPath, [runtime, "codex-wave", untrustedHomeFile]), /trusted out-of-band|codexHome/i);
  const untrustedCatalogFile = join(fixture.root, "untrusted-catalog-wave.json");
  await writeFile(untrustedCatalogFile, JSON.stringify({
    catalogVersions: { "gpt-5.6-luna": "v2" },
    members: [member("one", fixture.worktreeA)],
  }));
  await assert.rejects(execFile(process.execPath, [runtime, "codex-wave", untrustedCatalogFile]), /trusted out-of-band|catalogVersions/i);

  const fifoHome = join(fixture.root, "fifo-home");
  await mkdir(fifoHome);
  await execFile("mkfifo", [join(fifoHome, "config.toml")]);
  await assert.rejects(execFile(process.execPath, [
    runtime, "codex-wave", waveFile,
    "--fence-file", fenceFile,
    "--repository-root", fixture.repo,
    "--base-sha", fixture.baseSha,
  ], {
    env: { ...process.env, CODEX_HOME: fifoHome },
    timeout: 2000,
  }), /regular file|unsafe/i);
});
