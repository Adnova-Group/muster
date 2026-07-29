import { createHash, randomUUID } from "node:crypto";
import {
  chmod, cp, lstat, mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { publishCodexPlugin } from "./codex-release.js";

const CONNECTION_ID = /^asdk_app_[A-Za-z0-9][A-Za-z0-9_-]*$/;
const PROFILES = new Set(["pro-safe", "full"]);
const RECEIPT_NAME = "chatgpt-work.json";

export function normalizeChatgptWorkConnectionId(value) {
  if (typeof value !== "string") throw new Error("ChatGPT Work connection id is required");
  const normalized = value.startsWith("plugin_") ? value.slice("plugin_".length) : value;
  if (!CONNECTION_ID.test(normalized)) {
    throw new Error("ChatGPT Work connection id must match asdk_app_<id> (an initial plugin_ prefix is accepted)");
  }
  return normalized;
}

async function ordinaryDirectory(path, { create = false } = {}) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    let info;
    try { info = await lstat(current); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      if (!create) return false;
      await mkdir(current, { mode: 0o700 });
      info = await lstat(current);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new Error(`ChatGPT Work path ancestry must be ordinary directories: ${current}`);
    }
  }
  return absolute;
}

async function privateManagedDirectory(path) {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`ChatGPT Work managed path must be an ordinary directory: ${path}`);
  if (process.platform !== "win32" && typeof process.getuid === "function"
    && (info.uid !== process.getuid() || (info.mode & 0o077) !== 0)) {
    throw new Error(`ChatGPT Work managed directory must be current-user-owned and private: ${path}`);
  }
}

async function projectGitDir(cwd) {
  const marker = join(resolve(cwd), ".git");
  let info;
  try { info = await lstat(marker); } catch (cause) {
    if (cause.code !== "ENOENT") throw cause;
    const error = new Error("project scope requires a Git worktree", { cause });
    error.code = "MUSTER_NO_GIT_WORKTREE";
    throw error;
  }
  if (info.isSymbolicLink()) throw new Error("project scope rejects symlinked .git metadata");
  if (info.isDirectory()) return marker;
  if (!info.isFile()) throw new Error("project scope requires an ordinary .git directory or gitdir file");
  const text = await readFile(marker, "utf8");
  const match = text.trim().match(/^gitdir:\s*(.+)$/);
  if (!match) throw new Error("project scope .git file has an invalid gitdir pointer");
  const gitDir = isAbsolute(match[1]) ? resolve(match[1]) : resolve(dirname(marker), match[1]);
  const resolved = await realpath(gitDir);
  const gitInfo = await lstat(resolved);
  if (gitInfo.isSymbolicLink() || !gitInfo.isDirectory()) throw new Error("project gitdir must resolve to an ordinary directory");
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

function validateConfig(config) {
  if (config?.format !== 2 || config?.owner !== "muster" || !PROFILES.has(config.profile)
    || typeof config.allowFullActions !== "boolean") throw new Error("ChatGPT Work installer receipt is invalid");
  const connectionId = normalizeChatgptWorkConnectionId(config.connectionId);
  if (connectionId !== config.connectionId) throw new Error("ChatGPT Work installer receipt connection id is not canonical");
  if ((config.profile === "full") !== config.allowFullActions) {
    throw new Error("ChatGPT Work installer receipt profile/action opt-in is inconsistent");
  }
  const cacheKey = createHash("sha256").update(JSON.stringify([connectionId, config.profile, config.allowFullActions])).digest("hex");
  if (config.cacheKey !== cacheKey || !/^[a-f0-9]{64}$/.test(config.appSha256 ?? "") || !isAbsolute(config.pluginPath ?? "")) {
    throw new Error("ChatGPT Work installer receipt cache identity is invalid");
  }
  return {
    format: 2, owner: "muster", connectionId, profile: config.profile,
    allowFullActions: config.allowFullActions, cacheKey,
    appSha256: config.appSha256, pluginPath: config.pluginPath,
  };
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
    const expectedPluginPath = join(chatgptWorkPluginsRoot(options), "plugin");
    if (resolve(config.pluginPath) !== resolve(expectedPluginPath)) throw new Error("ChatGPT Work installer receipt plugin path is outside its scope");
    const appPath = join(config.pluginPath, ".app.json");
    const appInfo = await lstat(appPath);
    if (appInfo.isSymbolicLink() || !appInfo.isFile()) throw new Error("ChatGPT Work installed app metadata must be an ordinary file");
    const appBytes = await readFile(appPath, "utf8");
    if (createHash("sha256").update(appBytes).digest("hex") !== config.appSha256
      || JSON.stringify(JSON.parse(appBytes)) !== JSON.stringify({ apps: { muster: { id: config.connectionId } } })) {
      throw new Error("ChatGPT Work installer receipt does not match installed app metadata");
    }
    return config;
  }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error(`ChatGPT Work installer receipt is not valid JSON: ${path}`);
    throw error;
  }
}

export async function readOptionalChatgptWorkConfig(options = {}) {
  try { return await readChatgptWorkConfig(options); }
  catch (error) { if (error.code === "MUSTER_NO_GIT_WORKTREE") return null; throw error; }
}

async function prepareRuntimeAssets() {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const bundled = {
    cli: join(moduleDir, "muster.mjs"),
    server: join(moduleDir, "chatgpt-work-server.mjs"),
  };
  try {
    for (const path of Object.values(bundled)) {
      const info = await lstat(path);
      if (info.isSymbolicLink() || !info.isFile()) throw new Error(`runtime asset is not an ordinary file: ${path}`);
    }
    return { ...bundled, cleanup: async () => {} };
  } catch (error) {
    if (basename(moduleDir) !== "src") throw new Error(`bundled ChatGPT Work runtime assets are unavailable: ${error.message}`);
  }

  const root = resolve(moduleDir, "..");
  const dir = await mkdtemp(join(tmpdir(), "muster-work-runtime-"));
  const { build } = await import("esbuild");
  const requireBanner = 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);';
  const bundleOptions = { bundle: true, platform: "node", format: "esm", target: "node20", preserveSymlinks: true, external: ["esbuild"] };
  await build({ ...bundleOptions, entryPoints: [join(root, "src", "cli.js")], outfile: join(dir, "muster.mjs"), banner: { js: requireBanner } });
  await build({
    ...bundleOptions,
    entryPoints: [join(root, "mcp", "chatgpt-work-server.mjs")],
    outfile: join(dir, "chatgpt-work-server.mjs"),
  });
  return {
    cli: join(dir, "muster.mjs"), server: join(dir, "chatgpt-work-server.mjs"),
    cleanup: () => rm(dir, { recursive: true, force: true }),
  };
}

async function stageWorkPlugin(config, assets) {
  const stagingRoot = await mkdtemp(join(tmpdir(), "muster-work-plugin-"));
  const plugin = join(stagingRoot, "plugin");
  const runtime = join(plugin, "runtime");
  await mkdir(join(plugin, ".codex-plugin"), { recursive: true, mode: 0o700 });
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  await cp(assets.cli, join(runtime, "muster.mjs"));
  await cp(assets.server, join(runtime, "chatgpt-work-server.mjs"));
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  const app = { apps: { muster: { id: config.connectionId } } };
  await writeFile(join(plugin, ".app.json"), JSON.stringify(app, null, 2) + "\n");
  const serverEnv = config.profile === "full" && config.allowFullActions
    ? { MUSTER_CHATGPT_WORK_INSTALL_ALLOW_FULL_ACTIONS: "1" }
    : undefined;
  await writeFile(join(plugin, ".mcp.json"), JSON.stringify({
    mcpServers: {
      muster: {
        command: "node", args: ["./runtime/chatgpt-work-server.mjs"], cwd: ".",
        ...(serverEnv ? { env: serverEnv } : {}),
      },
    },
  }, null, 2) + "\n");
  await writeFile(join(plugin, "package.json"), JSON.stringify({ version: pkg.version }, null, 2) + "\n");
  await writeFile(join(plugin, ".codex-plugin", "plugin.json"), JSON.stringify({
    name: "muster", version: pkg.version,
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

export async function runChatgptWorkInstall({
  connectionId, profile, scope = "project", allowFullActions = false,
  dryRun = false, cwd = process.cwd(), home = homedir(),
} = {}) {
  const canonicalId = normalizeChatgptWorkConnectionId(connectionId);
  if (!PROFILES.has(profile)) throw new Error("ChatGPT Work profile must be pro-safe or full");
  if (profile === "full" && !allowFullActions) throw new Error("ChatGPT Work full profile requires --allow-full-actions");
  if (profile !== "full" && allowFullActions) throw new Error("--allow-full-actions is valid only with --profile full");
  const config = { connectionId: canonicalId, profile, allowFullActions: profile === "full" };
  const configPath = await chatgptWorkConfigPath({ scope, cwd, home });
  const pluginsRoot = chatgptWorkPluginsRoot({ scope, cwd, home });
  await ordinaryDirectory(dirname(configPath));
  await ordinaryDirectory(dirname(pluginsRoot));
  await readChatgptWorkConfig({ scope, cwd, home }); // validates any installer-owned receipt before mutation
  let receiptSnapshot = null;
  try { receiptSnapshot = await readFile(configPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (dryRun) {
    return { ok: true, scope, dryRun, configPath, pluginPath: join(pluginsRoot, "plugin"), connectionId: canonicalId, profile, allowFullActions: config.allowFullActions };
  }

  const assets = await prepareRuntimeAssets();
  let staged;
  try {
    staged = await stageWorkPlugin(config, assets);
    await ordinaryDirectory(dirname(configPath), { create: true });
    await ordinaryDirectory(dirname(pluginsRoot), { create: true });
    await ordinaryDirectory(pluginsRoot, { create: true });
    await privateManagedDirectory(dirname(configPath));
    await privateManagedDirectory(pluginsRoot);
    const published = await publishCodexPlugin({
      pluginsRoot, stagedPlugin: staged.plugin, packageVersion: staged.version,
      marketplaceTemplate: {
        name: "muster", interface: { displayName: "Muster" },
        plugins: [{ name: "muster", source: { source: "local", path: "./plugin" }, category: "Productivity" }],
      },
    });
    await privateManagedDirectory(dirname(configPath));
    let currentSnapshot = null;
    try { currentSnapshot = await readFile(configPath, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (currentSnapshot !== receiptSnapshot) throw new Error("ChatGPT Work installer receipt changed concurrently");
    const appBytes = await readFile(join(published.pluginRoot, ".app.json"), "utf8");
    const receipt = {
      format: 2, owner: "muster", ...config,
      cacheKey: createHash("sha256").update(JSON.stringify([canonicalId, profile, config.allowFullActions])).digest("hex"),
      appSha256: createHash("sha256").update(appBytes).digest("hex"),
      pluginPath: published.pluginRoot,
    };
    const temporary = `${configPath}.${process.pid}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
    await rename(temporary, configPath);
    await chmod(configPath, 0o600);
    return {
      ok: true, scope, dryRun, configPath, pluginPath: published.pluginRoot,
      connectionId: canonicalId, profile, allowFullActions: config.allowFullActions,
    };
  } finally {
    await assets.cleanup();
    if (staged) await rm(staged.stagingRoot, { recursive: true, force: true });
  }
}
