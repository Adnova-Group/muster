import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { promisify } from "node:util";
import { chmod, copyFile, mkdir, mkdtemp, readFile, readdir, rename, symlink, writeFile } from "node:fs/promises";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDispatchReceipts,
  compactDispatchReceipts,
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

async function waitForFile(path) {
  for (let i = 0; i < 100; i += 1) {
    try {
      await readFile(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  assert.fail(`fixture did not create ${path}`);
}

async function currentDispatchCgroupPids() {
  if (typeof process.getuid !== "function") return [];
  const root = `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service`;
  const found = [];
  const visit = async (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("muster-dispatch-")) {
        try {
          const rows = (await readFile(join(path, "cgroup.procs"), "utf8")).trim().split(/\s+/);
          found.push(...rows.filter(Boolean).map(Number));
        } catch {}
      }
      await visit(path, depth + 1);
    }
  };
  await visit(root, 0);
  return [...new Set(found)];
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
  assert.ok(result.rejected.length <= 256, "the total directory walk is globally bounded");
  assert.equal(result.incompleteProvenance, true);
  assert.equal(result.truncated, true, "malformed-name flooding is reported as truncation");
});

test("diagnostic receipt compaction is bounded and cannot follow substituted entries", async () => {
  const receiptRoot = await tempStore();
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 200; i += 1) {
    const token = `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
    await writeFile(join(receiptRoot, `receipt-${token}.json`), "diagnostic", { mode: 0o600 });
  }
  for (let i = 0; i < 100; i += 1) {
    await writeFile(join(receiptRoot, `malformed-${i}`), "x", { mode: 0o600 });
  }
  const outside = join(dirname(receiptRoot), "outside");
  await writeFile(outside, "must survive");
  await symlink(outside, join(receiptRoot, "malformed-substitution"));
  const first = await compactDispatchReceipts({ receiptRoot });
  assert.ok(first.removed.length <= 256, "each compaction pass has bounded work");
  assert.equal(first.truncated, true);
  await compactDispatchReceipts({ receiptRoot });
  assert.ok((await readdir(receiptRoot)).length <= 128, "repeated bounded passes converge to the retention cap");
  assert.equal(await readFile(outside, "utf8"), "must survive", "compaction never follows a substituted symlink");
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

test("agent-file launch is bound to the opened descriptor across same-UID replacement", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const receiptRoot = await tempStore();
  const executableRoot = await mkdtemp(join(tmpdir(), "muster-kimi-agent-binding-"));
  const executable = join(executableRoot, "kimi");
  await writeFile(executable,
    `#!${process.execPath}\n` +
    "const fs=require('node:fs');const i=process.argv.indexOf('--agent-file');" +
    "process.exit(fs.readFileSync(process.argv[i+1],'utf8').includes('fixture')?31:32);\n");
  await chmod(executable, 0o755);
  const moved = `${fixture.agentFile}.old`;
  const result = await runKimiProcess(fixture, {
    receiptRoot,
    executable,
    beforeFinalSpawn: async () => {
      await rename(fixture.agentFile, moved);
      await writeFile(fixture.agentFile, "---\nname: substituted\n---\n");
    },
    onReceiptEstablished: async () => {},
  });
  assert.deepEqual(result, { code: 31, signal: null });
  assert.match(await readFile(moved, "utf8"), /name: fixture/);
});

test("agent-file descriptor is an immutable snapshot across same-inode mutation", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const executableRoot = await mkdtemp(join(tmpdir(), "muster-kimi-agent-snapshot-"));
  const executable = join(executableRoot, "kimi");
  await writeFile(executable,
    `#!${process.execPath}\nconst fs=require('node:fs');const i=process.argv.indexOf('--agent-file');` +
    "process.exit(fs.readFileSync(process.argv[i+1],'utf8').includes('fixture')?33:34);\n");
  await chmod(executable, 0o755);
  const result = await runKimiProcess(fixture, {
    receiptRoot: await tempStore(),
    executable,
    beforeFinalSpawn: async () => {
      await writeFile(fixture.agentFile, "---\nname: mutated-in-place\n---\n");
    },
  });
  assert.deepEqual(result, { code: 33, signal: null });
});

test("executable launch is bound to the opened descriptor across same-UID replacement", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-exec-binding-"));
  const executable = join(root, "kimi");
  const original = join(root, "kimi.original");
  await writeFile(executable, `#!${process.execPath}\nprocess.exit(11);\n`);
  await chmod(executable, 0o755);
  const result = await runKimiProcess(fixture, {
    receiptRoot: await tempStore(),
    executable,
    beforeFinalSpawn: async () => {
      await rename(executable, original);
      await writeFile(executable, `#!${process.execPath}\nprocess.exit(12);\n`);
      await chmod(executable, 0o755);
    },
  });
  assert.deepEqual(result, { code: 11, signal: null });
});

test("executable launch uses an immutable snapshot across same-inode mutation", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-exec-snapshot-"));
  const executable = join(root, "kimi");
  await writeFile(executable, `#!${process.execPath}\nprocess.exit(13);\n`);
  await chmod(executable, 0o755);
  const result = await runKimiProcess(fixture, {
    receiptRoot: await tempStore(),
    executable,
    beforeFinalSpawn: async () => {
      await writeFile(executable, `#!${process.execPath}\nprocess.exit(14);\n`);
      await chmod(executable, 0o755);
    },
  });
  assert.deepEqual(result, { code: 13, signal: null });
});

test("script launch pins and snapshots its absolute native shebang interpreter", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-interpreter-binding-"));
  const interpreter = join(root, "node");
  const originalInterpreter = join(root, "node.original");
  const executable = join(root, "kimi");
  await copyFile(process.execPath, interpreter);
  await chmod(interpreter, 0o755);
  await writeFile(executable, `#!${interpreter}\nprocess.exit(15);\n`);
  await chmod(executable, 0o755);
  const result = await runKimiProcess(fixture, {
    receiptRoot: await tempStore(),
    executable,
    beforeFinalSpawn: async () => {
      await rename(interpreter, originalInterpreter);
      await writeFile(interpreter, "replacement");
      await chmod(interpreter, 0o755);
    },
  });
  assert.deepEqual(result, { code: 15, signal: null });
});

test("cwd launch is bound to the opened directory across same-UID replacement", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const originalCwd = `${fixture.cwd}.original`;
  const executableRoot = await mkdtemp(join(tmpdir(), "muster-kimi-cwd-binding-"));
  const executable = join(executableRoot, "kimi");
  await writeFile(join(fixture.cwd, "identity"), "original");
  await writeFile(executable,
    `#!${process.execPath}\nconst fs=require('node:fs');` +
    "process.exit(fs.readFileSync('identity','utf8')==='original'?21:22);\n");
  await chmod(executable, 0o755);
  const result = await runKimiProcess(fixture, {
    receiptRoot: await tempStore(),
    executable,
    beforeFinalSpawn: async () => {
      await rename(fixture.cwd, originalCwd);
      await mkdir(fixture.cwd);
      await writeFile(join(fixture.cwd, "identity"), "replacement");
    },
  });
  assert.deepEqual(result, { code: 21, signal: null });
});

test("SIGINT, SIGTERM, and SIGHUP cancellation use bounded broker TERM-to-KILL cleanup", async () => {
  if (process.platform !== "linux") return;
  for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    const fixture = await fixtureRequest();
    const executableRoot = await mkdtemp(join(tmpdir(), "muster-kimi-cancel-"));
    const executable = join(executableRoot, "kimi");
    const pidFile = join(executableRoot, "target.pid");
    const signalSource = new EventEmitter();
    await writeFile(executable,
      `#!${process.execPath}\nconst fs=require('node:fs');` +
      `fs.writeFileSync(${JSON.stringify(pidFile)},fs.readFileSync('/proc/self/status','utf8').match(/^NSpid:\\s*(\\d+)/m)[1]);` +
      "process.on('SIGTERM',()=>{});process.on('SIGINT',()=>{});" +
      "process.on('SIGHUP',()=>{});setInterval(()=>{},1000);\n");
    await chmod(executable, 0o755);
    const started = Date.now();
    let containedPids = [];
    const running = runKimiProcess(fixture, {
      receiptRoot: await tempStore(),
      executable,
      signalSource,
      killTimeoutMs: 100,
      onReceiptEstablished: async () => {
        await waitForFile(pidFile);
        containedPids = await currentDispatchCgroupPids();
        assert.ok(containedPids.length > 0, `target entered cgroup before ${signal} cancellation`);
        signalSource.emit(signal);
      },
    });
    try {
      await assert.rejects(running, new RegExp(`cancel|${signal}|exited`, "i"));
      assert.ok(Date.now() - started < 3_000, `${signal} cancellation is bounded`);
      for (const pid of containedPids) {
        assert.throws(() => process.kill(pid, 0), /ESRCH/,
          `broker KILLs cgroup member ${pid} after ${signal}`);
      }
    } finally {
      for (const pid of containedPids) {
        try { process.kill(pid, "SIGKILL"); } catch {}
      }
    }
  }
});

test("cgroup cleanup kills a setsid descendant that escapes the launcher's process group", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const executableRoot = await mkdtemp(join(tmpdir(), "muster-kimi-descendant-"));
  const executable = join(executableRoot, "kimi");
  const pidFile = join(executableRoot, "descendant.pid");
  const source = join(executableRoot, "fixture.c");
  await writeFile(source, `
#include <fcntl.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/types.h>
#include <unistd.h>
int main(void) {
  pid_t child = fork();
  if (child < 0) return 90;
  if (child > 0) return 0;
  if (setsid() < 0) return 91;
  signal(SIGTERM, SIG_IGN);
  FILE *file = fopen(${JSON.stringify(pidFile)}, "w");
  if (!file) return 92;
  fprintf(file, "%d", getpid());
  fclose(file);
  for (;;) pause();
}
`);
  await execFile("cc", ["-O2", "-o", executable, source]);
  let containedPids = [];
  try {
    const result = await runKimiProcess(fixture, {
      receiptRoot: await tempStore(),
      executable,
      killTimeoutMs: 100,
      onReceiptEstablished: async () => {
        await waitForFile(pidFile);
        containedPids = await currentDispatchCgroupPids();
      },
    });
    assert.deepEqual(result, { code: 0, signal: null });
    assert.ok(containedPids.length > 1, "fixture populated the cgroup with a detached descendant");
    for (const pid of containedPids) {
      assert.throws(() => process.kill(pid, 0), /ESRCH/,
        `run completion waited for detached cgroup member ${pid}`);
    }
  } finally {
    for (const pid of containedPids) {
      try { process.kill(pid, "SIGKILL"); } catch {}
    }
  }
});

test("an unsupported/unpinnable shebang fails closed before untrusted launch", async () => {
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
  }), /ENOENT|spawn|stable Kimi process identity unavailable/);
  assert.ok(Date.now() - started < 5_000, "setup cleanup and direct-child wait are bounded");
});

test("receipt/setup failure never waits for a TERM-resistant target's natural exit", async () => {
  if (process.platform !== "linux") return;
  const fixture = await fixtureRequest();
  const executableRoot = await mkdtemp(join(tmpdir(), "muster-kimi-setup-failure-"));
  const executable = join(executableRoot, "kimi");
  await writeFile(executable,
    `#!${process.execPath}\nprocess.on('SIGTERM',()=>{});setInterval(()=>{},1000);\n`);
  await chmod(executable, 0o755);
  const started = Date.now();
  await assert.rejects(runKimiProcess(fixture, {
    receiptRoot: await tempStore(),
    executable,
    killTimeoutMs: 100,
    onReceiptEstablished: async () => { throw new Error("injected receipt publication failure"); },
  }), /injected receipt publication failure/);
  assert.ok(Date.now() - started < 3_000, "setup failure cleanup is bounded");
});

test("supervisor crash triggers detached-descendant cgroup cleanup", async () => {
  if (process.platform !== "linux") return;
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-crash-cleanup-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const cwd = join(root, "work");
  const pidFile = join(root, "descendant.pid");
  await Promise.all([mkdir(bin), mkdir(home), mkdir(cwd)]);
  const fakeKimi = join(bin, "kimi");
  const source = join(root, "fixture.c");
  await writeFile(source, `
#include <signal.h>
#include <stdio.h>
#include <sys/types.h>
#include <unistd.h>
int main(void) {
  pid_t child = fork();
  if (child < 0) return 90;
  if (child == 0) {
    if (setsid() < 0) return 91;
    signal(SIGTERM, SIG_IGN);
    FILE *file = fopen(${JSON.stringify(pidFile)}, "w");
    if (!file) return 92;
    fprintf(file, "%d", getpid());
    fclose(file);
    for (;;) pause();
  }
  signal(SIGTERM, SIG_IGN);
  for (;;) pause();
}
`);
  await execFile("cc", ["-O2", "-o", fakeKimi, source]);
  const agentFile = join(cwd, "agent.md");
  await writeFile(agentFile, "---\nname: fixture\n---\n");
  const supervisor = spawn(process.execPath, [
    CLI, "kimi-process-run", "--brief", "crash cleanup", "--agent-file", agentFile,
    "--cwd", cwd, "--lane", "primary",
  ], { env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` }, stdio: "ignore" });
  await waitForFile(pidFile);
  const containedPids = await currentDispatchCgroupPids();
  assert.ok(containedPids.length > 1, "fixture descendant started inside the contained cgroup");
  supervisor.kill("SIGKILL");
  await new Promise((resolveExit) => supervisor.once("exit", resolveExit));
  for (const pid of containedPids) {
    let terminal = false;
    for (let i = 0; i < 150 && !terminal; i += 1) {
      try {
        const statText = await readFile(`/proc/${pid}/stat`, "utf8");
        terminal = statText.slice(statText.lastIndexOf(")") + 1).trim().startsWith("Z ");
      } catch {
        terminal = true;
      }
      if (!terminal) await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    }
    assert.equal(terminal, true, `broker disconnect cleanup terminated cgroup member ${pid}`);
  }
});

test("production CLI kimi-process-run supervises fixed kimi stdio/exit and retains only a diagnostic receipt", async () => {
  if (process.platform !== "linux") return;
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-cli-run-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const cwd = join(root, "work");
  await Promise.all([mkdir(bin), mkdir(home), mkdir(cwd)]);
  const fakeKimi = join(bin, "kimi");
  await writeFile(fakeKimi, `#!${process.execPath}\nsetTimeout(() => { process.stdout.write('transparent-child-output\\n'); process.exit(7); }, 50);\n`);
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
