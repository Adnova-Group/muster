// ChatGPT Work installer -- publishes the muster-chatgpt-work plugin into a
// ChatGPT plugins root and binds the published tree to a private install
// receipt (chatgpt-work.json under .git/muster for project scope, ~/.muster
// for user scope). The receipt is the OWNERSHIP model: a destination plugin
// directory or marketplace entry is mutated only when a valid receipt proves
// a prior Muster install owns it; anything else is left byte-for-byte
// untouched. The receipt is also the trust anchor the installed server
// re-verifies on every startup (mcp/chatgpt-work-server.mjs), which is why
// validateConfig is fail-closed and names the offending field per clause.
//
// HUMAN-HOLD is the vocabulary for "a person must look before Muster
// proceeds": an unowned destination, a foreign marketplace entry, insecure
// publication-directory ownership/permissions, or an install whose rollback
// itself failed. These paths never auto-correct -- they stop and report.
//
// The install is staged, double-locked, and snapshot-rollbacked on purpose:
// - The plugin is built completely in a temp staging dir, so the destination
//   only ever appears as one cp of a finished tree, never a half-built one.
// - The receipt-adjacent lock serializes the whole install against other
//   installers; the plugins-root .build.lock serializes the destination swap
//   against concurrent plugin builds sharing the same root.
// - Before mutating, the prior receipt and marketplace bytes are snapshotted
//   and any existing plugin is renamed aside, so any failure restores the
//   exact prior plugin/marketplace/receipt trio; if restoration itself fails
//   the error escalates to HUMAN-HOLD instead of leaving mixed state.

import { createHash, randomUUID } from "node:crypto";
import { execFile as execFileCb } from "node:child_process";
import {
  cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { withCodexFileLock } from "./codex-lock.js";
import { ordinaryDirectoryPath as walkOrdinaryDirectoryPath } from "./fs-safe.js";

const execFile = promisify(execFileCb);
const CONNECTION_ID = /^asdk_app_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROFILES = new Set(["pro-safe", "full"]);
const RECEIPT_NAME = "chatgpt-work.json";
const WORK_PLUGIN_ID = "muster-chatgpt-work";
const MARKETPLACE_NAME = "muster";
const CATALOG_ARTIFACTS = [
  "agents.generated.yaml", "agents.manifest.json", "agents.muster.yaml",
  "builtins.generated.yaml", "builtins.muster.yaml", "software.yaml",
].map(path => `catalog/${path}`);
const PIPELINE_ARTIFACTS = [
  "ai-implementation-spec.yaml", "ai-test-plan.yaml", "blog-post.yaml", "book.yaml",
  "business-case.yaml", "case-study.yaml", "competitive-battlecard.yaml", "epic.yaml",
  "executive-summary.yaml", "launch-plan.yaml", "lead-magnet.yaml", "newsletter.yaml",
  "okrs.yaml", "prd.yaml", "release-notes.yaml", "roadmap.yaml", "runbook.yaml",
  "social-post.yaml", "user-story.yaml", "video-content.yaml",
].map(path => `pipelines/${path}`);
const GIT_REPOSITORY_OVERRIDES = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_COUNT",
  "GIT_GRAFT_FILE",
  "GIT_NO_REPLACE_OBJECTS",
  "GIT_REPLACE_REF_BASE",
  "GIT_SHALLOW_FILE",
  "GIT_NAMESPACE",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
  "GIT_IMPLICIT_WORK_TREE",
  "GIT_PREFIX",
];
// The installed server duplicates this list verbatim (artifactPaths in
// mcp/chatgpt-work-server.mjs) and hard-fails startup on any mismatch;
// test/chatgpt-work-artifact-parity.test.js pins the two lists identical.
const ARTIFACT_PATHS = [
  ".app.json",
  ".mcp.json",
  ".codex-plugin/plugin.json",
  "runtime/chatgpt-work-server.mjs",
  "runtime/muster.mjs",
  "runtime/sprint-protocol.md",
  "package.json",
  ...CATALOG_ARTIFACTS,
  ...PIPELINE_ARTIFACTS,
];
const HEX64 = /^[a-f0-9]{64}$/;
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");

function gitVerificationEnvironment() {
  const env = { ...process.env };
  for (const name of GIT_REPOSITORY_OVERRIDES) delete env[name];
  return env;
}

export function normalizeChatgptWorkConnectionId(value) {
  if (typeof value !== "string") throw new Error("ChatGPT Work connection id is required");
  const normalized = value.startsWith("plugin_") ? value.slice("plugin_".length) : value;
  if (!CONNECTION_ID.test(normalized)) {
    throw new Error("ChatGPT Work connection id must match asdk_app_<id> (an initial plugin_ prefix is accepted)");
  }
  return normalized;
}

const ordinaryDirectory = (path, options = {}) => walkOrdinaryDirectoryPath(path, {
  ...options,
  unsafeError: current => new Error(`ChatGPT Work path ancestry must be ordinary directories: ${current}`),
});

async function privateManagedDirectory(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`ChatGPT Work managed path must be an ordinary directory: ${path}`);
  if (process.platform !== "win32" && typeof process.getuid === "function"
    && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) {
    throw new Error(`ChatGPT Work managed directory must be current-user-owned and private: ${path}`);
  }
}

async function securePublicationDirectory(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new Error(`HUMAN-HOLD: ChatGPT Work publication path must be an ordinary directory: ${path}`);
  }
  if (process.platform !== "win32" && typeof process.getuid === "function"
    && (info.uid !== process.getuid() || (info.mode & 0o022) !== 0)) {
    throw new Error(`HUMAN-HOLD: ChatGPT Work publication directory must be current-user-owned and not group/world-writable: ${path}`);
  }
}

async function projectGitDir(cwd) {
  const projectRoot = resolve(cwd);
  const marker = join(projectRoot, ".git");
  let info;
  try { info = await lstat(marker); } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    const error = new Error("project scope requires a Git worktree", { cause });
    error.code = "MUSTER_NO_GIT_WORKTREE";
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error("project scope rejects symlinked .git metadata");
  let gitDir;
  if (info.isDirectory()) {
    gitDir = marker;
  } else {
    if (!info.isFile()) throw new Error("project scope requires an ordinary .git directory or gitdir file");
    const text = await readFile(marker, "utf8");
    const match = text.trim().match(/^gitdir:\s*(.+)$/);
    if (!match) throw new Error("project scope .git file has an invalid gitdir pointer");
    gitDir = isAbsolute(match[1]) ? resolve(match[1]) : resolve(dirname(marker), match[1]);
  }
  try {
    if (!(await ordinaryDirectory(gitDir))) throw new Error("gitdir is missing");
  } catch (cause) {
    throw new Error("project gitdir ancestry must contain only ordinary directories", { cause });
  }
  const resolved = await realpath(gitDir);
  const gitInfo = await lstat(resolved);
  if (gitInfo.isSymbolicLink() || !gitInfo.isDirectory()) throw new Error("project gitdir must resolve to an ordinary directory");

  let stdout;
  try {
    ({ stdout } = await execFile("git", [
      "-C", projectRoot, "rev-parse", "--path-format=absolute", "--git-dir", "--is-inside-work-tree",
    ], {
      env: gitVerificationEnvironment(),
      timeout: 10_000,
      maxBuffer: 1024 * 1024,
    }));
  } catch (cause) {
    const error = new Error("project scope requires a Git worktree", { cause });
    error.code = "MUSTER_NO_GIT_WORKTREE";
    throw error;
  }
  const lines = stdout.trim().split(/\r?\n/);
  if (lines.length !== 2 || lines[1] !== "true") {
    const error = new Error("project scope requires a Git worktree");
    error.code = "MUSTER_NO_GIT_WORKTREE";
    throw error;
  }
  const authoritative = await realpath(resolve(lines[0]));
  if (authoritative !== resolved) {
    throw new Error("project .git pointer does not match Git's authoritative gitdir");
  }
  return resolved;
}

export async function chatgptWorkConfigPath({ scope = "project", cwd = process.cwd(), home = homedir() } = {}) {
  if (scope === "project") return join(await projectGitDir(cwd), "muster", RECEIPT_NAME);
  if (scope === "user") return join(resolve(home), ".muster", RECEIPT_NAME);
  throw new Error("ChatGPT Work install scope must be project or user");
}

export function chatgptWorkPluginsRoot({ scope = "project", cwd = process.cwd(), home = homedir() } = {}) {
  if (scope === "project") return join(resolve(cwd), ".agents", "plugins");
  if (scope === "user") return join(resolve(home), ".agents", "plugins");
  throw new Error("ChatGPT Work install scope must be project or user");
}

// ChatGPT Work's marketplace source.path grammar is a "./"-prefixed POSIX
// path relative to the marketplace root -- the directory two levels above the
// plugins root -- so the owned entry always has the form
// "./<root-rel>/muster-chatgpt-work" (e.g. "./.agents/plugins/muster-chatgpt-work").
// Backslashes are rewritten so the pinned form holds on Windows too.
function workMarketplaceSourcePath(pluginsRoot) {
  const addedRoot = resolve(pluginsRoot, "..", "..");
  return "./" + relative(addedRoot, join(pluginsRoot, WORK_PLUGIN_ID)).replaceAll("\\", "/");
}

async function readWorkMarketplace(pluginsRoot, { allowMissing = false } = {}) {
  const marketplacePath = join(pluginsRoot, "marketplace.json");
  let info;
  try { info = await lstat(marketplacePath); }
  catch (error) {
    if (allowMissing && error.code === "ENOENT") {
      return {
        marketplacePath,
        bytes: null,
        value: { name: MARKETPLACE_NAME, interface: { displayName: "Muster" }, plugins: [] },
      };
    }
    throw error;
  }
  if (info.isSymbolicLink() || !info.isFile()) {
    throw new Error(`HUMAN-HOLD: ChatGPT Work marketplace must be an ordinary file: ${marketplacePath}`);
  }
  const bytes = await readFile(marketplacePath);
  let value;
  try { value = JSON.parse(bytes); }
  catch { throw new Error(`HUMAN-HOLD: ChatGPT Work marketplace is not valid JSON: ${marketplacePath}`); }
  if (value?.name !== MARKETPLACE_NAME || !Array.isArray(value.plugins)) {
    throw new Error(`HUMAN-HOLD: ChatGPT Work marketplace has an unrecognized contract: ${marketplacePath}`);
  }
  return { marketplacePath, bytes, value };
}

function workMarketplaceEntries(marketplace) {
  return marketplace.plugins.filter(plugin => plugin?.name === WORK_PLUGIN_ID);
}

function assertWorkMarketplaceEntry(marketplace, pluginsRoot) {
  const entries = workMarketplaceEntries(marketplace);
  const expectedPath = workMarketplaceSourcePath(pluginsRoot);
  if (entries.length !== 1
    || entries[0]?.source?.source !== "local"
    || entries[0]?.source?.path !== expectedPath) {
    throw new Error(`HUMAN-HOLD: ChatGPT Work marketplace entry is missing or unowned (expected ${expectedPath})`);
  }
  return entries[0];
}

function mergeWorkMarketplace(marketplace, pluginsRoot, { owned }) {
  const entries = workMarketplaceEntries(marketplace);
  if (!owned && entries.length) {
    throw new Error("HUMAN-HOLD: ChatGPT Work marketplace entry already exists without a valid Muster receipt");
  }
  if (owned) assertWorkMarketplaceEntry(marketplace, pluginsRoot);
  const next = structuredClone(marketplace);
  next.plugins = next.plugins.filter(plugin => plugin?.name !== WORK_PLUGIN_ID);
  next.plugins.push({
    name: WORK_PLUGIN_ID,
    source: { source: "local", path: workMarketplaceSourcePath(pluginsRoot) },
    policy: { installation: "AVAILABLE", authentication: "ON_INSTALL" },
    category: "Productivity",
  });
  return next;
}

function validateConfig(config) {
  const receiptKeys = [
    "allowFullActions", "appId", "artifactFlavor", "artifacts", "cacheKey",
    "connectionId", "format", "owner", "pluginPath", "profile",
  ];
  // Per-clause failures: every rejection names the field, its expectation, AND
  // the value actually received (`got ...`, the same shape this file's newer
  // receipt/marketplace errors use), so a tampered or stale receipt is fully
  // diagnosable from the error alone -- without it, an operator holding a
  // rejected receipt could not tell WHICH value the installer objected to.
  if (!config || Object.keys(config).sort().join("\0") !== [...receiptKeys].sort().join("\0")) {
    throw new Error(`ChatGPT Work installer receipt keys must be exactly: ${receiptKeys.join(", ")}; got ${JSON.stringify(config && Object.keys(config).sort())}`);
  }
  if (config.format !== 3) throw new Error(`ChatGPT Work installer receipt format must be 3; got ${JSON.stringify(config.format)}`);
  if (config.owner !== "muster") throw new Error(`ChatGPT Work installer receipt owner must be "muster"; got ${JSON.stringify(config.owner)}`);
  if (config.artifactFlavor !== "chatgpt-work") {
    throw new Error(`ChatGPT Work installer receipt artifactFlavor must be "chatgpt-work"; got ${JSON.stringify(config.artifactFlavor)}`);
  }
  if (!PROFILES.has(config.profile)) {
    throw new Error(`ChatGPT Work installer receipt profile must be pro-safe or full; got ${JSON.stringify(config.profile)}`);
  }
  if (typeof config.allowFullActions !== "boolean") {
    throw new Error(`ChatGPT Work installer receipt allowFullActions must be a boolean; got ${JSON.stringify(config.allowFullActions)}`);
  }
  const connectionId = normalizeChatgptWorkConnectionId(config.connectionId);
  if (connectionId !== config.connectionId || config.appId !== connectionId) {
    throw new Error(`ChatGPT Work installer receipt app id is not canonical; got connectionId ${JSON.stringify(config.connectionId)} and appId ${JSON.stringify(config.appId)}, expected both to be ${JSON.stringify(connectionId)}`);
  }
  if ((config.profile === "full") !== config.allowFullActions) {
    throw new Error(`ChatGPT Work installer receipt profile/action opt-in is inconsistent; got profile ${JSON.stringify(config.profile)} with allowFullActions ${JSON.stringify(config.allowFullActions)}`);
  }
  const cacheKey = sha256(JSON.stringify(["chatgpt-work", connectionId, config.profile, config.allowFullActions]));
  if (config.cacheKey !== cacheKey) {
    throw new Error(`ChatGPT Work installer receipt cacheKey must be the install identity digest; got ${JSON.stringify(config.cacheKey)}, expected ${cacheKey}`);
  }
  if (!isAbsolute(config.pluginPath ?? "")) {
    throw new Error(`ChatGPT Work installer receipt pluginPath must be an absolute path; got ${JSON.stringify(config.pluginPath)}`);
  }
  if (!config.artifacts || Object.keys(config.artifacts).sort().join("\0") !== [...ARTIFACT_PATHS].sort().join("\0")) {
    throw new Error(`ChatGPT Work installer receipt artifacts must cover exactly the published artifact set; got ${JSON.stringify(config.artifacts && Object.keys(config.artifacts).sort())}`);
  }
  const malformedDigests = Object.entries(config.artifacts).filter(([, digest]) => !HEX64.test(digest));
  if (malformedDigests.length) {
    throw new Error(`ChatGPT Work installer receipt artifact digests must be 64-character lowercase hex sha256 values; got ${JSON.stringify(Object.fromEntries(malformedDigests))}`);
  }
  return {
    format: 3, owner: "muster", artifactFlavor: "chatgpt-work", appId: connectionId,
    connectionId, profile: config.profile,
    allowFullActions: config.allowFullActions, cacheKey,
    pluginPath: config.pluginPath, artifacts: { ...config.artifacts },
  };
}

async function readArtifact(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`ChatGPT Work ${label} must be an ordinary file`);
  return readFile(path);
}

async function validateInstalledConfig(config, expectedPluginPath, expectedConfigPath) {
  if (resolve(config.pluginPath) !== resolve(expectedPluginPath)) {
    throw new Error(`ChatGPT Work installer receipt plugin path is outside its scope; got ${JSON.stringify(resolve(config.pluginPath))}, expected ${JSON.stringify(resolve(expectedPluginPath))}`);
  }
  for (const path of ARTIFACT_PATHS) {
    const bytes = await readArtifact(join(config.pluginPath, ...path.split("/")), `installed artifact ${path}`);
    if (sha256(bytes) !== config.artifacts[path]) {
      throw new Error(`ChatGPT Work installer receipt artifact digest does not match ${path}`);
    }
  }
  const app = JSON.parse(await readFile(join(config.pluginPath, ".app.json"), "utf8"));
  if (JSON.stringify(app) !== JSON.stringify({ apps: { muster: { id: config.appId } } })) {
    throw new Error(`ChatGPT Work installer receipt does not match installed app metadata; got ${JSON.stringify(app)}, expected ${JSON.stringify({ apps: { muster: { id: config.appId } } })}`);
  }
  const manifest = JSON.parse(await readFile(join(config.pluginPath, ".codex-plugin", "plugin.json"), "utf8"));
  if (manifest?.name !== WORK_PLUGIN_ID || manifest?.apps !== "./.app.json" || manifest?.mcpServers !== "./.mcp.json") {
    throw new Error(`ChatGPT Work installed plugin manifest is inconsistent; got ${JSON.stringify({ name: manifest?.name, apps: manifest?.apps, mcpServers: manifest?.mcpServers })}, expected ${JSON.stringify({ name: WORK_PLUGIN_ID, apps: "./.app.json", mcpServers: "./.mcp.json" })}`);
  }
  const mcp = JSON.parse(await readFile(join(config.pluginPath, ".mcp.json"), "utf8"));
  const env = mcp?.mcpServers?.muster?.env;
  if (mcp?.mcpServers?.muster?.command !== "node"
    || JSON.stringify(mcp?.mcpServers?.muster?.args) !== JSON.stringify(["./runtime/chatgpt-work-server.mjs"])
    || mcp?.mcpServers?.muster?.cwd !== "."
    || env?.MUSTER_CHATGPT_WORK_PROFILE !== config.profile
    || env?.MUSTER_CHATGPT_WORK_CONNECTION_ID !== config.connectionId
    || resolve(env?.MUSTER_CHATGPT_WORK_APP_JSON_PATH ?? "") !== resolve(config.pluginPath, ".app.json")
    || resolve(env?.MUSTER_CHATGPT_WORK_PLUGIN_PATH ?? "") !== resolve(config.pluginPath)
    || resolve(env?.MUSTER_CHATGPT_WORK_RECEIPT_PATH ?? "") !== resolve(expectedConfigPath)
    || env?.MUSTER_CHATGPT_WORK_PLUGIN_VERSION !== manifest.version
    || (env?.MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS === "1") !== config.allowFullActions) {
    throw new Error(`ChatGPT Work installed MCP activation metadata is inconsistent; got ${JSON.stringify(mcp?.mcpServers?.muster)}`);
  }
  const pluginsRoot = dirname(config.pluginPath);
  const { value: marketplace } = await readWorkMarketplace(pluginsRoot);
  assertWorkMarketplaceEntry(marketplace, pluginsRoot);
  return config;
}

export async function readChatgptWorkConfig(options = {}) {
  const path = await chatgptWorkConfigPath(options);
  let info;
  try { info = await lstat(path); } catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`ChatGPT Work installer receipt must be an ordinary file: ${path}`);
  if (process.platform !== "win32" && typeof process.getuid === "function"
    && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) {
    throw new Error(`ChatGPT Work installer receipt must be current-user-owned and private: ${path}`);
  }
  try {
    const config = validateConfig(JSON.parse(await readFile(path, "utf8")));
    return await validateInstalledConfig(config, join(chatgptWorkPluginsRoot(options), WORK_PLUGIN_ID), path);
  }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`ChatGPT Work installer receipt is not valid JSON: ${path}`);
    throw error;
  }
}

async function prepareRuntimeAssets() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bundled = {
    cli: join(moduleDir, "muster.mjs"),
    server: join(moduleDir, "chatgpt-work-server.mjs"),
    sprintProtocol: join(moduleDir, "sprint-protocol.md"),
    catalog: join(moduleDir, "..", "catalog"),
    pipelines: join(moduleDir, "..", "pipelines"),
  };
  try {
    for (const path of [bundled.cli, bundled.server, bundled.sprintProtocol]) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`runtime asset is not an ordinary file: ${path}`);
    }
    for (const path of [bundled.catalog, bundled.pipelines]) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`runtime asset is not an ordinary directory: ${path}`);
    }
    return { ...bundled, cleanup: async () => {} };
  } catch (error) {
    if (basename(moduleDir) !== "src") throw new Error(`bundled ChatGPT Work runtime assets are unavailable: ${error.message}`);
  }

  const root = resolve(moduleDir, "..");
  const dir = await mkdtemp(join(tmpdir(), "muster-work-runtime-"));
  const { build } = await import("esbuild");
  const requireBanner = 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';
  const bundleOptions = {
    bundle: true,
    platform: "node",
    format: "esm",
    target: "node20",
    preserveSymlinks: true,
    external: ["esbuild", "../scripts/build-codex.mjs"],
  };
  await build({ ...bundleOptions, entryPoints: [join(root, "src", "cli.js")], outfile: join(dir, "muster.mjs"), banner: { js: requireBanner } });
  await build({
    ...bundleOptions,
    entryPoints: [join(root, "mcp", "chatgpt-work-server.mjs")],
    outfile: join(dir, "chatgpt-work-server.mjs"),
  });
  return {
    cli: join(dir, "muster.mjs"),
    server: join(dir, "chatgpt-work-server.mjs"),
    sprintProtocol: join(root, "cowork", "sprint-protocol.md"),
    catalog: join(root, "catalog"),
    pipelines: join(root, "pipelines"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function stageWorkPlugin(config, assets, { configPath, pluginPath }) {
  const stagingRoot = await mkdtemp(join(tmpdir(), "muster-work-plugin-"));
  const plugin = join(stagingRoot, "plugin");
  const runtime = join(plugin, "runtime");
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: 0o700 });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await cp(assets.cli, join(runtime, "muster.mjs"));
  await cp(assets.server, join(runtime, "chatgpt-work-server.mjs"));
  await cp(assets.sprintProtocol, join(runtime, "sprint-protocol.md"));
  await cp(assets.catalog, join(plugin, "catalog"), { recursive: true });
  await cp(assets.pipelines, join(plugin, "pipelines"), { recursive: true });
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const app = { apps: { muster: { id: config.connectionId } } };
  await writeFile(join(plugin, ".app.json"), JSON.stringify(app, null, 2) + "\n");
  const serverEnv = {
    MUSTER_CHATGPT_WORK_PROFILE: config.profile,
    MUSTER_CHATGPT_WORK_CONNECTION_ID: config.connectionId,
    MUSTER_CHATGPT_WORK_APP_JSON_PATH: join(pluginPath, ".app.json"),
    MUSTER_CHATGPT_WORK_PLUGIN_PATH: pluginPath,
    MUSTER_CHATGPT_WORK_RECEIPT_PATH: configPath,
    MUSTER_CHATGPT_WORK_PLUGIN_VERSION: pkg.version,
    ...(config.profile === "full" && config.allowFullActions
      ? { MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS: "1" }
      : {}),
  };
  await writeFile(join(plugin, ".mcp.json"), JSON.stringify({
    mcpServers: {
      muster: {
        command: "node", args: ["./runtime/chatgpt-work-server.mjs"], cwd: ".",
        env: serverEnv,
      },
    },
  }, null, 2) + "\n");
  await writeFile(join(plugin, "package.json"), JSON.stringify({ version: pkg.version }, null, 2) + "\n");
  await writeFile(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: WORK_PLUGIN_ID, version: pkg.version,
    description: "Muster deterministic tools for ChatGPT Work.",
    author: { name: "Adnova Group" }, license: "Apache-2.0",
    mcpServers: "./.mcp.json", apps: "./.app.json",
    interface: {
      displayName: "Muster",
      shortDescription: "Deterministic tools for ChatGPT Work.",
      longDescription: "A tool-only Muster integration for ChatGPT Work.",
      developerName: "Adnova Group",
      category: "Productivity",
      capabilities: ["Tools"],
      defaultPrompt: "Use the available Muster tools.",
    },
  }, null, 2) + "\n");
  return { stagingRoot, plugin, version: pkg.version };
}

async function snapshotFile(path) {
  try { return await readFile(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
}

async function atomicPrivateWrite(path, bytes) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await writeFile(temporary, bytes, { mode: 0o600, flag: "wx" });
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

async function pathExists(path) {
  try { await lstat(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}

async function artifactDigests(pluginPath) {
  return Object.fromEntries(await Promise.all(ARTIFACT_PATHS.map(async path => [
    path,
    sha256(await readArtifact(join(pluginPath, ...path.split("/")), `installed artifact ${path}`)),
  ])));
}

export async function runChatgptWorkInstall({
  connectionId, profile, scope = "project", allowFullActions = false,
  dryRun = false, cwd = process.cwd(), home = homedir(),
  __testBeforeReceiptCommit,
} = {}) {
  const canonicalId = normalizeChatgptWorkConnectionId(connectionId);
  if (!PROFILES.has(profile)) throw new Error(`ChatGPT Work profile must be pro-safe or full; got ${JSON.stringify(profile)}`);
  if (profile === "full" && !allowFullActions) throw new Error("ChatGPT Work full profile requires --allow-full-actions");
  if (profile !== "full" && allowFullActions) throw new Error("--allow-full-actions is valid only with --profile full");
  const config = { connectionId: canonicalId, profile, allowFullActions: profile === "full" };
  const configPath = await chatgptWorkConfigPath({ scope, cwd, home });
  const pluginsRoot = chatgptWorkPluginsRoot({ scope, cwd, home });
  const pluginPath = join(pluginsRoot, WORK_PLUGIN_ID);
  await ordinaryDirectory(dirname(configPath));
  await ordinaryDirectory(dirname(pluginsRoot));
  if (dryRun) {
    if (await pathExists(dirname(pluginsRoot))) await securePublicationDirectory(dirname(pluginsRoot));
    if (await pathExists(pluginsRoot)) await securePublicationDirectory(pluginsRoot);
    const owned = await readChatgptWorkConfig({ scope, cwd, home });
    if (!owned && await pathExists(pluginPath)) throw new Error(`HUMAN-HOLD: ChatGPT Work destination is unowned: ${pluginPath}`);
    const { value: marketplace } = await readWorkMarketplace(pluginsRoot, { allowMissing: true });
    mergeWorkMarketplace(marketplace, pluginsRoot, { owned: Boolean(owned) });
    return { ok: true, scope, dryRun, configPath, pluginPath, connectionId: canonicalId, profile, allowFullActions: config.allowFullActions };
  }

  await ordinaryDirectory(dirname(configPath), { create: true });
  await privateManagedDirectory(dirname(configPath));
  return withCodexFileLock(`${configPath}.lock`, async () => {
    const owned = await readChatgptWorkConfig({ scope, cwd, home });
    if (!owned && await pathExists(pluginPath)) {
      throw new Error(`HUMAN-HOLD: ChatGPT Work destination is unowned: ${pluginPath}`);
    }
    const assets = await prepareRuntimeAssets();
    let staged;
    try {
      // The exclusive receipt-adjacent lock intentionally spans staging,
      // destination/marketplace publication, validation, and the final receipt commit.
      staged = await stageWorkPlugin(config, assets, { configPath, pluginPath });
      await ordinaryDirectory(dirname(pluginsRoot), { create: true });
      await ordinaryDirectory(pluginsRoot, { create: true });
      await securePublicationDirectory(dirname(pluginsRoot));
      await securePublicationDirectory(pluginsRoot);
      return await withCodexFileLock(join(pluginsRoot, ".build.lock"), async () => {
        await securePublicationDirectory(dirname(pluginsRoot));
        await securePublicationDirectory(pluginsRoot);
        const receiptSnapshot = await snapshotFile(configPath);
        const { marketplacePath, bytes: marketplaceSnapshot, value: marketplace } =
          await readWorkMarketplace(pluginsRoot, { allowMissing: true });
        const nextMarketplace = mergeWorkMarketplace(marketplace, pluginsRoot, { owned: Boolean(owned) });
        let backup = null;
        let published = false;
        let marketplaceWriteAttempted = false;
        if (await pathExists(pluginPath)) {
          backup = join(pluginsRoot, `.${WORK_PLUGIN_ID}.retired-${randomUUID()}`);
          await rename(pluginPath, backup);
        }
        try {
          // Pessimistic: the flag is set BEFORE the fallible publish so a
          // partial copy still rolls back (cp can fail mid-tree, leaving a
          // half-written pluginPath the catch below must remove).
          published = true;
          await cp(staged.plugin, pluginPath, { recursive: true, errorOnExist: true, force: false });
          // Same rationale: a failed marketplace write must still restore the
          // snapshot, so the attempt flag goes up before the write.
          marketplaceWriteAttempted = true;
          await atomicPrivateWrite(marketplacePath, Buffer.from(JSON.stringify(nextMarketplace, null, 2) + "\n"));
          const receipt = validateConfig({
            format: 3,
            owner: "muster",
            artifactFlavor: "chatgpt-work",
            appId: canonicalId,
            ...config,
            cacheKey: sha256(JSON.stringify(["chatgpt-work", canonicalId, profile, config.allowFullActions])),
            pluginPath,
            artifacts: await artifactDigests(pluginPath),
          });
          await validateInstalledConfig(receipt, pluginPath, configPath);
          if (__testBeforeReceiptCommit) await __testBeforeReceiptCommit();
          await atomicPrivateWrite(configPath, Buffer.from(JSON.stringify(receipt, null, 2) + "\n"));
          // Re-read the committed plugin, marketplace entry, and receipt before reporting success.
          await readChatgptWorkConfig({ scope, cwd, home });
        } catch (error) {
          const rollbackFailures = [];
          if (published) {
            try { await rm(pluginPath, { recursive: true, force: true }); }
            catch (rollback) { rollbackFailures.push(`new plugin removal failed: ${rollback.message}`); }
          }
          if (backup) {
            try { await rename(backup, pluginPath); backup = null; }
            catch (rollback) { rollbackFailures.push(`prior plugin restore failed: ${rollback.message}`); }
          }
          if (marketplaceWriteAttempted) {
            try {
              if (marketplaceSnapshot === null) await rm(marketplacePath, { force: true });
              else await atomicPrivateWrite(marketplacePath, marketplaceSnapshot);
            } catch (rollback) { rollbackFailures.push(`prior marketplace restore failed: ${rollback.message}`); }
          }
          try {
            if (receiptSnapshot === null) await rm(configPath, { force: true });
            else await atomicPrivateWrite(configPath, receiptSnapshot);
          } catch (rollback) { rollbackFailures.push(`prior receipt restore failed: ${rollback.message}`); }
          if (rollbackFailures.length) {
            throw new Error(`HUMAN-HOLD: ChatGPT Work install failed and rollback was incomplete: ${rollbackFailures.join("; ")} (original failure: ${error.message})`, { cause: error });
          }
          throw error;
        }
        if (backup) await rm(backup, { recursive: true, force: true });
        return {
          ok: true, scope, dryRun, configPath, pluginPath,
          connectionId: canonicalId, profile, allowFullActions: config.allowFullActions,
        };
      });
    } finally {
      await assets.cleanup();
      if (staged) await rm(staged.stagingRoot, { recursive: true, force: true });
    }
  });
}
