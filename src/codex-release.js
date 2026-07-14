import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, win32 } from "node:path";

const RELEASE_FORMAT = 1;
const GENERATION = /^[a-f0-9]{64}$/;
const slash = value => value.replaceAll("\\", "/");
const sha256 = value => createHash("sha256").update(value).digest("hex");

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

function pointerRelative(value, label) {
  if (typeof value !== "string" || !value.startsWith("./") || value.includes("\\") || win32.isAbsolute(value)) {
    throw new Error(`${label} must be a forward-slash relative release pointer`);
  }
  const parts = value.slice(2).split("/");
  if (!parts.length || parts.some(part => !part || part === "." || part === "..")) throw new Error(`${label} is not a contained release pointer`);
  return parts;
}

async function readPointer(repoRoot) {
  const path = join(repoRoot, ".agents", "plugins", "marketplace.json");
  await ordinary(path, "file", "Codex marketplace pointer");
  let pointer;
  try { pointer = JSON.parse(await readFile(path, "utf8")); }
  catch (error) { throw new Error("Codex marketplace pointer is invalid JSON", { cause: error }); }
  return { path, pointer };
}

export async function resolveCodexRelease(repoRoot) {
  const { pointer } = await readPointer(repoRoot);
  const selected = pointer?.musterRelease;
  const pluginPath = pointer?.plugins?.find(plugin => plugin?.name === "muster")?.source?.path;
  if (selected?.format !== RELEASE_FORMAT || !GENERATION.test(selected?.generation || "")) throw new Error("Codex marketplace is missing a valid Muster release pointer");
  const base = `.agents/plugins/releases/${selected.generation}`;
  const expected = {
    plugin: `./${base}/plugin`, profiles: `./${base}/profiles`, metadata: `./${base}/release.json`
  };
  for (const [label, value] of Object.entries({ plugin: pluginPath, profiles: selected.profiles, metadata: selected.metadata })) {
    pointerRelative(value, `${label} path`);
    if (value !== expected[label]) throw new Error(`${label} path does not match the selected release pointer`);
  }
  const releaseRoot = join(repoRoot, ...base.split("/"));
  contained(repoRoot, releaseRoot, "selected release");
  const metadata = await validateCodexRelease(releaseRoot, selected.generation);
  return {
    generation: selected.generation,
    releaseRoot,
    pluginRoot: join(releaseRoot, "plugin"),
    profilesRoot: join(releaseRoot, "profiles"),
    metadata
  };
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

export async function publishCodexRelease({ repoRoot, stagedRelease, packageVersion, marketplaceTemplate, replacePointer = rename }) {
  const metadata = await createCodexReleaseMetadata(stagedRelease, packageVersion);
  await writeFile(join(stagedRelease, "release.json"), JSON.stringify(metadata, null, 2) + "\n", { flag: "wx" });
  const releasesRoot = join(repoRoot, ".agents", "plugins", "releases");
  await mkdir(releasesRoot, { recursive: true });
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
    pointerPath = join(repoRoot, ".agents", "plugins", "marketplace.json");
    previous = structuredClone(marketplaceTemplate);
  }
  if (previous?.name !== "muster" || !Array.isArray(previous.plugins) || !previous.plugins.some(plugin => plugin?.name === "muster")) {
    throw new Error("Codex marketplace pointer does not describe the Muster plugin");
  }
  const base = `.agents/plugins/releases/${metadata.generation}`;
  const pointer = structuredClone(previous);
  const plugin = pointer.plugins.find(item => item.name === "muster");
  plugin.source = { ...plugin.source, source: "local", path: `./${base}/plugin` };
  pointer.musterRelease = {
    format: RELEASE_FORMAT,
    generation: metadata.generation,
    profiles: `./${base}/profiles`,
    metadata: `./${base}/release.json`
  };
  const content = JSON.stringify(pointer, null, 2) + "\n";
  let current = null;
  try { current = await readFile(pointerPath, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (current !== content) await atomicWritePointer(pointerPath, content, replacePointer);
  return { generation: metadata.generation, releaseRoot, pluginRoot: join(releaseRoot, "plugin"), profilesRoot: join(releaseRoot, "profiles") };
}
