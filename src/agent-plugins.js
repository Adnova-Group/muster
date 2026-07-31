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

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stringArray = value => Array.isArray(value) && value.every(item => typeof item === "string");
const stringRecord = value => isRecord(value) && Object.values(value).every(item => typeof item === "string");

function invalidServer(name, reason) {
  throw new Error(`invalid Agent Plugins MCP server ${name}: ${reason}`);
}

function validateStdioServer(root, name, server) {
  const allowed = new Set(["type", "command", "args", "env", "cwd"]);
  const unknown = Object.keys(server).find(key => !allowed.has(key));
  if (unknown) invalidServer(name, `unknown field ${unknown}`);
  if (
    typeof server.command !== "string"
    || !server.command
    || /\s/.test(server.command)
    || (server.command.includes("/") && !server.command.startsWith("./"))
  ) {
    invalidServer(name, "command must be one bare executable token or a ./ plugin path");
  }
  if (server.command.startsWith("./")) {
    try {
      assertInside(resolve(root), resolve(root, server.command), `MCP server ${name} command`);
    } catch (error) {
      invalidServer(name, error.message);
    }
  }
  if (server.args !== undefined && !stringArray(server.args)) invalidServer(name, "args must be strings");
  if (server.env !== undefined && !stringRecord(server.env)) invalidServer(name, "env must contain strings");
  if (server.env && ("PLUGIN_ROOT" in server.env || "PLUGIN_DATA" in server.env)) {
    invalidServer(name, "env must not override PLUGIN_ROOT or PLUGIN_DATA");
  }
  if (server.cwd !== undefined) {
    if (typeof server.cwd !== "string") invalidServer(name, "cwd must be a string");
    const portable = server.cwd === "${PLUGIN_ROOT}"
      || server.cwd.startsWith("${PLUGIN_ROOT}/")
      || server.cwd === "${PLUGIN_DATA}"
      || server.cwd.startsWith("${PLUGIN_DATA}/")
      || server.cwd.startsWith("./");
    if (!portable) invalidServer(name, "cwd must be plugin-relative, PLUGIN_ROOT, or PLUGIN_DATA");
    if (server.cwd.startsWith("./")) {
      assertInside(resolve(root), resolve(root, server.cwd), `MCP server ${name} cwd`);
    }
    if (server.cwd.startsWith("${PLUGIN_ROOT}/")) {
      try {
        assertInside(
          resolve(root),
          resolve(root, server.cwd.slice("${PLUGIN_ROOT}/".length)),
          `MCP server ${name} cwd`
        );
      } catch (error) {
        invalidServer(name, error.message);
      }
    }
    if (server.cwd.startsWith("${PLUGIN_DATA}/")) {
      const dataRoot = resolve(root, ".agent-plugin-data-boundary");
      try {
        assertInside(
          dataRoot,
          resolve(dataRoot, server.cwd.slice("${PLUGIN_DATA}/".length)),
          `MCP server ${name} cwd`
        );
      } catch (error) {
        invalidServer(name, error.message);
      }
    }
  }
}

function isLoopback(hostname) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || /^127\./.test(hostname);
}

function validateHttpServer(name, server) {
  const allowed = new Set(["type", "url", "headers"]);
  const unknown = Object.keys(server).find(key => !allowed.has(key));
  if (unknown) invalidServer(name, `unknown field ${unknown}`);
  let url;
  try {
    url = new URL(server.url);
  } catch {
    invalidServer(name, "url must be an absolute HTTP(S) URL");
  }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.hash) {
    invalidServer(name, "url must be an absolute HTTP(S) URL without credentials or a fragment");
  }
  if (url.protocol === "http:" && !isLoopback(url.hostname)) {
    invalidServer(name, "non-loopback MCP URLs must use HTTPS");
  }
  if (server.headers !== undefined && !stringRecord(server.headers)) {
    invalidServer(name, "headers must contain strings");
  }
  for (const [header, value] of Object.entries(server.headers ?? {})) {
    if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/.test(header)) {
      invalidServer(name, `invalid HTTP header name ${JSON.stringify(header)}`);
    }
    if (/[\x00-\x08\x0a-\x1f\x7f]/.test(value)) {
      invalidServer(name, `invalid HTTP header value for ${header}`);
    }
  }
  const names = Object.keys(server.headers ?? {}).map(header => header.toLowerCase());
  if (new Set(names).size !== names.length) invalidServer(name, "header names must be unique ignoring case");
}

export async function validateMcpConfiguration(root, mcp) {
  if (mcp?.$schema !== AGENT_PLUGIN_MCP_SCHEMA) {
    throw new Error(`unsupported Agent Plugins MCP schema: ${JSON.stringify(mcp?.$schema)}`);
  }
  if (!isRecord(mcp.mcpServers)) {
    throw new Error("Agent Plugins mcpServers must be an object");
  }
  const extra = Object.keys(mcp).filter(key => !["$schema", "mcpServers"].includes(key));
  if (extra.length) throw new Error(`unknown Agent Plugins MCP field: ${extra[0]}`);

  for (const [name, server] of Object.entries(mcp.mcpServers)) {
    if (!isRecord(server)) invalidServer(name, "entry must be an object");
    if (server.type === "stdio") validateStdioServer(root, name, server);
    else if (server.type === "streamable-http" || server.type === "sse") validateHttpServer(name, server);
    else invalidServer(name, `unknown transport ${JSON.stringify(server.type)}`);
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
  await validateMcpConfiguration(root, mcp);

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

export async function readAgentPluginInventory(root) {
  const manifest = await readJson(join(root, "plugin.json"));
  const mcp = await readJson(join(root, "mcp.json"));
  validateManifest(manifest);
  await validateMcpConfiguration(root, mcp);
  return {
    runtime: "agent-plugins",
    plugins: [manifest.name],
    skills: await listDirectChildSkills(join(root, "skills")),
    agents: [],
    mcpServers: Object.keys(mcp.mcpServers).sort(),
  };
}
