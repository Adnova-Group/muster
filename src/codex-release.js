import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";

const RELEASE_FORMAT = 1;
const GENERATION = /^[a-f0-9]{64}$/;
const slash = value => value.replaceAll("\\", "/");
const sha256 = value => createHash("sha256").update(value).digest("hex");

async function readRegularJson(path, label, maxBytes = 64 * 1024) {
  let handle;
  try {
    await ordinary(path, "file", label);
    handle = await open(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${label} must be a bounded regular file: ${path}`);
    return JSON.parse(await handle.readFile("utf8"));
  } finally { if (handle) await handle.close().catch(() => {}); }
}

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
        const content = await readFile(path);
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
  const metadata = JSON.parse(await readFile(join(bootstrapRoot, "bootstrap.json"), "utf8"));
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

function metadataFor(packageVersion, files) {
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("release package version is required");
  const payload = { format: RELEASE_FORMAT, packageVersion, files };
  return { ...payload, generation: sha256(JSON.stringify(payload)) };
}

export async function createCodexReleaseMetadata(releaseRoot, packageVersion) {
  const tree = await assertRegularTree(releaseRoot);
  if (!tree.dirs.includes("plugin") || !tree.dirs.includes("profiles")) throw new Error("release must contain plugin and profiles directories");
  const files = tree.files.filter(file => file.path !== "release.json");
  if (!files.some(file => file.path.startsWith("plugin/")) || !files.some(file => file.path.startsWith("profiles/"))) {
    throw new Error("release plugin and profiles must both contain regular files");
  }
  return metadataFor(packageVersion, files);
}

export async function validateCodexRelease(releaseRoot, expectedGeneration) {
  await ordinary(join(releaseRoot, "release.json"), "file", "release metadata");
  let metadata;
  try { metadata = JSON.parse(await readFile(join(releaseRoot, "release.json"), "utf8")); }
  catch (error) { throw new Error(`release metadata is invalid: ${releaseRoot}`, { cause: error }); }
  if (metadata?.format !== RELEASE_FORMAT || !GENERATION.test(metadata.generation || "") || !Array.isArray(metadata.files)) {
    throw new Error(`release metadata has an invalid contract: ${releaseRoot}`);
  }
  if (expectedGeneration && metadata.generation !== expectedGeneration) throw new Error("release generation does not match the selected pointer");
  if (releaseRoot.split(/[\\/]/).at(-1) !== metadata.generation) throw new Error("release directory is not content-addressed by its generation");
  const actual = await createCodexReleaseMetadata(releaseRoot, metadata.packageVersion);
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
  try { pointer = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error("Codex marketplace pointer is invalid JSON", { cause: error }); }
  return { path, pointer };
}

export async function resolveCodexRelease(repoRoot) {
  return resolveCodexReleaseWithOptions(repoRoot);
}

const STABLE_BOOTSTRAP_PATH = "./.agents/plugins/bootstrap/muster";
const SELECTION = /^(\d{12})-([a-f0-9]{64})\.json$/;

async function releaseResult(repoRoot, generation) {
  if (!GENERATION.test(generation || "")) throw new Error("selected Codex generation is invalid");
  const releaseRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "releases", generation]);
  const metadata = await validateCodexRelease(releaseRoot, generation);
  await registerGenerationLease(repoRoot, generation);
  return { generation, releaseRoot, pluginRoot: join(releaseRoot, "plugin"), profilesRoot: join(releaseRoot, "profiles"), metadata };
}

async function registerGenerationLease(repoRoot, generation) {
  const root = await repositoryDirectory(repoRoot, [".agents", "plugins", "leases", generation], { create: true });
  const record = { format: RELEASE_FORMAT, pid: process.pid, processStartedAt: Math.floor(Date.now() - process.uptime() * 1000), touchedAt: Date.now(), generation };
  await atomicWritePointer(join(root, `${process.pid}.json`), JSON.stringify(record, null, 2) + "\n", rename);
}

function processAlive(pid) {
  if (!Number.isInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code === "EPERM"; }
}

async function activeLeaseGenerations(repoRoot) {
  const leasesRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "leases"], { create: true });
  const active = new Set();
  for (const generation of await readdir(leasesRoot)) {
    if (!GENERATION.test(generation)) throw new Error(`invalid Codex generation lease directory: ${generation}`);
    const dir = await repositoryDirectory(repoRoot, [".agents", "plugins", "leases", generation]);
    for (const name of await readdir(dir)) {
      const path = join(dir, name);
      let record;
      try { record = await readRegularJson(path, "Codex generation lease"); }
      catch { await rm(path, { force: true }); continue; }
      const coherent = record?.format === RELEASE_FORMAT && record.generation === generation && /^\d+\.json$/.test(name)
        && record.pid === Number(name.slice(0, -5)) && Number.isFinite(record.processStartedAt) && Number.isFinite(record.touchedAt);
      if (coherent && processAlive(record.pid)) active.add(generation);
      else await rm(path, { force: true });
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

export async function resolveCodexReleaseWithOptions(repoRoot, { retries = 4, readSelections } = {}) {
  let pointerError;
  let pointer;
  for (let attempt = 0; attempt < retries; attempt++) {
    try { ({ pointer } = await readPointer(repoRoot)); pointerError = null; break; }
    catch (error) { pointerError = error; if (!transient(error.cause || error)) throw error; await pause(5 * (attempt + 1)); }
  }
  if (pointerError) throw pointerError;
  const bootstrap = pointer?.musterBootstrap;
  const pluginPath = pointer?.plugins?.find(plugin => plugin?.name === "muster")?.source?.path;
  if (pointer?.name !== "muster" || pluginPath !== STABLE_BOOTSTRAP_PATH || bootstrap?.format !== RELEASE_FORMAT
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
  for (const name of candidates) {
    try {
      const record = await readRegularJson(join(repoRoot, ".agents", "plugins", "selections", name), "Codex selection record");
      if (!validSelection(record, name, bootstrap.digest)) continue;
      return await releaseResult(repoRoot, record.generation);
    } catch { /* corrupt/incomplete newest selections fall back to an older complete generation */ }
  }
  return releaseResult(repoRoot, bootstrap.initialGeneration);
}

async function atomicWritePointer(path, content, replacePointer) {
  const temporary = `${path}.muster-${process.pid}-${Date.now()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(content, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await ordinary(temporary, "file", "staged marketplace pointer");
    JSON.parse(await readFile(temporary, "utf8"));
    await replacePointer(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

export async function publishCodexRelease({ repoRoot, stagedRelease, packageVersion, marketplaceTemplate, bootstrapDigest = "b".repeat(64), replacePointer = rename, allowBootstrapMigration = false }) {
  const metadata = await createCodexReleaseMetadata(stagedRelease, packageVersion);
  await writeFile(join(stagedRelease, "release.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
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
  const alreadyStable = plugin.source?.path === STABLE_BOOTSTRAP_PATH && stable.musterBootstrap?.format === RELEASE_FORMAT;
  if (!alreadyStable) {
    if (!allowBootstrapMigration && await regularFileExists(pointerPath)) {
      throw new Error("Codex bootstrap maintenance required: stop Codex/Desktop, then run MUSTER_CODEX_BOOTSTRAP_MAINTENANCE=1 npm run build:codex");
    }
    plugin.source = { ...plugin.source, source: "local", path: STABLE_BOOTSTRAP_PATH };
    delete stable.musterRelease;
    stable.musterBootstrap = { format: RELEASE_FORMAT, digest: bootstrapDigest, initialGeneration: metadata.generation };
    await atomicWritePointer(pointerPath, JSON.stringify(stable, null, 2) + "\n", rename);
  } else if (stable.musterBootstrap.digest !== bootstrapDigest) {
    if (!allowBootstrapMigration) throw new Error("Codex bootstrap surface drift detected; explicit offline bootstrap maintenance and restart are required");
    stable.musterBootstrap = { format: RELEASE_FORMAT, digest: bootstrapDigest, initialGeneration: metadata.generation };
    await atomicWritePointer(pointerPath, JSON.stringify(stable, null, 2) + "\n", rename);
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
  const prior = ordered.find(generation => generation !== metadata.generation && generation !== stable.musterBootstrap.initialGeneration);
  const activeLeases = await activeLeaseGenerations(repoRoot);
  const keep = new Set([metadata.generation, stable.musterBootstrap.initialGeneration, prior, ...activeLeases].filter(Boolean));
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
  return { generation: metadata.generation, releaseRoot, pluginRoot: join(releaseRoot, "plugin"), profilesRoot: join(releaseRoot, "profiles"), selectionName };
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
