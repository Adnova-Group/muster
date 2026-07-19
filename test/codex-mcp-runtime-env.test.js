import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb, spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCodexPlugin } from "../src/codex-release.js";

const execFile = promisify(execFileCb);
const repoRoot = new URL("../", import.meta.url).pathname;

// Regression for the 2026-07-18 Codex dogfood: cowork/mcp-server.mjs launches
// every CLI child with `env: { ...process.env, MUSTER_RUNTIME: "cowork" }`
// (a Cowork-only signal), and src/capabilities.js honors that env over the
// `--codex` flag, so the Codex-bundled MCP server's muster_capabilities
// resolved every role to "inline" instead of the named agent profiles that
// `node src/cli.js capabilities --codex` (clean env) correctly resolves.

function callTool(entry, name, args, cwd, env) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [entry], { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
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
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "runtime-env-test", version: "1" } } }) + "\n");
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name, arguments: args } }) + "\n");
  });
}

test("built Codex plugin's MCP server resolves roles to named agent profiles, not inline (MUSTER_RUNTIME cowork-poisoning regression)", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-runtime-env-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const { pluginRoot } = await resolveCodexPlugin(repoRoot);
  const env = { ...process.env };
  delete env.NODE_ENV;
  delete env.MUSTER_COWORK_TEST_CLI;
  delete env.MUSTER_RUNTIME;

  const messages = await callTool(join(pluginRoot, "runtime", "muster-mcp.mjs"), "muster_capabilities", {}, tmp, env);
  const response = messages.find(message => message.id === 2);
  assert.ok(response?.result, `muster_capabilities returned no result: ${JSON.stringify(response?.error || {}).slice(0, 300)}`);
  assert.notEqual(response.result.isError, true, `muster_capabilities errored: ${String(response.result.content?.[0]?.text).slice(0, 300)}`);
  const capabilities = JSON.parse(response.result.content[0].text);

  const expected = { implement: "muster-builder", "code-review": "muster-reviewer", "test-author": "wsh-test-automator" };
  for (const [role, id] of Object.entries(expected)) {
    const chosen = capabilities.roles?.[role]?.chosen;
    assert.equal(chosen?.id, id, `role ${role} must resolve to ${id}, got ${JSON.stringify(chosen)} -- MUSTER_RUNTIME=cowork leaking into the Codex-spawned CLI child forces the coworkMcpOnly gate and every role collapses to inline`);
    assert.notEqual(chosen?.source, "inline", `role ${role} must not fall back to inline`);
  }

  // Same dogfood run also reported manifest validation failing to recognize
  // the bundled sp-tdd skill. That traces to the identical root cause:
  // capabilities.js's coworkMcpOnly branch short-circuits before the skills
  // inventory is ever populated (capabilities.js's `if (coworkMcpOnly) return
  // { roles, installedRaw: installed, skills };` with skills still []). Once
  // the runtime env no longer misidentifies the Codex bundle as Cowork, the
  // skills inventory is populated normally and sp-tdd is back on it.
  assert.ok(capabilities.skills?.some(skill => skill.id === "sp-tdd"), `bundled sp-tdd skill missing from codex capabilities skills inventory: ${JSON.stringify(capabilities.skills)}`);
});

test("MUSTER_RUNTIME=cowork leaking into `capabilities --codex` is the proven mechanism (CLI-level pin, no MCP spawn required)", async t => {
  // Narrower, faster companion to the MCP-level regression above: pins the
  // exact mechanism at the CLI layer so a future change to capabilities.js's
  // cowork-detection OR-clause (src/capabilities.js:39) trips a fast test
  // instead of only the slower end-to-end MCP spawn.
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-runtime-env-cli-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cli = join(repoRoot, "src", "cli.js");

  const clean = { ...process.env };
  delete clean.MUSTER_RUNTIME;
  const cleanOut = JSON.parse((await execFile(process.execPath, [cli, "capabilities", "--codex", "--roles-only"], { cwd: tmp, env: clean })).stdout);
  assert.equal(cleanOut.roles.implement.chosen.id, "muster-builder", "clean env: --codex must resolve implement to muster-builder");

  const poisoned = { ...process.env, MUSTER_RUNTIME: "cowork" };
  const poisonedOut = JSON.parse((await execFile(process.execPath, [cli, "capabilities", "--codex", "--roles-only"], { cwd: tmp, env: poisoned })).stdout);
  assert.equal(poisonedOut.roles.implement.chosen.id, "inline", "MUSTER_RUNTIME=cowork must no longer be injected by the built Codex bundle's MCP server -- this assertion documents the mechanism this fix removes from the child-spawn env, not a desired outcome");
});

test("muster_route's domain:unknown/pipeline:null symptom from the dogfood is NOT MUSTER_RUNTIME-caused (documented, left open)", async t => {
  // The dogfood also reported muster_route returning domain:unknown/pipeline:null
  // for a concrete code outcome. Tested directly against the CLI with and
  // without MUSTER_RUNTIME=cowork: identical result both ways, so this
  // symptom is unrelated to the runtime-env bug this item fixes. route()
  // classifies from outcome-text keywords (none of which match "fix"/
  // "flaky"/"test"/"login") and otherwise falls back to the detected
  // project's shape at process.cwd() -- from a bare tmp cwd with no
  // detectable project, that fallback also misses, independent of env.
  // Left open under codex-assess-criteria-detect; not addressed here.
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-route-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cli = join(repoRoot, "src", "cli.js");
  const outcome = "Fix the flaky login test in src/auth.js";

  const clean = { ...process.env };
  delete clean.MUSTER_RUNTIME;
  const withoutEnv = JSON.parse((await execFile(process.execPath, [cli, "route", outcome], { cwd: tmp, env: clean })).stdout);

  const poisoned = { ...process.env, MUSTER_RUNTIME: "cowork" };
  const withEnv = JSON.parse((await execFile(process.execPath, [cli, "route", outcome], { cwd: tmp, env: poisoned })).stdout);

  assert.deepEqual(withoutEnv, withEnv, "route's result must be identical regardless of MUSTER_RUNTIME -- proves the domain:unknown symptom is not env-caused");
  assert.equal(withoutEnv.domain, "unknown", "documents the actual (still-open, non-env) cause: no project detectable from a bare cwd and no outcome-text keyword match");
});

test("cowork bundle path is unchanged: cowork/mcp-server.mjs still launches CLI children with MUSTER_RUNTIME: \"cowork\"", async () => {
  // The fix lives ONLY in the Codex build transform (scripts/build-codex.mjs).
  // cowork/mcp-server.mjs's own cowork semantics are correct for the Cowork
  // bundle and must stay untouched -- it also sits inside the Claude-surface
  // parity hash (test/claude-parity.test.js), so editing it would churn that
  // pin for no reason.
  const source = await readFile(join(repoRoot, "cowork", "mcp-server.mjs"), "utf8");
  assert.match(source, /env:\s*\{\s*\.\.\.process\.env,\s*MUSTER_RUNTIME:\s*"cowork"\s*\}/, "cowork/mcp-server.mjs must still pin MUSTER_RUNTIME to \"cowork\" for the Cowork bundle -- this file is the shared source the Codex build transform rewrites FROM, not a file this fix touches");
});
