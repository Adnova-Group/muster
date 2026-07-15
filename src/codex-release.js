import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, linkSync, openSync, readFileSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { cp, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { processAlive, processStartIdentity, withCodexFileLock } from "./codex-lock.js";

const RELEASE_FORMAT = 1;
const CURRENT_RELEASE_FORMAT = 2;
const SUPPORTED_RELEASE_FORMATS = new Set([1, CURRENT_RELEASE_FORMAT]);
const GENERATION = /^[a-f0-9]{64}$/;
const slash = value => value.replaceAll("\\", "/");
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function readRegular(path, label, maxBytes = 32 * 1024 * 1024) {
  let handle;
  try {
    await ordinary(path, "file", label);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${label} must be a bounded regular file: ${path}`);
    return await handle.readFile();
  } finally { if (handle) await handle.close().catch(() => {}); }
}
const readRegularJson = async (path, label, maxBytes = 64 * 1024) => JSON.parse((await readRegular(path, label, maxBytes)).toString("utf8"));

function contained(base, target, label) {
  const rel = relative(resolve(base), resolve(target));
  if (!rel || rel === ".") return;
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error(`${label} is not contained by ${base}: ${target}`);
  }
}

async function ordinary(path, expected, label) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { throw new Error(`${label} is missing: ${path}`, { cause: error }); }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (expected === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${label} must be a regular ${expected}: ${path}`);
  }
  return stat;
}

async function repositoryDirectory(repoRoot, parts, { create = false } = {}) {
  await ordinary(repoRoot, "directory", "repository root");
  let current = repoRoot;
  for (const part of parts) {
    current = join(current, part);
    let stat;
    try { stat = await lstat(current); }
    catch (error) {
      if (error.code !== "ENOENT" || !create) throw new Error(`repository directory is missing: ${current}`, { cause: error });
      try { await mkdir(current); }
      catch (mkdirError) { if (mkdirError.code !== "EEXIST") throw mkdirError; }
      stat = await lstat(current);
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`repository path must be an ordinary directory: ${current}`);
  }
  return current;
}

export async function assertRegularTree(root) {
  await ordinary(root, "directory", "tree root");
  const files = [], dirs = [];
  async function walk(dir) {
    const entries = await readdir(dir);
    entries.sort();
    for (const name of entries) {
      const path = join(dir, name);
      contained(root, path, "tree entry");
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`tree entry must not be a symlink: ${path}`);
      const rel = slash(relative(root, path));
      if (stat.isDirectory()) {
        dirs.push(rel);
        await walk(path);
      } else if (stat.isFile()) {
        const content = await readRegular(path, "tree entry");
        files.push({ path: rel, sha256: sha256(content), size: content.length });
      } else throw new Error(`tree entry must be a regular file or directory: ${path}`);
    }
  }
  await walk(root);
  return { dirs, files };
}

export async function assertRegularFile(path) {
  await ordinary(path, "file", "source file");
  return path;
}

export async function createCodexBootstrapMetadata(bootstrapRoot) {
  const tree = await assertRegularTree(bootstrapRoot);
  const files = tree.files.filter(file => file.path !== "bootstrap.json");
  const payload = { format: RELEASE_FORMAT, files };
  return { ...payload, digest: sha256(JSON.stringify(payload)) };
}

export async function validateCodexBootstrap(bootstrapRoot) {
  await ordinary(join(bootstrapRoot, "bootstrap.json"), "file", "bootstrap metadata");
  const metadata = await readRegularJson(join(bootstrapRoot, "bootstrap.json"), "bootstrap metadata", 4 * 1024 * 1024);
  if (metadata?.format !== RELEASE_FORMAT || !GENERATION.test(metadata.digest || "") || !Array.isArray(metadata.files)) {
    throw new Error("Codex bootstrap metadata has an invalid contract");
  }
  const actual = await createCodexBootstrapMetadata(bootstrapRoot);
  if (actual.digest !== metadata.digest || JSON.stringify(actual.files) !== JSON.stringify(metadata.files)) throw new Error("Codex bootstrap content hash mismatch");
  return metadata;
}

export async function prepareCodexBootstrap({ repoRoot, stagedBootstrap, allowMaintenance = false }) {
  const metadata = await createCodexBootstrapMetadata(stagedBootstrap);
  await writeFile(join(stagedBootstrap, "bootstrap.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
  const bootstrapParent = await repositoryDirectory(repoRoot, [".agents", "plugins", "bootstrap"], { create: true });
  const live = join(bootstrapParent, "muster");
  try {
    await ordinary(live, "directory", "existing Codex bootstrap");
    const current = await validateCodexBootstrap(live);
    if (current.digest === metadata.digest) {
      await rm(stagedBootstrap, { recursive: true, force: true });
      return current;
    }
    if (!allowMaintenance) throw new Error("Codex bootstrap surface drift detected; stop Codex/Desktop and run explicit offline bootstrap maintenance, then restart");
    const backup = join(bootstrapParent, `.muster-maintenance-${process.pid}-${Date.now()}`);
    await rename(live, backup);
    try { await rename(stagedBootstrap, live); }
    catch (error) { await rename(backup, live); throw error; }
    await rm(backup, { recursive: true, force: true });
    return metadata;
  } catch (error) {
    if (!String(error.message).startsWith("existing Codex bootstrap is missing:")) throw error;
    await rename(stagedBootstrap, live);
    return metadata;
  }
}

function metadataFor(packageVersion, files, format = CURRENT_RELEASE_FORMAT) {
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("release package version is required");
  const payload = { format, packageVersion, files };
  return { ...payload, generation: sha256(JSON.stringify(payload)) };
}

async function createCodexReleaseMetadataForFormat(releaseRoot, packageVersion, format) {
  const tree = await assertRegularTree(releaseRoot);
  const files = tree.files.filter(file => file.path !== "release.json");
  if (format === 1) {
    if (!tree.dirs.includes("plugin") || !tree.dirs.includes("profiles")
      || !files.some(file => file.path.startsWith("plugin/")) || !files.some(file => file.path.startsWith("profiles/"))) {
      throw new Error("format-1 release plugin and profiles must both contain regular files");
    }
  } else if (format === CURRENT_RELEASE_FORMAT) {
    if (!tree.dirs.includes("plugin") || !tree.dirs.includes("plugin/agents")
      || !files.some(file => file.path.startsWith("plugin/agents/") && file.path.endsWith(".toml"))
      || !files.some(file => file.path === "plugin/runtime/muster.mjs")) {
      throw new Error("format-2 release must contain canonical plugin agents and runtime");
    }
    if (tree.dirs.includes("profiles") || files.some(file => file.path.startsWith("profiles/"))) {
      throw new Error("format-2 release must not duplicate canonical agent profiles");
    }
  } else throw new Error(`unsupported Codex release format: ${format}`);
  return metadataFor(packageVersion, files, format);
}

export async function createCodexReleaseMetadata(releaseRoot, packageVersion) {
  return createCodexReleaseMetadataForFormat(releaseRoot, packageVersion, CURRENT_RELEASE_FORMAT);
}

async function migrateLegacyRelease(releasesRoot, generation) {
  const source = join(releasesRoot, generation);
  const legacy = await validateCodexRelease(source, generation);
  if (legacy.format !== 1) return { generation, metadata: legacy };
  const legacyProfiles = (await readdir(join(source, "profiles"))).filter(name => name.endsWith(".toml")).sort();
  const canonicalProfiles = await readdir(join(source, "plugin", "agents")).then(
    names => names.filter(name => name.endsWith(".toml")).sort(),
    error => { if (error.code === "ENOENT") return null; throw error; }
  );
  if (canonicalProfiles && JSON.stringify(legacyProfiles) !== JSON.stringify(canonicalProfiles)) throw new Error("legacy Codex release profile copies diverged; refusing compatibility migration");
  if (canonicalProfiles) for (const name of legacyProfiles) {
    const [legacyBytes, canonicalBytes] = await Promise.all([
      readRegular(join(source, "profiles", name), `legacy profile ${name}`),
      readRegular(join(source, "plugin", "agents", name), `canonical profile ${name}`)
    ]);
    if (!legacyBytes.equals(canonicalBytes)) throw new Error(`legacy Codex release profile copies diverged: ${name}`);
  }
  const [legacyCli, canonicalCli] = await Promise.all([
    readRegular(join(source, "plugin", "src", "cli.js"), "legacy CLI copy"),
    readRegular(join(source, "plugin", "runtime", "muster.mjs"), "canonical CLI bundle")
  ]);
  if (!legacyCli.equals(canonicalCli)) throw new Error("legacy Codex release CLI copies diverged; refusing compatibility migration");
  const staging = await mkdtemp(join(releasesRoot, ".muster-format-2-"));
  try {
    await cp(source, staging, { recursive: true });
    await rm(join(staging, "release.json"));
    if (!canonicalProfiles) await cp(join(staging, "profiles"), join(staging, "plugin", "agents"), { recursive: true });
    await rm(join(staging, "profiles"), { recursive: true });
    await mkdir(join(staging, "plugin", "src"), { recursive: true });
    await writeFile(join(staging, "plugin", "src", "cli.js"), '#!/usr/bin/env node\nimport "../runtime/muster.mjs";\n');
    const metadata = await createCodexReleaseMetadata(staging, legacy.packageVersion);
    await writeFile(join(staging, "release.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
    const destination = join(releasesRoot, metadata.generation);
    try {
      await ordinary(destination, "directory", "existing migrated Codex release");
      await validateCodexRelease(destination, metadata.generation);
      await rm(staging, { recursive: true, force: true });
    } catch (error) {
      if (!String(error.message).startsWith("existing migrated Codex release is missing:")) throw error;
      await rename(staging, destination);
    }
    return { generation: metadata.generation, metadata };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

function releaseProfilesRoot(releaseRoot, metadata) {
  return metadata.format === CURRENT_RELEASE_FORMAT ? join(releaseRoot, "plugin", "agents") : join(releaseRoot, "profiles");
}

function releasePluginRoot(releaseRoot) {
  return join(releaseRoot, "plugin");
}

function validateReleaseFormat(metadata, releaseRoot) {
  if (!SUPPORTED_RELEASE_FORMATS.has(metadata?.format) || !GENERATION.test(metadata?.generation || "") || !Array.isArray(metadata?.files)) {
    throw new Error(`release metadata has an invalid contract: ${releaseRoot}`);
  }
}

export async function validateCodexRelease(releaseRoot, expectedGeneration) {
  await ordinary(join(releaseRoot, "release.json"), "file", "release metadata");
  let metadata;
  try { metadata = await readRegularJson(join(releaseRoot, "release.json"), "release metadata", 4 * 1024 * 1024); }
  catch (error) { throw new Error(`release metadata is invalid: ${releaseRoot}`, { cause: error }); }
  validateReleaseFormat(metadata, releaseRoot);
  if (expectedGeneration && metadata.generation !== expectedGeneration) throw new Error("release generation does not match the selected pointer");
  if (releaseRoot.split(/[\\/]/).at(-1) !== metadata.generation) throw new Error("release directory is not content-addressed by its generation");
  const actual = await createCodexReleaseMetadataForFormat(releaseRoot, metadata.packageVersion, metadata.format);
  if (actual.generation !== metadata.generation || JSON.stringify(actual.files) !== JSON.stringify(metadata.files)) {
    throw new Error(`release content hash mismatch: ${releaseRoot}`);
  }
  return metadata;
}

async function readPointer(repoRoot) {
  await repositoryDirectory(repoRoot, [".agents", "plugins"]);
  const path = join(repoRoot, ".agents", "plugins", "marketplace.json");
  await ordinary(path, "file", "Codex marketplace pointer");
  let pointer;
  try { pointer = await readRegularJson(path, "Codex marketplace pointer", 1024 * 1024); }
  catch (error) { throw new Error("Codex marketplace pointer is invalid JSON", { cause: error }); }
  return { path, pointer };
}

export async function resolveCodexRelease(repoRoot) {
  return resolveCodexReleaseWithOptions(repoRoot);
}

const STABLE_BOOTSTRAP_PATH = "./.agents/plugins/bootstrap/muster";
const RELEASE_PLUGIN_PATH = /^\.\/\.agents\/plugins\/releases\/([a-f0-9]{64})\/plugin$/;
const SELECTION = /^(\d{12})-([a-f0-9]{64})\.json$/;
const LEASE = /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const LEGACY_LEASE = /^(\d+)\.json$/;

async function releaseResult(repoRoot, generation, leaseOptions) {
  return withLeaseRegistryTransaction(repoRoot, async () => {
    if (!GENERATION.test(generation || "")) throw new Error("selected Codex generation is invalid");
    const releaseRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "releases", generation]);
    const metadata = await validateCodexRelease(releaseRoot, generation);
    const lease = await registerGenerationLease(repoRoot, generation, leaseOptions);
    return { generation, releaseRoot, pluginRoot: releasePluginRoot(releaseRoot), profilesRoot: releaseProfilesRoot(releaseRoot, metadata), metadata, lease };
  });
}

const LEASE_HEARTBEAT_INTERVAL_MS = 60 * 1000;
const leaseControllers = new Map();
const leaseExitPools = [];
const defaultAddExitListener = (event, listener) => process.once(event, listener);
const defaultRemoveExitListener = (event, listener) => process.removeListener(event, listener);
function localProcessNamespace() {
  if (process.env.MUSTER_PROCESS_NAMESPACE) return process.env.MUSTER_PROCESS_NAMESPACE;
  if (process.platform === "linux") {
    try { return `linux-pidns:${readlinkSync("/proc/self/ns/pid")}`; }
    catch { /* hard heartbeat expiry remains the fallback */ }
  }
  return `${process.platform}:${process.arch}`;
}
const leaseLockPath = path => `${path}.lifecycle.lock`;
const leaseRegistryLockPath = repoRoot => join(repoRoot, ".agents", "plugins", ".lease-registry.lock");

async function withLeaseRegistryTransaction(repoRoot, callback) {
  await repositoryDirectory(repoRoot, [".agents", "plugins"], { create: true });
  return withCodexFileLock(leaseRegistryLockPath(repoRoot), callback);
}

function retainLeaseExitCleanup(addExitListener, removeExitListener, key, cleanup) {
  let pool = leaseExitPools.find(candidate => candidate.addExitListener === addExitListener && candidate.removeExitListener === removeExitListener);
  if (!pool) {
    pool = { addExitListener, removeExitListener, cleanups: new Map() };
    pool.listener = () => {
      for (const callback of pool.cleanups.values()) {
        try { callback(); } catch { /* bounded process-exit cleanup */ }
      }
      pool.cleanups.clear();
    };
    leaseExitPools.push(pool);
    addExitListener("exit", pool.listener);
  }
  pool.cleanups.set(key, cleanup);
  return () => {
    if (!pool.cleanups.delete(key) || pool.cleanups.size) return;
    removeExitListener("exit", pool.listener);
    leaseExitPools.splice(leaseExitPools.indexOf(pool), 1);
  };
}

async function leaseIdentity(path, token) {
  let handle;
  try {
    await ordinary(path, "file", "Codex generation lease");
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 64 * 1024) throw new Error(`unsafe Codex generation lease: ${path}`);
    const record = JSON.parse(await handle.readFile("utf8"));
    if (record?.token !== token) throw new Error(`Codex generation lease ownership changed: ${path}`);
    return stat;
  } finally { if (handle) await handle.close().catch(() => {}); }
}

const sameLeaseIdentity = (left, right) => left.dev === right.dev && left.ino === right.ino;

async function renewLease(path, token, record, replaceLease = rename) {
  return withCodexFileLock(leaseLockPath(path), async () => {
    const initial = await leaseIdentity(path, token);
    await atomicWritePointer(path, JSON.stringify(record, null, 2) + "\n", async (temporary, destination) => {
      const current = await leaseIdentity(path, token);
      if (!sameLeaseIdentity(initial, current)) throw new Error(`Codex generation lease changed during renewal: ${path}`);
      await replaceLease(temporary, destination);
    });
  });
}

function removeLeaseSync(path, token) {
  const quarantine = `${path}.reclaim-${process.pid}-${randomUUID()}`;
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const current = JSON.parse(readFileSync(fd, "utf8"));
    if (current?.token !== token) return;
    closeSync(fd); fd = undefined;
    renameSync(path, quarantine);
    fd = openSync(quarantine, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const quarantined = JSON.parse(readFileSync(fd, "utf8"));
    closeSync(fd); fd = undefined;
    if (quarantined?.token === token) rmSync(quarantine);
    else {
      try { linkSync(quarantine, path); rmSync(quarantine); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  finally { if (fd !== undefined) try { closeSync(fd); } catch { /* process exit */ } }
}

const leaseOwnershipChanged = error => error?.code === "ENOENT" || /lease ownership changed/.test(error?.message || "");

async function removeLease(path, token, beforeLeaseCleanup) {
  try { return await withCodexFileLock(leaseLockPath(path), async () => {
    let initial;
    try { initial = await leaseIdentity(path, token); }
    catch (error) { if (leaseOwnershipChanged(error)) return false; throw error; }
    await beforeLeaseCleanup?.({ path, token });
    let current;
    try { current = await leaseIdentity(path, token); }
    catch (error) { if (leaseOwnershipChanged(error)) return false; throw error; }
    if (!sameLeaseIdentity(initial, current)) return false;
    removeLeaseSync(path, token);
    return true;
  }); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false; throw error; }
}

async function registerGenerationLease(repoRoot, generation, leaseOptions = {}) {
  const key = `${resolve(repoRoot)}\0${generation}`;
  if (leaseControllers.has(key)) return leaseControllers.get(key);
  const creating = createGenerationLease(repoRoot, generation, leaseOptions, key);
  leaseControllers.set(key, creating);
  try {
    const controller = await creating;
    if (leaseControllers.get(key) === creating) leaseControllers.set(key, controller);
    return controller;
  }
  catch (error) { if (leaseControllers.get(key) === creating) leaseControllers.delete(key); throw error; }
}

async function createGenerationLease(repoRoot, generation, leaseOptions, key) {
  const root = await repositoryDirectory(repoRoot, [".agents", "plugins", "leases", generation], { create: true });
  const token = randomUUID(), path = join(root, `${process.pid}-${token}.json`);
  const now = leaseOptions.now || Date.now;
  const setIntervalFn = leaseOptions.setInterval || setInterval;
  const clearIntervalFn = leaseOptions.clearInterval || clearInterval;
  const addExitListener = leaseOptions.addExitListener || defaultAddExitListener;
  const removeExitListener = leaseOptions.removeExitListener || defaultRemoveExitListener;
  const replaceLease = leaseOptions.replaceLease || rename;
  const beforeLeaseCleanup = leaseOptions.beforeLeaseCleanup;
  const identity = await processStartIdentity();
  const processNamespace = typeof leaseOptions.processNamespace === "string" && leaseOptions.processNamespace
    ? leaseOptions.processNamespace
    : localProcessNamespace();
  const base = { format: RELEASE_FORMAT, pid: process.pid, processIdentity: identity, processNamespace, processStartedAt: Math.floor(Date.now() - process.uptime() * 1000), generation, token };
  const record = () => ({ ...base, touchedAt: now() });
  await atomicWritePointer(path, JSON.stringify(record(), null, 2) + "\n", rename);
  let closed = false, renewal = Promise.resolve();
  const renew = () => {
    if (closed) return renewal;
    renewal = renewal.catch(() => {}).then(() => renewLease(path, token, record(), replaceLease)).catch(error => {
      if (["ENOENT", "ENOTDIR"].includes(error?.code)) stop();
      else throw error;
    });
    return renewal;
  };
  const timer = setIntervalFn(() => renew().catch(() => { /* publisher expiry handles an unavailable lease */ }), LEASE_HEARTBEAT_INTERVAL_MS);
  timer?.unref?.();
  const releaseExitCleanup = retainLeaseExitCleanup(addExitListener, removeExitListener, `${path}\0${token}`, () => removeLeaseSync(path, token));
  function stop() {
    if (closed) return;
    closed = true;
    clearIntervalFn(timer);
    releaseExitCleanup();
    if (leaseControllers.get(key) === controller) leaseControllers.delete(key);
  }
  const controller = {
    path,
    renew,
    async close() {
      stop();
      await renewal.catch(() => {});
      await removeLease(path, token, beforeLeaseCleanup);
    }
  };
  return controller;
}

const LEASE_HEARTBEAT_MAX_AGE_MS = 5 * 60 * 1000;

async function activeLeaseGenerations(repoRoot) {
  const leasesRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "leases"], { create: true });
  const active = new Set();
  for (const generation of await readdir(leasesRoot)) {
    if (!GENERATION.test(generation)) throw new Error(`invalid Codex generation lease directory: ${generation}`);
    const dir = await repositoryDirectory(repoRoot, [".agents", "plugins", "leases", generation]);
    for (const name of (await readdir(dir)).filter(entry => LEASE.test(entry) || LEGACY_LEASE.test(entry))) {
      const path = join(dir, name);
      await withCodexFileLock(leaseLockPath(path), async () => {
        let record;
        try { record = await readRegularJson(path, "Codex generation lease"); }
        catch {
          // Legacy PID-only leases were updated in place. Keep a bounded fresh
          // record while its writer has a transient invalid JSON snapshot.
          if (LEGACY_LEASE.test(name)) {
            try {
              const stat = await ordinary(path, "file", "Codex generation lease");
              const age = Date.now() - stat.mtimeMs;
              if (age >= -30_000 && age <= LEASE_HEARTBEAT_MAX_AGE_MS) active.add(generation);
            } catch { /* replaced legacy path is not an authority to retain */ }
          }
          return;
        }
        const match = name.match(LEASE) || name.match(LEGACY_LEASE);
        const namedOwner = name.match(LEASE) ? record.token === match?.[2] : true;
        const coherent = record?.format === RELEASE_FORMAT && record.generation === generation && match
          && record.pid === Number(match[1]) && typeof record.token === "string" && record.token.length > 0 && namedOwner
          && Number.isFinite(record.processStartedAt) && Number.isFinite(record.touchedAt);
        const heartbeatAge = Date.now() - record.touchedAt;
        const fresh = coherent && heartbeatAge >= -30_000 && heartbeatAge <= LEASE_HEARTBEAT_MAX_AGE_MS;
        const foreignNamespace = typeof record.processNamespace === "string" && record.processNamespace.length > 0
          && record.processNamespace !== localProcessNamespace();
        const actualIdentity = fresh && !foreignNamespace && processAlive(record.pid) ? await processStartIdentity(record.pid) : null;
        const identityMatches = foreignNamespace || (actualIdentity
          ? record.processIdentity === actualIdentity
          : fresh && processAlive(record.pid) && (record.processIdentity === null || record.processIdentity === undefined));
        if (fresh && identityMatches) active.add(generation); else if (coherent) removeLeaseSync(path, record.token);
      });
    }
    if ((await readdir(dir)).length === 0) await rm(dir, { recursive: true });
  }
  return active;
}

function validSelection(record, name, bootstrapDigest) {
  const match = name.match(SELECTION);
  return record?.format === RELEASE_FORMAT && record.sequence === Number(match?.[1]) && record.generation === match?.[2]
    && record.bootstrapDigest === bootstrapDigest;
}

const transient = error => ["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(error?.code);
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function resolveCodexReleaseWithOptions(repoRoot, { retries = 4, readSelections, lease } = {}) {
  let pointerError;
  let pointer;
  for (let attempt = 0; attempt < retries; attempt++) {
    try { ({ pointer } = await readPointer(repoRoot)); pointerError = null; break; }
    catch (error) { pointerError = error; if (!transient(error.cause || error)) throw error; await pause(5 * (attempt + 1)); }
  }
  if (pointerError) throw pointerError;
  const bootstrap = pointer?.musterBootstrap;
  const pluginPath = pointer?.plugins?.find(plugin => plugin?.name === "muster")?.source?.path;
  const advertisedGeneration = pluginPath?.match(RELEASE_PLUGIN_PATH)?.[1] || null;
  if (pointer?.name !== "muster" || (pluginPath !== STABLE_BOOTSTRAP_PATH && !advertisedGeneration) || bootstrap?.format !== RELEASE_FORMAT
    || !GENERATION.test(bootstrap?.initialGeneration || "") || !GENERATION.test(bootstrap?.digest || "")) {
    throw new Error("Codex marketplace is missing a valid immutable Muster bootstrap contract");
  }
  const bootstrapRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "bootstrap", "muster"]);
  const bootstrapMetadata = await validateCodexBootstrap(bootstrapRoot);
  if (bootstrapMetadata.digest !== bootstrap.digest) throw new Error("Codex marketplace bootstrap digest does not match the installed immutable bootstrap");

  let names = [];
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      names = readSelections ? await readSelections() : await readdir(join(repoRoot, ".agents", "plugins", "selections"));
      break;
    } catch (error) {
      if (!transient(error) || attempt === retries - 1) break;
      await pause(5 * (attempt + 1));
    }
  }
  const candidates = names.filter(name => SELECTION.test(name)).sort().reverse();
  if (advertisedGeneration) candidates.sort((left, right) => {
    const leftAdvertised = left.endsWith(`-${advertisedGeneration}.json`), rightAdvertised = right.endsWith(`-${advertisedGeneration}.json`);
    return leftAdvertised === rightAdvertised ? right.localeCompare(left) : leftAdvertised ? -1 : 1;
  });
  for (const name of candidates) {
    let generation;
    try {
      const record = await readRegularJson(join(repoRoot, ".agents", "plugins", "selections", name), "Codex selection record");
      if (!validSelection(record, name, bootstrap.digest)) continue;
      const releaseRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "releases", record.generation]);
      await validateCodexRelease(releaseRoot, record.generation);
      generation = record.generation;
    } catch { /* corrupt/incomplete newest selections fall back to an older complete generation */ }
    if (generation) return releaseResult(repoRoot, generation, lease);
  }
  return releaseResult(repoRoot, bootstrap.initialGeneration, lease);
}

async function atomicWritePointer(path, content, replacePointer) {
  let temporary;
  let handle;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      temporary = `${path}.muster-${process.pid}-${randomUUID()}.tmp`;
      try { handle = await open(temporary, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST" || attempt === 7) throw error; }
    }
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await ordinary(temporary, "file", "staged marketplace pointer");
    JSON.parse(await readFile(temporary, "utf8"));
    await replacePointer(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true });
  }
}

async function stageExitPointer(path, content) {
  let temporary, handle;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      temporary = `${path}.muster-${process.pid}-${randomUUID()}.exit-tmp`;
      try { handle = await open(temporary, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST" || attempt === 7) throw error; }
    }
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await ordinary(temporary, "file", "staged exit marketplace pointer");
    JSON.parse(await readFile(temporary, "utf8"));
    let pending = temporary;
    return {
      commit() {
        if (!pending) return;
        renameSync(pending, path);
        pending = null;
      },
      async discard() {
        if (!pending) return;
        const stale = pending;
        pending = null;
        await rm(stale, { force: true });
      },
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true });
    throw error;
  }
}

export async function publishCodexRelease({ repoRoot, stagedRelease, packageVersion, marketplaceTemplate, bootstrapDigest = "b".repeat(64), replacePointer = rename, allowBootstrapMigration = false, afterLeaseScan = async () => {}, deferFinalPointer = false }) {
  const metadata = await createCodexReleaseMetadata(stagedRelease, packageVersion);
  await writeFile(join(stagedRelease, "release.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
  const pluginsRoot = await repositoryDirectory(repoRoot, [".agents", "plugins"], { create: true });
  return withCodexFileLock(join(pluginsRoot, ".publication.lock"), async () => {
  const releasesRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "releases"], { create: true });
  await assertRegularTree(releasesRoot);
  const releaseRoot = join(releasesRoot, metadata.generation);
  try {
    await ordinary(releaseRoot, "directory", "existing immutable release");
    await validateCodexRelease(releaseRoot, metadata.generation);
    await rm(stagedRelease, { recursive: true, force: true });
  } catch (error) {
    if (!String(error.message).startsWith("existing immutable release is missing:")) throw error;
    await rename(stagedRelease, releaseRoot);
  }
  await validateCodexRelease(releaseRoot, metadata.generation);

  let pointerPath, previous;
  try {
    ({ path: pointerPath, pointer: previous } = await readPointer(repoRoot));
  } catch (error) {
    if (error.cause?.code !== "ENOENT" || !marketplaceTemplate) throw error;
    await repositoryDirectory(repoRoot, [".agents", "plugins"], { create: true });
    pointerPath = join(repoRoot, ".agents", "plugins", "marketplace.json");
    previous = structuredClone(marketplaceTemplate);
  }
  const stable = structuredClone(previous);
  if (stable?.name !== "muster" || !Array.isArray(stable.plugins) || !stable.plugins.some(plugin => plugin?.name === "muster")) {
    throw new Error("Codex marketplace does not describe the Muster plugin");
  }
  const plugin = stable.plugins.find(item => item.name === "muster");
  const advertisedGeneration = plugin.source?.path?.match(RELEASE_PLUGIN_PATH)?.[1] || null;
  const alreadyStable = (plugin.source?.path === STABLE_BOOTSTRAP_PATH || RELEASE_PLUGIN_PATH.test(plugin.source?.path || ""))
    && stable.musterBootstrap?.format === RELEASE_FORMAT;
  if (!alreadyStable) {
    if (!allowBootstrapMigration && await regularFileExists(pointerPath)) {
      throw new Error("Codex bootstrap maintenance required: stop Codex/Desktop, then run MUSTER_CODEX_BOOTSTRAP_MAINTENANCE=1 npm run build:codex");
    }
    plugin.source = { ...plugin.source, source: "local", path: STABLE_BOOTSTRAP_PATH };
    delete stable.musterRelease;
    stable.musterBootstrap = { format: RELEASE_FORMAT, digest: bootstrapDigest, initialGeneration: metadata.generation };
    if (!deferFinalPointer) await atomicWritePointer(pointerPath, JSON.stringify(stable, null, 2) + "\n", rename);
  } else if (stable.musterBootstrap.digest !== bootstrapDigest) {
    if (!allowBootstrapMigration) throw new Error("Codex bootstrap surface drift detected; explicit offline bootstrap maintenance and restart are required");
    stable.musterBootstrap = { format: RELEASE_FORMAT, digest: bootstrapDigest, initialGeneration: metadata.generation };
    if (!deferFinalPointer) await atomicWritePointer(pointerPath, JSON.stringify(stable, null, 2) + "\n", rename);
  }

  const selectionsRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "selections"], { create: true });
  const names = await readdir(selectionsRoot);
  const validRecord = async (name, generation) => {
    try {
      const record = await readRegularJson(join(selectionsRoot, name), "Codex selection record");
      return validSelection(record, name, bootstrapDigest) && record.generation === generation;
    } catch { return false; }
  };
  let selectionName;
  for (const name of names.filter(name => name.endsWith(`-${metadata.generation}.json`)).sort().reverse()) {
    if (await validRecord(name, metadata.generation)) { selectionName = name; break; }
  }
  let nextSequence = Math.max(0, ...names.map(name => Number(name.match(SELECTION)?.[1] || 0))) + 1;
  let lastAppendedGeneration = null;
  const appendSelection = async generation => {
    const sequence = nextSequence++;
    const name = `${String(sequence).padStart(12, "0")}-${generation}.json`;
    const record = { format: RELEASE_FORMAT, sequence, generation, bootstrapDigest };
    await atomicWritePointer(join(selectionsRoot, name), JSON.stringify(record, null, 2) + "\n", replacePointer);
    names.push(name);
    lastAppendedGeneration = generation;
    return name;
  };
  if (!selectionName) {
    selectionName = await appendSelection(metadata.generation);
  }
  const ordered = [...new Set(names.filter(name => SELECTION.test(name)).sort().reverse().map(name => name.match(SELECTION)[2]))];
  const priorMetadata = [];
  for (const generation of ordered.filter(generation => generation !== metadata.generation)) {
    try { priorMetadata.push({ generation, metadata: await validateCodexRelease(join(releasesRoot, generation), generation) }); }
    catch { /* pruning below removes incoherent history */ }
  }
  let canonicalLkg = priorMetadata.find(item => item.metadata.format === CURRENT_RELEASE_FORMAT);
  const legacyLkg = priorMetadata.find(item => item.metadata.format === 1);
  if (!canonicalLkg && legacyLkg) canonicalLkg = await migrateLegacyRelease(releasesRoot, legacyLkg.generation);
  if (canonicalLkg && !names.some(name => name.endsWith(`-${canonicalLkg.generation}.json`))) await appendSelection(canonicalLkg.generation);
  await withLeaseRegistryTransaction(repoRoot, async () => {
    const activeLeases = await activeLeaseGenerations(repoRoot);
    await afterLeaseScan({ generation: metadata.generation, selectionName, activeLeases: new Set(activeLeases) });
    const keep = new Set([metadata.generation, stable.musterBootstrap.initialGeneration, advertisedGeneration, canonicalLkg?.generation, legacyLkg?.generation, ...activeLeases].filter(Boolean));
    for (const generation of keep) {
      let coherent = false;
      for (const name of names.filter(name => name.endsWith(`-${generation}.json`))) if (await validRecord(name, generation)) coherent = true;
      if (!coherent) await appendSelection(generation);
    }
    let highestCoherentGeneration = null;
    for (const name of names.filter(name => SELECTION.test(name)).sort().reverse()) {
      const generation = name.match(SELECTION)[2];
      if (await validRecord(name, generation)) { highestCoherentGeneration = generation; break; }
    }
    if ((lastAppendedGeneration && lastAppendedGeneration !== metadata.generation) || highestCoherentGeneration !== metadata.generation) {
      selectionName = await appendSelection(metadata.generation);
    }
    await pruneCodexHistory({ repoRoot, releasesRoot, selectionsRoot, keep, bootstrapDigest });
  });
  plugin.source = { ...plugin.source, source: "local", path: `./.agents/plugins/releases/${metadata.generation}/plugin` };
  const pointerContent = JSON.stringify(stable, null, 2) + "\n";
  const pendingPointer = deferFinalPointer ? await stageExitPointer(pointerPath, pointerContent) : null;
  if (!pendingPointer) await atomicWritePointer(pointerPath, pointerContent, replacePointer);
  return {
    generation: metadata.generation,
    releaseRoot,
    pluginRoot: releasePluginRoot(releaseRoot),
    profilesRoot: releaseProfilesRoot(releaseRoot, metadata),
    selectionName,
    initialGeneration: stable.musterBootstrap.initialGeneration,
    commitPointer: pendingPointer?.commit,
    discardPointer: pendingPointer?.discard
  };
  });
}

async function pruneCodexHistory({ repoRoot, releasesRoot, selectionsRoot, keep, bootstrapDigest }) {
  const selectionNames = (await readdir(selectionsRoot)).filter(name => SELECTION.test(name)).sort().reverse();
  const retainedSelectionGenerations = new Set();
  for (const name of selectionNames) {
    const path = join(selectionsRoot, name), generation = name.match(SELECTION)[2];
    await ordinary(path, "file", "Codex selection record");
    let coherent = false;
    try { coherent = validSelection(await readRegularJson(path, "Codex selection record"), name, bootstrapDigest); } catch { /* remove malformed selectors */ }
    if (!keep.has(generation) || !coherent || retainedSelectionGenerations.has(generation)) await rm(path);
    else retainedSelectionGenerations.add(generation);
  }
  for (const generation of await readdir(releasesRoot)) {
    const path = join(releasesRoot, generation);
    if (!GENERATION.test(generation)) throw new Error(`unexpected entry in immutable release directory: ${path}`);
    await ordinary(path, "directory", "immutable release");
    if (!keep.has(generation)) {
      await assertRegularTree(path);
      await rm(path, { recursive: true });
      await rm(join(repoRoot, ".agents", "plugins", "leases", generation), { recursive: true, force: true });
    }
  }
}

async function regularFileExists(path) {
  try { await ordinary(path, "file", "Codex marketplace pointer"); return true; }
  catch (error) { if (error.cause?.code === "ENOENT") return false; throw error; }
}
