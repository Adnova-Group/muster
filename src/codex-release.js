import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants, renameSync } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { withCodexFileLock } from "./codex-lock.js";

const RELEASE_FORMAT = 1;
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
  try { metadata = await readRegularJson(join(releaseRoot, "release.json"), "release metadata", 4 * 1024 * 1024); }
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

// Dropped: this publisher's generation-lease subsystem (per-reader heartbeat
// lease files under .agents/plugins/leases/<generation>/, a lease-registry
// transaction lock, foreign-namespace/legacy-lease reconciliation, and
// process-exit cleanup pools) that used to CREATE, RENEW, and RETIRE leases.
// That writer-side machinery is gone from this file and from the hook; it is
// not coming back here. codex/bootstrap/resolve-release.mjs (a separate,
// still-owned artifact; see codex-cache-package.test.js) is the only
// remaining lease writer, registering/renewing a lease file while it holds a
// generation open for point-of-use asset revalidation. Pruning below stays
// lease-RESPECTING but read-only: it retains a generation whose lease
// directory has any file touched within LEASE_FRESH_MS, on top of the
// bounded "current + previous" window (the `prior` generation kept in
// publishCodexRelease below). A lease older than LEASE_FRESH_MS is treated
// as abandoned/crashed debris and does not protect its generation, so
// pre-teardown debris still gets swept on the next publish.
async function releaseResult(repoRoot, generation) {
  if (!GENERATION.test(generation || "")) throw new Error("selected Codex generation is invalid");
  const releaseRoot = await repositoryDirectory(repoRoot, [".agents", "plugins", "releases", generation]);
  const metadata = await validateCodexRelease(releaseRoot, generation);
  return { generation, releaseRoot, pluginRoot: join(releaseRoot, "plugin"), profilesRoot: join(releaseRoot, "profiles"), metadata };
}

const LEASE_FRESH_MS = 5 * 60 * 1000;

async function freshlyLeasedGenerations(repoRoot, now = Date.now()) {
  let generations;
  try { generations = await readdir(join(repoRoot, ".agents", "plugins", "leases")); }
  catch (error) { if (error.code === "ENOENT") return new Set(); throw error; }
  const fresh = new Set();
  for (const generation of generations) {
    if (!GENERATION.test(generation)) continue;
    const dir = join(repoRoot, ".agents", "plugins", "leases", generation);
    let files;
    try { files = await readdir(dir); } catch { continue; }
    for (const file of files) {
      try {
        const stat = await lstat(join(dir, file));
        if (stat.isFile() && !stat.isSymbolicLink() && now - stat.mtimeMs <= LEASE_FRESH_MS) { fresh.add(generation); break; }
      } catch { /* a transient reader/writer race is not authoritative for this file */ }
    }
  }
  return fresh;
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
    if (generation) return releaseResult(repoRoot, generation);
  }
  return releaseResult(repoRoot, bootstrap.initialGeneration);
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

export async function publishCodexRelease({ repoRoot, stagedRelease, packageVersion, marketplaceTemplate, bootstrapDigest = "b".repeat(64), replacePointer = rename, allowBootstrapMigration = false, deferFinalPointer = false }) {
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
  const prior = ordered.find(generation => generation !== metadata.generation && generation !== stable.musterBootstrap.initialGeneration);
  // Retention is a bounded "current + previous" generation window (plus the
  // stable bootstrap, whatever the marketplace pointer still advertises, and
  // any generation with a fresh reader lease; see the removal-rationale
  // comment above releaseResult()).
  const freshlyLeased = await freshlyLeasedGenerations(repoRoot);
  const keep = new Set([metadata.generation, stable.musterBootstrap.initialGeneration, advertisedGeneration, prior, ...freshlyLeased].filter(Boolean));
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
  plugin.source = { ...plugin.source, source: "local", path: `./.agents/plugins/releases/${metadata.generation}/plugin` };
  const pointerContent = JSON.stringify(stable, null, 2) + "\n";
  const pendingPointer = deferFinalPointer ? await stageExitPointer(pointerPath, pointerContent) : null;
  if (!pendingPointer) await atomicWritePointer(pointerPath, pointerContent, replacePointer);
  return {
    generation: metadata.generation,
    releaseRoot,
    pluginRoot: join(releaseRoot, "plugin"),
    profilesRoot: join(releaseRoot, "profiles"),
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
      // Sweep this generation's lease directory too, so an abandoned/crashed
      // reader lease does not accumulate as debris once its generation is gone.
      await rm(join(repoRoot, ".agents", "plugins", "leases", generation), { recursive: true, force: true });
    }
  }
}

async function regularFileExists(path) {
  try { await ordinary(path, "file", "Codex marketplace pointer"); return true; }
  catch (error) { if (error.cause?.code === "ENOENT") return false; throw error; }
}
