import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
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
  const projectReceipt = await readChatgptWorkConfig({ scope: "project", cwd: project, home });
  assert.deepEqual({
    format: projectReceipt.format, owner: projectReceipt.owner,
    connectionId: projectReceipt.connectionId, profile: projectReceipt.profile,
    allowFullActions: projectReceipt.allowFullActions,
  }, {
    format: 2, owner: "muster", connectionId: "asdk_app_Project1",
    profile: "pro-safe", allowFullActions: false,
  });
  assert.match(projectReceipt.cacheKey, /^[a-f0-9]{64}$/);
  assert.match(projectResult.configPath, /[\/\\]\.git[\/\\]muster[\/\\]chatgpt-work\.json$/);

  await assert.rejects(
    runChatgptWorkInstall({ connectionId: "asdk_app_User1", profile: "full", scope: "user", cwd: project, home }),
    /allow-full-actions/i,
  );
  const userResult = await runChatgptWorkInstall({
    connectionId: "asdk_app_User1", profile: "full", allowFullActions: true,
    scope: "user", cwd: project, home,
  });
  assert.match(userResult.configPath, /[\/\\]\.muster[\/\\]chatgpt-work\.json$/);
  assert.equal(projectResult.pluginPath, join(project, ".agents", "plugins", "plugin"));
  assert.equal(userResult.pluginPath, join(home, ".agents", "plugins", "plugin"));
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

test("probe startup fails before MCP output for invalid or pre-existing attestation targets", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-probe-start-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const attestation = join(dir, "server-attestation.json");
  const base = {
    MUSTER_CHATGPT_WORK_PROFILE: "pro-safe",
    MUSTER_CHATGPT_WORK_PROBE_NONCE: "a".repeat(32),
    MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH: attestation,
  };
  for (const env of [
    { ...base, MUSTER_CHATGPT_WORK_PROFILE: "full" },
    { ...base, MUSTER_CHATGPT_WORK_PROBE_NONCE: "A".repeat(32) },
    { ...base, MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH: join(dir, "wrong.json") },
    { ...base, MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH: "server-attestation.json" },
  ]) {
    const result = await serverExit(env);
    assert.notEqual(result.code, 0);
    assert.equal(result.stdout, "");
  }
  await writeFile(attestation, "{}\n", { mode: 0o600 });
  const existing = await serverExit(base);
  assert.notEqual(existing.code, 0);
  assert.equal(existing.stdout, "");
});

test("bundled runtime installs a scope-correct neutral Work plugin without source build scripts", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-bundled-"));
  const project = join(dir, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(root, ".agents", "plugins", "plugin", "runtime", "muster.mjs");
  const { stdout } = await execFile(process.execPath, [
    cli, "install", "chatgpt-work", "--connection-id", "asdk_app_Bundled1",
    "--profile", "pro-safe", "--scope", "project",
  ], { cwd: project, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || tmpdir() } });
  const result = JSON.parse(stdout);
  assert.equal(result.pluginPath, join(project, ".agents", "plugins", "plugin"));
  const manifest = JSON.parse(await readFile(join(result.pluginPath, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.apps, "./.app.json");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.skills, undefined);
  assert.equal(manifest.interface.defaultPrompt, "Use the available Muster tools.");
  assert.deepEqual(manifest.interface.capabilities, ["Tools"]);
  assert.doesNotMatch(JSON.stringify(manifest.interface), /Codex|Read|Write/);
  assert.match(manifest.interface.longDescription, /tool-only.*ChatGPT Work/i);
  const server = await readFile(join(result.pluginPath, "runtime", "chatgpt-work-server.mjs"), "utf8");
  assert.match(server, /MUSTER_MCP_HOST/);
  assert.doesNotMatch(server, /work-mcp\.mjs/);
  assert.doesNotMatch(server, /muster-mcp\.mjs/);
});

test("installer cache identity revokes full opt-in on full to pro-safe transition", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-transition-"));
  const project = join(dir, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  t.after(() => rm(dir, { recursive: true, force: true }));
  const common = { connectionId: "asdk_app_Transition1", scope: "project", cwd: project, home: join(dir, "home") };
  const full = await runChatgptWorkInstall({ ...common, profile: "full", allowFullActions: true });
  assert.equal(JSON.parse(await readFile(join(full.pluginPath, ".mcp.json"), "utf8")).mcpServers.muster.env.MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS, "1");
  const safe = await runChatgptWorkInstall({ ...common, profile: "pro-safe" });
  assert.equal(JSON.parse(await readFile(join(safe.pluginPath, ".mcp.json"), "utf8")).mcpServers.muster.env, undefined);
  assert.equal((await readChatgptWorkConfig({ scope: "project", cwd: project })).profile, "pro-safe");
});

test("symlinked marketplace ancestry fails before receipt mutation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-symlink-"));
  const project = join(dir, "project");
  await mkdir(join(project, ".git"), { recursive: true });
  await mkdir(join(dir, "redirect"), { recursive: true });
  await symlink(join(dir, "redirect"), join(project, ".agents"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(runChatgptWorkInstall({
    connectionId: "asdk_app_Symlink1", profile: "pro-safe", scope: "project", cwd: project,
  }), /ordinary directories/);
  assert.equal(await readChatgptWorkConfig({ scope: "project", cwd: project }), null);
});

test("probe identity validates installed app bytes and consumes nonce durably across restarts", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-probe-restart-"));
  await chmod(dir, 0o700);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const connectionId = "asdk_app_Restart1";
  const appPath = join(dir, ".app.json");
  await writeFile(appPath, JSON.stringify({ apps: { muster: { id: connectionId } } }) + "\n", { mode: 0o600 });
  const env = {
    MUSTER_CHATGPT_WORK_PROFILE: "pro-safe",
    MUSTER_CHATGPT_WORK_PROBE_NONCE: "d".repeat(32),
    MUSTER_CHATGPT_WORK_PROBE_ATTESTATION_PATH: join(dir, "server-attestation.json"),
    MUSTER_CHATGPT_WORK_CONNECTION_ID: connectionId,
    MUSTER_CHATGPT_WORK_APP_JSON_PATH: appPath,
    MUSTER_CHATGPT_WORK_PLUGIN_VERSION: "0.5.0",
    MUSTER_CHATGPT_WORK_CONNECTION_LABEL: "Muster Restart Probe",
  };
  assert.equal((await serverExit(env)).code, 0);
  const replay = await serverExit(env);
  assert.notEqual(replay.code, 0);
  assert.equal(replay.stdout, "");
  assert.match(replay.stderr, /nonce\/instance state rejected/);
});
