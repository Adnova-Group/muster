import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  readDispatchReceipts,
  runKimiProcess,
} from "../src/dispatch-receipts.js";
import { findZombieProcesses, runHygiene } from "../src/hygiene.js";

const execFile = promisify(execFileCb);
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CLI = join(REPO_ROOT, "src", "cli.js");
const DISPATCH_MODULE = join(REPO_ROOT, "src", "dispatch-receipts.js");
const tempStore = async () =>
  join(await mkdtemp(join(tmpdir(), "muster-dispatch-receipts-")), "receipts");

async function fixtureRequest() {
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-run-"));
  const agentFile = join(root, "agent.md");
  await writeFile(agentFile, "---\nname: fixture\n---\n");
  return {
    brief: "do the bounded task",
    agentFile,
    cwd: root,
    lane: "primary",
  };
}

async function currentDispatchCgroups() {
  if (typeof process.getuid !== "function") return [];
  const root =
    `/sys/fs/cgroup/user.slice/user-${process.getuid()}.slice/user@${process.getuid()}.service`;
  const found = [];
  const visit = async (directory, depth) => {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const path = join(directory, entry.name);
      if (entry.name.startsWith("muster-dispatch-")) found.push(path);
      await visit(path, depth + 1);
    }
  };
  await visit(root, 0);
  return found.sort();
}

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
  const processes = [
    { pid: 8123, ppid: 1, command: "kimi -p forged", startIdentity: "linux-proc-stat:81230" },
  ];
  const { zombies } = findZombieProcesses(processes, {
    dispatchReceipts: diagnostic.receipts,
  });
  let signaled = false;
  const result = await runHygiene({
    processes,
    worktrees: [],
    reap: true,
    zombieOptions: { dispatchReceipts: diagnostic.receipts },
    kill: () => {
      signaled = true;
    },
  });
  assert.equal(zombies[0].reapable, false);
  assert.equal(signaled, false);
  assert.deepEqual(result.reapedProcesses.reaped, []);
});

test("receipt enumeration is bounded and reports malformed-name provenance", async () => {
  const receiptRoot = await tempStore();
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  for (let i = 0; i < 300; i += 1) {
    await writeFile(
      join(receiptRoot, `000-malformed-${String(i).padStart(3, "0")}`),
      "x",
      { mode: 0o600 },
    );
  }
  const result = await readDispatchReceipts({ receiptRoot, processes: [] });
  assert.ok(result.rejected.length <= 256);
  assert.equal(result.incompleteProvenance, true);
  assert.equal(result.truncated, true);
  assert.deepEqual(result.cleaned, []);
});

test("receipt reads reject symlinks without following their target", async () => {
  const receiptRoot = await tempStore();
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const token = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const outside = join(dirname(receiptRoot), "outside");
  await writeFile(outside, "must survive");
  await symlink(outside, join(receiptRoot, `receipt-${token}.json`));
  const result = await readDispatchReceipts({ receiptRoot, processes: [] });
  assert.equal(result.receipts.length, 0);
  assert.equal(result.rejected.length, 1);
  assert.equal(await readFile(outside, "utf8"), "must survive");
});

test("partial process snapshots never prove death or delete diagnostic receipts", async () => {
  const receiptRoot = await tempStore();
  await mkdir(receiptRoot, { recursive: true, mode: 0o700 });
  const token = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  await writeFile(join(receiptRoot, `receipt-${token}.json`), JSON.stringify({
    format: "muster.dispatch-process",
    schemaVersion: 1,
    provider: "kimi",
    token,
    pid: 8323,
    startIdentity: "linux-proc-stat:83230",
    createdAt: new Date().toISOString(),
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

test("runKimiProcess rejects before injected spawn, receipt, hook, or signal capabilities", async () => {
  const fixture = await fixtureRequest();
  const receiptRoot = await tempStore();
  let spawnCalls = 0;
  let hookCalls = 0;
  let signalCalls = 0;
  const signalSource = {
    on() {
      signalCalls += 1;
    },
    off() {
      signalCalls += 1;
    },
  };

  await assert.rejects(runKimiProcess(fixture, {
    receiptRoot,
    signalSource,
    spawnProcess: () => {
      spawnCalls += 1;
    },
    beforeFinalSpawn: async () => {
      hookCalls += 1;
    },
    onReceiptEstablished: async () => {
      hookCalls += 1;
    },
  }), /Kimi process dispatch is report-only: trusted broker bootstrap is unavailable/);

  assert.equal(spawnCalls, 0);
  assert.equal(hookCalls, 0);
  assert.equal(signalCalls, 0);
  await assert.rejects(readdir(receiptRoot), /ENOENT/);
});

test("dispatch receipt module exposes only diagnostic read and report-only run APIs", async () => {
  const module = await import("../src/dispatch-receipts.js");
  assert.deepEqual(Object.keys(module).sort(), ["readDispatchReceipts", "runKimiProcess"]);
});

test("internal broker and launcher modes cannot bypass report-only dispatch", async () => {
  for (const mode of ["--broker", "--launcher"]) {
    await assert.rejects(execFile(process.execPath, [DISPATCH_MODULE, mode]), (error) => {
      assert.notEqual(error.code, 0);
      assert.equal(
        error.stderr,
        "Kimi process dispatch is report-only: trusted broker bootstrap is unavailable\n",
      );
      return true;
    });
  }
});

test("symlinked broker and launcher modes remain report-only", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-dispatch-module-link-"));
  const linkedModule = join(root, "dispatch-receipts.js");
  await symlink(DISPATCH_MODULE, linkedModule);

  for (const mode of ["--broker", "--launcher"]) {
    await assert.rejects(execFile(process.execPath, [linkedModule, mode]), (error) => {
      assert.notEqual(error.code, 0);
      assert.equal(
        error.stderr,
        "Kimi process dispatch is report-only: trusted broker bootstrap is unavailable\n",
      );
      return true;
    });
  }
});

test("CLI kimi-process-run creates no Kimi marker, receipt, or dispatch cgroup", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-kimi-cli-report-only-"));
  const bin = join(root, "bin");
  const home = join(root, "home");
  const cwd = join(root, "work");
  const marker = join(root, "kimi-ran");
  await Promise.all([mkdir(bin), mkdir(home), mkdir(cwd)]);
  const fakeKimi = join(bin, "kimi");
  await writeFile(
    fakeKimi,
    `#!${process.execPath}\nrequire("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran");\n`,
  );
  await chmod(fakeKimi, 0o755);
  const agentFile = join(cwd, "agent.md");
  await writeFile(agentFile, "---\nname: fixture\n---\n");
  const cgroupsBefore = await currentDispatchCgroups();

  await assert.rejects(execFile(process.execPath, [
    CLI,
    "kimi-process-run",
    "--brief",
    "must remain report-only",
    "--agent-file",
    agentFile,
    "--cwd",
    cwd,
    "--lane",
    "primary",
  ], {
    env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}` },
  }), (error) => {
    assert.notEqual(error.code, 0);
    assert.match(
      error.stderr,
      /Kimi process dispatch is report-only: trusted broker bootstrap is unavailable/,
    );
    return true;
  });

  await assert.rejects(readFile(marker), /ENOENT/);
  await assert.rejects(readdir(join(home, ".muster", "dispatch-receipts")), /ENOENT/);
  assert.deepEqual(await currentDispatchCgroups(), cgroupsBefore);
});
