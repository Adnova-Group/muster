#!/usr/bin/env node

// This resolver is intentionally self-contained. Codex may copy only the
// marketplace plugin into its cache, where checkout-relative src/ imports and
// package node_modules do not exist.
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants as fsConstants, linkSync, openSync, readFileSync, readlinkSync, renameSync, rmSync } from "node:fs";
import { link, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, unlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT = 1;
const GENERATION = /^[a-f0-9]{64}$/;
const SELECTION = /^(\d{12})-([a-f0-9]{64})\.json$/;
const STABLE_BOOTSTRAP_PATH = "./.agents/plugins/bootstrap/muster";
const LEASE = /^(\d+)-([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.json$/;
const sha256 = value => createHash("sha256").update(value).digest("hex");
const slash = value => value.replaceAll("\\", "/");
const transient = error => ["ENOENT", "EACCES", "EPERM", "EBUSY"].includes(error?.code);
const pause = ms => new Promise(done => setTimeout(done, ms));

function contained(base, target) {
  const rel = relative(resolve(base), resolve(target));
  return rel && rel !== ".." && !rel.startsWith("../") && !rel.startsWith("..\\") && !isAbsolute(rel);
}

async function ordinary(path, kind, label) {
  const stat = await lstat(path);
  if (stat.isSymbolicLink() || (kind === "directory" ? !stat.isDirectory() : !stat.isFile())) {
    throw new Error(`${label} must be an ordinary ${kind}: ${path}`);
  }
}

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

async function processStartIdentity(pid = process.pid) {
  if (process.platform !== "linux") return null;
  try {
    const stat = await readFile(`/proc/${pid}/stat`, "utf8"), close = stat.lastIndexOf(")");
    const value = stat.slice(close + 2).trim().split(/\s+/)[19];
    return /^\d+$/.test(value || "") ? `linux-proc-start:${value}` : null;
  } catch { return null; }
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function directory(root, parts, { create = false } = {}) {
  await ordinary(root, "directory", "repository root");
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!contained(root, current)) throw new Error(`repository path escaped its root: ${current}`);
    try { await ordinary(current, "directory", "repository path"); }
    catch (error) {
      if (!create || error.code !== "ENOENT") throw error;
      await mkdir(current);
      await ordinary(current, "directory", "repository path");
    }
  }
  return current;
}

async function regularTree(root, excluded = new Set()) {
  await ordinary(root, "directory", "content root");
  const files = [];
  async function walk(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
    for (const entry of entries) {
      const path = join(dir, entry.name), rel = slash(relative(root, path));
      if (!contained(root, path)) throw new Error(`content escaped its root: ${path}`);
      const stat = await lstat(path);
      if (stat.isSymbolicLink()) throw new Error(`content must not be a symlink: ${path}`);
      if (stat.isDirectory()) await walk(path);
      else if (stat.isFile() && !excluded.has(rel)) {
        const content = await readRegular(path, "release content");
        files.push({ path: rel, sha256: sha256(content), size: content.length });
      } else if (!stat.isFile()) throw new Error(`content must be a regular file: ${path}`);
    }
  }
  await walk(root);
  return files;
}

async function validateBootstrap(root, expectedDigest) {
  await ordinary(join(root, "bootstrap.json"), "file", "bootstrap metadata");
  const metadata = JSON.parse((await readRegular(join(root, "bootstrap.json"), "bootstrap metadata", 1024 * 1024)).toString("utf8"));
  const files = await regularTree(root, new Set(["bootstrap.json"]));
  const digest = sha256(JSON.stringify({ format: FORMAT, files }));
  if (metadata?.format !== FORMAT || metadata.digest !== digest || digest !== expectedDigest
    || JSON.stringify(metadata.files) !== JSON.stringify(files)) throw new Error("Codex bootstrap content hash mismatch");
}

async function validateRelease(root, expectedGeneration) {
  await ordinary(join(root, "release.json"), "file", "release metadata");
  const metadata = JSON.parse((await readRegular(join(root, "release.json"), "release metadata", 4 * 1024 * 1024)).toString("utf8"));
  if (metadata?.format !== FORMAT || metadata.generation !== expectedGeneration || !Array.isArray(metadata.files)) {
    throw new Error("Codex release metadata contract mismatch");
  }
  const files = await regularTree(root, new Set(["release.json"]));
  const generation = sha256(JSON.stringify({ format: FORMAT, packageVersion: metadata.packageVersion, files }));
  if (generation !== expectedGeneration || JSON.stringify(metadata.files) !== JSON.stringify(files)) throw new Error("Codex release content hash mismatch");
  return metadata;
}

async function releaseResult(repoRoot, generation, leaseOptions) {
  return withLeaseRegistryTransaction(repoRoot, async () => {
    if (!GENERATION.test(generation || "")) throw new Error("selected Codex generation is invalid");
    const releaseRoot = await directory(repoRoot, [".agents", "plugins", "releases", generation]);
    const metadata = await validateRelease(releaseRoot, generation);
    const lease = await registerLease(repoRoot, generation, leaseOptions);
    return { repoRoot, generation, releaseRoot, pluginRoot: join(releaseRoot, "plugin"), profilesRoot: join(releaseRoot, "profiles"), metadata, lease };
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
  await directory(repoRoot, [".agents", "plugins"], { create: true });
  return withLeaseLifecycleLock(leaseRegistryLockPath(repoRoot), callback);
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

async function atomicWriteLease(path, content, replaceLease = rename) {
  let temporary, handle;
  try {
    for (let attempt = 0; attempt < 8; attempt++) {
      temporary = `${path}.muster-${process.pid}-${randomUUID()}.tmp`;
      try { handle = await open(temporary, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST" || attempt === 7) throw error; }
    }
    await handle.writeFile(content, "utf8");
    await handle.sync(); await handle.close(); handle = null;
    await ordinary(temporary, "file", "staged Codex generation lease");
    JSON.parse(await readFile(temporary, "utf8"));
    await replaceLease(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    if (temporary) await rm(temporary, { force: true });
  }
}

async function readLifecycleLock(path, maxBytes = 16 * 1024) {
  let handle;
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isFile() || before.size > maxBytes) throw new Error(`unsafe Codex generation lease lock: ${path}`);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`unsafe Codex generation lease lock: ${path}`);
    let record = null;
    try { record = JSON.parse(await handle.readFile("utf8")); } catch { /* a crashed writer is reclaimable after expiry */ }
    return { record, stat };
  } finally { if (handle) await handle.close().catch(() => {}); }
}

const sameInode = (left, right) => left.dev === right.dev && left.ino === right.ino;
const sameLifecycleOwner = (left, right) => typeof left?.token === "string" && left.token.length > 0
  && left.token === right?.token && left.pid === right?.pid
  && left.processIdentity === right?.processIdentity && left.createdAt === right?.createdAt;

async function privateLifecycleRetirement(path) {
  for (let attempt = 0; attempt < 8; attempt++) {
    const dir = join(dirname(path), `.muster-retired-${process.pid}-${randomUUID()}`);
    try { await mkdir(dir, { mode: 0o700 }); }
    catch (error) { if (error.code === "EEXIST" && attempt < 7) continue; throw error; }
    const stat = await lstat(dir);
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error(`unsafe Codex generation lease retirement directory: ${dir}`);
    return { dir, path: join(dir, "lock") };
  }
  throw new Error(`could not create Codex generation lease retirement directory for ${path}`);
}

async function restoreRetiredLifecycleLock(path, retired, stat) {
  const current = await lstat(retired);
  if (!sameInode(current, stat)) return false;
  try { await link(retired, path); }
  catch (error) { if (error.code === "EEXIST") return false; throw error; }
  const restored = await lstat(path);
  if (!sameInode(restored, stat)) throw new Error(`Codex generation lease lock restore changed identity: ${path}`);
  await unlink(retired);
  await rmdir(dirname(retired));
  return true;
}

async function retireOwnedLifecycleLock(path, expectedStat, expectedRecord, { stale = null, restorePath = path } = {}) {
  const retirement = await privateLifecycleRetirement(path);
  try { await rename(path, retirement.path); }
  catch (error) {
    try { await rmdir(retirement.dir); } catch { /* preserve ambiguous retirement */ }
    if (error.code === "ENOENT") return false;
    throw error;
  }
  let retired;
  try { retired = await readLifecycleLock(retirement.path); }
  catch { return false; }
  if (!sameInode(retired.stat, expectedStat) || !sameLifecycleOwner(retired.record, expectedRecord)
    || stale && !await stale(retired)) {
    await restoreRetiredLifecycleLock(restorePath, retirement.path, retired.stat);
    return false;
  }
  await unlink(retirement.path);
  await rmdir(retirement.dir);
  return true;
}

async function lifecycleLockIsStale(current, { staleMs, maxStaleMs }) {
  const age = Date.now() - current.stat.mtimeMs;
  if (age < staleMs) return false;
  const pid = Number(current.record?.pid), alive = processAlive(pid);
  const actualIdentity = alive ? await processStartIdentity(pid) : null;
  const recordedIdentity = typeof current.record?.processIdentity === "string" ? current.record.processIdentity : null;
  if (alive && recordedIdentity && actualIdentity && recordedIdentity === actualIdentity && age < maxStaleMs) return false;
  if (alive && (!recordedIdentity || !actualIdentity) && age < maxStaleMs) return false;
  return true;
}

async function reclaimStaleLeaseLifecycleLock(path, { staleMs, maxStaleMs }) {
  let current;
  try { current = await readLifecycleLock(path); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  if (!sameLifecycleOwner(current.record, current.record) || !await lifecycleLockIsStale(current, { staleMs, maxStaleMs })) return false;
  const quarantine = `${path}.muster-reclaim-${process.pid}-${randomUUID()}`;
  try { await rename(path, quarantine); }
  catch (error) { if (error.code === "ENOENT") return true; throw error; }
  const quarantined = await readLifecycleLock(quarantine);
  if (!sameInode(quarantined.stat, current.stat) || !sameLifecycleOwner(quarantined.record, current.record)
    || !await lifecycleLockIsStale(quarantined, { staleMs, maxStaleMs })) {
    const retirement = await privateLifecycleRetirement(quarantine);
    try { await rename(quarantine, retirement.path); }
    catch (error) { if (error.code === "ENOENT") return false; throw error; }
    await restoreRetiredLifecycleLock(path, retirement.path, quarantined.stat);
    return false;
  }
  return retireOwnedLifecycleLock(quarantine, quarantined.stat, quarantined.record, {
    stale: state => lifecycleLockIsStale(state, { staleMs, maxStaleMs }),
    restorePath: path
  });
}

async function withLeaseLifecycleLock(path, callback, { staleMs = 60_000, maxStaleMs = 15 * 60_000, timeoutMs = 30_000 } = {}) {
  const token = randomUUID(), processIdentity = await processStartIdentity(), started = Date.now();
  let handle;
  for (;;) {
    try {
      handle = await open(path, "wx", 0o600);
      await handle.writeFile(JSON.stringify({ format: FORMAT, pid: process.pid, processIdentity, createdAt: Date.now(), token }) + "\n", "utf8");
      await handle.sync(); await handle.close(); handle = null;
      break;
    } catch (error) {
      if (handle) { await handle.close().catch(() => {}); handle = null; }
      if (error.code !== "EEXIST") throw error;
      if (await reclaimStaleLeaseLifecycleLock(path, { staleMs, maxStaleMs })) continue;
      if (Date.now() - started >= timeoutMs) throw new Error(`timed out waiting for Codex generation lease lock: ${path}`);
      await pause(Math.min(25, 5 + Math.floor((Date.now() - started) / 100)));
    }
  }
  const heartbeat = setInterval(async () => {
    try {
      const current = await readLifecycleLock(path);
      if (current.record?.token === token) await utimes(path, new Date(), new Date());
    } catch { /* release/recovery owns the diagnostic */ }
  }, Math.max(1_000, Math.floor(staleMs / 3)));
  heartbeat.unref();
  try { return await callback(); }
  finally {
    clearInterval(heartbeat);
    try {
      const current = await readLifecycleLock(path);
      if (current.record?.token !== token) return;
      if (!await retireOwnedLifecycleLock(path, current.stat, current.record)) throw new Error(`Codex generation lease lock ownership changed: ${path}`);
    } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
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

async function renewLease(path, token, record, replaceLease = rename, lifecycleLock = undefined) {
  return withLeaseLifecycleLock(leaseLockPath(path), async () => {
    const initial = await leaseIdentity(path, token);
    await atomicWriteLease(path, JSON.stringify(record, null, 2) + "\n", async (temporary, destination) => {
      const current = await leaseIdentity(path, token);
      if (!sameLeaseIdentity(initial, current)) throw new Error(`Codex generation lease changed during renewal: ${path}`);
      await replaceLease(temporary, destination);
    });
  }, lifecycleLock);
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

async function removeLease(path, token, beforeLeaseCleanup, lifecycleLock = undefined) {
  try { return await withLeaseLifecycleLock(leaseLockPath(path), async () => {
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
  }, lifecycleLock); }
  catch (error) { if (["ENOENT", "ENOTDIR"].includes(error?.code)) return false; throw error; }
}

async function registerLease(repoRoot, generation, leaseOptions = {}) {
  const key = `${resolve(repoRoot)}\0${generation}`;
  if (leaseControllers.has(key)) return leaseControllers.get(key);
  const creating = createLease(repoRoot, generation, leaseOptions, key);
  leaseControllers.set(key, creating);
  try {
    const controller = await creating;
    if (leaseControllers.get(key) === creating) leaseControllers.set(key, controller);
    return controller;
  } catch (error) { if (leaseControllers.get(key) === creating) leaseControllers.delete(key); throw error; }
}

async function createLease(repoRoot, generation, leaseOptions, key) {
  const root = await directory(repoRoot, [".agents", "plugins", "leases", generation], { create: true });
  const token = randomUUID(), path = join(root, `${process.pid}-${token}.json`), now = leaseOptions.now || Date.now;
  const setIntervalFn = leaseOptions.setInterval || setInterval;
  const clearIntervalFn = leaseOptions.clearInterval || clearInterval;
  const addExitListener = leaseOptions.addExitListener || defaultAddExitListener;
  const removeExitListener = leaseOptions.removeExitListener || defaultRemoveExitListener;
  const replaceLease = leaseOptions.replaceLease || rename;
  const beforeLeaseCleanup = leaseOptions.beforeLeaseCleanup;
  const lifecycleLock = leaseOptions.lifecycleLock;
  const processNamespace = typeof leaseOptions.processNamespace === "string" && leaseOptions.processNamespace
    ? leaseOptions.processNamespace
    : localProcessNamespace();
  const base = { format: FORMAT, pid: process.pid, processIdentity: await processStartIdentity(), processNamespace, processStartedAt: Math.floor(Date.now() - process.uptime() * 1000), generation, token };
  const record = () => ({ ...base, touchedAt: now() });
  await atomicWriteLease(path, JSON.stringify(record(), null, 2) + "\n");
  let closed = false, renewal = Promise.resolve();
  const renew = () => {
    if (closed) return renewal;
    renewal = renewal.catch(() => {}).then(() => renewLease(path, token, record(), replaceLease, lifecycleLock)).catch(error => {
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
      await removeLease(path, token, beforeLeaseCleanup, lifecycleLock);
    }
  };
  return controller;
}

export async function resolveCodexRelease(repoRoot, { retries = 4, lease } = {}) {
  await directory(repoRoot, [".agents", "plugins"]);
  let pointer;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const path = join(repoRoot, ".agents", "plugins", "marketplace.json");
      await ordinary(path, "file", "marketplace");
      pointer = JSON.parse((await readRegular(path, "marketplace", 1024 * 1024)).toString("utf8"));
      break;
    } catch (error) {
      if (!transient(error) || attempt === retries - 1) throw error;
      await pause(5 * (attempt + 1));
    }
  }
  const contract = pointer?.musterBootstrap;
  const pluginPath = pointer?.plugins?.find(item => item?.name === "muster")?.source?.path;
  if (pointer?.name !== "muster" || pluginPath !== STABLE_BOOTSTRAP_PATH || contract?.format !== FORMAT
    || !GENERATION.test(contract?.digest || "") || !GENERATION.test(contract?.initialGeneration || "")) {
    throw new Error("Codex marketplace is missing a valid immutable bootstrap contract");
  }
  const bootstrapRoot = await directory(repoRoot, [".agents", "plugins", "bootstrap", "muster"]);
  await validateBootstrap(bootstrapRoot, contract.digest);
  let names = [];
  for (let attempt = 0; attempt < retries; attempt++) {
    try { names = await readdir(join(repoRoot, ".agents", "plugins", "selections")); break; }
    catch (error) {
      if (!transient(error) || attempt === retries - 1) break;
      await pause(5 * (attempt + 1));
    }
  }
  for (const name of names.filter(item => SELECTION.test(item)).sort().reverse()) {
    try {
      const match = name.match(SELECTION);
      const recordPath = join(repoRoot, ".agents", "plugins", "selections", name);
      await ordinary(recordPath, "file", "selection record");
      const record = JSON.parse((await readRegular(recordPath, "selection record", 64 * 1024)).toString("utf8"));
      if (record?.format !== FORMAT || record.sequence !== Number(match[1]) || record.generation !== match[2]
        || record.bootstrapDigest !== contract.digest) continue;
      return await releaseResult(repoRoot, record.generation, lease);
    } catch { /* use the next complete immutable selection */ }
  }
  return releaseResult(repoRoot, contract.initialGeneration, lease);
}

export async function readSelectedAsset(selected, relativePath, maxBytes = 32 * 1024 * 1024) {
  const normalized = slash(relativePath || "");
  if (!normalized || normalized.startsWith("/") || normalized.split("/").includes("..")) throw new Error(`invalid selected asset path: ${JSON.stringify(relativePath)}`);
  const path = join(selected.releaseRoot, ...normalized.split("/"));
  if (!contained(selected.releaseRoot, path)) throw new Error("selected asset escaped its release");
  const expected = selected.metadata.files.find(file => file.path === normalized);
  if (!expected) throw new Error(`selected asset is not in release metadata: ${normalized}`);
  const content = await readRegular(path, "selected release asset", maxBytes);
  if (content.length !== expected.size || sha256(content) !== expected.sha256) throw new Error(`selected asset changed after release validation: ${normalized}`);
  return content;
}

export async function materializeSelectedRuntime(selected, name) {
  if (!/^(?:muster|muster-mcp)\.mjs$/.test(name || "")) throw new Error(`invalid selected runtime: ${JSON.stringify(name)}`);
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-runtime-"));
  const releaseRoot = join(dir, ".agents", "plugins", "releases", selected.generation);
  const writeSnapshot = async (path, content) => {
    await mkdir(dirname(path), { recursive: true, mode: 0o700 });
    let handle;
    try { handle = await open(path, "wx", 0o600); await handle.writeFile(content); await handle.sync(); }
    finally { if (handle) await handle.close().catch(() => {}); }
  };
  try {
    for (const file of selected.metadata.files) {
      if (!file.path.startsWith("plugin/")) continue;
      await writeSnapshot(join(releaseRoot, ...file.path.split("/")), await readSelectedAsset(selected, file.path));
    }
    await writeSnapshot(join(releaseRoot, "release.json"), Buffer.from(JSON.stringify(selected.metadata, null, 2) + "\n"));
    await writeSnapshot(join(dir, ".agents", "plugins", "marketplace.json"), await readRegular(join(selected.repoRoot, ".agents", "plugins", "marketplace.json"), "marketplace", 1024 * 1024));
    return { dir, path: join(releaseRoot, "plugin", "runtime", name) };
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
}

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(ownPath)) {
  const pluginRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const selected = await resolveCodexRelease(resolve(pluginRoot, "../../../.."));
  const [kind = "plugin", name = ""] = process.argv.slice(2);
  if (["skill", "command"].includes(kind) && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid bootstrap ${kind} id: ${JSON.stringify(name)}`);
  }
  const assets = {
    skill: `plugin/skills/${name}/SKILL.md`,
    command: `plugin/commands/${name}.md`,
    adapter: "plugin/runtime/codex-skill-adapter.md",
    sprint: "plugin/runtime/sprint-protocol.md"
  };
  if (kind === "plugin") process.stdout.write(`${selected.pluginRoot}\n`);
  else {
    if (!assets[kind]) throw new Error(`unknown bootstrap resolution kind: ${kind}`);
    process.stdout.write(await readSelectedAsset(selected, assets[kind]));
  }
}
