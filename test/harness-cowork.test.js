import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coworkConfigDirs, readInstalledCowork } from "../src/harness.js";

function fixture(build) {
  const dir = mkdtempSync(path.join(tmpdir(), "cowork-"));
  build(dir);
  return dir;
}

test("coworkConfigDirs: macOS path", async () => {
  const dirs = await coworkConfigDirs("/Users/me", "darwin");
  assert.deepEqual(dirs, ["/Users/me/Library/Application Support/Claude"]);
});

test("coworkConfigDirs: linux path", async () => {
  const dirs = await coworkConfigDirs("/home/me", "linux");
  assert.deepEqual(dirs, ["/home/me/.config/Claude"]);
});

test("coworkConfigDirs: win32 puts the MSIX-virtualized path before %APPDATA%", async () => {
  const home = fixture((d) => {
    mkdirSync(path.join(d, "AppData/Local/Packages/Claude_pzs8sxrjxfjjc"), { recursive: true });
  });
  try {
    const dirs = await coworkConfigDirs(home, "win32");
    assert.match(dirs[0], /Packages[\/\\]Claude_pzs8sxrjxfjjc[\/\\]LocalCache[\/\\]Roaming[\/\\]Claude$/, "MSIX path first");
    assert.match(dirs.at(-1), /AppData[\/\\]Roaming[\/\\]Claude$/, "APPDATA fallback last");
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("readInstalledCowork: reads local mcpServers and enumerates Claude Extensions", async () => {
  const dir = fixture((d) => {
    writeFileSync(path.join(d, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { foo: { command: "node" }, bar: { command: "npx" } } }));
    mkdirSync(path.join(d, "Claude Extensions/ext1"), { recursive: true });
    writeFileSync(path.join(d, "Claude Extensions/ext1/manifest.json"), JSON.stringify({ name: "baz" }));
  });
  try {
    const r = await readInstalledCowork("/ignored", { dir });
    assert.deepEqual(r.mcpServers.sort(), ["bar", "baz", "foo"]);
    assert.deepEqual([r.plugins, r.skills, r.agents], [[], [], []], "no plugins installed in this fixture home");
    assert.equal(r.connectorsDiscoverable, false, "remote connectors are never disk-discoverable");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readInstalledCowork: declared connectors merge into mcpServers and are reported", async () => {
  const dir = fixture((d) => {
    writeFileSync(path.join(d, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { foo: {} } }));
  });
  try {
    const r = await readInstalledCowork("/ignored", { dir, declaredConnectors: ["slack", "drive"] });
    assert.ok(["slack", "drive"].every((c) => r.mcpServers.includes(c)), "declared connectors are available providers");
    assert.deepEqual(r.connectorsDeclared.sort(), ["drive", "slack"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readInstalledCowork: missing config dir yields empty providers, no throw", async () => {
  const r = await readInstalledCowork("/no/such/home", { dir: "/no/such/dir" });
  assert.deepEqual(r.mcpServers, []);
  assert.equal(r.connectorsDiscoverable, false);
});

test("readInstalledCowork: merges Claude Code plugin inventory into all lanes", async () => {
  const home = fixture((d) => {
    const install = path.join(d, ".claude/plugins/cache/official/serena/1.0.0");
    mkdirSync(path.join(install, "agents"), { recursive: true });
    writeFileSync(path.join(install, ".mcp.json"), JSON.stringify({ serena: { command: "uvx" } }));
    writeFileSync(path.join(install, "agents/serena-agent.md"), "# serena agent");
    writeFileSync(path.join(d, ".claude/plugins/installed_plugins.json"), JSON.stringify({
      version: 2, plugins: { "serena@official": [{ installPath: install }] }
    }));
  });
  const cfg = fixture((d) => {
    writeFileSync(path.join(d, "claude_desktop_config.json"), JSON.stringify({ mcpServers: { foo: {} } }));
  });
  try {
    const r = await readInstalledCowork(home, { dir: cfg });
    assert.deepEqual(r.mcpServers.sort(), ["foo", "serena"], "registry + plugin servers merge");
    assert.deepEqual(r.plugins, ["serena"], "plugin lane populated");
    assert.deepEqual(r.agents, ["serena-agent"], "agent lane populated");
    assert.equal(r.connectorsDiscoverable, false, "connector contract unchanged");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});
