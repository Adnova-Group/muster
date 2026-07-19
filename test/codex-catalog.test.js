// Split from the former test/codex.test.js monolith: capability-catalog
// adaptation, live Codex plugin/skill/MCP inventory discovery, and the
// packaged (install-time-generated, not committed) distribution surface.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { CODEX_COUNTS } from "../src/codex.js";
import { readCodexInventory } from "../src/codex-inventory.js";
import { adaptCatalogForCodex, codexFallbackSkillId } from "../src/codex-catalog.js";
import { execFile, repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";

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

test("Codex inventory is driven by live JSON and project/user directories", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-inventory-"));
  const plugin = join(tmp, "live-plugin");
  await mkdir(join(plugin, "skills", "plugin-skill"), { recursive: true });
  await mkdir(join(plugin, "agents"), { recursive: true });
  await mkdir(join(tmp, "project", ".codex", "skills", "project-skill"), { recursive: true });
  await mkdir(join(tmp, "home", "skills", "user-skill"), { recursive: true });
  await mkdir(join(tmp, "project", ".codex", "agents"), { recursive: true });
  await writeFile(join(plugin, "skills", "plugin-skill", "SKILL.md"), "---\nname: plugin-skill\ndescription: test\n---\n");
  await writeFile(join(plugin, "agents", "plugin-agent.toml"), "name = 'plugin-agent'\n");
  await writeFile(join(tmp, "project", ".codex", "skills", "project-skill", "SKILL.md"), "---\nname: project-skill\ndescription: test\n---\n");
  await writeFile(join(tmp, "home", "skills", "user-skill", "SKILL.md"), "---\nname: user-skill\ndescription: test\n---\n");
  await writeFile(join(tmp, "project", ".codex", "agents", "project-agent.toml"), "name = 'project-agent'\n");
  const execFile = async (_bin, args) => {
    if (args[0] === "plugin") return { stdout: JSON.stringify({ installed: [
      { name: "muster", installed: true, enabled: true, source: { path: plugin } },
      { name: "disabled-plugin", installed: true, enabled: false, source: { path: "/never-read" } }
    ], available: [{ name: "stale", installed: false, enabled: true, source: { path: "/never-read" } }] }) };
    return { stdout: JSON.stringify([{ name: "muster", enabled: true }, { name: "disabled-mcp", enabled: false }]) };
  };
  const inventory = await readCodexInventory({ cwd: join(tmp, "project"), codexHome: join(tmp, "home"), execFile });
  assert.deepEqual(inventory.plugins, ["muster"]);
  assert.deepEqual(new Set(inventory.skills), new Set(["plugin-skill", "project-skill", "user-skill"]));
  assert.deepEqual(inventory.mcpServers, ["muster"]);
  assert.deepEqual(new Set(inventory.agents), new Set(["plugin-agent", "project-agent"]));
});

test("Codex inventory excludes disabled plugins and MCP servers", async () => {
  const execFile = async (_bin, args) => args[0] === "plugin"
    ? { stdout: JSON.stringify({ installed: [{ name: "disabled", installed: true, enabled: false, source: { path: "/never-read" } }] }) }
    : { stdout: JSON.stringify([{ name: "disabled", enabled: false }, { name: "active", enabled: true }]) };
  const inventory = await readCodexInventory({ cwd: "/nonexistent", codexHome: "/nonexistent", execFile });
  assert.deepEqual(inventory.plugins, []);
  assert.deepEqual(inventory.skills, []);
  assert.deepEqual(inventory.agents, []);
  assert.deepEqual(inventory.mcpServers, ["active"]);
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
  assert.ok(paths.has("codex/agents.manifest.json"), "npm package must ship the frozen Codex agent mapping");
  assert.ok(!files.some(path => path.startsWith(".agents/")), "npm package must not ship a pre-generated .agents/ payload");
});

test("packaged Codex CLI runs without a consumer npm install", async () => {
  const runtime = join(selectedPluginRoot, "runtime", "muster.mjs");
  const { stdout } = await execFile("node", [runtime, "detect", repoRoot], { cwd: repoRoot });
  const result = JSON.parse(stdout);
  assert.equal(result.vcs.isRepo, true);
});
