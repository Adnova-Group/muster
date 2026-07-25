// readInstalledKimi: the Kimi Code CLI capability-scan bind. Reads a gen2
// ~/.kimi-code data root into the {plugins, skills, mcpServers, agents} shape
// resolveCapabilities consumes. Hermetic fixtures only (temp roots) -- the
// real-install probe is done by hand, never as an env-coupled committed test.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readInstalledKimi } from "../src/harness.js";

function tmp() { return mkdtempSync(join(tmpdir(), "muster-kimi-")); }
function write(p, s) { mkdirSync(join(p, ".."), { recursive: true }); writeFileSync(p, s); }

test("readInstalledKimi: parses a populated gen2 data root", async () => {
  const root = tmp(), home = tmp();
  try {
    write(join(root, "plugins", "installed.json"), JSON.stringify({ plugins: { "kimi-finance": { enabled: true }, "kimi-docs": { enabled: false } } }));
    write(join(root, "skills", "report", "SKILL.md"), "---\nname: report\ndescription: x\n---\nbody");
    write(join(root, "agents", "reviewer.md"), "---\nname: reviewer\ndescription: x\n---\nbody");
    write(join(root, "mcp.json"), JSON.stringify({ mcpServers: { context7: { url: "https://x" }, github: { command: "npx" } } }));
    // shared cross-tool lane under ~/.agents (does NOT move with KIMI_CODE_HOME)
    write(join(home, ".agents", "skills", "shared-skill", "SKILL.md"), "---\nname: shared-skill\ndescription: x\n---\nb");

    const inv = await readInstalledKimi(home, { dir: root });
    assert.equal(inv.runtime, "kimi");
    assert.deepEqual(inv.plugins.sort(), ["kimi-docs", "kimi-finance"]);
    assert.deepEqual(inv.skills.sort(), ["report", "shared-skill"]);
    assert.deepEqual(inv.agents, ["reviewer"]);
    assert.deepEqual(inv.mcpServers.sort(), ["context7", "github"]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("readInstalledKimi: a fresh install (nothing installed yet) is an empty inventory", async () => {
  const root = tmp(), home = tmp();
  try {
    const inv = await readInstalledKimi(home, { dir: root });
    assert.deepEqual(inv, { runtime: "kimi", plugins: [], skills: [], agents: [], mcpServers: [] });
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("readInstalledKimi: honors KIMI_CODE_HOME when opts.dir is absent", async () => {
  const root = tmp(), home = tmp();
  const prev = process.env.KIMI_CODE_HOME;
  process.env.KIMI_CODE_HOME = root;
  try {
    write(join(root, "mcp.json"), JSON.stringify({ mcpServers: { linear: { url: "https://x" } } }));
    const inv = await readInstalledKimi(home);
    assert.deepEqual(inv.mcpServers, ["linear"]);
  } finally {
    if (prev === undefined) delete process.env.KIMI_CODE_HOME; else process.env.KIMI_CODE_HOME = prev;
    rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true });
  }
});

test("readInstalledKimi: reads the documented plugins/managed/<id>/ surface (managed-only root)", async () => {
  const root = tmp(), home = tmp();
  try {
    // Documented stable surface (docs/research/kimi-code-cli.md): a managed
    // plugin is a directory under plugins/managed/ carrying a manifest at
    // kimi.plugin.json or .kimi-plugin/plugin.json. No installed.json here.
    write(join(root, "plugins", "managed", "kimi-finance", "kimi.plugin.json"), JSON.stringify({ name: "kimi-finance" }));
    write(join(root, "plugins", "managed", "kimi-docs", ".kimi-plugin", "plugin.json"), JSON.stringify({ name: "kimi-docs" }));
    // a managed dir with NO manifest is not an installed plugin
    mkdirSync(join(root, "plugins", "managed", "manifestless"), { recursive: true });
    const inv = await readInstalledKimi(home, { dir: root });
    assert.deepEqual(inv.plugins.sort(), ["kimi-docs", "kimi-finance"]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("readInstalledKimi: installed.json-only root behaves exactly as before (no managed dir)", async () => {
  const root = tmp(), home = tmp();
  try {
    write(join(root, "plugins", "installed.json"), JSON.stringify({ plugins: { "plug-a": { enabled: true }, "plug-b": {} } }));
    const inv = await readInstalledKimi(home, { dir: root });
    assert.deepEqual(inv.plugins.sort(), ["plug-a", "plug-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("readInstalledKimi: unions installed.json and the managed surface when both are present", async () => {
  const root = tmp(), home = tmp();
  try {
    write(join(root, "plugins", "installed.json"), JSON.stringify({ plugins: { "plug-a": { enabled: true }, "shared-plug": {} } }));
    write(join(root, "plugins", "managed", "shared-plug", "kimi.plugin.json"), JSON.stringify({ name: "shared-plug" }));
    write(join(root, "plugins", "managed", "plug-c", ".kimi-plugin", "plugin.json"), JSON.stringify({ name: "plug-c" }));
    const inv = await readInstalledKimi(home, { dir: root });
    // union, deduped: shared-plug appears in both surfaces but only once
    assert.deepEqual(inv.plugins.sort(), ["plug-a", "plug-c", "shared-plug"]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});

test("readInstalledKimi: tolerates a flat-map installed.json (unpublished schema)", async () => {
  const root = tmp(), home = tmp();
  try {
    // no top-level `plugins` key -- a flat { id: {...} } map
    write(join(root, "plugins", "installed.json"), JSON.stringify({ "plug-a": { enabled: true }, "plug-b": {} }));
    const inv = await readInstalledKimi(home, { dir: root });
    assert.deepEqual(inv.plugins.sort(), ["plug-a", "plug-b"]);
  } finally { rmSync(root, { recursive: true, force: true }); rmSync(home, { recursive: true, force: true }); }
});
