import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  normalizeChatgptWorkConnectionId,
  runChatgptWorkInstall,
  readChatgptWorkConfig,
} from "../src/chatgpt-work-install.js";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

const execFile = promisify(execFileCb);
const root = new URL("../", import.meta.url).pathname;

async function initGit(project, { separateGitDir } = {}) {
  await mkdir(project, { recursive: true });
  const args = separateGitDir
    ? ["init", "--separate-git-dir", separateGitDir, project]
    : ["init", project];
  await execFile("git", args, { env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" } });
}

test("connection IDs normalize only an initial plugin_ and otherwise fail closed", () => {
  assert.equal(normalizeChatgptWorkConnectionId("asdk_app_Abc-123_x"), "asdk_app_Abc-123_x");
  assert.equal(normalizeChatgptWorkConnectionId("plugin_asdk_app_Abc-123_x"), "asdk_app_Abc-123_x");
  for (const invalid of ["", "plugin_plugin_asdk_app_a", "xasdk_app_a", "ASDK_APP_a", "asdk_app_", "asdk_app_a b",
    123, null, undefined, { id: "asdk_app_a" }]) {
    assert.throws(() => normalizeChatgptWorkConnectionId(invalid), /connection id/i);
  }
});

test("installer supports project/user scopes, dry-run, persistence, and full opt-in", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-install-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  await initGit(project);
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
    format: 3, owner: "muster", connectionId: "asdk_app_Project1",
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
  assert.equal(projectResult.pluginPath, join(project, ".agents", "plugins", "muster-chatgpt-work"));
  assert.equal(userResult.pluginPath, join(home, ".agents", "plugins", "muster-chatgpt-work"));
  for (const result of [projectResult, userResult]) {
    const marketplace = JSON.parse(await readFile(join(result.pluginPath, "..", "marketplace.json"), "utf8"));
    const entry = marketplace.plugins.find(plugin => plugin.name === "muster-chatgpt-work");
    assert.equal(entry.source.path, "./.agents/plugins/muster-chatgpt-work");
  }
});

test("CLI install chatgpt-work validates flags and dry-run emits no receipt", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-cli-"));
  await initGit(dir);
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
  let optional;
  try {
    optional = await readChatgptWorkConfig({ scope: "project", cwd: dir, home: join(dir, "home") });
  } catch (error) {
    if (error.code !== "MUSTER_NO_GIT_WORKTREE") throw error;
    optional = null;
  }
  assert.equal(optional, null);
  await assert.rejects(
    runChatgptWorkInstall({
      connectionId: "asdk_app_Explicit1", profile: "pro-safe",
      scope: "project", cwd: dir, home: join(dir, "home"),
    }),
    /project scope requires a Git worktree/,
  );
});

test("project-scope install accepts an ordinary relative gitdir and rejects unsafe pointers before mutation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-gitdir-file-"));
  t.after(() => rm(dir, { recursive: true, force: true }));

  const ordinaryProject = join(dir, "ordinary-project");
  const ordinaryGitDir = join(dir, "ordinary-gitdir");
  await initGit(ordinaryProject, { separateGitDir: ordinaryGitDir });
  await writeFile(join(ordinaryProject, ".git"), "gitdir: ../ordinary-gitdir\n");

  const installed = await runChatgptWorkInstall({
    connectionId: "asdk_app_RelativeGitdir", profile: "pro-safe",
    scope: "project", cwd: ordinaryProject, home: join(dir, "home"),
  });
  assert.equal(installed.configPath, join(ordinaryGitDir, "muster", "chatgpt-work.json"));

  const forgedProject = join(dir, "forged-project");
  const forgedGitDir = join(dir, "forged-gitdir");
  await mkdir(forgedProject, { recursive: true });
  await mkdir(forgedGitDir, { recursive: true });
  await writeFile(join(forgedProject, ".git"), "gitdir: ../forged-gitdir\n");
  await assert.rejects(
    runChatgptWorkInstall({
      connectionId: "asdk_app_ForgedGitdir", profile: "pro-safe",
      scope: "project", cwd: forgedProject, home: join(dir, "home"),
    }),
    /Git worktree|authoritative gitdir/i,
  );
  await assert.rejects(stat(join(forgedProject, ".agents")), /ENOENT/);
  await assert.rejects(stat(join(forgedGitDir, "muster")), /ENOENT/);

  const malformedProject = join(dir, "malformed-project");
  await mkdir(malformedProject, { recursive: true });
  await writeFile(join(malformedProject, ".git"), "not-a-gitdir-pointer\n");
  const malformedError = await runChatgptWorkInstall({
    connectionId: "asdk_app_MalformedGitdir", profile: "pro-safe",
    scope: "project", cwd: malformedProject, home: join(dir, "home"),
  }).then(() => null, error => error);
  await assert.rejects(stat(join(malformedProject, ".agents")), /ENOENT/);
  assert.match(malformedError?.message ?? "", /invalid gitdir pointer/i);

  const symlinkProject = join(dir, "symlink-project");
  const symlinkTarget = join(dir, "symlink-target");
  const symlinkGitDir = join(dir, "symlink-gitdir");
  await mkdir(symlinkProject, { recursive: true });
  await mkdir(symlinkTarget, { recursive: true });
  await symlink(symlinkTarget, symlinkGitDir);
  await writeFile(join(symlinkProject, ".git"), "gitdir: ../symlink-gitdir\n");
  const symlinkError = await runChatgptWorkInstall({
    connectionId: "asdk_app_SymlinkGitdir", profile: "pro-safe",
    scope: "project", cwd: symlinkProject, home: join(dir, "home"),
  }).then(() => null, error => error);
  await assert.rejects(stat(join(symlinkProject, ".agents")), /ENOENT/);
  await assert.rejects(stat(join(symlinkTarget, "muster")), /ENOENT/);
  assert.match(symlinkError?.message ?? "", /gitdir.*ordinary|symlink/i);
});

test("project gitdir verification ignores inherited repository override variables", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-git-env-"));
  const project = join(dir, "project");
  const redirect = join(dir, "redirect");
  await initGit(project);
  await initGit(redirect);
  t.after(() => rm(dir, { recursive: true, force: true }));

  const { stdout } = await execFile(process.execPath, [
    join(root, "src", "cli.js"), "install", "chatgpt-work",
    "--connection-id", "asdk_app_GitEnv1", "--profile", "pro-safe",
    "--scope", "project", "--dry-run",
  ], {
    cwd: project,
    env: {
      ...process.env,
      GIT_DIR: join(redirect, ".git"),
      GIT_WORK_TREE: project,
      GIT_COMMON_DIR: join(redirect, ".git"),
      GIT_INDEX_FILE: join(redirect, ".git", "index"),
      GIT_OBJECT_DIRECTORY: join(redirect, ".git", "objects"),
      GIT_ALTERNATE_OBJECT_DIRECTORIES: join(project, ".git", "objects"),
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "core.worktree",
      GIT_CONFIG_VALUE_0: redirect,
      GIT_NAMESPACE: "redirected",
    },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.configPath, join(project, ".git", "muster", "chatgpt-work.json"));
});

function serverExit(env, input = "", serverPath = join(root, "cowork", "chatgpt-work-server.mjs")) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
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

function serverRpc(env, requests, serverPath) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [serverPath], {
      cwd: root, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"],
    });
    const expected = new Set(requests.filter(request => request.id != null).map(request => request.id));
    const messages = [];
    let buffer = "", stderr = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`installed Work RPC timed out: ${stderr}`));
    }, 20_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      buffer += chunk;
      let newline;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        messages.push(message);
        expected.delete(message.id);
      }
      if (expected.size === 0) {
        clearTimeout(timer);
        child.kill();
        resolve({ messages, stderr });
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => {
      clearTimeout(timer);
      reject(error);
    });
    for (const request of requests) child.stdin.write(JSON.stringify(request) + "\n");
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

test("dedicated full server starts only with receipted activation and both opt-ins", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-full-server-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installed = await runChatgptWorkInstall({
    connectionId: "asdk_app_FullServer1",
    profile: "full",
    allowFullActions: true,
    scope: "project",
    cwd: project,
  });
  const activation = JSON.parse(await readFile(join(installed.pluginPath, ".mcp.json"), "utf8"))
    .mcpServers.muster.env;
  const input = [
    JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} }),
    JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
  ].join("\n") + "\n";
  const result = await serverExit({
    ...activation,
    MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS: "1",
  }, input);
  assert.equal(result.code, 0);
  const messages = result.stdout.trim().split("\n").map(line => JSON.parse(line));
  assert.equal(messages.find(message => message.id === 2).result.tools.length, 31);

  if (process.platform !== "win32") {
    await chmod(join(installed.pluginPath, ".."), 0o777);
    const insecure = await serverExit({
      ...activation,
      MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS: "1",
    });
    assert.notEqual(insecure.code, 0);
    assert.equal(insecure.stdout, "");
    assert.match(insecure.stderr, /publication path rejected/);
  }
});

test("installed full Work runtime executes with Work-only capability semantics", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-runtime-call-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installed = await runChatgptWorkInstall({
    connectionId: "asdk_app_RuntimeCall1",
    profile: "full",
    allowFullActions: true,
    scope: "project",
    cwd: project,
  });
  const activation = JSON.parse(await readFile(join(installed.pluginPath, ".mcp.json"), "utf8"))
    .mcpServers.muster.env;
  const requests = [
    { jsonrpc: "2.0", id: 1, method: "initialize", params: {} },
    { jsonrpc: "2.0", id: 2, method: "tools/call", params: {
      name: "muster_match", arguments: { task: "implement and review an API" },
    } },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: {
      name: "muster_match_skills", arguments: { task: "implement a React API" },
    } },
    { jsonrpc: "2.0", id: 4, method: "tools/call", params: {
      name: "muster_manifest_validate",
      arguments: { manifest: {
        outcome: "test", successCriteria: ["green"],
        crew: [{ role: "implement", provider: "muster-builder", source: "builtin" }],
        plan: [{ id: "a", task: "test", deps: [] }],
      } },
    } },
    { jsonrpc: "2.0", id: 5, method: "tools/call", params: {
      name: "muster_diagnose", arguments: { symptom: "API test failed" },
    } },
    { jsonrpc: "2.0", id: 6, method: "tools/call", params: {
      name: "muster_audit", arguments: { dir: project },
    } },
    { jsonrpc: "2.0", id: 7, method: "tools/call", params: {
      name: "muster_sprint_protocol", arguments: {},
    } },
    { jsonrpc: "2.0", id: 8, method: "tools/call", params: {
      name: "muster_wave", arguments: { manifest: { plan: [{ id: "a", task: "test", deps: [] }] } },
    } },
    { jsonrpc: "2.0", id: 9, method: "tools/call", params: {
      name: "muster_tally", arguments: { verdicts: [{ reviewer: "code", findings: [] }] },
    } },
  ];
  const result = await serverRpc({
    ...activation,
    MUSTER_CHATGPT_WORK_SERVER_ALLOW_FULL_ACTIONS: "1",
  }, requests, join(installed.pluginPath, "runtime", "chatgpt-work-server.mjs"));
  assert.doesNotMatch(result.stderr, /ERR_MODULE_NOT_FOUND|esbuild/);
  const messages = result.messages;
  const response = id => messages.find(message => message.id === id)?.result;
  assert.match(response(2).content[0].text, /^\[/, response(2).content[0].text);
  assert.deepEqual(JSON.parse(response(2).content[0].text), []);
  assert.deepEqual(JSON.parse(response(3).content[0].text), { ranked: [], suggested: [] });
  assert.equal(response(4).isError, true);
  assert.match(response(4).content[0].text, /not callable in capabilities --work/);
  for (const id of [5, 6]) {
    const body = JSON.parse(response(id).content[0].text);
    const manifest = body.manifest || body;
    assert.ok(manifest.crew.every(member => member.source === "inline"));
    assert.doesNotMatch(JSON.stringify(body), /muster-builder|wsh-|claude|sonnet|opus/i);
  }
  assert.equal(
    response(7).content[0].text,
    (await readFile(join(root, "cowork", "sprint-protocol.md"), "utf8")).trim(),
  );
  assert.equal(response(8).isError, false, response(8).content[0].text);
  assert.equal(JSON.parse(response(8).content[0].text)[0][0].id, "a");
  assert.equal(response(9).isError, false, response(9).content[0].text);
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
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const cli = join(root, ".agents", "plugins", "plugin", "runtime", "muster.mjs");
  const { stdout } = await execFile(process.execPath, [
    cli, "install", "chatgpt-work", "--connection-id", "asdk_app_Bundled1",
    "--profile", "pro-safe", "--scope", "project",
  ], { cwd: project, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR || tmpdir() } });
  const result = JSON.parse(stdout);
  assert.equal(result.pluginPath, join(project, ".agents", "plugins", "muster-chatgpt-work"));
  const manifest = JSON.parse(await readFile(join(result.pluginPath, ".codex-plugin", "plugin.json"), "utf8"));
  assert.equal(manifest.apps, "./.app.json");
  assert.equal(manifest.mcpServers, "./.mcp.json");
  assert.equal(manifest.skills, undefined);
  assert.equal(manifest.interface.defaultPrompt, "Use the available Muster tools.");
  assert.deepEqual(manifest.interface.capabilities, ["Tools"]);
  assert.doesNotMatch(JSON.stringify(manifest.interface), /Codex|Read|Write/);
  assert.match(manifest.interface.longDescription, /tool-only.*ChatGPT Work/i);
  const server = await readFile(join(result.pluginPath, "runtime", "chatgpt-work-server.mjs"), "utf8");
  assert.match(server, /runtimeIdentity:\s*"work"/);
  assert.doesNotMatch(server, /MUSTER_MCP_HOST/);
  assert.doesNotMatch(server, /work-mcp\.mjs/);
  assert.doesNotMatch(server, /muster-mcp\.mjs/);
});

test("installer cache identity revokes full opt-in on full to pro-safe transition", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-transition-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const common = { connectionId: "asdk_app_Transition1", scope: "project", cwd: project, home: join(dir, "home") };
  const full = await runChatgptWorkInstall({ ...common, profile: "full", allowFullActions: true });
  assert.equal(JSON.parse(await readFile(join(full.pluginPath, ".mcp.json"), "utf8")).mcpServers.muster.env.MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS, "1");
  const safe = await runChatgptWorkInstall({ ...common, profile: "pro-safe" });
  assert.equal(
    JSON.parse(await readFile(join(safe.pluginPath, ".mcp.json"), "utf8"))
      .mcpServers.muster.env.MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS,
    undefined,
  );
  assert.equal((await readChatgptWorkConfig({ scope: "project", cwd: project })).profile, "pro-safe");
});

test("receipt v3 binds every Work activation artifact and rejects tampering", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-receipt-v3-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installed = await runChatgptWorkInstall({
    connectionId: "asdk_app_Receipt3", profile: "pro-safe", scope: "project", cwd: project,
  });
  const receipt = JSON.parse(await readFile(installed.configPath, "utf8"));
  assert.equal(receipt.format, 3);
  assert.equal(receipt.artifactFlavor, "chatgpt-work");
  assert.equal(receipt.appId, "asdk_app_Receipt3");
  assert.ok(Object.hasOwn(receipt.artifacts, "runtime/muster.mjs"));
  assert.ok(Object.hasOwn(receipt.artifacts, "runtime/in-process-worker.mjs"));
  assert.ok(Object.hasOwn(receipt.artifacts, "runtime/verdict.schema.json"));
  assert.ok(Object.hasOwn(receipt.artifacts, "runtime/sprint-protocol.md"));
  assert.ok(Object.hasOwn(receipt.artifacts, "package.json"));
  assert.ok(Object.hasOwn(receipt.artifacts, "catalog/software.yaml"));
  assert.ok(Object.hasOwn(receipt.artifacts, "pipelines/prd.yaml"));
  assert.equal(Object.keys(receipt.artifacts).length, 35);
  for (const digest of Object.values(receipt.artifacts)) assert.match(digest, /^[a-f0-9]{64}$/);
  const mcp = JSON.parse(await readFile(join(installed.pluginPath, ".mcp.json"), "utf8"));
  assert.equal(mcp.mcpServers.muster.env.MUSTER_CHATGPT_WORK_RECEIPT_PATH, installed.configPath);
  assert.equal(mcp.mcpServers.muster.env.MUSTER_CHATGPT_WORK_PLUGIN_PATH, installed.pluginPath);
  const packagePath = join(installed.pluginPath, "package.json");
  const packageBytes = await readFile(packagePath);
  await writeFile(packagePath, JSON.stringify({ version: "9.9.9" }));
  await assert.rejects(
    readChatgptWorkConfig({ scope: "project", cwd: project }),
    /artifact digest/i,
  );
  await writeFile(packagePath, packageBytes);
  const cliPath = join(installed.pluginPath, "runtime", "muster.mjs");
  const cliBytes = await readFile(cliPath);
  await writeFile(cliPath, "");
  await assert.rejects(
    readChatgptWorkConfig({ scope: "project", cwd: project }),
    /artifact digest/i,
  );
  const activation = mcp.mcpServers.muster.env;
  const rejected = await serverExit(activation);
  assert.notEqual(rejected.code, 0);
  assert.equal(rejected.stdout, "");
  assert.match(rejected.stderr, /installed activation receipt rejected.*digest mismatch/i);
  await writeFile(cliPath, cliBytes);
  await writeFile(join(installed.pluginPath, ".mcp.json"), "{}\n");
  await assert.rejects(
    readChatgptWorkConfig({ scope: "project", cwd: project }),
    /artifact digest/i,
  );
});

test("installed server startup rejects a receipt whose profile or artifact set no longer matches", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-receipt-mutation-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installed = await runChatgptWorkInstall({
    connectionId: "asdk_app_Mutation1", profile: "pro-safe", scope: "project", cwd: project,
  });
  const activation = JSON.parse(await readFile(join(installed.pluginPath, ".mcp.json"), "utf8"))
    .mcpServers.muster.env;
  const valid = JSON.parse(await readFile(installed.configPath, "utf8"));
  const publish = receipt => writeFile(installed.configPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600 });

  // The receipt claims full while the activation env says pro-safe: the server
  // must refuse before any MCP output rather than serve the weaker profile.
  await publish({ ...valid, profile: "full" });
  const profileMismatch = await serverExit(activation);
  assert.notEqual(profileMismatch.code, 0);
  assert.equal(profileMismatch.stdout, "");
  assert.match(profileMismatch.stderr, /installed activation receipt rejected \(receipt identity\/profile mismatch\)/);

  // One artifact silently dropped from the receipt would leave that published
  // file unbound by any digest, so the whole set must fail closed.
  const { "package.json": _dropped, ...artifacts } = valid.artifacts;
  await publish({ ...valid, artifacts });
  const artifactMismatch = await serverExit(activation);
  assert.notEqual(artifactMismatch.code, 0);
  assert.equal(artifactMismatch.stdout, "");
  assert.match(artifactMismatch.stderr, /installed activation receipt rejected \(receipt artifact set mismatch\)/);

  await publish(valid);
  const restored = await serverExit(activation);
  assert.equal(restored.code, 0, restored.stderr);
});

test("receipt validation names the offending field for each invalid shape", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-receipt-fields-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installed = await runChatgptWorkInstall({
    connectionId: "asdk_app_Fields1", profile: "pro-safe", scope: "project", cwd: project,
  });
  const valid = JSON.parse(await readFile(installed.configPath, "utf8"));
  const readReceipt = () => readChatgptWorkConfig({ scope: "project", cwd: project });
  const reject = async (mutated, pattern) => {
    await writeFile(installed.configPath, JSON.stringify(mutated, null, 2) + "\n");
    await assert.rejects(readReceipt(), pattern);
  };

  const { format: _dropped, ...missingKey } = valid;
  await reject(missingKey, /receipt keys must be exactly/);
  await reject({ ...valid, extra: 1 }, /receipt keys must be exactly/);
  await reject({ ...valid, format: 2 }, /receipt format must be 3/);
  await reject({ ...valid, owner: "other" }, /receipt owner must be "muster"/);
  await reject({ ...valid, artifactFlavor: "other" }, /receipt artifactFlavor must be "chatgpt-work"/);
  await reject({ ...valid, profile: "admin" }, /receipt profile must be pro-safe or full/);
  await reject({ ...valid, allowFullActions: "yes" }, /receipt allowFullActions must be a boolean/);
  await reject({ ...valid, appId: "asdk_app_Other" }, /app id is not canonical/);
  await reject({ ...valid, connectionId: "plugin_asdk_app_Fields1" }, /app id is not canonical/);
  await reject({ ...valid, allowFullActions: true }, /profile\/action opt-in is inconsistent/);
  await reject({ ...valid, cacheKey: "0".repeat(64) }, /receipt cacheKey must be the install identity digest/);
  await reject({ ...valid, pluginPath: "relative/plugin" }, /receipt pluginPath must be an absolute path/);
  await reject(
    { ...valid, artifacts: { ...valid.artifacts, "extra.txt": "0".repeat(64) } },
    /receipt artifacts must cover exactly the published artifact set/,
  );
  await reject(
    { ...valid, artifacts: { ...valid.artifacts, "package.json": "not-hex" } },
    /receipt artifact digests must be 64-character lowercase hex sha256 values/,
  );

  await writeFile(installed.configPath, JSON.stringify(valid, null, 2) + "\n");
  assert.equal((await readReceipt()).connectionId, "asdk_app_Fields1");
});

test("an existing unowned Work destination fails closed without mutation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-unowned-"));
  const project = join(dir, "project");
  const destination = join(project, ".agents", "plugins", "muster-chatgpt-work");
  await initGit(project);
  await mkdir(destination, { recursive: true });
  await writeFile(join(destination, "foreign.txt"), "leave me\n");
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(runChatgptWorkInstall({
    connectionId: "asdk_app_Unowned1", profile: "pro-safe", scope: "project", cwd: project,
  }), /HUMAN-HOLD.*unowned/i);
  assert.equal(await readFile(join(destination, "foreign.txt"), "utf8"), "leave me\n");
});

test("Work marketplace merge preserves Codex and rejects an unowned Work entry", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-marketplace-"));
  const project = join(dir, "project");
  const pluginsRoot = join(project, ".agents", "plugins");
  const marketplacePath = join(pluginsRoot, "marketplace.json");
  await initGit(project);
  await mkdir(pluginsRoot, { recursive: true });
  const codexEntry = {
    name: "muster",
    source: { source: "local", path: "./.agents/plugins/plugin" },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  };
  await writeFile(marketplacePath, JSON.stringify({
    name: "muster", interface: { displayName: "Muster" }, plugins: [codexEntry],
  }, null, 2) + "\n");
  t.after(() => rm(dir, { recursive: true, force: true }));

  await runChatgptWorkInstall({
    connectionId: "asdk_app_Marketplace1", profile: "pro-safe", scope: "project", cwd: project,
  });
  const merged = JSON.parse(await readFile(marketplacePath, "utf8"));
  assert.deepEqual(merged.plugins.find(plugin => plugin.name === "muster"), codexEntry);
  assert.equal(
    merged.plugins.find(plugin => plugin.name === "muster-chatgpt-work")?.source?.path,
    "./.agents/plugins/muster-chatgpt-work",
  );

  const other = join(dir, "other");
  const otherRoot = join(other, ".agents", "plugins");
  await initGit(other);
  await mkdir(otherRoot, { recursive: true });
  const unowned = {
    name: "muster",
    plugins: [{
      name: "muster-chatgpt-work",
      source: { source: "local", path: "./foreign/plugin" },
    }],
  };
  await writeFile(join(otherRoot, "marketplace.json"), JSON.stringify(unowned, null, 2) + "\n");
  await assert.rejects(runChatgptWorkInstall({
    connectionId: "asdk_app_Marketplace2", profile: "pro-safe", scope: "project", cwd: other,
  }), /HUMAN-HOLD.*marketplace/i);
  assert.deepEqual(JSON.parse(await readFile(join(otherRoot, "marketplace.json"), "utf8")), unowned);
});

test("overlapping full and pro-safe installs serialize into one coherent receipted state", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-overlap-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const common = { connectionId: "asdk_app_Overlap1", scope: "project", cwd: project };
  await Promise.all([
    runChatgptWorkInstall({ ...common, profile: "full", allowFullActions: true }),
    runChatgptWorkInstall({ ...common, profile: "pro-safe" }),
  ]);
  const receipt = await readChatgptWorkConfig({ scope: "project", cwd: project });
  const mcp = JSON.parse(await readFile(join(receipt.pluginPath, ".mcp.json"), "utf8"));
  assert.equal(receipt.profile, receipt.allowFullActions ? "full" : "pro-safe");
  assert.equal(
    mcp.mcpServers.muster.env.MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS === "1",
    receipt.allowFullActions,
  );
  await assert.doesNotReject(readChatgptWorkConfig({ scope: "project", cwd: project }));
});

test("a late receipt failure restores the prior plugin and receipt as one pair", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-rollback-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const common = { connectionId: "asdk_app_Rollback1", scope: "project", cwd: project };
  const first = await runChatgptWorkInstall({ ...common, profile: "pro-safe" });
  const receiptBefore = await readFile(first.configPath);
  const mcpBefore = await readFile(join(first.pluginPath, ".mcp.json"));
  const marketplacePath = join(first.pluginPath, "..", "marketplace.json");
  const marketplaceBefore = await readFile(marketplacePath);
  await assert.rejects(
    runChatgptWorkInstall({
      ...common,
      profile: "full",
      allowFullActions: true,
      __testBeforeReceiptCommit: () => { throw new Error("injected receipt failure"); },
    }),
    /injected receipt failure/,
  );
  assert.deepEqual(await readFile(first.configPath), receiptBefore);
  assert.deepEqual(await readFile(join(first.pluginPath, ".mcp.json")), mcpBefore);
  assert.deepEqual(await readFile(marketplacePath), marketplaceBefore);
  assert.equal((await readChatgptWorkConfig({ scope: "project", cwd: project })).profile, "pro-safe");
});

test("symlinked marketplace ancestry fails before receipt mutation", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-symlink-"));
  const project = join(dir, "project");
  await initGit(project);
  await mkdir(join(dir, "redirect"), { recursive: true });
  await symlink(join(dir, "redirect"), join(project, ".agents"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(runChatgptWorkInstall({
    connectionId: "asdk_app_Symlink1", profile: "pro-safe", scope: "project", cwd: project,
  }), /ordinary directories/);
  assert.equal(await readChatgptWorkConfig({ scope: "project", cwd: project }), null);
});

test("group/world-writable Work publication directories fail closed", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-writable-parent-"));
  const project = join(dir, "project");
  const agents = join(project, ".agents");
  const plugins = join(agents, "plugins");
  await initGit(project);
  await mkdir(plugins, { recursive: true });
  await chmod(agents, 0o777);
  await chmod(plugins, 0o777);
  t.after(() => rm(dir, { recursive: true, force: true }));
  await assert.rejects(runChatgptWorkInstall({
    connectionId: "asdk_app_Writable1", profile: "pro-safe", scope: "project", cwd: project,
  }), /HUMAN-HOLD.*group\/world-writable/i);
  await assert.rejects(stat(join(plugins, "muster-chatgpt-work")), /ENOENT/);
});

test("installed Work startup rejects a symlink introduced anywhere in managed ancestry", async t => {
  const dir = await mkdtemp(join(tmpdir(), "muster-work-startup-symlink-"));
  const project = join(dir, "project");
  await initGit(project);
  t.after(() => rm(dir, { recursive: true, force: true }));
  const installed = await runChatgptWorkInstall({
    connectionId: "asdk_app_StartupSymlink1", profile: "pro-safe", scope: "project", cwd: project,
  });
  const activation = JSON.parse(await readFile(join(installed.pluginPath, ".mcp.json"), "utf8"))
    .mcpServers.muster.env;
  const agents = join(project, ".agents");
  const retired = join(project, ".agents-real");
  await rename(agents, retired);
  await symlink(retired, agents);
  const result = await serverExit(activation);
  assert.notEqual(result.code, 0);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /publication path rejected.*not an ordinary directory/i);
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

  await writeFile(join(dir, "server-instance.json"), JSON.stringify({
    serverInstanceId: "00000000-0000-0000-0000-000000000000",
  }) + "\n", { mode: 0o600 });
  const malformed = await serverExit({
    ...env,
    MUSTER_CHATGPT_WORK_PROBE_NONCE: "e".repeat(32),
  });
  assert.notEqual(malformed.code, 0);
  assert.equal(malformed.stdout, "");
  assert.match(malformed.stderr, /invalid instance id/);
});
