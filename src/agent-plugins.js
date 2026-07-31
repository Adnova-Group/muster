import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { matchFrontmatter } from "./frontmatter.js";

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
  if (!isRecord(manifest)) {
    throw new Error("invalid Agent Plugins manifest: expected an object");
  }
  if (manifest?.$schema !== AGENT_PLUGIN_SCHEMA) {
    throw new Error(`unsupported Agent Plugins manifest schema: ${JSON.stringify(manifest?.$schema)}`);
  }
  const name = manifest.name ?? "";
  if (
    typeof name !== "string"
    || !/^[a-z0-9][a-z0-9.-]{0,62}[a-z0-9]$|^[a-z0-9]$/.test(name)
    || name.includes("--")
    || name.includes("..")
  ) {
    throw new Error("invalid Agent Plugins manifest name");
  }
  for (const field of Object.keys(manifest)) {
    if (!MANIFEST_FIELDS.has(field)) throw new Error(`unknown Agent Plugins manifest field: ${field}`);
  }
  for (const field of ["version", "description", "homepage", "repository", "license"]) {
    if (manifest[field] !== undefined && typeof manifest[field] !== "string") {
      throw new Error(`invalid Agent Plugins manifest ${field}: expected a string`);
    }
  }
  if (manifest.author !== undefined) {
    if (!isRecord(manifest.author)) {
      throw new Error("invalid Agent Plugins manifest author: expected an object");
    }
    const authorFields = new Set(["name", "email", "url"]);
    for (const [field, value] of Object.entries(manifest.author)) {
      if (!authorFields.has(field)) {
        throw new Error(`invalid Agent Plugins manifest author: unknown field ${field}`);
      }
      if (typeof value !== "string") {
        throw new Error(`invalid Agent Plugins manifest author.${field}: expected a string`);
      }
    }
  }
  if (manifest.keywords !== undefined && !stringArray(manifest.keywords)) {
    throw new Error("invalid Agent Plugins manifest keywords: expected strings");
  }
  if (
    manifest.extensions !== undefined
    && (
      !isRecord(manifest.extensions)
      || !Object.values(manifest.extensions).every(isRecord)
    )
  ) {
    throw new Error("invalid Agent Plugins manifest extensions: expected object values");
  }
}

const isRecord = value => value !== null && typeof value === "object" && !Array.isArray(value);
const stringArray = value => Array.isArray(value) && value.every(item => typeof item === "string");
const stringRecord = value => isRecord(value) && Object.values(value).every(item => typeof item === "string");

function invalidServer(name, reason) {
  throw new Error(`invalid Agent Plugins MCP server ${name}: ${reason}`);
}

async function validateStdioServer(root, name, server, { pluginDataRoot } = {}) {
  const allowed = new Set(["type", "command", "args", "env", "cwd"]);
  const unknown = Object.keys(server).find(key => !allowed.has(key));
  if (unknown) invalidServer(name, `unknown field ${unknown}`);
  if (
    typeof server.command !== "string"
    || !server.command
    || /\s/.test(server.command)
    || server.command.includes("\\")
    || server.command === "."
    || server.command === ".."
    || (server.command.includes("/") && !server.command.startsWith("./"))
  ) {
    invalidServer(name, "command must be one bare executable token or a ./ plugin path");
  }
  if (server.command.startsWith("./")) {
    try {
      await assertExistingInside(root, resolve(root, server.command), `MCP server ${name} command`);
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
      try {
        await assertExistingInside(root, resolve(root, server.cwd), `MCP server ${name} cwd`);
      } catch (error) {
        invalidServer(name, error.message);
      }
    }
    if (server.cwd.startsWith("${PLUGIN_ROOT}/")) {
      try {
        await assertExistingInside(
          root,
          resolve(root, server.cwd.slice("${PLUGIN_ROOT}/".length)),
          `MCP server ${name} cwd`
        );
      } catch (error) {
        invalidServer(name, error.message);
      }
    }
    if (server.cwd.startsWith("${PLUGIN_DATA}/")) {
      if (!pluginDataRoot) invalidServer(name, "PLUGIN_DATA cwd requires the runtime plugin-data root");
      try {
        const dataRoot = await realpath(pluginDataRoot);
        await assertExistingInside(
          dataRoot,
          resolve(dataRoot, server.cwd.slice("${PLUGIN_DATA}/".length)),
          `MCP server ${name} cwd`
        );
      } catch (error) {
        invalidServer(name, error.message);
      }
    } else if (server.cwd === "${PLUGIN_DATA}") {
      if (!pluginDataRoot) invalidServer(name, "PLUGIN_DATA cwd requires the runtime plugin-data root");
      try {
        await realpath(pluginDataRoot);
      } catch (error) {
        invalidServer(name, error.message);
      }
    }
  }
}

function isLoopback(hostname) {
  const literal = hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
  if (literal === "localhost" || literal === "::1") return true;
  return isIP(literal) === 4 && literal.split(".")[0] === "127";
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

export async function validateMcpConfiguration(root, mcp, options = {}) {
  const resolvedRoot = await realpath(root);
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
    if (server.type === "stdio") await validateStdioServer(resolvedRoot, name, server, options);
    else if (server.type === "streamable-http" || server.type === "sse") validateHttpServer(name, server);
    else invalidServer(name, `unknown transport ${JSON.stringify(server.type)}`);
  }
}

async function resolvePackageEntry(root, relativePath) {
  return assertExistingInside(root, join(root, relativePath), relativePath);
}

function descriptionFromSkillMd(text) {
  const frontmatter = matchFrontmatter(text);
  if (!frontmatter) return "";
  const lines = frontmatter.body.split(/\r?\n/);
  const line = lines.find(value => /^description:/.test(value));
  if (line === undefined) return "";
  let value = line.slice("description:".length).trim();
  if (/^[|>][-+]?\d*$/.test(value)) {
    const first = lines.slice(lines.indexOf(line) + 1).find(candidate => candidate.trim() !== "");
    return first ? first.trim() : "";
  }
  if (
    value.length >= 2
    && (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    )
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

async function readPortableSkillDescriptions(skillsDir, skills) {
  const descriptions = {};
  for (const name of skills) {
    const skillFile = await assertExistingInside(
      skillsDir,
      join(skillsDir, name, "SKILL.md"),
      `skill ${name}`
    );
    descriptions[name] = descriptionFromSkillMd(await readFile(skillFile, "utf8"));
  }
  return descriptions;
}

export async function validateAgentPluginPackage(root, options = {}) {
  const resolvedRoot = await realpath(root);
  const manifestPath = await resolvePackageEntry(resolvedRoot, "plugin.json");
  const mcpPath = await resolvePackageEntry(resolvedRoot, "mcp.json");
  const skillsDir = await resolvePackageEntry(resolvedRoot, "skills");
  const manifest = await readJson(manifestPath);
  const mcp = await readJson(mcpPath);
  validateManifest(manifest);
  await validateMcpConfiguration(resolvedRoot, mcp, options);

  const pkg = await readJson(await resolvePackageEntry(resolvedRoot, "package.json"));
  const claude = await readJson(
    await resolvePackageEntry(resolvedRoot, join("plugin", ".claude-plugin", "plugin.json"))
  );
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

  const skills = await listDirectChildSkills(skillsDir);
  const canonicalSkills = await listDirectChildSkills(
    await resolvePackageEntry(resolvedRoot, join("plugin", "skills"))
  );
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

export async function readAgentPluginInventory(root, options = {}) {
  const resolvedRoot = await realpath(root);
  const manifestPath = await resolvePackageEntry(resolvedRoot, "plugin.json");
  const mcpPath = await resolvePackageEntry(resolvedRoot, "mcp.json");
  const skillsDir = await resolvePackageEntry(resolvedRoot, "skills");
  const manifest = await readJson(manifestPath);
  const mcp = await readJson(mcpPath);
  validateManifest(manifest);
  await validateMcpConfiguration(resolvedRoot, mcp, options);
  const skills = await listDirectChildSkills(skillsDir);
  return {
    runtime: "agent-plugins",
    plugins: [manifest.name],
    skills,
    skillDescriptions: await readPortableSkillDescriptions(skillsDir, skills),
    agents: [],
    mcpServers: Object.keys(mcp.mcpServers).sort(),
  };
}
