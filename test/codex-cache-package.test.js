import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, realpath, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { publishCodexPlugin, resolveCodexPlugin } from "../src/codex-release.js";

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

// Publishes a minimal but coherent plugin (skills/ dir, package.json,
// .codex-plugin/plugin.json all agreeing on `version` and name "muster") into
// `outDir` via the real publish path, so the marketplace pointer is computed
// correctly. Mirrors the synthetic-tree recipe in codex-build-repro.test.js's
// force-flag test. Returns the manifest path so a test can then mislabel it
// AFTER publication (the publish contract check forbids a mislabeled STAGED
// tree) to simulate a swapped/mislabeled published manifest.
async function publishMinimalPlugin(tmp, outDir, version) {
  const staged = join(tmp, "staged");
  await rm(staged, { recursive: true, force: true });
  await mkdir(join(staged, "skills"), { recursive: true });
  await mkdir(join(staged, ".codex-plugin"), { recursive: true });
  await writeFile(join(staged, "package.json"), JSON.stringify({ version }));
  await writeFile(join(staged, ".codex-plugin", "plugin.json"), JSON.stringify({ name: "muster", version }));
  await publishCodexPlugin({
    pluginsRoot: outDir,
    stagedPlugin: staged,
    packageVersion: version,
    marketplaceTemplate: {
      name: "muster",
      interface: { displayName: "Muster" },
      plugins: [{ name: "muster", source: { source: "local", path: "./plugin" }, category: "Productivity" }]
    }
  });
  return join(outDir, "plugin", ".codex-plugin", "plugin.json");
}

test("resolveCodexPlugin rejects a resolved plugin whose .codex-plugin/plugin.json NAME disagrees, not version alone", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-resolve-name-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const outDir = join(tmp, "plugins");
  const version = "1.2.3-name-fixture";
  const manifestPath = await publishMinimalPlugin(tmp, outDir, version);
  // The package.json version still matches (version-only identity would still
  // resolve valid), but the manifest declares a different plugin name: a
  // mislabeled or swapped manifest that must be rejected during resolution.
  await writeFile(manifestPath, JSON.stringify({ name: "not-muster", version }));
  await assert.rejects(
    resolveCodexPlugin(tmp, { pluginsRoot: outDir }),
    /manifest name .* does not match expected plugin name/,
    "a manifest name != \"muster\" must make resolution reject even when package.json version matches"
  );
});

test("resolveCodexPlugin rejects a resolved plugin whose .codex-plugin/plugin.json VERSION disagrees with the package version", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-resolve-version-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const outDir = join(tmp, "plugins");
  const version = "1.2.3-version-fixture";
  const manifestPath = await publishMinimalPlugin(tmp, outDir, version);
  // Name is right, but the two manifests disagree on version: package.json
  // says `version`, the plugin.json says something else. The identity contract
  // requires both to be internally consistent, so resolution must reject.
  await writeFile(manifestPath, JSON.stringify({ name: "muster", version: "9.9.9-manifest-disagrees" }));
  await assert.rejects(
    resolveCodexPlugin(tmp, { pluginsRoot: outDir }),
    /manifest version .* does not match package version/,
    "a plugin.json version disagreeing with package.json version must make resolution reject"
  );
});

test("the built plugin's MCP server executes tools/call from the bundle alone (no repo src/ tree)", async t => {
  // Regression: the bundled muster-mcp.mjs resolved its CLI at ../src/cli.js
  // (the repo layout), which the plugin bundle does not ship -- so initialize +
  // tools/list succeeded while EVERY tools/call crashed with Cannot find module
  // (found by the 2026-07-18 Codex dogfood). The bundle must fall back to its
  // sibling runtime/muster.mjs.
  const tmp = await mkdtemp(join(tmpdir(), "muster-mcp-call-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { pluginRoot } = await resolveCodexPlugin(repoRoot);
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.MUSTER_COWORK_TEST_CLI;
  const messages = await new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [join(pluginRoot, "runtime", "muster-mcp.mjs")], { cwd: tmp, env, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    const timer = setTimeout(() => { child.kill(); reject(new Error(`tools/call timed out: ${stderr}`)); }, 15_000);
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
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "call-test", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "muster_detect", arguments: {} } }) + "\n");
  });
  const response = messages.find(message => message.id === 2);
  assert.ok(response?.result, `tools/call returned no result: ${JSON.stringify(response?.error || {}).slice(0, 200)}`);
  assert.notEqual(response.result.isError, true, `tools/call errored: ${String(response.result.content?.[0]?.text).slice(0, 200)}`);
  const detect = JSON.parse(response.result.content[0].text);
  assert.equal(typeof detect.greenfield, "boolean", "muster_detect must return real detect JSON from the bundled CLI");
});
