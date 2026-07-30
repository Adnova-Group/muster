import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, mkdtemp, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDispatchReceipts,
  readKernelStartIdentity,
  runKimiProcess,
  signalContainedGroup,
} from "../src/dispatch-receipts.js";
import { findZombieProcesses, runHygiene } from "../src/hygiene.js";

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

test("readKernelStartIdentity exposes the current Linux process identity when supported", () => {
  const identity = readKernelStartIdentity(process.pid);
  if (process.platform === "linux") assert.match(identity, /^linux-proc-stat:\d+$/);
  else assert.equal(identity, null);
});

test("PID-addressed group signaling revalidates both identity and group state", () => {
  for (const fixture of [
    { identity: "linux-proc-stat:changed", group: 9001 },
    { identity: "linux-proc-stat:bound", group: 9002 },
  ]) {
    let signaled = false;
    assert.throws(() => signalContainedGroup({
      pid: 9001,
      startIdentity: "linux-proc-stat:bound",
      signal: "SIGTERM",
    }, {
      readIdentity: () => fixture.identity,
      readGroup: () => fixture.group,
      kill: () => { signaled = true; },
    }), /identity\/state changed/);
    assert.equal(signaled, false);
  }
  const calls = [];
  signalContainedGroup({
    pid: 9001,
    startIdentity: "linux-proc-stat:bound",
    signal: "SIGTERM",
  }, {
    readIdentity: () => "linux-proc-stat:bound",
    readGroup: () => 9001,
    kill: (...args) => calls.push(args),
  });
  assert.deepEqual(calls, [[-9001, "SIGTERM"]]);
});

test("forged valid receipts are diagnostic only and never authorize hygiene signaling", async () => {
  const receiptRoot = await tempStore();
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const token = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  await writeFile(join(receiptRoot, `receipt-${token}.json`), JSON.stringify({
    format: "muster.dispatch-process",
    schemaVersion: 1,
    provider: "kimi",
    token,
    pid: 8123,
    startIdentity: "linux-proc-stat:81230",
    createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const diagnostic = await readDispatchReceipts({
    receiptRoot,
    processes: [{ pid: 8123, startIdentity: "linux-proc-stat:81230" }],
    processSnapshotComplete: true,
  });
  const { zombies } = findZombieProcesses([
    { pid: 8123, ppid: 1, command: "kimi -p forged", startIdentity: "linux-proc-stat:81230" },
  ], { dispatchReceipts: diagnostic.receipts });
  let signaled = false;
  const result = await runHygiene({
    processes: [{ pid: 8123, ppid: 1, command: "kimi -p forged", startIdentity: "linux-proc-stat:81230" }],
    worktrees: [],
    reap: true,
    zombieOptions: { dispatchReceipts: diagnostic.receipts },
    kill: () => { signaled = true; },
  });
  assert.equal(zombies[0].reapable, false);
  assert.equal(signaled, false);
  assert.deepEqual(result.reapedProcesses.reaped, []);
});

test("receipt enumeration filters malformed names before the cap and reports incomplete provenance", async () => {
  const receiptRoot = await tempStore();
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 300; i += 1) {
    await writeFile(join(receiptRoot, `000-malformed-${String(i).padStart(3, "0")}`), "x", { mode: 0o600 });
  }
  const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  await writeFile(join(receiptRoot, `receipt-${token}.json`), JSON.stringify({
    format: "muster.dispatch-process", schemaVersion: 1, provider: "kimi", token,
    pid: 8223, startIdentity: "linux-proc-stat:82230", createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const result = await readDispatchReceipts({ receiptRoot, processes: [] });
  assert.deepEqual(result.receipts, [{ pid: 8223, startIdentity: "linux-proc-stat:82230" }]);
  assert.equal(result.rejected.length, 300);
  assert.equal(result.incompleteProvenance, true);
  assert.equal(result.truncated, false, "invalid names do not consume the valid-receipt cap");
});

test("partial process snapshots never prove death or delete a diagnostic receipt", async () => {
  const receiptRoot = await tempStore();
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const token = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await writeFile(join(receiptRoot, `receipt-${token}.json`), JSON.stringify({
    format: "muster.dispatch-process", schemaVersion: 1, provider: "kimi", token,
    pid: 8323, startIdentity: "linux-proc-stat:83230", createdAt: new Date().toISOString(),
  }), { mode: 0o600 });
  const before = await readdir(receiptRoot);
  const result = await readDispatchReceipts({
    receiptRoot,
    processes: [{ pid: 1, startIdentity: "linux-proc-stat:1" }],
    processSnapshotComplete: false,
    reap: true,
  });
  assert.deepEqual(result.cleaned, []);
  assert.deepEqual(await readdir(receiptRoot), before);
  assert.equal(result.incompleteProvenance, true);
});

test("validated cwd and agent file identities are rechecked before final spawn", async () => {
  const fixture = await fixtureRequest();
  const receiptRoot = await tempStore();
  const moved = `${fixture.agentFile}.old`;
  let spawned = false;
  await assert.rejects(runKimiProcess(fixture, {
    receiptRoot,
    executable: process.execPath,
    beforeFinalSpawn: async () => {
      await rename(fixture.agentFile, moved);
      await writeFile(fixture.agentFile, "---\nname: substituted\n---\n");
    },
    spawnProcess: () => { spawned = true; throw new Error("must not spawn"); },
  }), /agent file identity changed|agentFile identity changed/);
  assert.equal(spawned, false);
});

test("final spawn uses the pinned absolute executable after PATH substitution", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-path-pin-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await Promise.all([mkdir(first), mkdir(second)]);
  await writeFile(join(first, "kimi"), "#!/usr/bin/env node\nprocess.exit(11);\n");
  await writeFile(join(second, "kimi"), "#!/usr/bin/env node\nprocess.exit(12);\n");
  await Promise.all([chmod(join(first, "kimi"), 0o755), chmod(join(second, "kimi"), 0o755)]);
  const dispatchEnv = { ...process.env, PATH: `${first}:${process.env.PATH}` };
  const result = await runKimiProcess(fixture, {
    receiptRoot: await tempStore(),
    env: dispatchEnv,
    beforeFinalSpawn: async () => { dispatchEnv.PATH = `${second}:${process.env.PATH}`; },
  });
  assert.deepEqual(result, { code: 11, signal: null });
});

test("broker setup failure is terminal only after the trusted launcher has been decisively awaited", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-bad-exec-"));
  const bad = join(root, "kimi");
  await writeFile(bad, "#!/definitely/missing/interpreter\n");
  await chmod(bad, 0o755);
  const started = Date.now();
  await assert.rejects(runKimiProcess(fixture, {
    receiptRoot: await tempStore(),
    executable: bad,
    killTimeoutMs: 100,
  }), /ENOENT|spawn/);
  assert.ok(Date.now() - started < 5_000, "setup cleanup and direct-child wait are bounded");
});

test("supervisor crash triggers descendant process-group cleanup", async () => {
  if (process.platform !== "linux") return;
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-crash-cleanup-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const cwd = join(root, "work");
  const pidFile = join(root, "descendant.pid");
  await Promise.all([mkdir(bin), mkdir(home), mkdir(cwd)]);
  const fakeKimi = join(bin, "kimi");
  await writeFile(fakeKimi,
    "#!/usr/bin/env node\n" +
    "const {spawn}=require('node:child_process');const fs=require('node:fs');" +
    "process.on('SIGTERM',()=>{});" +
    "const c=spawn(process.execPath,['-e',\"process.on('SIGTERM',()=>{});setInterval(()=>{},1000)\"],{stdio:'ignore'});" +
    `fs.writeFileSync(${JSON.stringify(pidFile)},String(c.pid));setInterval(()=>{},1000);\n`);
  await chmod(fakeKimi, 0o755);
  const agentFile = join(cwd, "agent.md");
  await writeFile(agentFile, "---\nname: fixture\n---\n");
  const supervisor = spawn(process.execPath, [
    CLI, "kimi-process-run", "--brief", "crash cleanup", "--agent-file", agentFile,
    "--cwd", cwd, "--lane", "primary",
  ], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" });
  let descendantPid = null;
  for (let i = 0; i < 100 && descendantPid === null; i += 1) {
    try {
      const bytes = await import("node:fs/promises").then(({ readFile }) => readFile(pidFile, "utf8"));
      descendantPid = Number(bytes);
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
  }
  assert.ok(descendantPid > 0, "fixture descendant started inside the contained group");
  supervisor.kill("SIGKILL");
  await new Promise((resolveExit) => supervisor.once("exit", resolveExit));
  let terminal = false;
  for (let i = 0; i < 150 && !terminal; i += 1) {
    try {
      const statText = await import("node:fs/promises").then(({ readFile }) =>
        readFile(`/proc/${descendantPid}/stat`, "utf8"));
      terminal = statText.slice(statText.lastIndexOf(")") + 1).trim().startsWith("Z ");
    } catch {
      terminal = true;
    }
    if (!terminal) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  assert.equal(terminal, true, "broker/launcher disconnect cleanup terminated the descendant group");
});

test("production CLI kimi-process-run supervises fixed kimi stdio/exit and retains only a diagnostic receipt", async () => {
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
  assert.equal((await readdir(join(home, ".muster", "dispatch-receipts"))).length, 1);
});
