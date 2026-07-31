import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const AGENT_PLUGIN_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
export const AGENT_PLUGIN_MCP_SCHEMA =
  "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";

const MANIFEST_FIELDS = new Set([
  "$schema", "name", "version", "description", "author", "homepage",
  "repository", "license", "keywords", "extensions",
]);

const readJson = async path => JSON.parse(await readFile(path, "utf8"));

function assertInside(root, candidate, label) {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} escapes the Agent Plugin package root`);
  }
}

async function assertExistingInside(root, candidate, label) {
  const resolvedRoot = await realpath(root);
  const resolvedCandidate = await realpath(candidate);
  assertInside(resolvedRoot, resolvedCandidate, label);
  return resolvedCandidate;
}

export function generateAgentPluginManifest({ pkg, claude }) {
  const repository = typeof pkg.repository === "string"
    ? pkg.repository
    : pkg.repository?.url;
  return {
    $schema: AGENT_PLUGIN_SCHEMA,
    name: claude.name,
    version: pkg.version,
    description: pkg.description,
    author: claude.author,
    homepage: pkg.homepage,
    repository,
    license: pkg.license,
    keywords: pkg.keywords,
  };
}

export async function listDirectChildSkills(skillsDir) {
  const root = await realpath(skillsDir);
  const names = [];
  for (const entry of await readdir(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillFile = join(skillsDir, entry.name, "SKILL.md");
    let info;
    try {
      info = await lstat(skillFile);
    } catch (error) {
      if (error?.code === "ENOENT") continue;
      throw error;
    }
    if (!info.isFile() || info.isSymbolicLink()) continue;
    await assertExistingInside(root, skillFile, `skill ${entry.name}`);
    names.push(entry.name);
  }
  return names.sort();
}

function validateManifest(manifest) {
  if (manifest?.$schema !== AGENT_PLUGIN_SCHEMA) {
    throw new Error(`unsupported Agent Plugins manifest schema: ${JSON.stringify(manifest?.$schema)}`);
  }
  const name = manifest.name ?? "";
  if (
    !/^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$|^[a-z0-9]$/.test(name)
    || name.includes("--")
    || name.includes("..")
  ) {
    throw new Error("invalid Agent Plugins manifest name");
  }
  for (const field of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(field)) throw new Error(`unknown Agent Plugins manifest field: ${field}`);
  }
}

async function validateMcp(root, mcp) {
  if (mcp?.$schema !== AGENT_PLUGIN_MCP_SCHEMA) {
    throw new Error(`unsupported Agent Plugins MCP schema: ${JSON.stringify(mcp?.$schema)}`);
  }
  if (!mcp.mcpServers || typeof mcp.mcpServers !== "object" || Array.isArray(mcp.mcpServers)) {
    throw new Error("Agent Plugins mcpServers must be an object");
  }
  const extra = Object.keys(mcp).filter(key => !["$schema", "mcpServers"].includes(key));
  if (extra.length) throw new Error(`unknown Agent Plugins MCP field: ${extra[0]}`);

  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    if (server?.type !== "stdio" || typeof server.command !== "string") {
      throw new Error(`invalid Agent Plugins MCP server: ${name}`);
    }
    for (const value of server.args ?? []) {
      const prefix = "${PLUGIN_ROOT}/";
      if (typeof value !== "string" || !value.startsWith(prefix)) continue;
      const target = resolve(root, value.slice(prefix.length));
      assertInside(resolve(root), target, `MCP server ${name} argument`);
      await assertExistingInside(root, target, `MCP server ${name} argument`);
    }
  }
}

export async function validateAgentPluginPackage(root) {
  const manifest = await readJson(join(root, "plugin.json"));
  const mcp = await readJson(join(root, "mcp.json"));
  validateManifest(manifest);
  await validateMcp(root, mcp);

  const pkg = await readJson(join(root, "package.json"));
  const claude = await readJson(join(root, "plugin", ".claude-plugin", "plugin.json"));
  const expected = generateAgentPluginManifest({ pkg, claude });
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) {
    throw new Error("Agent Plugins manifest metadata differs from its package and Claude sources");
  }

  const packageFiles = pkg.files ?? [];
  for (const required of ["plugin.json", "mcp.json", "skills", "mcp"]) {
    if (!packageFiles.includes(required)) {
      throw new Error(`npm package boundary omits Agent Plugins path: ${required}`);
    }
  }

  const skills = await listDirectChildSkills(join(root, "skills"));
  const canonicalSkills = await listDirectChildSkills(join(root, "plugin", "skills"));
  if (JSON.stringify(skills) !== JSON.stringify(canonicalSkills)) {
    throw new Error("portable skills differ from canonical direct-child skills");
  }

  return {
    schemaVersion: "1.0.0",
    skills,
    mcpServers: mcp.mcpServers,
    packageFiles,
  };
}
