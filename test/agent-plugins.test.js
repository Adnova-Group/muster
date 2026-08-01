import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, symlink, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AGENT_PLUGIN_MCP_SCHEMA,
  AGENT_PLUGIN_SCHEMA,
  AGENT_PLUGIN_INVENTORY_LIMITS,
  generateAgentPluginManifest,
  listDirectChildSkills,
  readAgentPluginInventory,
  validateMcpConfiguration,
  validateAgentPluginPackage,
} from "../src/agent-plugins.js";

const repoRoot = new URL("../", import.meta.url).pathname;
const execFile = promisify(execFileCallback);
const json = async relative => JSON.parse(await readFile(join(repoRoot, relative), "utf8"));
const validMcp = {
  $schema: AGENT_PLUGIN_MCP_SCHEMA,
  mcpServers: {},
};

async function writeInventoryRoot(root, manifest = { $schema: AGENT_PLUGIN_SCHEMA, name: "fixture" }) {
  await mkdir(join(root, "skills"), { recursive: true });
  await writeFile(join(root, "plugin.json"), JSON.stringify(manifest));
  await writeFile(join(root, "mcp.json"), JSON.stringify(validMcp));
}

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
  await mkdir(join(tmp, "skills"));
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

test("manifest metadata follows the complete closed Agent Plugins 1.0 shape", async () => {
  const invalidFields = [
    ["version", 1],
    ["description", false],
    ["author", "Muster"],
    ["author", { name: "Muster", handle: "@muster" }],
    ["author", { name: 7 }],
    ["homepage", 7],
    ["repository", {}],
    ["license", null],
    ["keywords", ["valid", 7]],
    ["extensions", []],
    ["extensions", { "dev.muster": "invalid" }],
  ];

  for (const [field, value] of invalidFields) {
    const root = await mkdtemp(join(tmpdir(), "muster-agent-plugin-manifest-shape-"));
    await writeInventoryRoot(root, {
      $schema: AGENT_PLUGIN_SCHEMA,
      name: "fixture",
      [field]: value,
    });
    await assert.rejects(
      readAgentPluginInventory(root),
      /invalid Agent Plugins manifest/
    );
  }
});

test("invalid closed-variant MCP server entries fail validation", async () => {
  const invalidServers = [
    { type: "stdio", command: "" },
    { type: "stdio", command: ".." },
    { type: "stdio", command: "./../outside" },
    { type: "stdio", command: "C:\\Windows\\System32\\cmd.exe" },
    { type: "stdio", command: ".\\mcp\\server.exe" },
    { type: "stdio", command: "..\\outside\\server.exe" },
    { type: "stdio", command: "node", cwd: "outside" },
    { type: "stdio", command: "node", cwd: "${PLUGIN_DATA}/../outside" },
    { type: "stdio", command: "node", env: { PLUGIN_ROOT: "/tmp/override" } },
    { type: "stdio", command: "node", surprise: true },
    { type: "streamable-http", url: "https://example.com/mcp", headers: { "bad header": "x" } },
    { type: "streamable-http", url: "https://example.com/mcp", headers: { Good: "line\nbreak" } },
    { type: "streamable-http", url: "http://127.example.com/mcp" },
  ];
  for (const server of invalidServers) {
    await assert.rejects(
      validateMcpConfiguration(repoRoot, {
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { invalid: server },
      }),
      /invalid Agent Plugins MCP server/
    );
  }
});

test("PLUGIN_DATA cwd resolves against the actual runtime data root", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-agent-plugin-root-"));
  const dataRoot = await mkdtemp(join(tmpdir(), "muster-agent-plugin-data-"));
  const outside = await mkdtemp(join(tmpdir(), "muster-agent-plugin-data-outside-"));
  await mkdir(join(dataRoot, "inside"));
  await symlink(outside, join(dataRoot, "escape"), "dir");
  const configuration = cwd => ({
    $schema: AGENT_PLUGIN_MCP_SCHEMA,
    mcpServers: { fixture: { type: "stdio", command: "node", cwd } },
  });

  await validateMcpConfiguration(root, configuration("${PLUGIN_DATA}/inside"), { pluginDataRoot: dataRoot });
  await assert.rejects(
    validateMcpConfiguration(root, configuration("${PLUGIN_DATA}/inside")),
    /PLUGIN_DATA/
  );
  await assert.rejects(
    validateMcpConfiguration(root, configuration("${PLUGIN_DATA}/escape"), { pluginDataRoot: dataRoot }),
    /invalid Agent Plugins MCP server/
  );
});

test("manifest, MCP config, and portable skills are resolved inside the package root", async () => {
  for (const escaped of ["plugin.json", "mcp.json", "skills"]) {
    const root = await mkdtemp(join(tmpdir(), "muster-agent-plugin-boundary-"));
    const outside = await mkdtemp(join(tmpdir(), "muster-agent-plugin-boundary-outside-"));
    if (escaped === "skills") {
      await writeFile(join(root, "plugin.json"), JSON.stringify({ $schema: AGENT_PLUGIN_SCHEMA, name: "fixture" }));
      await writeFile(join(root, "mcp.json"), JSON.stringify(validMcp));
      await mkdir(join(outside, "skill"));
      await writeFile(join(outside, "skill", "SKILL.md"), "---\ndescription: escaped\n---\n");
      await symlink(outside, join(root, "skills"), "dir");
    } else {
      await mkdir(join(root, "skills"));
      const outsideFile = join(outside, escaped);
      await writeFile(
        outsideFile,
        JSON.stringify(escaped === "plugin.json"
          ? { $schema: AGENT_PLUGIN_SCHEMA, name: "fixture" }
          : validMcp)
      );
      await symlink(outsideFile, join(root, escaped), "file");
      const other = escaped === "plugin.json" ? "mcp.json" : "plugin.json";
      await writeFile(
        join(root, other),
        JSON.stringify(other === "plugin.json"
          ? { $schema: AGENT_PLUGIN_SCHEMA, name: "fixture" }
          : validMcp)
      );
    }

    await assert.rejects(
      validateAgentPluginPackage(root),
      /escapes the Agent Plugin package root/
    );
  }
});

test("portable inventory reads skill descriptions from the package, independent of HOME", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-agent-plugin-descriptions-"));
  await writeInventoryRoot(root);
  await mkdir(join(root, "skills", "portable-skill"));
  await writeFile(
    join(root, "skills", "portable-skill", "SKILL.md"),
    "---\nname: portable-skill\ndescription: Finds quuxle-only capabilities.\n---\n"
  );

  const inventory = await readAgentPluginInventory(root);
  assert.deepEqual(inventory.skills, ["portable-skill"]);
  assert.equal(inventory.skillDescriptions["portable-skill"], "Finds quuxle-only capabilities.");
});

test("portable inventory rejects oversized manifests before reading their contents", async () => {
  for (const manifestName of ["plugin.json", "mcp.json"]) {
    const root = await mkdtemp(join(tmpdir(), "muster-agent-plugin-oversized-manifest-"));
    await writeInventoryRoot(root);
    await truncate(join(root, manifestName), AGENT_PLUGIN_INVENTORY_LIMITS.manifestBytes + 1);

    await assert.rejects(
      readAgentPluginInventory(root),
      new RegExp(`${manifestName} exceeds the ${AGENT_PLUGIN_INVENTORY_LIMITS.manifestBytes} byte limit`),
    );
  }
});

test("portable inventory rejects an oversized SKILL.md before reading its contents", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-agent-plugin-oversized-skill-"));
  await writeInventoryRoot(root);
  const skillRoot = join(root, "skills", "oversized-skill");
  await mkdir(skillRoot);
  const skillFile = join(skillRoot, "SKILL.md");
  await writeFile(skillFile, "");
  await truncate(skillFile, AGENT_PLUGIN_INVENTORY_LIMITS.skillBytes + 1);

  await assert.rejects(
    readAgentPluginInventory(root),
    new RegExp(`skill oversized-skill SKILL.md exceeds the ${AGENT_PLUGIN_INVENTORY_LIMITS.skillBytes} byte limit`),
  );
});

test("portable inventory rejects excessive skill counts instead of returning a partial inventory", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-agent-plugin-many-skills-"));
  await writeInventoryRoot(root);
  for (let index = 0; index <= AGENT_PLUGIN_INVENTORY_LIMITS.maxSkills; index += 1) {
    const name = `skill-${String(index).padStart(3, "0")}`;
    const skillRoot = join(root, "skills", name);
    await mkdir(skillRoot);
    await writeFile(join(skillRoot, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n`);
  }

  await assert.rejects(
    readAgentPluginInventory(root),
    new RegExp(`Agent Plugin skills exceed the ${AGENT_PLUGIN_INVENTORY_LIMITS.maxSkills} skill limit`),
  );
});

test("plugin-relative MCP command and cwd reject symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-agent-plugin-root-"));
  const outside = await mkdtemp(join(tmpdir(), "muster-agent-plugin-outside-"));
  await writeFile(join(outside, "server.mjs"), "export {};\n");
  await symlink(outside, join(root, "escape"), "dir");
  await mkdir(join(root, "inside"));

  for (const server of [
    { type: "stdio", command: "./escape/server.mjs" },
    { type: "stdio", command: "node", cwd: "./escape" },
    { type: "stdio", command: "node", cwd: "${PLUGIN_ROOT}/escape" },
  ]) {
    await assert.rejects(
      validateMcpConfiguration(root, {
        $schema: AGENT_PLUGIN_MCP_SCHEMA,
        mcpServers: { escaped: server },
      }),
      /invalid Agent Plugins MCP server/
    );
  }
});

test("stdio MCP arguments are opaque and need not name package files", async () => {
  await validateMcpConfiguration(repoRoot, {
    $schema: AGENT_PLUGIN_MCP_SCHEMA,
    mcpServers: {
      opaque: {
        type: "stdio",
        command: "node",
        args: ["${PLUGIN_ROOT}/does-not-exist", "--literal", "../not-a-path"],
      },
    },
  });
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

  for (const path of ["plugin.json", "mcp.json", "mcp/agent-plugins-server.mjs"]) {
    assert.ok(paths.has(path), `npm package must include ${path}`);
  }
  for (const name of await listDirectChildSkills(join(repoRoot, "plugin", "skills"))) {
    assert.ok(paths.has(`skills/${name}/SKILL.md`), `npm package must include portable skill ${name}`);
    assert.ok(paths.has(`plugin/skills/${name}/SKILL.md`), `npm package must include canonical skill ${name}`);
  }
});

test("portable MCP entry point starts with neutral instructions and exposes Muster tools", async () => {
  const mcp = await json("mcp.json");
  const entry = mcp.mcpServers.muster.args[0].replace("${PLUGIN_ROOT}/", "");
  assert.equal(entry, "mcp/agent-plugins-server.mjs");
  const cleanHome = await mkdtemp(join(tmpdir(), "muster-agent-plugins-home-"));

  const result = await new Promise((resolve, reject) => {
    const server = spawn("node", [join(repoRoot, entry)], {
      cwd: repoRoot,
      env: { ...process.env, HOME: cleanHome },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const messages = new Map();
    let buffer = "";
    let stderr = "";
    const timer = setTimeout(() => finish(new Error(`portable MCP timeout: ${stderr}`)), 10_000);
    const finish = (error, value) => {
      clearTimeout(timer);
      server.kill();
      if (error) reject(error);
      else resolve(value);
    };
    server.stderr.setEncoding("utf8");
    server.stderr.on("data", chunk => { stderr += chunk; });
    server.stdout.setEncoding("utf8");
    server.stdout.on("data", chunk => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf("\n");
        if (newline < 0) break;
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        messages.set(message.id, message);
        if (messages.has(1) && messages.has(2) && messages.has(3) && messages.has(4)) {
          finish(null, {
            initialize: messages.get(1).result,
            tools: messages.get(2).result.tools,
            capabilities: JSON.parse(messages.get(3).result.content[0].text),
            matches: JSON.parse(messages.get(4).result.content[0].text),
          });
        }
      }
    });
    server.on("error", error => finish(error));
    server.on("exit", code => {
      if (code && !messages.has(2)) finish(new Error(stderr || `portable MCP exited ${code}`));
    });
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "agent-plugins-test", version: "1" },
      },
    }) + "\n");
    server.stdin.write(JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) + "\n");
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "muster_capabilities", arguments: {} },
    }) + "\n");
    server.stdin.write(JSON.stringify({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: {
        name: "muster_match_skills",
        arguments: { task: "runner heartbeats" },
      },
    }) + "\n");
  });

  assert.match(result.initialize.instructions, /Agent Plugins client/);
  assert.doesNotMatch(result.initialize.instructions, /\bCodex\b/);
  assert.ok(result.tools.length > 0);
  assert.ok(result.tools.every(tool => tool.name.startsWith("muster_")));
  assert.equal(result.capabilities.installedRaw.runtime, "agent-plugins");
  assert.ok(Object.values(result.capabilities.roles).every(role => role.claudeModel === undefined));
  const portableSkills = new Set(await listDirectChildSkills(join(repoRoot, "skills")));
  const portableMcp = new Set(Object.keys(mcp.mcpServers));
  for (const role of Object.values(result.capabilities.roles)) {
    assert.notEqual(role.chosen.kind, "agent");
    if (role.chosen.kind === "skill") assert.ok(portableSkills.has(role.chosen.id));
    if (role.chosen.kind === "mcp") assert.ok(portableMcp.has(role.chosen.id));
  }
  assert.deepEqual(
    new Set(result.capabilities.skills.map(skill => skill.id)),
    portableSkills,
    "the neutral lane must not advertise skills absent from the portable package"
  );
  assert.ok(
    result.matches.ranked.some(skill => skill.id === "coordination"),
    "description-only terms must rank the package's portable skill under a clean HOME"
  );
});
