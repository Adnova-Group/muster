import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_PLUGIN_MCP_SCHEMA,
  AGENT_PLUGIN_SCHEMA,
  generateAgentPluginManifest,
  listDirectChildSkills,
  validateAgentPluginPackage,
} from "../src/agent-plugins.js";

const repoRoot = new URL("../", import.meta.url).pathname;
const execFile = promisify(execFileCallback);
const json = async relative => JSON.parse(await readFile(join(repoRoot, relative), "utf8"));

test("portable metadata is generated from the existing package and Claude overlay", async () => {
  const pkg = await json("package.json");
  const claude = await json("plugin/.claude-plugin/plugin.json");
  const portable = await json("plugin.json");

  assert.deepEqual(portable, generateAgentPluginManifest({ pkg, claude }));
  assert.equal(portable.$schema, AGENT_PLUGIN_SCHEMA);
  assert.equal(portable.name, claude.name);
  assert.equal(portable.version, pkg.version);
  assert.equal(portable.license, pkg.license);
  assert.equal(portable.homepage, pkg.homepage);
  assert.equal(portable.repository, pkg.repository.url);
});

test("portable skills map exactly to canonical direct-child skills", async () => {
  const canonical = await listDirectChildSkills(join(repoRoot, "plugin", "skills"));
  const portable = await listDirectChildSkills(join(repoRoot, "skills"));

  assert.deepEqual(portable, canonical);
  for (const name of portable) {
    const shim = await readFile(join(repoRoot, "skills", name, "SKILL.md"), "utf8");
    assert.match(shim, new RegExp(`name:\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "m"));
    assert.match(shim, new RegExp(`plugin/skills/${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/SKILL\\.md`));
  }
});

test("unsupported Agent Plugins schema versions fail closed", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-agent-plugin-version-"));
  const manifest = generateAgentPluginManifest({
    pkg: await json("package.json"),
    claude: await json("plugin/.claude-plugin/plugin.json"),
  });
  await writeFile(join(tmp, "plugin.json"), JSON.stringify({
    ...manifest,
    $schema: "https://agent-plugins.org/schemas/2.0.0/plugin.schema.json",
  }));
  await writeFile(join(tmp, "mcp.json"), JSON.stringify({
    $schema: AGENT_PLUGIN_MCP_SCHEMA,
    mcpServers: {},
  }));

  await assert.rejects(
    validateAgentPluginPackage(tmp),
    /unsupported Agent Plugins manifest schema/
  );

  await writeFile(join(tmp, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(tmp, "mcp.json"), JSON.stringify({
    $schema: "https://agent-plugins.org/schemas/2.0.0/mcp.schema.json",
    mcpServers: {},
  }));
  await assert.rejects(
    validateAgentPluginPackage(tmp),
    /unsupported Agent Plugins MCP schema/
  );
});

test("portable package validates schema, direct-child discovery, and package boundaries", async () => {
  const result = await validateAgentPluginPackage(repoRoot);

  assert.equal(result.schemaVersion, "1.0.0");
  assert.equal(result.mcpServers.muster.command, "node");
  assert.deepEqual(result.skills, await listDirectChildSkills(join(repoRoot, "plugin", "skills")));
  assert.ok(result.packageFiles.includes("plugin.json"));
  assert.ok(result.packageFiles.includes("mcp.json"));
  assert.ok(result.packageFiles.includes("skills"));
  assert.ok(result.packageFiles.includes("mcp"));
});

test("npm package includes every Agent Plugins entry point and mapped component", async () => {
  const { stdout } = await execFile("npm", ["pack", "--dry-run", "--json"], {
    cwd: repoRoot,
    maxBuffer: 4 * 1024 * 1024,
  });
  const [packed] = JSON.parse(stdout);
  const paths = new Set(packed.files.map(file => file.path));

  for (const path of ["plugin.json", "mcp.json", "mcp/codex-server.mjs"]) {
    assert.ok(paths.has(path), `npm package must include ${path}`);
  }
  for (const name of await listDirectChildSkills(join(repoRoot, "plugin", "skills"))) {
    assert.ok(paths.has(`skills/${name}/SKILL.md`), `npm package must include portable skill ${name}`);
    assert.ok(paths.has(`plugin/skills/${name}/SKILL.md`), `npm package must include canonical skill ${name}`);
  }
});
