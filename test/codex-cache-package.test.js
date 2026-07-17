import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resolveCodexPlugin } from "../src/codex-release.js";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;
const primary = ["muster-plan", "muster-go", "muster-plan-backlog", "muster-go-backlog", "muster-diagnose", "muster-audit", "muster-runner", "muster-capture"];

function mcpSmoke(entry, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`cache MCP timed out: ${stderr}`)); }, 10_000);
    child.stdout.setEncoding("utf8"); child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => {
      stdout += chunk;
      const lines = stdout.trim().split("\n");
      if (lines.some(line => { try { return JSON.parse(line).id === 2; } catch { return false; } })) {
        clearTimeout(timer); child.kill(); resolvePromise(lines.map(line => JSON.parse(line)));
      }
    });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", error => { clearTimeout(timer); reject(error); });
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "cache-test", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }) + "\n");
  });
}

test("a packed npm tarball can generate a Codex plugin whose real Codex cache copy is fully self-contained", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-cache-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const packDir = join(tmp, "pack"); await mkdir(packDir);
  const packed = JSON.parse((await execFile("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 })).stdout)[0];
  await execFile("tar", ["-xzf", join(packDir, packed.filename), "-C", tmp]);
  const extracted = join(tmp, "package");
  assert.ok(await readFile(join(extracted, "scripts", "build-codex.mjs"), "utf8"), "packed tarball must ship the install-time Codex generation script");
  await assert.rejects(readFile(join(extracted, ".agents", "plugins", "marketplace.json"), "utf8"), "packed tarball must not ship a pre-generated Codex payload");

  await symlink(await realpath(join(repoRoot, "node_modules")), join(extracted, "node_modules"), "dir");
  await execFile(process.execPath, ["scripts/build-codex.mjs"], { cwd: extracted, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  const selected = await resolveCodexPlugin(extracted);
  for (const name of primary) {
    const skill = await readFile(join(selected.pluginRoot, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`name: ${name}`));
  }
  assert.match(await readFile(join(selected.pluginRoot, "internal-skills", "orchestrator", "SKILL.md"), "utf8"), /name: orchestrator/);

  // Simulate `codex plugin add`: Codex copies the plugin tree into its own
  // internal cache, decoupled from wherever it was generated. That cache copy
  // — not the staging directory — is what real Codex sessions run from
  // afterward, so it must work with none of the generation/source tree
  // (node_modules, scripts/, src/, .agents/) still present.
  const version = JSON.parse(await readFile(join(selected.pluginRoot, ".codex-plugin", "plugin.json"), "utf8")).version;
  const realCache = join(tmp, "codex-home", "plugins", "cache", "muster", "muster", version);
  await mkdir(join(realCache, ".."), { recursive: true });
  await cp(selected.pluginRoot, realCache, { recursive: true });
  await rm(extracted, { recursive: true, force: true });

  for (const name of primary) {
    const skill = await readFile(join(realCache, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`name: ${name}`));
  }
  assert.match(await readFile(join(realCache, "internal-skills", "orchestrator", "SKILL.md"), "utf8"), /name: orchestrator/);
  const providerResolver = join(realCache, "runtime", "resolve-skill-provider.mjs");
  const bundledBrainstorm = (await execFile(process.execPath, [providerResolver, "builtin", "sp-brainstorm"], { cwd: tmp })).stdout;
  assert.match(bundledBrainstorm, /name: sp-brainstorm/);
  assert.match(bundledBrainstorm, /resolve-skill-provider\.mjs builtin sp-brainstorm visual-companion\.md/);
  assert.doesNotMatch(bundledBrainstorm, /skills\/brainstorming\/visual-companion\.md/);
  const companion = (await execFile(process.execPath, [providerResolver, "builtin", "sp-brainstorm", "visual-companion.md"], { cwd: tmp })).stdout;
  assert.match(companion, /Visual Companion Guide/);
  for (const id of ["brainstorming", "debugging-strategies"]) {
    const invocation = (await execFile(process.execPath, [providerResolver, "installed", id], { cwd: tmp })).stdout;
    assert.equal(invocation, `Invoke the already-enabled Codex skill explicitly as $${id}.\n`);
  }
  for (const [source, id] of [["builtin", "../../escape"], ["installed", "Not_Valid"], ["external", "brainstorming"]]) {
    await assert.rejects(execFile(process.execPath, [providerResolver, source, id], { cwd: tmp }), /invalid (?:skill provider source|skill provider id)/);
  }

  const internalSkill = join(realCache, "internal-skills", "sp-brainstorm", "SKILL.md");
  const originalInternalSkill = await readFile(internalSkill);
  await writeFile(internalSkill, "ATTACKER-CONTROLLED-INTERNAL-SKILL\n");
  await assert.rejects(execFile(process.execPath, [providerResolver, "builtin", "sp-brainstorm"], { cwd: tmp }), /hash|size|changed/i);
  await writeFile(internalSkill, originalInternalSkill);
  const symlinkVictim = join(tmp, "internal-skill-victim.md");
  await writeFile(symlinkVictim, originalInternalSkill);
  await unlink(internalSkill);
  await symlink(symlinkVictim, internalSkill);
  await assert.rejects(execFile(process.execPath, [providerResolver, "builtin", "sp-brainstorm"], { cwd: tmp }), /symlink|ordinary|regular/i);
  await unlink(internalSkill);
  await writeFile(internalSkill, originalInternalSkill);
  assert.deepEqual(await readFile(internalSkill), originalInternalSkill);

  const env = { ...process.env, CODEX_HOME: join(tmp, "codex-home") };
  const cachedDetected = JSON.parse((await execFile(process.execPath, [join(realCache, "runtime", "muster.mjs"), "detect", tmp], { cwd: tmp, env })).stdout);
  assert.equal(typeof cachedDetected.greenfield, "boolean");
  const cachedMcp = await mcpSmoke(join(realCache, "runtime", "muster-mcp.mjs"), tmp, env);
  assert.ok(cachedMcp.find(message => message.id === 2)?.result?.tools?.length >= 20);
});

test("resolveCodexPlugin rejects a marketplace pointer with a traversal or Windows-shaped path", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-cache-pointer-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  await mkdir(join(tmp, "plugins"), { recursive: true });
  for (const path of ["../../outside/plugin", "C:\\outside\\plugin", "\\\\server\\share\\plugin", "./plugin/../../escape"]) {
    await writeFile(join(tmp, "plugins", "marketplace.json"), JSON.stringify({ name: "muster", plugins: [{ name: "muster", source: { source: "local", path } }] }));
    await assert.rejects(resolveCodexPlugin(tmp, { pluginsRoot: join(tmp, "plugins") }), /valid Muster plugin contract/, path);
  }
});
