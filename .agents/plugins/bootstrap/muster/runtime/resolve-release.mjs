#!/usr/bin/env node

// This resolver is intentionally self-contained. Codex may copy only the
// marketplace plugin into its cache, where checkout-relative src/ imports and
// package node_modules do not exist.
import { createHash } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir, rename, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const FORMAT = 1;
const GENERATION = /^[a-f0-9]{64}$/;
const SELECTION = /^(\d{12})-([a-f0-9]{64})\.json$/;
const STABLE_BOOTSTRAP_PATH = "./.agents/plugins/bootstrap/muster";
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
        const content = await readFile(path);
        files.push({ path: rel, sha256: sha256(content), size: content.length });
      } else if (!stat.isFile()) throw new Error(`content must be a regular file: ${path}`);
    }
  }
  await walk(root);
  return files;
}

async function validateBootstrap(root, expectedDigest) {
  await ordinary(join(root, "bootstrap.json"), "file", "bootstrap metadata");
  const metadata = JSON.parse(await readFile(join(root, "bootstrap.json"), "utf8"));
  const files = await regularTree(root, new Set(["bootstrap.json"]));
  const digest = sha256(JSON.stringify({ format: FORMAT, files }));
  if (metadata?.format !== FORMAT || metadata.digest !== digest || digest !== expectedDigest
    || JSON.stringify(metadata.files) !== JSON.stringify(files)) throw new Error("Codex bootstrap content hash mismatch");
}

async function validateRelease(root, expectedGeneration) {
  await ordinary(join(root, "release.json"), "file", "release metadata");
  const metadata = JSON.parse(await readFile(join(root, "release.json"), "utf8"));
  if (metadata?.format !== FORMAT || metadata.generation !== expectedGeneration || !Array.isArray(metadata.files)) {
    throw new Error("Codex release metadata contract mismatch");
  }
  const files = await regularTree(root, new Set(["release.json"]));
  const generation = sha256(JSON.stringify({ format: FORMAT, packageVersion: metadata.packageVersion, files }));
  if (generation !== expectedGeneration || JSON.stringify(metadata.files) !== JSON.stringify(files)) throw new Error("Codex release content hash mismatch");
  return metadata;
}

async function releaseResult(repoRoot, generation) {
  if (!GENERATION.test(generation || "")) throw new Error("selected Codex generation is invalid");
  const releaseRoot = await directory(repoRoot, [".agents", "plugins", "releases", generation]);
  const metadata = await validateRelease(releaseRoot, generation);
  await registerLease(repoRoot, generation);
  return { generation, releaseRoot, pluginRoot: join(releaseRoot, "plugin"), profilesRoot: join(releaseRoot, "profiles"), metadata };
}

async function registerLease(repoRoot, generation) {
  const root = await directory(repoRoot, [".agents", "plugins", "leases", generation], { create: true });
  const path = join(root, `${process.pid}.json`), temporary = join(root, `.${process.pid}-${Date.now()}.tmp`);
  const record = { format: FORMAT, pid: process.pid, processStartedAt: Math.floor(Date.now() - process.uptime() * 1000), touchedAt: Date.now(), generation };
  let handle;
  try {
    handle = await open(temporary, "wx", 0o600);
    await handle.writeFile(JSON.stringify(record, null, 2) + "\n", "utf8");
    await handle.sync(); await handle.close(); handle = null;
    await rename(temporary, path);
  } finally {
    if (handle) await handle.close().catch(() => {});
    await rm(temporary, { force: true });
  }
}

export async function resolveCodexRelease(repoRoot, { retries = 4 } = {}) {
  await directory(repoRoot, [".agents", "plugins"]);
  let pointer;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const path = join(repoRoot, ".agents", "plugins", "marketplace.json");
      await ordinary(path, "file", "marketplace");
      pointer = JSON.parse(await readFile(path, "utf8"));
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
      const record = JSON.parse(await readFile(recordPath, "utf8"));
      if (record?.format !== FORMAT || record.sequence !== Number(match[1]) || record.generation !== match[2]
        || record.bootstrapDigest !== contract.digest) continue;
      return await releaseResult(repoRoot, record.generation);
    } catch { /* use the next complete immutable selection */ }
  }
  return releaseResult(repoRoot, contract.initialGeneration);
}

const ownPath = fileURLToPath(import.meta.url);
if (process.argv[1] && resolve(process.argv[1]) === resolve(ownPath)) {
  const pluginRoot = resolve(fileURLToPath(new URL("../", import.meta.url)));
  const selected = await resolveCodexRelease(resolve(pluginRoot, "../../../.."));
  const [kind = "plugin", name = ""] = process.argv.slice(2);
  if (["skill", "command"].includes(kind) && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
    throw new Error(`invalid bootstrap ${kind} id: ${JSON.stringify(name)}`);
  }
  const paths = {
    plugin: selected.pluginRoot,
    skill: join(selected.pluginRoot, "skills", name, "SKILL.md"),
    command: join(selected.pluginRoot, "commands", `${name}.md`),
    adapter: join(selected.pluginRoot, "runtime", "codex-skill-adapter.md"),
    sprint: join(selected.pluginRoot, "runtime", "sprint-protocol.md")
  };
  if (!paths[kind]) throw new Error(`unknown bootstrap resolution kind: ${kind}`);
  if (kind !== "plugin" && !contained(selected.pluginRoot, paths[kind])) throw new Error("bootstrap resolution escaped the selected plugin");
  await ordinary(paths[kind], kind === "plugin" ? "directory" : "file", `bootstrap ${kind}`);
  process.stdout.write(`${paths[kind]}\n`);
}
