// Split from the former test/codex.test.js monolith: capability-catalog
// adaptation, live Codex plugin/skill/MCP inventory discovery, and the
// packaged (install-time-generated, not committed) distribution surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CODEX_COUNTS } from "../src/codex.js";
import { readCodexInventory } from "../src/codex-inventory.js";
import { adaptCatalogForCodex, codexFallbackSkillId } from "../src/codex-catalog.js";
import { execFile, repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

function packagedMcpTools() {
  return new Promise((resolve, reject) => {
    const server = spawn("node", [join(selectedPluginRoot, "runtime", "muster-mcp.mjs")], {
      cwd: repoRoot,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let buffer = "";
    const timer = setTimeout(() => {
      server.kill();
      reject(new Error("packaged Codex MCP server timed out"));
    }, 10_000);
    const finish = (error, result) => {
      clearTimeout(timer);
      server.kill();
      if (error) reject(error); else resolve(result);
    };
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.id === 2) finish(null, message.result.tools);
      }
    });
    server.stderr.setEncoding("utf8");
    let stderr = "";
    server.stderr.on("data", chunk => { stderr += chunk; });
    server.on("error", error => finish(error));
    server.on("exit", code => {
      if (code && stderr) finish(new Error(stderr));
    });
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } } };
    server.stdin.write(JSON.stringify(init) + "\n");
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
  });
}

test("Codex capability catalog prefers enabled native upstream skills and namespaces GSD fallback", () => {
  const catalog = [
    { id: "sp-plan", kind: "builtin", roles: ["plan"], rank: 50, provenance: { license: "MIT" } },
    { id: "wsh-code-review-excellence", kind: "builtin", roles: ["code-review"], rank: 50, provenance: { license: "MIT" } },
    { id: "gsd-execute-phase", kind: "builtin", roles: ["implement"], rank: 50, provenance: { license: "MIT" } }
  ];
  const adapted = adaptCatalogForCodex(catalog, { skills: ["writing-plans", "code-review-excellence", "gsd-execute-phase"] });
  assert.ok(adapted.some(entry => entry.id === "writing-plans" && entry.kind === "external"));
  assert.ok(adapted.some(entry => entry.id === "code-review-excellence" && entry.kind === "external"));
  assert.ok(adapted.some(entry => entry.id === "gsd-execute-phase" && entry.kind === "external"));
  assert.ok(adapted.some(entry => entry.id === "muster-gsd-execute-phase" && entry.kind === "builtin"));
  assert.equal(codexFallbackSkillId("sp-plan"), "sp-plan");
  assert.equal(codexFallbackSkillId("gsd-plan-phase"), "muster-gsd-plan-phase");
});

test("Codex capability catalog preserves the exact namespaced runtime skill id", () => {
  const catalog = [
    { id: "sp-plan", kind: "builtin", roles: ["plan"], rank: 50, provenance: { license: "MIT" } },
  ];
  const adapted = adaptCatalogForCodex(catalog, { skills: ["superpowers:writing-plans"] });
  assert.ok(adapted.some(entry => entry.id === "superpowers:writing-plans" && entry.kind === "external"));
  assert.ok(!adapted.some(entry => entry.id === "writing-plans" && entry.kind === "external"));
});

test("Codex inventory uses exact skill ids from the native runtime authority", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-inventory-"));
  const plugin = join(tmp, "live-plugin");
  await mkdir(join(plugin, "agents"), { recursive: true });
  await mkdir(join(tmp, "project", ".codex", "agents"), { recursive: true });
  await writeFile(join(plugin, "agents", "plugin-agent.toml"), "name = 'plugin-agent'\n");
  await writeFile(join(tmp, "project", ".codex", "agents", "project-agent.toml"), "name = 'project-agent'\n");
  const runtimeInventory = async () => ({
    plugins: [{ name: "muster", sourcePath: plugin }, { name: "supabase", sourcePath: null }],
    skills: [
      { id: "muster:muster-go", description: "Run one outcome" },
      { id: "supabase:supabase", description: "Use Supabase" },
    ],
    complete: true,
    errors: [],
  });
  const execFile = async () => ({ stdout: JSON.stringify([{ name: "muster", enabled: true }, { name: "disabled-mcp", enabled: false }]) });
  const inventory = await readCodexInventory({ cwd: join(tmp, "project"), codexHome: join(tmp, "home"), execFile, runtimeInventory });
  assert.deepEqual(inventory.plugins, ["muster", "supabase"]);
  assert.deepEqual(inventory.skills, ["muster:muster-go", "supabase:supabase"]);
  assert.equal(inventory.skillDescriptions["supabase:supabase"], "Use Supabase");
  assert.deepEqual(inventory.skillInventory, { source: "codex-app-server", complete: true, errors: [] });
  assert.deepEqual(inventory.mcpServers, ["muster"]);
  assert.deepEqual(new Set(inventory.agents), new Set(["plugin-agent", "project-agent"]));
});

test("Codex inventory exposes a failed native probe as incomplete, not authoritative absence", async () => {
  const execFile = async () => ({ stdout: JSON.stringify([{ name: "disabled", enabled: false }, { name: "active", enabled: true }]) });
  const runtimeInventory = async () => ({ plugins: [], skills: [], complete: false, errors: ["skills/list timed out"] });
  const inventory = await readCodexInventory({ cwd: "/nonexistent", codexHome: "/nonexistent", execFile, runtimeInventory });
  assert.deepEqual(inventory.plugins, []);
  assert.deepEqual(inventory.skills, []);
  assert.deepEqual(inventory.agents, []);
  assert.deepEqual(inventory.mcpServers, ["active"]);
  assert.deepEqual(inventory.skillInventory, {
    source: "codex-app-server", complete: false, errors: ["skills/list timed out"],
  });
});

test("packaged Codex MCP runtime registers the shared muster_* tools (CODEX_COUNTS.mcpTools)", async () => {
  const tools = await packagedMcpTools();
  assert.equal(tools.length, CODEX_COUNTS.mcpTools);
  assert.ok(tools.every(tool => tool.name.startsWith("muster_")));
  const runtime = await readFile(join(selectedPluginRoot, "runtime", "muster-mcp.mjs"), "utf8");
  assert.match(runtime, /"capabilities", "--codex"/);
  assert.match(runtime, /"assess", "--codex"/);
  assert.doesNotMatch(runtime, /"capabilities", "--cowork"/);
});

test("npm package ships install-time generation sources, not a committed Codex payload", async () => {
  const { stdout } = await execFile("npm", ["pack", "--dry-run", "--json"], { cwd: repoRoot, maxBuffer: 16 * 1024 * 1024 });
  const files = JSON.parse(stdout)[0].files.map(file => file.path);
  const paths = new Set(files);
  assert.ok(paths.has("scripts/build-codex.mjs"), "npm package must ship the install-time Codex generation script");
  assert.ok(paths.has("catalog/agents.manifest.json"), "npm package must ship the frozen Codex agent mapping");
  assert.ok(!files.some(path => path.startsWith(".agents/")), "npm package must not ship a pre-generated .agents/ payload");
});

test("packaged Codex CLI runs without a consumer npm install", async () => {
  const runtime = join(selectedPluginRoot, "runtime", "muster.mjs");
  const { stdout } = await execFile("node", [runtime, "detect", repoRoot], { cwd: repoRoot });
  const result = JSON.parse(stdout);
  assert.equal(result.vcs.isRepo, true);
});
