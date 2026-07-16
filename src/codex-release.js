import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants as fsConstants, cpSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { withCodexFileLock } from "./codex-lock.js";
import { CODEX_MODEL_POLICY } from "./codex.js";

// Wave 2 teardown: the Codex plugin used to be published as a committed,
// content-addressed generation (release.json + releases/<sha256>/, an
// append-only selection log, per-reader leases, and an immutable "bootstrap"
// fallback tree) because the payload was committed to git and read
// concurrently by other checkouts/sessions mid-`git pull`. Nothing under
// .agents/ is committed anymore — generation now happens at build/install
// time into a gitignored staging directory or the user's CODEX_HOME, and is
// consumed by the same process that produced it. That removes the
// multi-reader-of-a-shared-git-tree hazard the old machinery defended
// against, so the generation-hash addressing, selection log, lease
// bookkeeping, and bootstrap indirection are deleted rather than ported.
//
// Deliberately synchronous fs throughout this module (see scripts/build-codex.mjs's
// top comment for why: a confirmed WSL2 drvfs rename pathology on hot-written
// trees, worked around by staging on native tmpfs and never renaming a
// generated tree across that mount). This is a build/install-time-only code
// path (never a request-serving hot path), so the brief event-loop block per
// sync call is an acceptable trade for correctness.

function ordinary(path, expected, label) {
  let stat;
  try { stat = lstatSync(path); }
  catch (error) { throw new Error(`${label} is missing: ${path}`, { cause: error }); }
  if (stat.isSymbolicLink()) throw new Error(`${label} must not be a symlink: ${path}`);
  if (expected === "directory" ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${label} must be a regular ${expected}: ${path}`);
  }
  return stat;
}

function ensureOrdinaryDirectory(path, label) {
  try { ordinary(path, "directory", label); return; }
  catch (error) { if (error.cause?.code !== "ENOENT") throw error; }
  mkdirSync(path, { recursive: true });
  ordinary(path, "directory", label);
}

// Kept only for same-device renames of small single files (atomicWritePointer
// below) where cross-device copy doesn't apply and no hot-written-tree burst
// precedes the rename. The plugin tree itself is no longer renamed into place
// at all — see publishCodexPlugin's docblock — so this is not used for that
// anymore. A/B testing (sandboxed and unsandboxed) confirmed the drvfs
// pathology is real and independent of any external process; strace-level
// syscall slowdown passes, but even a 50-second bounded backoff on the same
// rename does not reliably clear it for a large directory, so this retry is
// deliberately not relied on for that case anymore either.
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function renameWithRetry(source, destination, { retries = 4, delayMs = 250 } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { renameSync(source, destination); return; }
    catch (error) {
      if (error.code !== "ENOENT" || attempt >= retries) throw error;
      sleepSync(delayMs * 2 ** attempt);
    }
  }
}

function contained(base, target, label) {
  const rel = relative(resolve(base), resolve(target));
  if (!rel || rel === ".") return;
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`)) {
    throw new Error(`${label} is not contained by ${base}: ${target}`);
  }
}

function readRegular(path, label, maxBytes = 32 * 1024 * 1024) {
  ordinary(path, "file", label);
  const fd = openSync(path, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW || 0));
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error(`${label} must be a bounded regular file: ${path}`);
    return readFileSync(fd);
  } finally { closeSync(fd); }
}
const readRegularJson = (path, label, maxBytes = 64 * 1024) => JSON.parse(readRegular(path, label, maxBytes).toString("utf8"));
const sha256 = value => createHash("sha256").update(value).digest("hex");

// Walks a tree, rejecting any symlink or special file, and returns every
// regular file's path/size/digest (still needed by the packaged plugin's
// point-of-use internal-asset integrity check, which is orthogonal to the
// deleted generation-hash/release-addressing system) plus its directories.
//
// This used to also fsync every visited file/directory, on the theory that
// writes weren't durable before the immediately following publish rename.
// The confirmed root cause (see renameWithRetry above) is a drvfs
// rename-after-write-burst race at the rename call site itself, not a
// durability gap here, so the extra fsync pass — real cost on every build,
// on every filesystem — was removed. The rename call site is where this is
// actually handled now.
export async function assertRegularTree(root) {
  let rootStat;
  try { rootStat = lstatSync(root); }
  catch (error) { throw new Error(`tree root is missing: ${root}`, { cause: error }); }
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) throw new Error(`tree root must be a regular directory: ${root}`);
  const files = [], dirs = [];
  function walk(dir) {
    const entries = readdirSync(dir).sort();
    for (const name of entries) {
      const path = join(dir, name);
      contained(root, path, "tree entry");
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error(`tree entry must not be a symlink: ${path}`);
      const rel = relative(root, path).replaceAll("\\", "/");
      if (stat.isDirectory()) {
        dirs.push(rel);
        walk(path);
      } else if (stat.isFile()) {
        const content = readFileSync(path);
        files.push({ path: rel, sha256: sha256(content), size: content.length });
      } else throw new Error(`tree entry must be a regular file or directory: ${path}`);
    }
  }
  walk(root);
  return { dirs, files };
}

export async function assertRegularFile(path) {
  ordinary(path, "file", "source file");
  return path;
}

// Pure, dependency-free profile generation: the project/user-scope `.codex/agents/`
// materialization (codex-install.js) needs only this — no esbuild bundle, no
// Codex plugin tree — so it stays available even when the heavier plugin
// build cannot run (see the CONSTRAINT this wave preserves).
export function profileToml(id, source, config) {
  const body = source.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
  const description = (source.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1].match(/^description:\s*(.+)$/m)?.[1] || "").trim().replace(/^['"]|['"]$/g, "") || `${id} Muster specialist.`;
  const defaultModel = CODEX_MODEL_POLICY[config.tier];
  if (!defaultModel) throw new Error(`unknown Codex profile tier for ${id}: ${config.tier}`);
  if (config.reasoning !== undefined && !["medium", "high", "xhigh"].includes(config.reasoning)) {
    throw new Error(`invalid Codex profile reasoning override for ${id}: ${config.reasoning}`);
  }
  if (config.model !== undefined && !/^gpt-5\.6-(?:luna|terra|sol)$/.test(config.model)) {
    throw new Error(`invalid Codex profile model override for ${id}: ${config.model}`);
  }
  const model = { model: config.model ?? defaultModel.model, reasoning: config.reasoning ?? defaultModel.reasoning };
  const isolation = config.readOnly
    ? "Remain read-only. Do not edit files or run commands that mutate the workspace."
    : "Before writing, verify the task is running in an isolated git worktree; do not write directly on a base branch.";
  return [
    `name = ${JSON.stringify(id)}`,
    `description = ${JSON.stringify(description)}`,
    `model = ${JSON.stringify(model.model)}`,
    `model_reasoning_effort = ${JSON.stringify(model.reasoning)}`,
    `sandbox_mode = ${JSON.stringify(config.readOnly ? "read-only" : "workspace-write")}`,
    "developer_instructions = \"\"\"",
    body,
    "",
    isolation,
    "\"\"\"",
    ""
  ].join("\n");
}

// Returns a Map of `${id}.toml` -> generated profile content, sourced only
// from the frozen codex/agents.manifest.json mapping and its referenced agent
// markdown files. No build step, no staging directory, no Codex CLI needed.
export async function generateCodexProfiles(root) {
  const mapping = readRegularJson(join(root, "codex", "agents.manifest.json"), "Codex agent mapping", 256 * 1024);
  const files = new Map();
  for (const [id, config] of Object.entries(mapping.agents || {})) {
    if (typeof config.source !== "string" || !config.source) throw new Error(`Codex agent mapping entry ${id} has no source`);
    const source = readRegular(join(root, config.source), `Codex agent source for ${id}`).toString("utf8");
    files.set(`${id}.toml`, profileToml(id, source, config));
  }
  return files;
}

function atomicWritePointer(path, content) {
  let temporary, fd;
  try {
    for (let attempt = 0; ; attempt++) {
      temporary = `${path}.muster-${process.pid}-${randomUUID()}.tmp`;
      try { fd = openSync(temporary, "wx", 0o600); break; }
      catch (error) { if (error.code !== "EEXIST" || attempt === 7) throw error; }
    }
    writeFileSync(fd, content, "utf8");
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    ordinary(temporary, "file", "staged Codex marketplace pointer");
    JSON.parse(readFileSync(temporary, "utf8"));
    renameWithRetry(temporary, path);
    temporary = null;
  } finally {
    if (fd !== null && fd !== undefined) try { closeSync(fd); } catch { /* already closed */ }
    if (temporary) rmSync(temporary, { force: true });
  }
}

// Publishes a freshly staged Codex plugin tree into `pluginsRoot/plugin`,
// replacing whatever was there before with a single crash-safe swap, and
// (re)writes `pluginsRoot/marketplace.json` to point at it. `pluginsRoot` is
// entirely caller-chosen (both `npm run build:codex` and codex-install.js use
// a gitignored repo-relative staging directory today; a directory under the
// user's CODEX_HOME is an equally valid target this function does not care
// about). Concurrent builds targeting the same `pluginsRoot` are serialized
// with the shared, already-simplified codex-lock.js primitive instead of a
// bespoke lease system.
export async function publishCodexPlugin({ pluginsRoot, stagedPlugin, packageVersion, marketplaceTemplate }) {
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("Codex plugin package version is required");
  ordinary(stagedPlugin, "directory", "staged Codex plugin");
  await assertRegularTree(stagedPlugin);
  ensureOrdinaryDirectory(pluginsRoot, "Codex plugin staging root");
  return withCodexFileLock(join(pluginsRoot, ".build.lock"), async () => {
    const pluginPath = join(pluginsRoot, "plugin");
    const retired = join(pluginsRoot, `.muster-retired-${process.pid}-${randomUUID()}`);
    let hadPrevious = false;
    try {
      ordinary(pluginPath, "directory", "existing Codex plugin");
      renameWithRetry(pluginPath, retired);
      hadPrevious = true;
    } catch (error) {
      if (error.cause?.code !== "ENOENT") throw error;
    }
    try {
      // stagedPlugin was just populated by a large (several-hundred-file)
      // write burst — the rename immediately afterward is exactly the drvfs
      // race documented above renameWithRetry.
      renameWithRetry(stagedPlugin, pluginPath);
    } catch (error) {
      if (hadPrevious) try { renameWithRetry(retired, pluginPath); } catch { /* best-effort restore */ }
      throw error;
    }
    if (hadPrevious) rmSync(retired, { recursive: true, force: true });

    const pointerPath = join(pluginsRoot, "marketplace.json");
    let pointer;
    try { pointer = readRegularJson(pointerPath, "Codex marketplace pointer", 1024 * 1024); }
    catch (error) {
      if (error.cause?.code !== "ENOENT") throw error;
      if (!marketplaceTemplate) throw new Error(`Codex marketplace pointer is missing and no template was provided: ${pointerPath}`);
      pointer = structuredClone(marketplaceTemplate);
    }
    if (pointer?.name !== "muster" || !Array.isArray(pointer.plugins) || !pointer.plugins.some(item => item?.name === "muster")) {
      throw new Error(`Codex marketplace does not describe the Muster plugin: ${pointerPath}`);
    }
    const plugin = pointer.plugins.find(item => item.name === "muster");
    plugin.source = { ...plugin.source, source: "local", path: "./plugin" };
    atomicWritePointer(pointerPath, JSON.stringify(pointer, null, 2) + "\n");
    return { pluginRoot: pluginPath, profilesRoot: join(pluginPath, "agents"), packageVersion };
  });
}

// Resolves an already-published Codex plugin under `pluginsRoot` (defaulting
// to the repo-relative gitignored staging directory). Fails closed with a
// clear "run the build/install step first" error if nothing has been
// generated yet — there is no fallback bootstrap to fall back to anymore.
export async function resolveCodexPlugin(root, { pluginsRoot = join(root, ".agents", "plugins") } = {}) {
  ordinary(pluginsRoot, "directory", "Codex plugin staging directory");
  const pointerPath = join(pluginsRoot, "marketplace.json");
  const pointer = readRegularJson(pointerPath, "Codex marketplace pointer", 1024 * 1024);
  const path = pointer?.plugins?.find(item => item?.name === "muster")?.source?.path;
  if (pointer?.name !== "muster" || path !== "./plugin") throw new Error(`Codex marketplace is missing a valid Muster plugin contract: ${pointerPath}`);
  const pluginRoot = join(pluginsRoot, "plugin");
  await assertRegularTree(pluginRoot);
  const pkg = readRegularJson(join(pluginRoot, "package.json"), "Codex plugin package descriptor", 64 * 1024);
  if (typeof pkg?.version !== "string" || !pkg.version.trim()) throw new Error(`Codex plugin is missing a coherent package version: ${pluginRoot}`);
  return { pluginRoot, profilesRoot: join(pluginRoot, "agents"), packageVersion: pkg.version };
}
