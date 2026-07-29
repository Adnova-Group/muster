import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  normalizeChatgptWorkConnectionId,
  runChatgptWorkInstall,
  readChatgptWorkConfig,
  readOptionalChatgptWorkConfig,
} from "../src/chatgpt-work-install.js";

const execFile = promisify(execFileCb);
const root = new URL("../", import.meta.url).pathname;

test("connection IDs normalize only an initial plugin_ and otherwise fail closed", () => {
  assert.equal(normalizeChatgptWorkConnectionId("asdk_app_Abc-123_x"), "asdk_app_Abc-123_x");
  assert.equal(normalizeChatgptWorkConnectionId("plugin_asdk_app_Abc-123_x"), "asdk_app_Abc-123_x");
  for (const invalid of ["", "plugin_plugin_asdk_app_a", "xasdk_app_a", "ASDK_APP_a", "asdk_app_", "asdk_app_a b"]) {
    assert.throws(() => normalizeChatgptWorkConnectionId(invalid), /connection id/i);
  }
});

test("installer supports project/user scopes, dry-run, persistence, and full opt-in", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-install-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(home, { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));

  const dry = await runChatgptWorkInstall({
    connectionId: "plugin_asdk_app_Project1", profile: "pro-safe",
    scope: "project", dryRun: true, cwd: project, home,
  });
  assert.equal(dry.connectionId, "asdk_app_Project1");
  await assert.rejects(stat(dry.configPath), /ENOENT/);

  const projectResult = await runChatgptWorkInstall({
    connectionId: "asdk_app_Project1", profile: "pro-safe",
    scope: "project", cwd: project, home,
  });
  assert.deepEqual(await readChatgptWorkConfig({ scope: "project", cwd: project, home }), {
    format: 1, owner: "muster", connectionId: "asdk_app_Project1",
    profile: "pro-safe", allowFullActions: false,
  });
  assert.match(projectResult.configPath, /[\/\\]\.git[\/\\]muster[\/\\]chatgpt-work\.json$/);

  await assert.rejects(
    runChatgptWorkInstall({ connectionId: "asdk_app_User1", profile: "full", scope: "user", cwd: project, home }),
    /allow-full-actions/i,
  );
  const userResult = await runChatgptWorkInstall({
    connectionId: "asdk_app_User1", profile: "full", allowFullActions: true,
    scope: "user", cwd: project, home,
  });
  assert.match(userResult.configPath, /[\/\\]\.codex[\/\\]muster[\/\\]chatgpt-work\.json$/);
});

test("CLI install chatgpt-work validates flags and dry-run emits no receipt", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-cli-"));
  await mkdir(join(dir, ".git"), { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const { stdout } = await execFile(process.execPath, [
    join(root, "src", "cli.js"), "install", "chatgpt-work",
    "--connection-id", "plugin_asdk_app_Cli1", "--profile", "pro-safe",
    "--scope", "project", "--dry-run",
  ], { cwd: dir, env: { ...process.env, CODEX_HOME: join(dir, "codex-home") } });
  const result = JSON.parse(stdout);
  assert.equal(result.connectionId, "asdk_app_Cli1");
  await assert.rejects(stat(result.configPath), /ENOENT/);
});

test("ordinary Codex preservation lookup is optional outside Git while explicit project install still fails", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-non-git-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  assert.equal(
    await readOptionalChatgptWorkConfig({ scope: "project", cwd: dir, home: join(dir, "home") }),
    null,
  );
  await assert.rejects(
    runChatgptWorkInstall({
      connectionId: "asdk_app_Explicit1", profile: "pro-safe",
      scope: "project", cwd: dir, home: join(dir, "home"),
    }),
    /project scope requires a Git worktree/,
  );
});

function serverExit(env, input = "") {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(root, "cowork", "chatgpt-work-server.mjs")], {
      cwd: root, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "", stderr = "";
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", code => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("dedicated server fails before MCP output without known profile and full double opt-in", async () => {
  for (const env of [
    {},
    { MUSTER_CHATGPT_WORK_PROFILE: "unknown" },
    { MUSTER_CHATGPT_WORK_PROFILE: "full", MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS: "1" },
    { MUSTER_CHATGPT_WORK_PROFILE: "full", MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS: "1" },
  ]) {
    const result = await serverExit(env);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
  }
});

test("dedicated full server starts only with both opt-ins and lists all 28 tools", async () => {
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  ].join("\n") + "\n";
  const result = await serverExit({
    MUSTER_CHATGPT_WORK_PROFILE: "full",
    MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS: "1",
    MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS: "1",
  }, input);
  assert.equal(result.code, 0);
  const messages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(messages.find(message => message.id === 2).result.tools.length, 28);
});
