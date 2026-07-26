import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCodexStrictConfigCheck } from "../src/codex-strict-config.js";
import { runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

function fakeSpawn({ code = 0, stderr = "", stdout = "", hang = false } = {}) {
  const calls = [];
  const spawn = (command, args, options) => {
    const child = new EventEmitter();
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.killed = false;
    child.kill = signal => {
      child.killed = true;
      queueMicrotask(() => child.emit("close", null, signal));
      return true;
    };
    calls.push({ command, args, options, child });
    child.stdin.on("finish", () => {
      if (hang) return;
      queueMicrotask(() => {
        if (stdout) child.stdout.write(stdout);
        if (stderr) child.stderr.write(stderr);
        child.stdout.end();
        child.stderr.end();
        child.emit("exit", code, null);
        queueMicrotask(() => child.emit("close", code, null));
      });
    });
    return child;
  };
  spawn.calls = calls;
  return spawn;
}

test("strict config: valid config uses app-server stdio with closed stdin and zero model-turn events", async () => {
  const spawn = fakeSpawn();
  const result = await runCodexStrictConfigCheck({
    cwd: "/workspace/project",
    codexHome: "/workspace/codex-home",
    spawn,
    timeoutMs: 100
  });
  assert.deepEqual(result, { ok: true, modelTurnEvents: 0 });
  assert.equal(spawn.calls.length, 2, "shared config and non-persistently trusted project config are both parsed");
  assert.deepEqual(spawn.calls[0].args, ["app-server", "--strict-config", "--listen", "stdio://"]);
  assert.equal(spawn.calls[0].options.cwd, "/workspace/project");
  assert.equal(spawn.calls[0].options.env.CODEX_HOME, "/workspace/codex-home");
  assert.equal(spawn.calls[0].child.stdin.writableEnded, true);
  assert.equal(spawn.calls[1].child.stdin.writableEnded, true);
});

test("strict config: unknown key preserves Codex file:line diagnostics", async () => {
  const spawn = fakeSpawn({ code: 1, stderr: "error: unknown key `mystery`\n  --> /tmp/config.toml:7:1\n" });
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 100 }),
    /unknown key `mystery`[\s\S]*\/tmp\/config\.toml:7:1/
  );
});

test("strict config: missing app-server support fails loudly", async () => {
  const spawn = fakeSpawn({ code: 2, stderr: "error: unrecognized subcommand 'app-server'\n" });
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 100 }),
    /app-server[\s\S]*unrecognized subcommand/
  );
});

test("strict config: bounded timeout kills the parser process", async () => {
  const spawn = fakeSpawn({ hang: true });
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 5 }),
    /timed out after 5ms/
  );
  assert.equal(spawn.calls[0].child.killed, true);
});

test("strict config: any model-turn event is rejected", async () => {
  const spawn = fakeSpawn({ stdout: '{"method":"turn/started","params":{}}\n' });
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 100 }),
    /model-turn event/
  );
});

test("strict config: waits for drained streams after exit before accepting", async () => {
  const spawn = fakeSpawn();
  const original = spawn.calls;
  const delayedSpawn = (command, args, options) => {
    const child = spawn(command, args, options);
    child.stdin.removeAllListeners("finish");
    child.stdin.on("finish", () => queueMicrotask(() => {
      child.emit("exit", 0, null);
      child.stdout.write('{"method":"turn/started","params":{}}\n');
      child.stdout.end();
      child.stderr.end();
      queueMicrotask(() => child.emit("close", 0, null));
    }));
    return child;
  };
  delayedSpawn.calls = original;
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn: delayedSpawn, timeoutMs: 100 }),
    /model-turn event/
  );
});

test("strict config: output cap counts UTF-8 bytes, not JavaScript characters", async () => {
  const spawn = fakeSpawn({ stdout: "€".repeat(30_000) });
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 100 }),
    /65536-byte stdout limit/
  );
});

test("strict config: real app-server validates an otherwise-untrusted project config in place", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-strict-real-project-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), codexHome = join(tmp, "codex-home");
  await mkdir(join(cwd, ".codex"), { recursive: true });
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), "[agents]\nmax_threads = 12\nmax_depth = 2\n");
  await writeFile(join(cwd, ".codex", "config.toml"), "unknown_muster_key = true\n");
  try {
    await runCodexStrictConfigCheck({ cwd, codexHome, timeoutMs: 2_500 });
    assert.fail("unknown project config key must fail");
  } catch (error) {
    if (/could not start:.*(?:ENOENT|not found)/i.test(error.message)) {
      t.skip("Codex CLI is not installed");
      return;
    }
    assert.match(error.message, new RegExp(`${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codex/config\\.toml:1:1`));
    assert.match(error.message, /unknown configuration field `unknown_muster_key`/);
  }
});

test("strict config: install validates after the complete config write and rolls the transaction back on failure", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-strict-install-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  await mkdir(codexHome, { recursive: true });
  const original = "model = \"gpt-5.6\"\n";
  await writeFile(join(codexHome, "config.toml"), original);
  let observed = "";
  const strictConfigRunner = async () => {
    observed = `${await readFile(join(codexHome, "config.toml"), "utf8")}\n${await readFile(join(cwd, ".codex", "config.toml"), "utf8")}`;
    throw new Error("config.toml:9:1: unknown key `future_typo`");
  };
  await assert.rejects(
    runCodexInstall({
      cwd, home, repoRoot,
      execFile: async () => { throw new Error("codex absent"); },
      strictConfigRunner
    }),
    /config\.toml:9:1: unknown key `future_typo`/
  );
  assert.match(observed, /\[agents\][\s\S]*muster managed agent declarations/);
  assert.equal(await readFile(join(codexHome, "config.toml"), "utf8"), original);
  await assert.rejects(readFile(join(cwd, ".codex", "agents", ".muster-managed.json"), "utf8"), /ENOENT/);
});

test("strict config: doctor reuses the same bounded parser check", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-strict-doctor-"));
  t.after(() => import("node:fs/promises").then(fs => fs.rm(tmp, { recursive: true, force: true })));
  const cwd = join(tmp, "project"), codexHome = join(tmp, "codex-home");
  let called = 0;
  const report = await runCodexDoctor({
    root: repoRoot,
    cwd,
    codexHome,
    execFile: async () => { throw new Error("codex absent"); },
    strictConfigRunner: async options => {
      called++;
      assert.equal(options.cwd, cwd);
      assert.equal(options.codexHome, codexHome);
      throw new Error("Codex app-server strict config validation timed out after 2500ms");
    }
  });
  assert.equal(called, 1);
  const check = report.checks.find(item => item.name === "codex-config-strict");
  assert.equal(check?.ok, false);
  assert.match(check?.detail || "", /timed out after 2500ms/);
});
