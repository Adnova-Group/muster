import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { access, chmod, mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDispatchReceipts,
  readKernelStartIdentity,
  runKimiProcess,
} from "../src/dispatch-receipts.js";
import { findZombieProcesses, runHygiene } from "../src/hygiene.js";

class FakeChild extends EventEmitter {
  constructor(pid = 4321) {
    super();
    this.pid = pid;
    this.kills = [];
  }
  kill(signal) { this.kills.push(signal); return true; }
}

const tempStore = async () => join(await mkdtemp(join(tmpdir(), "muster-dispatch-receipts-")), "receipts");
const request = { brief: "do the bounded task", agentFile: "agent.md", cwd: null, lane: "primary" };
const execFile = promisify(execFileCb);
const CLI = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "cli.js");

async function fixtureRequest() {
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-run-"));
  const agentFile = join(root, "agent.md");
  await writeFile(agentFile, "---\nname: fixture\n---\n");
  return { ...request, agentFile, cwd: root };
}

test("runKimiProcess spawns only fixed kimi from the validated descriptor and establishes a private secret-free receipt before reporting ready", async () => {
  const receiptRoot = await tempStore();
  const child = new FakeChild();
  const calls = [];
  let receiptAtReady;
  const running = runKimiProcess(await fixtureRequest(), {
    receiptRoot,
    spawnProcess(command, argv, options) {
      calls.push({ command, argv, options });
      return child;
    },
    readIdentity: () => "linux-proc-stat:888",
    onReceiptEstablished: async () => {
      const names = await readdir(receiptRoot);
      receiptAtReady = JSON.parse(await readFile(join(receiptRoot, names[0]), "utf8"));
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  child.emit("exit", 0, null);
  assert.deepEqual(await running, { code: 0, signal: null });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "kimi");
  assert.deepEqual(calls[0].argv.slice(0, 2), ["-p", "do the bounded task"]);
  assert.equal(calls[0].options.stdio, "inherit");
  assert.equal(receiptAtReady.pid, 4321);
  assert.equal(receiptAtReady.startIdentity, "linux-proc-stat:888");
  assert.equal(receiptAtReady.provider, "kimi");
  assert.equal(receiptAtReady.brief, undefined);
  assert.equal(receiptAtReady.argv, undefined);
  assert.equal(receiptAtReady.env, undefined);
  assert.deepEqual(child.kills, ["SIGSTOP", "SIGCONT"], "the child is released only after the durable receipt is established");
  assert.equal((await stat(receiptRoot)).mode & 0o777, 0o700);
  assert.equal((await readdir(receiptRoot)).length, 0, "normal completion removes only the owned receipt");
});

test("runKimiProcess forwards signals and transparently returns child exit state", async () => {
  const child = new FakeChild();
  const signals = new EventEmitter();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const running = runKimiProcess(await fixtureRequest(), {
    receiptRoot: await tempStore(),
    spawnProcess: () => child,
    readIdentity: () => "linux-proc-stat:999",
    signalSource: signals,
    onReceiptEstablished: readyResolve,
  });
  await ready;
  await new Promise((resolve) => setImmediate(resolve));
  signals.emit("SIGTERM");
  assert.deepEqual(child.kills, ["SIGSTOP", "SIGCONT", "SIGTERM"]);
  child.emit("exit", 17, null);
  assert.deepEqual(await running, { code: 17, signal: null });
  assert.equal(signals.listenerCount("SIGTERM"), 0);
});

test("runKimiProcess fails closed and cleans up when stable identity is unsupported", async () => {
  const receiptRoot = await tempStore();
  const child = new FakeChild();
  await assert.rejects(
    runKimiProcess(await fixtureRequest(), {
      receiptRoot,
      spawnProcess: () => child,
      readIdentity: () => null,
    }),
    /stable kernel process-start identity is unavailable/
  );
  assert.deepEqual(child.kills, ["SIGTERM"]);
  await assert.rejects(access(receiptRoot), { code: "ENOENT" });
});

test("runKimiProcess cleans the exact token-bound receipt after a child failure", async () => {
  const receiptRoot = await tempStore();
  const child = new FakeChild();
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const running = runKimiProcess(await fixtureRequest(), {
    receiptRoot,
    spawnProcess: () => child,
    readIdentity: () => "linux-proc-stat:1000",
    onReceiptEstablished: readyResolve,
  });
  await ready;
  child.emit("error", new Error("provider failed"));
  await assert.rejects(running, /provider failed/);
  assert.deepEqual(await readdir(receiptRoot), []);
});

test("normal completion never removes a receipt replaced with a different valid identity", async () => {
  const receiptRoot = await tempStore();
  const child = new FakeChild(4999);
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const running = runKimiProcess(await fixtureRequest(), {
    receiptRoot,
    spawnProcess: () => child,
    readIdentity: () => "linux-proc-stat:49990",
    onReceiptEstablished: readyResolve,
  });
  await ready;
  const [name] = await readdir(receiptRoot);
  const path = join(receiptRoot, name);
  const replacement = JSON.parse(await readFile(path, "utf8"));
  replacement.pid = 4998;
  replacement.startIdentity = "linux-proc-stat:49980";
  await writeFile(path, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });
  child.emit("exit", 0, null);
  await running;
  assert.deepEqual(await readdir(receiptRoot), [name]);
});

test("receipt reader authorizes matching rows, cleans dead/PID-reuse rows on reap, and never follows unsafe rows", async () => {
  const receiptRoot = await tempStore();
  const child = new FakeChild(5001);
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const running = runKimiProcess(await fixtureRequest(), {
    receiptRoot,
    spawnProcess: () => child,
    readIdentity: () => "linux-proc-stat:50010",
    onReceiptEstablished: readyResolve,
  });
  await ready;
  const [liveName] = await readdir(receiptRoot);
  const live = await readDispatchReceipts({
    receiptRoot,
    processes: [{ pid: 5001, startIdentity: "linux-proc-stat:50010" }],
  });
  assert.deepEqual(live.receipts, [{ pid: 5001, startIdentity: "linux-proc-stat:50010" }]);

  const legacy = join(receiptRoot, "receipt-11111111-1111-4111-8111-111111111111.json");
  const malformed = join(receiptRoot, "receipt-22222222-2222-4222-8222-222222222222.json");
  const linked = join(receiptRoot, "receipt-33333333-3333-4333-8333-333333333333.json");
  await writeFile(legacy, JSON.stringify({ pid: 77 }), { mode: 0o600 });
  await writeFile(malformed, "{not json", { mode: 0o600 });
  await symlink(liveName, linked);
  const reused = await readDispatchReceipts({
    receiptRoot,
    processes: [{ pid: 5001, startIdentity: "linux-proc-stat:50011" }],
    reap: true,
  });
  assert.deepEqual(reused.receipts, []);
  assert.deepEqual(reused.cleaned.map((row) => row.reason), ["process-identity-mismatch"]);
  assert.equal(reused.rejected.length, 3);
  assert.deepEqual((await readdir(receiptRoot)).sort(), [linked, legacy, malformed].map((p) => p.split("/").pop()).sort());

  const { zombies } = findZombieProcesses(
    [{ pid: 5001, ppid: 1, command: "kimi -p task", startIdentity: "linux-proc-stat:50011" }],
    { dispatchReceipts: reused.receipts }
  );
  assert.equal(zombies[0].reapable, false, "a stale PID-reuse receipt cannot authorize the new process");
  child.emit("exit", 0, null);
  await running;
});

test("receipt reader performs bounded crash-orphan cleanup without signaling", async () => {
  const receiptRoot = await tempStore();
  const child = new FakeChild(6001);
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const running = runKimiProcess(await fixtureRequest(), {
    receiptRoot,
    spawnProcess: () => child,
    readIdentity: () => "linux-proc-stat:60010",
    onReceiptEstablished: readyResolve,
  });
  await ready;
  const result = await readDispatchReceipts({
    receiptRoot,
    processes: [{ pid: 1, startIdentity: "linux-proc-stat:1" }],
    reap: true,
  });
  assert.deepEqual(result.receipts, []);
  assert.deepEqual(result.cleaned.map((row) => row.reason), ["process-dead"]);
  assert.deepEqual(await readdir(receiptRoot), []);
  child.emit("exit", 0, null);
  await running;
});

test("runHygiene consumes production receipts and preserves immediate pre-signal identity revalidation", async () => {
  const receiptRoot = await tempStore();
  const child = new FakeChild(7001);
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const running = runKimiProcess(await fixtureRequest(), {
    receiptRoot,
    spawnProcess: () => child,
    readIdentity: () => "linux-proc-stat:70010",
    onReceiptEstablished: readyResolve,
  });
  await ready;
  const processes = [{
    pid: 7001,
    ppid: 1,
    command: "kimi -p bounded",
    startedAt: 1,
    startIdentity: "linux-proc-stat:70010",
  }];
  const killed = [];
  const result = await runHygiene({
    processes,
    worktrees: [],
    reap: true,
    dispatchReceiptStore: ({ processes: snapshot, reap }) =>
      readDispatchReceipts({ receiptRoot, processes: snapshot, reap }),
    getProcessIdentity: () => "linux-proc-stat:70010",
    kill: (pid) => killed.push(pid),
  });
  assert.deepEqual(result.reapedProcesses.reaped, [7001]);
  assert.deepEqual(killed, [7001]);
  assert.equal(result.provenance.dispatchReceipts, 1);
  child.emit("exit", 0, null);
  await running;
});

test("readKernelStartIdentity exposes the current Linux process identity when supported", () => {
  const identity = readKernelStartIdentity(process.pid);
  if (process.platform === "linux") assert.match(identity, /^linux-proc-stat:\d+$/);
  else assert.equal(identity, null);
});

test("production CLI kimi-process-run supervises fixed kimi stdio/exit and removes its receipt", async () => {
  if (process.platform !== "linux") return;
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-cli-run-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const cwd = join(root, "work");
  await Promise.all([mkdir(bin), mkdir(home), mkdir(cwd)]);
  const fakeKimi = join(bin, "kimi");
  await writeFile(fakeKimi, "#!/usr/bin/env node\nsetTimeout(() => { process.stdout.write('transparent-child-output\\n'); process.exit(7); }, 50);\n");
  await chmod(fakeKimi, 0o755);
  const agentFile = join(cwd, "agent.md");
  await writeFile(agentFile, "---\nname: fixture\n---\n");
  let failure;
  try {
    await execFile(process.execPath, [
      CLI, "kimi-process-run",
      "--brief", "cli bounded task",
      "--agent-file", agentFile,
      "--cwd", cwd,
      "--lane", "primary",
    ], {
      env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
    });
  } catch (error) {
    failure = error;
  }
  assert.equal(failure?.code, 7);
  assert.equal(failure?.stdout, "transparent-child-output\n");
  assert.deepEqual(await readdir(join(home, ".muster", "dispatch-receipts")), []);
});
