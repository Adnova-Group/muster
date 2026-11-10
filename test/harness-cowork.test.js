import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { coworkConfigDirs, declaredPluginRide, readAccountPluginList, readInstalledCowork } from "../src/harness.js";
import { trackedMkdtempSync as mkdtempSync } from "../test-support/helpers.js";

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

function writePluginList(dir, plugins) {
  const list = path.join(dir, "plugin-list/org-1/account-1");
  mkdirSync(list, { recursive: true });
  writeFileSync(path.join(list, "plugins.json"), JSON.stringify({ plugins }));
}

test("readInstalledCowork: with no readable account plugin list, the plugin route is the default", async () => {
  const r = await readInstalledCowork("/no/such/home", { dir: "/no/such/dir" });
  assert.equal(r.nativePluginRide, true, "the plugin marketplace is the documented Desktop route; unknown is not plugin-less");
  assert.deepEqual(r.pluginLoad, { state: "unknown", source: "default" });
});

test("readInstalledCowork: a declaration wins over everything (true and false)", async () => {
  const dir = fixture((d) => writePluginList(d, [{ id: "design@kw", name: "design", enabled: true }]));
  try {
    const on = await readInstalledCowork("/ignored", { dir, nativePluginRide: true });
    assert.equal(on.nativePluginRide, true);
    assert.deepEqual(on.pluginLoad, { state: "present", source: "declared" });
    const off = await readInstalledCowork("/ignored", { dir, nativePluginRide: false });
    assert.equal(off.nativePluginRide, false);
    assert.deepEqual(off.pluginLoad, { state: "absent", source: "declared" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readInstalledCowork: account plugin list without muster selects the plugin-less MCP fallback", async () => {
  const dir = fixture((d) => writePluginList(d, [{ id: "design@kw", name: "design", enabled: true }]));
  try {
    const r = await readInstalledCowork("/ignored", { dir });
    assert.equal(r.nativePluginRide, false);
    assert.deepEqual(r.pluginLoad, { state: "absent", source: "account-plugin-list" });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("readInstalledCowork: account plugin list with muster enabled rides the plugin; disabled does not", async () => {
  const on = fixture((d) => writePluginList(d, [{ id: "muster@muster", name: "muster", enabled: true }]));
  const off = fixture((d) => writePluginList(d, [{ id: "muster@muster", name: "muster", enabled: false }]));
  try {
    const a = await readInstalledCowork("/ignored", { dir: on });
    assert.equal(a.nativePluginRide, true);
    assert.deepEqual(a.pluginLoad, { state: "present", source: "account-plugin-list", id: "muster@muster", enabled: true });
    const b = await readInstalledCowork("/ignored", { dir: off });
    assert.equal(b.nativePluginRide, false, "a disabled plugin does not load");
    assert.equal(b.pluginLoad.state, "absent");
  } finally {
    rmSync(on, { recursive: true, force: true });
    rmSync(off, { recursive: true, force: true });
  }
});

test("readAccountPluginList: null when unreadable, entries when present", async () => {
  assert.equal(await readAccountPluginList("/no/such/dir"), null);
  const dir = fixture((d) => writePluginList(d, [{ id: "muster@muster", enabled: true }, { name: "no-id" }]));
  try {
    assert.deepEqual(await readAccountPluginList(dir), [{ id: "muster@muster", name: "muster", enabled: true }]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("declaredPluginRide: flags and env parse to true, false, or undeclared", () => {
  assert.equal(declaredPluginRide(["--native-plugin"], {}), true);
  assert.equal(declaredPluginRide(["--plugin-less"], {}), false);
  assert.equal(declaredPluginRide([], {}), undefined);
  for (const v of ["1", "true", "yes"]) assert.equal(declaredPluginRide([], { MUSTER_COWORK_NATIVE_PLUGIN: v }), true, v);
  for (const v of ["0", "false", "FALSE", "no", "off"]) assert.equal(declaredPluginRide([], { MUSTER_COWORK_NATIVE_PLUGIN: v }), false, v);
  for (const v of ["", "  "]) assert.equal(declaredPluginRide([], { MUSTER_COWORK_NATIVE_PLUGIN: v }), undefined, JSON.stringify(v));
});

test("readInstalledCowork: ignores Claude Code-only agents, skills, and unregistered plugin MCP servers", async () => {
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
    assert.deepEqual(r.mcpServers, ["foo"], "only the Cowork registry is invocable");
    assert.deepEqual([r.plugins, r.skills, r.agents], [[], [], []], "Claude Code-only provider lanes stay hidden");
    assert.equal(r.runtime, "cowork", "capability resolution receives an explicit runtime contract");
    assert.equal(r.connectorsDiscoverable, false, "connector contract unchanged");
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cfg, { recursive: true, force: true });
  }
});
