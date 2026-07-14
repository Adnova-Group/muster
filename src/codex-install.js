import { cp, mkdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { exists, readdirSafe } from "./fs-util.js";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { codexAvailable } from "./codex-inventory.js";
import { resolveCodexRelease } from "./codex-release.js";

const execFileDefault = promisify(execFileCb);
export const CODEX_MARKETPLACE = "Adnova-Group/muster";
export const CODEX_PLUGIN = "muster@muster";
const CODEX_MARKETPLACE_URL = "https://github.com/Adnova-Group/muster.git";
const MANIFEST = ".muster-managed.json";
const PROFILE_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/;
const HOOK_FILES = ["hooks/muster-hook.mjs", "hooks/action-guard.mjs"];

const codexHome = home => process.env.CODEX_HOME || join(home, ".codex");
const agentsDir = (scope, cwd, home) => scope === "user" ? join(codexHome(home), "agents") : join(cwd, ".codex", "agents");
const configDir = (scope, cwd, home) => scope === "user" ? codexHome(home) : join(cwd, ".codex");
const readJson = async path => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } };
const profileFiles = async root => (await readdirSafe(root)).filter(name => name.endsWith(".toml")).sort();
const run = (execFile, args) => execFile("codex", args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
async function runJson(execFile, args) { return JSON.parse((await run(execFile, args)).stdout); }

function validateManagedFiles(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Codex installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  const base = resolve(dir), seen = new Set();
  for (const file of manifest.files) {
    const destination = typeof file === "string" ? resolve(base, file) : "";
    if (typeof file !== "string" || file !== basename(file) || dirname(destination) !== base || !PROFILE_FILENAME.test(file) || seen.has(file)) {
      throw new Error(`Invalid Muster-owned Codex profile in ${manifestPath}: ${JSON.stringify(file)}. Remove the invalid manifest before retrying.`);
    }
    seen.add(file);
  }
  return [...seen];
}

function validateHookManifest(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files) || typeof manifest.hookGroups !== "object" || !manifest.hookGroups) {
    throw new Error(`Codex hook installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  const base = resolve(dir), seen = new Set();
  for (const file of manifest.files) {
    const destination = typeof file === "string" ? resolve(base, file) : "";
    const rel = destination ? relative(base, destination) : "";
    if (typeof file !== "string" || !file || isAbsolute(file) || rel === ".." || rel.startsWith(`..${sep}`) || seen.has(file)) {
      throw new Error(`Invalid Muster-owned Codex hook runtime in ${manifestPath}: ${JSON.stringify(file)}. Remove the invalid manifest before retrying.`);
    }
    seen.add(file);
  }
  return { files: [...seen], hookGroups: manifest.hookGroups, hookConfigCreated: manifest.hookConfigCreated === true };
}

function clone(value) { return JSON.parse(JSON.stringify(value)); }
const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);
const groupCommands = group => (group?.hooks || []).flatMap(hook => [hook?.command, hook?.commandWindows, hook?.command_windows]).filter(Boolean);
const isMusterHookCommand = command => typeof command === "string" && command.replaceAll("\\", "/").includes("/muster/hooks/muster-hook.mjs");

function removeOwnedHookGroups(config, owned, configPath) {
  const next = clone(config);
  next.hooks ||= {};
  for (const [event, groups] of Object.entries(owned || {})) {
    if (!Array.isArray(groups)) throw new Error(`Invalid Muster-owned Codex hook groups in ${configPath}: ${event}`);
    const current = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    for (const group of groups) {
      const exact = current.findIndex(candidate => same(candidate, group));
      if (exact >= 0) current.splice(exact, 1);
      else if (current.some(candidate => groupCommands(candidate).some(command => groupCommands(group).includes(command)))) {
        throw new Error(`Codex hook conflict: a Muster-owned hook was modified in ${configPath}. Restore it or remove the Muster hook manifest before retrying.`);
      }
    }
    if (current.length) next.hooks[event] = current;
    else delete next.hooks[event];
  }
  return next;
}

function shellCommand(path) {
  if (/[\r\n\0]/.test(path)) throw new Error(`Codex hook path contains unsupported control characters: ${path}`);
  const posix = `'${path.replaceAll("'", `'\\''`)}'`;
  const windows = path.replaceAll("\\", "/").replaceAll('"', '\\"');
  return { command: `node ${posix}`, commandWindows: `node "${windows}"` };
}

async function prepareHooks({ scope, cwd, home, root }) {
  const dir = configDir(scope, cwd, home);
  const runtimeDir = join(dir, "muster"), manifestPath = join(runtimeDir, MANIFEST), configPath = join(dir, "hooks.json");
  const manifestExists = await exists(manifestPath), configExists = await exists(configPath);
  const manifestRaw = manifestExists ? await readJson(manifestPath) : null;
  const previous = manifestExists ? validateHookManifest(manifestRaw, runtimeDir, manifestPath) : null;
  let config = { hooks: {} };
  if (configExists) {
    config = await readJson(configPath);
    if (!config || typeof config !== "object" || Array.isArray(config) || (config.hooks !== undefined && (typeof config.hooks !== "object" || Array.isArray(config.hooks)))) {
      throw new Error(`Codex hook configuration conflict: ${configPath} is not a valid hooks.json object. Repair it, then rerun the command.`);
    }
    config.hooks ||= {};
    for (const [event, groups] of Object.entries(config.hooks)) if (!Array.isArray(groups)) {
      throw new Error(`Codex hook configuration conflict: ${configPath} has a non-array ${event} hook group.`);
    }
  }
  if (!previous && Object.values(config.hooks).flat().some(group => groupCommands(group).some(isMusterHookCommand))) {
    throw new Error(`Codex hook conflict: ${configPath} contains an unmanaged Muster hook. Remove it or restore its Muster manifest, then rerun the command.`);
  }
  if (previous) config = removeOwnedHookGroups(config, previous.hookGroups, configPath);

  const templatePath = join(root, "codex", "hooks", "hooks.json");
  const template = await readJson(templatePath);
  if (!template?.hooks || typeof template.hooks !== "object") throw new Error(`Codex hook template is missing or malformed: ${templatePath}`);
  const runtimeScript = join(runtimeDir, "hooks", "muster-hook.mjs");
  const command = shellCommand(runtimeScript);
  const hookGroups = clone(template.hooks);
  for (const groups of Object.values(hookGroups)) for (const group of groups) for (const hook of group.hooks || []) {
    hook.command = command.command;
    hook.commandWindows = command.commandWindows;
  }
  for (const [event, groups] of Object.entries(hookGroups)) config.hooks[event] = [...(config.hooks[event] || []), ...groups];
  return {
    dir, runtimeDir, manifestPath, manifestExists, configPath, configExists, config,
    staleFiles: (previous?.files || []).filter(file => !HOOK_FILES.includes(file)),
    manifest: { format: 1, owner: "muster", files: HOOK_FILES, hookConfigCreated: previous?.hookConfigCreated ?? !configExists, hookGroups },
    sourceFiles: new Map([
      ["hooks/muster-hook.mjs", join(root, "codex", "hooks", "muster-hook.mjs")],
      ["hooks/action-guard.mjs", join(root, "codex", "hooks", "action-guard.mjs")]
    ])
  };
}

async function snapshot(originals, changed, path) {
  if (originals.has(path)) return;
  originals.set(path, await exists(path) ? await readFile(path, "utf8") : null);
  changed.push(path);
}

async function restoreFilesystem(originals, changed) {
  for (const destination of [...changed].reverse()) {
    if (originals.get(destination) === null) await rm(destination, { force: true });
    else {
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, originals.get(destination), "utf8");
    }
  }
}

function normalizedLocalRoot(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  return resolve(value.trim()).replaceAll("\\", "/");
}

function sameLocalRoot(left, right) {
  const actual = normalizedLocalRoot(left), expected = normalizedLocalRoot(right);
  if (!actual || !expected) return false;
  if (actual === expected) return true;
  const wslDrive = /^\/mnt\/[a-z](?:\/|$)/i;
  return wslDrive.test(actual) && wslDrive.test(expected) && actual.toLowerCase() === expected.toLowerCase();
}

function trustedMusterMarketplace(item, repoRoot) {
  const source = item?.marketplaceSource;
  if (source?.sourceType === "git") return source.source === CODEX_MARKETPLACE_URL;
  return source?.sourceType === "local"
    && sameLocalRoot(item.root, repoRoot)
    && sameLocalRoot(source.source, repoRoot);
}

async function existingMusterMarketplace(execFile, repoRoot) {
  const result = await runJson(execFile, ["plugin", "marketplace", "list", "--json"]);
  const matches = Array.isArray(result?.marketplaces) ? result.marketplaces.filter(item => item.name === "muster") : [];
  if (matches.some(item => !trustedMusterMarketplace(item, repoRoot))) {
    throw new Error(`Codex marketplace conflict: "muster" is registered from an unexpected source. Run "codex plugin marketplace remove muster", then rerun muster install codex.`);
  }
  return matches[0];
}

async function registerPlugin(execFile, dryRun, repoRoot) {
  if (dryRun) return [`codex plugin marketplace add ${CODEX_MARKETPLACE}`, `codex plugin add ${CODEX_PLUGIN}`];
  let marketplaceAdded = false, pluginAdded = false;
  try {
    const marketplace = await existingMusterMarketplace(execFile, repoRoot);
    if (!marketplace) {
      await run(execFile, ["plugin", "marketplace", "add", CODEX_MARKETPLACE]);
      marketplaceAdded = true;
    }
    await runJson(execFile, ["plugin", "list", "--available", "--json"]);
    await run(execFile, ["plugin", "add", CODEX_PLUGIN]);
    pluginAdded = true;
    return [];
  } catch (error) {
    if (pluginAdded) try { await run(execFile, ["plugin", "remove", CODEX_PLUGIN]); } catch { /* best-effort transaction rollback */ }
    if (marketplaceAdded) try { await run(execFile, ["plugin", "marketplace", "remove", "muster"]); } catch { /* best-effort transaction rollback */ }
    throw error;
  }
}

export async function runCodexInstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir(), repoRoot, execFile = execFileDefault } = {}) {
  if (!["project", "user"].includes(scope)) throw new Error("codex install scope must be project or user");
  const root = repoRoot || fileURLToPath(new URL("../", import.meta.url));
  const pluginRoot = await exists(join(root, ".codex-plugin", "plugin.json"));
  const source = pluginRoot ? join(root, "agents") : (await resolveCodexRelease(root)).profilesRoot;
  const files = await profileFiles(source);
  if (!files.length) throw new Error("Codex profiles are missing; run npm run build:codex first");
  const dir = agentsDir(scope, cwd, home), manifestPath = join(dir, MANIFEST);
  const manifest = await readJson(manifestPath);
  const manifestExists = await exists(manifestPath);
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const hooks = await prepareHooks({ scope, cwd, home, root });
  const managed = new Set(managedFiles.map(file => resolve(dir, file)));
  const staleFiles = managedFiles.filter(file => !files.includes(file));
  for (const file of files) {
    const destination = join(dir, file);
    if (await exists(destination) && !managed.has(resolve(destination))) throw new Error(`Codex profile conflict: ${destination}. Move it or remove it, then rerun muster install codex.`);
  }
  const present = await codexAvailable({ execFile });
  if (present && !dryRun) await existingMusterMarketplace(execFile, root);
  const planned = [
    ...files.map(file => ({ op: "write", path: join(dir, file) })),
    ...staleFiles.map(file => ({ op: "remove", path: join(dir, file) })),
    ...HOOK_FILES.map(file => ({ op: "write", path: join(hooks.runtimeDir, file) })),
    ...hooks.staleFiles.map(file => ({ op: "remove", path: join(hooks.runtimeDir, file) })),
    { op: "merge", path: hooks.configPath }
  ];
  let originals, changed;
  if (!dryRun) {
    await mkdir(dir, { recursive: true });
    originals = new Map(); changed = [];
    try {
      for (const file of files) {
        const destination = join(dir, file);
        await snapshot(originals, changed, destination);
        await cp(join(source, file), destination);
      }
      for (const file of staleFiles) {
        const destination = join(dir, file);
        await snapshot(originals, changed, destination);
        await rm(destination, { force: true });
      }
      await snapshot(originals, changed, manifestPath);
      await writeFile(manifestPath, JSON.stringify({ format: 1, owner: "muster", files }, null, 2) + "\n", "utf8");
      for (const [file, sourcePath] of hooks.sourceFiles) {
        const destination = join(hooks.runtimeDir, file);
        await mkdir(dirname(destination), { recursive: true });
        await snapshot(originals, changed, destination);
        await cp(sourcePath, destination);
      }
      for (const file of hooks.staleFiles) {
        const destination = join(hooks.runtimeDir, file);
        await snapshot(originals, changed, destination);
        await rm(destination, { force: true });
      }
      await mkdir(dirname(hooks.configPath), { recursive: true });
      await snapshot(originals, changed, hooks.configPath);
      await writeFile(hooks.configPath, JSON.stringify(hooks.config, null, 2) + "\n", "utf8");
      await snapshot(originals, changed, hooks.manifestPath);
      await writeFile(hooks.manifestPath, JSON.stringify(hooks.manifest, null, 2) + "\n", "utf8");
    } catch (error) {
      await restoreFilesystem(originals, changed);
      throw error;
    }
  }
  let actions = [];
  try {
    actions = present ? await registerPlugin(execFile, dryRun, root) : [];
  } catch (error) {
    if (!dryRun) await restoreFilesystem(originals, changed);
    throw error;
  }
  return { ok: true, target: "codex", scope, dryRun, profiles: files.length, hooks: Object.keys(hooks.manifest.hookGroups).length, files: planned,
    plugin: present ? { registered: !dryRun, actions } : { registered: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster install codex --scope ${scope}`] };
}

export async function runCodexUninstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir(), execFile = execFileDefault } = {}) {
  if (!["project", "user"].includes(scope)) throw new Error("codex uninstall scope must be project or user");
  const dir = agentsDir(scope, cwd, home), manifestPath = join(dir, MANIFEST), manifest = await readJson(manifestPath);
  const manifestExists = await exists(manifestPath);
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const files = managedFiles.map(file => join(dir, file));
  const hookDir = configDir(scope, cwd, home), hookRuntimeDir = join(hookDir, "muster"), hookManifestPath = join(hookRuntimeDir, MANIFEST), hookConfigPath = join(hookDir, "hooks.json");
  const hookManifestExists = await exists(hookManifestPath), hookConfigExists = await exists(hookConfigPath);
  const hookManifest = hookManifestExists ? validateHookManifest(await readJson(hookManifestPath), hookRuntimeDir, hookManifestPath) : null;
  let hookConfig = null, removeHookConfig = false;
  if (hookManifest) {
    hookConfig = hookConfigExists ? await readJson(hookConfigPath) : { hooks: {} };
    if (!hookConfig || typeof hookConfig !== "object" || Array.isArray(hookConfig)) throw new Error(`Codex hook configuration conflict: ${hookConfigPath} is not valid JSON.`);
    hookConfig = removeOwnedHookGroups(hookConfig, hookManifest.hookGroups, hookConfigPath);
    const otherKeys = Object.keys(hookConfig).filter(key => key !== "hooks");
    removeHookConfig = hookManifest.hookConfigCreated && otherKeys.length === 0 && Object.keys(hookConfig.hooks || {}).length === 0;
  }
  const hookFiles = hookManifest ? hookManifest.files.map(file => join(hookRuntimeDir, file)) : [];
  const present = await codexAvailable({ execFile });
  const planned = [
    ...files.map(path => ({ op: "remove", path })),
    ...hookFiles.map(path => ({ op: "remove", path })),
    ...(hookManifest ? [{ op: removeHookConfig ? "remove" : "merge", path: hookConfigPath }] : [])
  ];
  if (!dryRun) {
    const originals = new Map(), changed = [];
    try {
      for (const file of files) { await snapshot(originals, changed, file); await rm(file, { force: true }); }
      if (manifestExists) { await snapshot(originals, changed, manifestPath); await rm(manifestPath, { force: true }); }
      for (const file of hookFiles) { await snapshot(originals, changed, file); await rm(file, { force: true }); }
      if (hookManifestExists) { await snapshot(originals, changed, hookManifestPath); await rm(hookManifestPath, { force: true }); }
      if (hookManifest) {
        await snapshot(originals, changed, hookConfigPath);
        if (removeHookConfig) await rm(hookConfigPath, { force: true });
        else await writeFile(hookConfigPath, JSON.stringify(hookConfig, null, 2) + "\n", "utf8");
      }
    } catch (error) {
      await restoreFilesystem(originals, changed);
      throw error;
    }
    for (const empty of [join(hookRuntimeDir, "hooks"), hookRuntimeDir]) try { await rmdir(empty); } catch { /* preserve non-empty user content */ }
    if (present) try { await run(execFile, ["plugin", "remove", CODEX_PLUGIN]); } catch { /* already absent is idempotent */ }
  }
  return { ok: true, target: "codex", scope, dryRun, files: planned,
    plugin: present ? { removed: !dryRun } : { removed: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster uninstall codex --scope ${scope}`] };
}
