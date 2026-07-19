import { createHash, randomUUID } from "node:crypto";
import {
  closeSync, constants as fsConstants, cpSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, readdirSync, renameSync, rmSync, writeFileSync
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { withCodexFileLock } from "./codex-lock.js";
import { CODEX_MODEL_POLICY, codexProfileForConfig } from "./codex.js";

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

// Kept for same-device renames where cross-device copy doesn't apply and no
// hot-written-tree burst precedes the rename: atomicWritePointer below (a
// small single file) and publishCodexPlugin's retire-the-existing-plugin-dir
// step plus its restore-on-failure counterpart (an existing, cold directory
// — not the tree that was just hot-written). The freshly staged plugin tree
// itself is no longer renamed into place at all — see publishCodexPlugin's
// docblock — so this helper is never used for that. A/B testing (sandboxed
// and unsandboxed) confirmed the drvfs pathology is real and independent of
// any external process; strace-level syscall slowdown passes, but even a
// 50-second bounded backoff on the same rename does not reliably clear it
// for a large directory, so this retry is deliberately not relied on for
// that hot-written case anymore either.
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

// On win32, relative() returns `target` itself (still absolute, unchanged)
// when `base` and `target` are on different drives -- there is no relative
// path across drives -- which would otherwise slip past the ".." checks
// above undetected. Unreachable via this module's sole call path today
// (assertRegularTree below only ever passes a target built by joining
// directory segments read from within `base`, never a foreign-drive path),
// but restored anyway for defense-in-depth so a future caller of `contained`
// can't have this guard silently miss a cross-drive escape on Windows.
function contained(base, target, label) {
  const rel = relative(resolve(base), resolve(target));
  if (!rel || rel === ".") return;
  if (rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
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
// on every filesystem — was removed. The freshly written tree is instead
// never renamed at all: it is staged on native tmpfs (scripts/build-codex.mjs's
// top comment) and published by copy (publishCodexPlugin's docblock), which
// sidesteps the drvfs rename hazard entirely rather than retrying around it.
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
  // Single-sourced with the `capabilities --codex` lane: codexProfileForConfig
  // applies the same per-agent override-over-tier-default resolution, so the
  // committed TOML pin and the capabilities codexModel can never diverge. The
  // id-rich validation above stays here (defaultModel/override guards) for the
  // generator's fail-closed error messages.
  const model = codexProfileForConfig(config);
  const isolation = config.readOnly
    ? "Remain read-only. Do not edit files or run commands that mutate the workspace."
    : "Before writing, verify the task is running in an isolated git worktree; do not write directly on a base branch.";
  return [
    `name = ${JSON.stringify(id)}`,
    `description = ${JSON.stringify(description)}`,
    `model = ${JSON.stringify(model.model)}`,
    `model_reasoning_effort = ${JSON.stringify(model.effort)}`,
    `sandbox_mode = ${JSON.stringify(config.readOnly ? "read-only" : "workspace-write")}`,
    "developer_instructions = \"\"\"",
    body,
    "",
    isolation,
    "\"\"\"",
    ""
  ].join("\n");
}

// codex/agents.manifest.json is a trust boundary: every `id` becomes a
// `${id}.toml` path segment a downstream writer join()s into a destination,
// and every `config.source` becomes a read path. A manifest-controlled id like
// "../evil" or a source like "../../etc/passwd" would otherwise escape their
// roots (arbitrary write / arbitrary read). Each id must be a strict safe
// kebab token BEFORE it is ever a segment. This is the exact stem of
// codex-install.js's PROFILE_FILENAME (`^[a-z0-9]+(?:-[a-z0-9]+)*$`), so every
// id accepted here yields a `${id}.toml` that also satisfies that destination
// guard -- no id can pass here yet trip the containment check there. It is a
// strict subset of src/sprint-waves.js's ID_TOKEN_RE (which tolerates the
// trailing/doubled hyphens this rejects).
const ID_TOKEN_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Returns a Map of `${id}.toml` -> generated profile content, sourced only
// from the frozen codex/agents.manifest.json mapping and its referenced agent
// markdown files. No build step, no staging directory, no Codex CLI needed.
export async function generateCodexProfiles(root) {
  const mapping = readRegularJson(join(root, "codex", "agents.manifest.json"), "Codex agent mapping", 256 * 1024);
  const files = new Map();
  for (const [id, config] of Object.entries(mapping.agents || {})) {
    if (!ID_TOKEN_RE.test(id)) throw new Error(`Codex agent mapping id is not a safe token: ${JSON.stringify(id)}`);
    if (typeof config.source !== "string" || !config.source) throw new Error(`Codex agent mapping entry ${id} has no source`);
    // resolve() honors an absolute source as-is (so it escapes root and is
    // rejected) and normalizes any `..` before the containment check; the
    // same resolved path is what gets read, so contained() rejecting an escape
    // guarantees the escaping file is never read.
    const sourcePath = resolve(root, config.source);
    contained(root, sourcePath, `Codex agent source for ${id}`);
    const source = readRegular(sourcePath, `Codex agent source for ${id}`).toString("utf8");
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

// Copies a staged tree into place, rejecting (not silently dropping) any
// symlink or special file `assertRegularTree` would also reject, without
// requiring a second full tree walk before the copy starts: cpSync's filter
// callback inspects (and skips) each entry as it is visited during the copy
// itself. A skipped entry is a hard error — see publishCodexPlugin's
// docblock for why a silently incomplete copy would be worse than failing
// closed — so callers must not treat a normal return as "everything staged
// was copied" without also checking this can throw.
export function copyStagedPluginTree(source, destination) {
  const skipped = [];
  cpSync(source, destination, {
    recursive: true,
    filter: entry => {
      let stat;
      try { stat = lstatSync(entry); }
      catch { return true; } // let cpSync raise its own natural error for a source that vanished mid-copy
      if (stat.isSymbolicLink() || (!stat.isDirectory() && !stat.isFile())) { skipped.push(entry); return false; }
      return true;
    }
  });
  if (skipped.length) {
    throw new Error(`Codex plugin publish refused to copy ${skipped.length} unsafe (symlink or special) staged entr${skipped.length === 1 ? "y" : "ies"}: ${skipped.join(", ")}`);
  }
}

// Publishes a freshly staged Codex plugin tree into `pluginsRoot/plugin`,
// replacing whatever was there before, and (re)writes
// `pluginsRoot/marketplace.json` to point at it. `pluginsRoot` is entirely
// caller-chosen (both `npm run build:codex` and codex-install.js use a
// gitignored repo-relative staging directory today; a directory under the
// user's CODEX_HOME is an equally valid target this function does not care
// about).
//
// This is NOT a single atomic swap. `stagedPlugin` is always staged on the
// native filesystem (scripts/build-codex.mjs's top comment), so it is
// frequently on a different device than `pluginsRoot` — an EXDEV rename is
// not an option — and even where they happen to share a device, renaming
// that tree immediately after the write burst that produced it is exactly
// the confirmed WSL2 drvfs (/mnt/c) rename-after-write-burst pathology
// documented above renameWithRetry. So publish is three steps: rename the
// existing `plugin` dir aside to a retirement path (same-device, a cold,
// already-settled directory, not the one just hot-written — unaffected by
// that pathology), copy the staged tree into place, then delete the retired
// dir. On any failure between retirement and a successful copy, the retired
// dir is best-effort restored so a failed publish leaves the previous
// plugin intact rather than nothing.
//
// `assertRegularTree(stagedPlugin)` above validates the staged tree once,
// before the publish lock is even acquired. That leaves a real window: a
// same-user writer (or a crashed/racing build) could mutate the staged
// tmpdir between that validation and the copy below. Two independent
// defenses close it: `copyStagedPlugin` (default `copyStagedPluginTree`)
// rejects/skips any symlink or special file it finds while copying, hard
// failing rather than silently dropping it, and `pluginPath` — the actual
// copy destination — is re-validated with `assertRegularTree` again before
// anything durable (the marketplace pointer) is written. Either one on its
// own would close the race; both run so a defect in one is not a single
// point of failure. A failure at either point restores the retired
// directory the same way a copy failure always has.
//
// A narrower window still remains after that second validation: nothing
// re-checks `pluginPath` between it and the `atomicWritePointer` call below,
// so a same-user writer racing in just that gap could still mutate the
// just-validated tree before the marketplace pointer commits to it.
//
// Concurrent publishes to the same `pluginsRoot` are serialized by the
// shared codex-lock.js primitive, so two publishers never interleave. But
// nothing here synchronizes with a concurrent *reader*: resolveCodexPlugin
// below, scripts/check-codex.mjs, src/codex-doctor.js, and this module's own
// build-time skip-check all read `pluginsRoot` without taking any lock. A
// reader that runs during the retire-then-copy window can observe a
// transient ENOENT (while the previous `plugin` dir is retired but the new
// one is not yet in place) or, if it races the copy itself, a partial tree.
// That is an accepted trade, not an oversight: every one of those readers is
// dev/CI tooling invoked by a human or a build step, and simply rerunning
// resolves it — resolveCodexPlugin absorbs the narrow ENOENT case with a
// small bounded retry (see its docblock) so most callers never even notice.
// A publish that crashes mid-copy can still leave a partial `plugin` dir
// (and, if the crash lands between retirement and copy, an orphaned
// `.muster-retired-*` sibling — swept at the top of the next publish, below)
// for the next build/install to detect (via resolveCodexPlugin's tree and
// version checks) and overwrite.
// Codex resolves a marketplace entry's `source.path` relative to the ROOT passed
// to `codex plugin marketplace add`, NOT relative to the marketplace.json's own
// directory (verified empirically against Codex 0.144.5; see docs/research/codex-cli.md).
// muster always builds the plugin at `<addedRoot>/.agents/plugins/plugin` and adds
// the marketplace from `<addedRoot>`, so the pointer must name the plugin from that
// root: `./.agents/plugins/plugin`. Writing `./plugin` (relative to the manifest's
// own dir, as an earlier revision wrongly assumed Codex would resolve) makes Codex
// install `<addedRoot>/plugin` -- the Claude plugin, whose default `hooks/hooks.json`
// Codex >=0.144.5 auto-discovers and FIRES, duplicating muster's scoped hooks.json
// install (the hook-bombardment regression). The path is derived purely from
// pluginsRoot via the build invariant (pluginsRoot === <addedRoot>/.agents/plugins),
// so publish and resolve compute the identical string with no extra plumbing, and it
// stays an exact-match traversal guard.
//
// The invariant (pluginsRoot === <addedRoot>/.agents/plugins, addedRoot == the
// `marketplace add`-ed root) holds for every shipped caller -- the CLI's build
// (build-codex.mjs, outDir === <root>/.agents/plugins) and `runCodexInstall`
// (marketplace add <distributionRoot>, build into <distributionRoot>/.agents/plugins).
// It is NOT asserted at runtime: a hypothetical caller building to a differently
// nested pluginsRoot would still make publish and resolve agree with each other
// (muster's self-checks stay green) while Codex's external resolution installed from
// a different dir. No such caller exists today; doctor's pluginRoot branch already
// bypasses this pointer check for the same reason.
function codexMarketplacePluginPath(pluginsRoot) {
  const addedRoot = resolve(pluginsRoot, "..", "..");
  return "./" + relative(addedRoot, join(pluginsRoot, "plugin")).replaceAll("\\", "/");
}

export async function publishCodexPlugin({ pluginsRoot, stagedPlugin, packageVersion, marketplaceTemplate, copyStagedPlugin = copyStagedPluginTree }) {
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("Codex plugin package version is required");
  ordinary(stagedPlugin, "directory", "staged Codex plugin");
  await assertRegularTree(stagedPlugin);
  ensureOrdinaryDirectory(pluginsRoot, "Codex plugin staging root");
  return withCodexFileLock(join(pluginsRoot, ".build.lock"), async () => {
    // A publish that crashed between retiring the previous plugin and either
    // completing or restoring leaves an orphaned `.muster-retired-*`
    // sibling behind. No other process can be mid-retire right now (this
    // publish just took the lock), so any such leftover is stale crash
    // debris from a prior run: sweep it before doing anything else.
    for (const name of readdirSync(pluginsRoot)) {
      if (name.startsWith(".muster-retired-")) rmSync(join(pluginsRoot, name), { recursive: true, force: true });
    }
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
      // write burst and is frequently on a different device than
      // pluginPath (see this function's docblock), so it is published by
      // copy rather than renamed into place. copyStagedPlugin and the
      // assertRegularTree re-validation below are this function's two
      // independent copy-time-race defenses (see the docblock above).
      await copyStagedPlugin(stagedPlugin, pluginPath);
      await assertRegularTree(pluginPath);
    } catch (error) {
      // pluginPath may now hold a partial or tainted copy (unlike the old
      // copy-only failure mode, where cpSync itself never created it): wipe
      // it before restoring so a failed publish never leaves compromised
      // content in place, whether or not there was a previous plugin.
      rmSync(pluginPath, { recursive: true, force: true });
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
    plugin.source = { ...plugin.source, source: "local", path: codexMarketplacePluginPath(pluginsRoot) };
    atomicWritePointer(pointerPath, JSON.stringify(pointer, null, 2) + "\n");
    return { pluginRoot: pluginPath, profilesRoot: join(pluginPath, "agents"), packageVersion };
  });
}

async function resolveCodexPluginOnce(pluginsRoot) {
  ordinary(pluginsRoot, "directory", "Codex plugin staging directory");
  const pointerPath = join(pluginsRoot, "marketplace.json");
  const pointer = readRegularJson(pointerPath, "Codex marketplace pointer", 1024 * 1024);
  const path = pointer?.plugins?.find(item => item?.name === "muster")?.source?.path;
  if (pointer?.name !== "muster" || path !== codexMarketplacePluginPath(pluginsRoot)) throw new Error(`Codex marketplace is missing a valid Muster plugin contract: ${pointerPath}`);
  const pluginRoot = join(pluginsRoot, "plugin");
  await assertRegularTree(pluginRoot);
  const pkg = readRegularJson(join(pluginRoot, "package.json"), "Codex plugin package descriptor", 64 * 1024);
  if (typeof pkg?.version !== "string" || !pkg.version.trim()) throw new Error(`Codex plugin is missing a coherent package version: ${pluginRoot}`);
  return { pluginRoot, profilesRoot: join(pluginRoot, "agents"), packageVersion: pkg.version };
}

// Resolves an already-published Codex plugin under `pluginsRoot` (defaulting
// to the repo-relative gitignored staging directory). Fails closed with a
// clear "run the build/install step first" error if nothing has been
// generated yet — there is no fallback bootstrap to fall back to anymore.
//
// This is a reader, and readers are never synchronized with a concurrent
// publish (see publishCodexPlugin's docblock): a call landing in the
// retire-then-copy window can see an ENOENT for `pluginPath` that clears a
// moment later on its own. A small bounded retry absorbs exactly that narrow
// window without adding any reader-side locking; it does not and cannot
// paper over a genuinely missing or invalid plugin, which still fails closed
// once the retries are exhausted.
export async function resolveCodexPlugin(root, { pluginsRoot = join(root, ".agents", "plugins") } = {}) {
  for (let attempt = 0; ; attempt++) {
    try { return await resolveCodexPluginOnce(pluginsRoot); }
    catch (error) {
      if (error?.cause?.code !== "ENOENT" || attempt >= 3) throw error;
      await new Promise(r => setTimeout(r, 10 * (attempt + 1)));
    }
  }
}
