import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";
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

test("strict config: valid config closes app-server stdin and emits zero model turns", async () => {
  const spawn = fakeSpawn();
  const result = await runCodexStrictConfigCheck({
    cwd: "/workspace/project",
    codexHome: "/workspace/codex-home",
    spawn,
    timeoutMs: 100
  });
  assert.deepEqual(result, { ok: true, modelTurnEvents: 0 });
  assert.equal(spawn.calls.length, 2, "shared config and otherwise-untrusted project config are both parsed");
  assert.deepEqual(spawn.calls[0].args, ["app-server", "--strict-config", "--listen", "stdio://"]);
  assert.equal(spawn.calls[0].options.cwd, "/workspace/project");
  assert.equal(spawn.calls[0].options.env.CODEX_HOME, "/workspace/codex-home");
  assert.equal(spawn.calls[0].child.stdin.writableEnded, true);
  assert.equal(spawn.calls[1].child.stdin.writableEnded, true);
});

test("strict config: unknown keys and malformed TOML preserve native file:line diagnostics", async t => {
  for (const diagnostic of [
    "Error: /tmp/config.toml:7:1: unknown configuration field `mystery`\n",
    "Error: /tmp/config.toml:9:4: unclosed table, expected `]`\n"
  ]) {
    await t.test(diagnostic.includes("unknown") ? "unknown key" : "malformed TOML", async () => {
      const spawn = fakeSpawn({ code: 1, stderr: diagnostic });
      await assert.rejects(
        runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 100 }),
        new RegExp(diagnostic.includes("unknown")
          ? String.raw`/tmp/config\.toml:7:1: unknown configuration field \x60mystery\x60`
          : String.raw`/tmp/config\.toml:9:4: unclosed table`)
      );
    });
  }
});

test("strict config: parser absence, timeout, capped output, and model-turn events fail closed", async t => {
  await t.test("missing app-server", async () => {
    const spawn = fakeSpawn({ code: 2, stderr: "error: unrecognized subcommand 'app-server'\n" });
    await assert.rejects(runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 100 }), /unrecognized subcommand 'app-server'/);
  });
  await t.test("timeout", async () => {
    const spawn = fakeSpawn({ hang: true });
    await assert.rejects(runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 5 }), /timed out after 5ms/);
    assert.equal(spawn.calls[0].child.killed, true);
  });
  await t.test("output cap counts bytes", async () => {
    const spawn = fakeSpawn({ stdout: "€".repeat(30_000) });
    await assert.rejects(runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 100 }), /65536-byte stdout limit/);
  });
  await t.test("model-turn event", async () => {
    const spawn = fakeSpawn({ stdout: '{"method":"turn/started","params":{}}\n' });
    await assert.rejects(runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn, timeoutMs: 100 }), /model-turn event/);
  });
});

test("strict config: waits for drained streams before accepting zero model turns", async () => {
  const baseSpawn = fakeSpawn();
  const delayedSpawn = (command, args, options) => {
    const child = baseSpawn(command, args, options);
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
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd: "/tmp/project", codexHome: "/tmp", spawn: delayedSpawn, timeoutMs: 100 }),
    /model-turn event/
  );
});

test("strict config: real Codex validates unknown and malformed config without a model turn", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-strict-real-"));
  const cwd = join(tmp, "project"), codexHome = join(tmp, "codex-home");
  await mkdir(join(cwd, ".codex"), { recursive: true });
  await mkdir(codexHome);
  await writeFile(join(codexHome, "config.toml"), "model = \"gpt-5.6-sol\"\n");

  const valid = await runCodexStrictConfigCheck({ cwd, codexHome, timeoutMs: 2_500 });
  assert.deepEqual(valid, { ok: true, modelTurnEvents: 0 });

  await writeFile(join(cwd, ".codex", "config.toml"), "unknown_muster_key = true\n");
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd, codexHome, timeoutMs: 2_500 }),
    new RegExp(`${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codex/config\\.toml:1:1: unknown configuration field`)
  );

  await writeFile(join(cwd, ".codex", "config.toml"), "[broken\nkey = true\n");
  await assert.rejects(
    runCodexStrictConfigCheck({ cwd, codexHome, timeoutMs: 2_500 }),
    new RegExp(`project config file ${cwd.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/\\.codex/config\\.toml: TOML parse error at line 1, column 8`)
  );
});

test("strict config: install validates the complete write and restores config bytes on failure", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-strict-install-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), codexHome = join(home, ".codex");
  const sharedPath = join(codexHome, "config.toml"), projectPath = join(cwd, ".codex", "config.toml");
  const sharedOriginal = Buffer.from("model = \"gpt-5.6-sol\"\r\n# preserve shared bytes\r\n");
  const projectOriginal = Buffer.from("model = \"project-choice\"\r\n# preserve project bytes\r\n");
  await mkdir(codexHome, { recursive: true });
  await mkdir(join(cwd, ".codex"), { recursive: true });
  await writeFile(sharedPath, sharedOriginal);
  await writeFile(projectPath, projectOriginal);

  let observedCompleteWrite = false;
  await assert.rejects(
    runCodexInstall({
      cwd, home, repoRoot,
      execFile: async () => { throw new Error("codex absent"); },
      strictConfigRunner: async () => {
        const shared = await readFile(sharedPath, "utf8");
        const project = await readFile(projectPath, "utf8");
        observedCompleteWrite = /max_concurrent_threads_per_session/.test(shared)
          && /muster managed agent declarations/.test(project);
        throw new Error(`${projectPath}:2:1: unknown configuration field \`future_typo\``);
      }
    }),
    /config\.toml:2:1: unknown configuration field `future_typo`/
  );
  assert.equal(observedCompleteWrite, true, "validation must run after all config mutations are on disk");
  assert.deepEqual(await readFile(sharedPath), sharedOriginal);
  assert.deepEqual(await readFile(projectPath), projectOriginal);
  await assert.rejects(readFile(join(cwd, ".codex", "agents", ".muster-managed.json")), /ENOENT/);
});

test("strict config: doctor reports the same non-billable parser boundary", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-strict-doctor-"));
  const cwd = join(tmp, "project"), codexHome = join(tmp, "codex-home");
  let calls = 0;
  const report = await runCodexDoctor({
    root: repoRoot,
    cwd,
    codexHome,
    execFile: async () => { throw new Error("codex absent"); },
    strictConfigRunner: async options => {
      calls++;
      assert.equal(options.cwd, cwd);
      assert.equal(options.codexHome, codexHome);
      throw new Error("Codex app-server strict config validation timed out after 2500ms");
    }
  });
  assert.equal(calls, 1);
  const check = report.checks.find(item => item.name === "codex-config-strict");
  assert.equal(check?.ok, false);
  assert.match(check?.detail || "", /timed out after 2500ms/);
});
