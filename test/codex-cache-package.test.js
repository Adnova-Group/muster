import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

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
    const skill = (await execFile(process.execPath, [resolver, "skill", name], { cwd: cache, env })).stdout.trim();
    assert.match(await readFile(skill, "utf8"), new RegExp(`name: ${name}`));
    await execFile(process.execPath, [resolver, "command", name.replace(/^muster-/, "")], { cwd: cache, env });
  }
  await assert.rejects(execFile(process.execPath, [resolver, "skill", "../../escape"], { cwd: cache, env }), /invalid bootstrap skill id/);
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

});
