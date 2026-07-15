import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;
const primary = ["muster-plan", "muster-go", "muster-plan-backlog", "muster-go-backlog", "muster-diagnose", "muster-audit", "muster-runner", "muster-capture"];

async function runJsonAllowFailure(file, args, options) {
  try { return { code: 0, stdout: (await execFile(file, args, options)).stdout }; }
  catch (error) { return { code: error.code, stdout: error.stdout }; }
}

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

test("packed Codex cache is self-contained and retains a bounded executable LKG", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-cache-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const packDir = join(tmp, "pack"); await mkdir(packDir);
  const packed = JSON.parse((await execFile("npm", ["pack", "--json", "--pack-destination", packDir], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 })).stdout)[0];
  assert.ok(packed.unpackedSize <= 9_707_029, `Codex package ${packed.unpackedSize} exceeds the 10% reduction guard`);
  await execFile("tar", ["-xzf", join(packDir, packed.filename), "-C", tmp]);
  const extracted = join(tmp, "package"), cache = join(tmp, "cache");
  await cp(join(extracted, ".agents"), join(cache, ".agents"), { recursive: true });
  const bootstrap = join(cache, ".agents", "plugins", "bootstrap", "muster", "runtime");
  const resolver = join(bootstrap, "resolve-release.mjs");
  assert.doesNotMatch(await readFile(resolver, "utf8"), /from\s+["'][^"']*(?:src\/codex-release|node_modules)/);
  const env = { ...process.env, CODEX_HOME: join(tmp, "codex-home") };
  const selected = (await execFile(process.execPath, [resolver, "plugin"], { cwd: cache, env })).stdout.trim();
  assert.ok(selected.startsWith(resolve(cache)), selected);
  for (const name of primary) {
    const skill = (await execFile(process.execPath, [resolver, "skill", name], { cwd: cache, env })).stdout;
    assert.match(skill, new RegExp(`name: ${name}`));
    await execFile(process.execPath, [resolver, "command", name.replace(/^muster-/, "")], { cwd: cache, env });
  }
  const internal = (await execFile(process.execPath, [resolver, "internal-skill", "orchestrator"], { cwd: cache, env })).stdout;
  assert.match(internal, /name: orchestrator/);
  await assert.rejects(execFile(process.execPath, [resolver, "skill", "../../escape"], { cwd: cache, env }), /invalid bootstrap skill id/);
  for (const id of ["../../escape", "Not_Valid"]) {
    await assert.rejects(
      execFile(process.execPath, [resolver, "internal-skill", id], { cwd: cache, env }),
      /invalid bootstrap internal-skill id/
    );
  }
  const resolverModule = await import(`${pathToFileURL(resolver).href}?parallel=${Date.now()}`);
  let leaseNow = Date.now() - 6 * 60 * 1000, heartbeat;
  const lease = {
    now: () => leaseNow,
    setInterval: callback => { heartbeat = callback; return { unref() {} }; },
    clearInterval() {},
    addExitListener() {},
    removeExitListener() {}
  };
  const parallel = await Promise.all(Array.from({ length: 128 }, () => resolverModule.resolveCodexRelease(cache, { lease })));
  assert.equal(new Set(parallel.map(item => item.generation)).size, 1);
  const selectedObject = parallel[0], selectedSkill = join(selectedObject.pluginRoot, "skills", "muster", "SKILL.md");
  assert.equal(typeof heartbeat, "function", "packed resolver did not schedule its lease heartbeat");
  leaseNow += 6 * 60 * 1000;
  await heartbeat();
  const leaseRecord = JSON.parse(await readFile(selectedObject.lease.path, "utf8"));
  assert.equal(leaseRecord.touchedAt, leaseNow, "packed resolver did not renew its lease beyond five minutes");
  const selectedSkillOriginal = await readFile(selectedSkill);
  await writeFile(selectedSkill, "ATTACKER-CONTROLLED-SKILL-AFTER-VALIDATION\n");
  await assert.rejects(resolverModule.readSelectedAsset(selectedObject, "plugin/skills/muster/SKILL.md"), /changed after release validation/);
  await writeFile(selectedSkill, selectedSkillOriginal);
  await selectedObject.lease.close();
  const detected = JSON.parse((await execFile(process.execPath, [join(bootstrap, "muster.mjs"), "detect", cache], { cwd: cache, env })).stdout);
  assert.equal(typeof detected.greenfield, "boolean");
  const mcp = await mcpSmoke(join(bootstrap, "muster-mcp.mjs"), cache, env);
  assert.ok(mcp.find(message => message.id === 2)?.result?.tools?.length >= 20);

  const staleHome = join(tmp, "stale-home");
  await mkdir(join(staleHome, "agents"), { recursive: true });
  await writeFile(join(staleHome, "agents", ".muster-managed.json"), JSON.stringify({ format: 1, owner: "muster", files: [], generation: "0".repeat(64), bootstrapDigest: "0".repeat(64) }));
  const doctorEnv = { ...process.env, CODEX_HOME: staleHome };
  const sourceDoctor = await runJsonAllowFailure(process.execPath, [join(repoRoot, "src", "cli.js"), "doctor", "--codex"], { cwd: cache, env: doctorEnv });
  const cacheDoctor = await runJsonAllowFailure(process.execPath, [join(bootstrap, "muster.mjs"), "doctor", "--codex"], { cwd: cache, env: doctorEnv });
  for (const result of [sourceDoctor, cacheDoctor]) {
    assert.notEqual(result.code, 0);
    const report = JSON.parse(result.stdout);
    assert.equal(report.checks.find(check => check.name === "codex-install-generation")?.ok, false);
  }

  const selections = join(cache, ".agents", "plugins", "selections"), names = (await readdir(selections)).sort();
  assert.ok(names.length >= 2 && names.length <= 3, `expected selected + bounded LKG selections, got ${names.length}`);
  const newest = names.at(-1), newestPath = join(selections, newest), original = await readFile(newestPath, "utf8");
  const currentGeneration = newest.match(/-([a-f0-9]{64})\.json$/)[1];
  await writeFile(newestPath, "{corrupt\n");
  const selectorFallback = (await execFile(process.execPath, [resolver, "plugin"], { cwd: cache, env })).stdout.trim();
  assert.doesNotMatch(selectorFallback, new RegExp(currentGeneration));
  await writeFile(newestPath, original);
  await writeFile(join(cache, ".agents", "plugins", "releases", currentGeneration, "release.json"), "{corrupt\n");
  const releaseFallback = (await execFile(process.execPath, [resolver, "plugin"], { cwd: cache, env })).stdout.trim();
  assert.equal(releaseFallback, selectorFallback);

  const marketplace = JSON.parse(await readFile(join(cache, ".agents", "plugins", "marketplace.json"), "utf8"));
  const sourcePath = marketplace.plugins.find(plugin => plugin.name === "muster")?.source?.path;
  assert.match(sourcePath || "", /^\.\/\.agents\/plugins\/releases\/[a-f0-9]{64}\/plugin$/,
    "Codex must cache the complete immutable release, not a checkout-relative bootstrap");
  const sourcePlugin = resolve(cache, sourcePath);
  const version = JSON.parse(await readFile(join(sourcePlugin, ".codex-plugin", "plugin.json"), "utf8")).version;
  const realCache = join(tmp, "real-codex-home", "plugins", "cache", "muster", "muster", version);
  await mkdir(join(realCache, ".."), { recursive: true });
  await cp(sourcePlugin, realCache, { recursive: true });
  await rm(join(cache, ".agents"), { recursive: true, force: true });
  for (const name of primary) {
    const skill = await readFile(join(realCache, "skills", name, "SKILL.md"), "utf8");
    assert.match(skill, new RegExp(`name: ${name}`));
    assert.doesNotMatch(skill, /# Immutable Muster bootstrap/);
  }
  assert.match(await readFile(join(realCache, "internal-skills", "orchestrator", "SKILL.md"), "utf8"), /name: orchestrator/);
  const providerResolver = join(realCache, "runtime", "resolve-skill-provider.mjs");
  await assert.rejects(readFile(join(realCache, "runtime", "resolve-release.mjs"), "utf8"));
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
  const cachedDetected = JSON.parse((await execFile(process.execPath, [join(realCache, "runtime", "muster.mjs"), "detect", cache], {
    cwd: tmp,
    env: { ...process.env, CODEX_HOME: join(tmp, "real-codex-home") }
  })).stdout);
  assert.equal(typeof cachedDetected.greenfield, "boolean");
  const cachedMcp = await mcpSmoke(join(realCache, "runtime", "muster-mcp.mjs"), tmp, env);
  assert.equal(cachedMcp.find(message => message.id === 2)?.result?.tools?.length, 21);

});
