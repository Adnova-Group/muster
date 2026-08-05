// codex-install-marketplace.js -- Codex plugin marketplace registration and
// plugin-cache publish/rollback, split out of codex-install.js
// (split-codex-install). Depends only on node builtins, codex-release.js,
// and codex-install-shared.js.
import { lstat, mkdir, readFile, readdir, realpath, rename, cp } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { assertRegularTree, generateCodexProfiles } from "./codex-release.js";
import { ordinaryDirectoryPath, readJson, run, runJson } from "./codex-install-shared.js";

export const CODEX_PLUGIN = "muster@muster";

const MIGRATED_COMMAND_PREFIX = ".codex-plugin/migrated-command-skills";

const MAX_MIGRATED_COMMAND_SKILL_BYTES = 4_000;


export async function expectedMigratedCommandSkill(sourceRoot, commandName) {
  const source = await readFile(join(sourceRoot, "commands", `${commandName}.md`));
  const text = new TextDecoder("utf-8", { fatal: true }).decode(source);
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error(`Codex trusted source command has malformed frontmatter: ${commandName}`);
  const description = match[1].split(/\r?\n/).find(line => line.startsWith("description:"));
  if (!description) throw new Error(`Codex trusted source command has no description: ${commandName}`);
  return Buffer.from([
    "---",
    `name: ${JSON.stringify(`source-command-${commandName}`)}`,
    description,
    "---",
    "",
    `# source-command-${commandName}`,
    "",
    `Use this skill when the user asks to run the migrated source command \`${commandName}\`.`,
    "",
    "## Command Template",
    match[2]
  ].join("\n"));
}


export async function assertTrustedPluginCacheProjection(root, tree, sourceRoot, sourceTree) {
  const projected = {
    dirs: tree.dirs.filter(path => path !== MIGRATED_COMMAND_PREFIX && !path.startsWith(`${MIGRATED_COMMAND_PREFIX}/`)),
    files: tree.files.filter(file => !file.path.startsWith(`${MIGRATED_COMMAND_PREFIX}/`))
  };
  if (JSON.stringify(projected) !== JSON.stringify(sourceTree)) {
    throw new Error(`Codex staged plugin cache differs from the exact trusted plugin source: ${root}`);
  }
  const expectedFiles = [];
  const expectedDirs = new Set();
  for (const sourceFile of sourceTree.files) {
    const match = /^commands\/([a-z0-9]+(?:-[a-z0-9]+)*)\.md$/.exec(sourceFile.path);
    if (!match) continue;
    const expected = await expectedMigratedCommandSkill(sourceRoot, match[1]);
    if (expected.length > MAX_MIGRATED_COMMAND_SKILL_BYTES) continue;
    const path = `${MIGRATED_COMMAND_PREFIX}/source-command-${match[1]}/SKILL.md`;
    expectedFiles.push({ path, sha256: createHash("sha256").update(expected).digest("hex"), size: expected.length });
    expectedDirs.add(dirname(path).replaceAll("\\", "/"));
  }
  expectedFiles.sort((left, right) => left.path.localeCompare(right.path));
  const migratedFiles = tree.files.filter(file => file.path.startsWith(`${MIGRATED_COMMAND_PREFIX}/`));
  if (JSON.stringify(migratedFiles) !== JSON.stringify(expectedFiles)) {
    throw new Error(`Codex staged plugin cache has an incomplete or tampered migrated command inventory under ${MIGRATED_COMMAND_PREFIX}`);
  }
  const migratedDirs = tree.dirs.filter(path => path === MIGRATED_COMMAND_PREFIX || path.startsWith(`${MIGRATED_COMMAND_PREFIX}/`));
  const allowedDirs = new Set(migratedFiles.length ? [MIGRATED_COMMAND_PREFIX, ...expectedDirs] : []);
  if (migratedDirs.some(path => !allowedDirs.has(path)) || migratedDirs.length !== allowedDirs.size) {
    throw new Error(`Codex staged plugin cache contains an untrusted derived directory under ${MIGRATED_COMMAND_PREFIX}`);
  }
}


export async function assertPrivatePluginCache(root, packageVersion, { sourceRoot = null, sourceTree = null, exactTree = null } = {}) {
  const tree = await assertRegularTree(root);
  const manifest = await readJson(join(root, "package.json"));
  const pluginManifest = await readJson(join(root, ".codex-plugin", "plugin.json"));
  if (manifest?.version !== packageVersion || !/^[a-f0-9]{64}$/.test(manifest.inputDigest || "")
    || pluginManifest?.name !== "muster" || pluginManifest.version !== packageVersion) {
    throw new Error(`Codex staged plugin cache identity mismatch at ${root}`);
  }
  if (sourceTree) await assertTrustedPluginCacheProjection(root, tree, sourceRoot, sourceTree);
  if (exactTree && JSON.stringify(tree) !== JSON.stringify(exactTree)) throw new Error(`Codex plugin cache differs from its exact staged receipt: ${root}`);
  return tree;
}


export async function stablePluginCacheSnapshot(root, packageVersion, options = {}) {
  const before = await lstat(root);
  if (before.isSymbolicLink() || !before.isDirectory()) throw new Error(`Codex plugin cache target must be an ordinary directory: ${root}`);
  const first = await assertPrivatePluginCache(root, packageVersion, options);
  const second = await assertPrivatePluginCache(root, packageVersion, options);
  const after = await lstat(root);
  if (before.dev !== after.dev || before.ino !== after.ino || JSON.stringify(first) !== JSON.stringify(second)) {
    throw new Error(`Codex plugin cache changed while being verified: ${root}`);
  }
  return { dev: after.dev, ino: after.ino, tree: second };
}


export const samePluginCacheSnapshot = (left, right) => left.dev === right.dev && left.ino === right.ino
  && JSON.stringify(left.tree) === JSON.stringify(right.tree);

export async function copyPluginCacheExclusively(source, target, expectedTree, packageVersion, pluginCacheOptions = {}) {
  await mkdir(target, { mode: 0o700 });
  const owner = await lstat(target);
  try {
    for (const name of await readdir(source)) {
      await cp(join(source, name), join(target, name), { recursive: true, force: false, errorOnExist: true });
    }
    // Test-only injection point (afterExclusiveCopy): fires after this
    // exclusive copy finishes, before the identity re-verification below --
    // the exact window a concurrent writer could swap this freshly reserved
    // target for an identical-content clone under a different dev/ino.
    // Undefined in production: zero behavior change.
    await pluginCacheOptions.afterExclusiveCopy?.({ source, target });
    const published = await stablePluginCacheSnapshot(target, packageVersion, { exactTree: expectedTree });
    if (published.dev !== owner.dev || published.ino !== owner.ino
      || JSON.stringify(published.tree) !== JSON.stringify(expectedTree)) {
      throw new Error(`Codex plugin cache changed during exclusive publication: ${target}`);
    }
    return published;
  } catch (error) {
    // Never recursively remove the reserved target: an uncooperative writer
    // may have populated or replaced it. The valid source remains retained.
    throw error;
  }
}


export async function publishStagedPluginCache(staged, liveCodexHome, packageVersion, trustedSourceRoot, trustedTree, pluginCacheOptions = {}) {
  const stagedTree = await assertPrivatePluginCache(staged, packageVersion, {
    sourceRoot: trustedSourceRoot, sourceTree: trustedTree
  });
  const parent = join(liveCodexHome, "plugins", "cache", "muster", "muster");
  await ordinaryDirectoryPath(parent, { create: true });
  const target = join(parent, packageVersion);
  const retired = join(parent, `.muster-retired-${packageVersion}-${process.pid}-${randomUUID()}`);
  let expected = null;
  try {
    expected = await stablePluginCacheSnapshot(target, packageVersion);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (expected && JSON.stringify(expected.tree) === JSON.stringify(stagedTree)) {
    return { target, retired: null, expected, published: expected, reused: true, packageVersion };
  }
  if (expected) {
    // Test-only injection point (beforeRetire): fires right before the live
    // target is renamed aside for retirement -- the exact window a concurrent
    // writer could mutate it so the post-rename snapshot no longer matches
    // the pre-rename `expected` read above. Undefined in production: zero
    // behavior change.
    await pluginCacheOptions.beforeRetire?.({ target, retired, expected });
    await rename(target, retired);
    const moved = await stablePluginCacheSnapshot(retired, packageVersion);
    if (!samePluginCacheSnapshot(expected, moved)) {
      try { await copyPluginCacheExclusively(retired, target, moved.tree, packageVersion, pluginCacheOptions); }
      catch { /* preserve both names/artifacts and fail with the ownership conflict */ }
      throw new Error(`Codex plugin cache changed before retirement: ${target}; concurrent state was preserved`);
    }
  }
  let published;
  try { published = await copyPluginCacheExclusively(staged, target, stagedTree, packageVersion, pluginCacheOptions); }
  catch (error) {
    if (expected) try { await copyPluginCacheExclusively(retired, target, expected.tree, packageVersion, pluginCacheOptions); } catch { /* preserve artifacts */ }
    throw error;
  }
  return { target, retired: expected ? retired : null, expected, published, reused: false, packageVersion };
}


export async function rollbackPublishedPluginCache(receipt, pluginCacheOptions = {}) {
  if (!receipt) return;
  if (receipt.reused) return;
  // Test-only injection point (beforeRollbackVerify): fires before the
  // published target is re-read for the rollback-owner check below.
  // Undefined in production: zero behavior change.
  await pluginCacheOptions.beforeRollbackVerify?.({ receipt });
  const current = await stablePluginCacheSnapshot(receipt.target, receipt.packageVersion);
  if (!samePluginCacheSnapshot(receipt.published, current)) {
    throw new Error(`Codex plugin cache changed before rollback: ${receipt.target}; concurrent state was preserved`);
  }
  const failed = join(dirname(receipt.target), `.muster-rolled-back-${receipt.packageVersion}-${process.pid}-${randomUUID()}`);
  // Test-only injection point (beforeRollbackRetire): fires right before the
  // published target is renamed aside as the failed generation -- the exact
  // window a concurrent writer could mutate it so the post-rename snapshot no
  // longer matches `receipt.published`. Undefined in production: zero
  // behavior change.
  await pluginCacheOptions.beforeRollbackRetire?.({ receipt, failed });
  await rename(receipt.target, failed);
  const moved = await stablePluginCacheSnapshot(failed, receipt.packageVersion);
  if (!samePluginCacheSnapshot(receipt.published, moved)) {
    try { await copyPluginCacheExclusively(failed, receipt.target, moved.tree, receipt.packageVersion, pluginCacheOptions); }
    catch { /* preserve both names and surface the ownership conflict */ }
    throw new Error(`Codex plugin cache changed during rollback: ${receipt.target}; concurrent state was preserved`);
  }
  if (receipt.retired) {
    await copyPluginCacheExclusively(
      receipt.retired, receipt.target, receipt.expected.tree, receipt.packageVersion, pluginCacheOptions
    );
  }
  // The failed generation and retired predecessor remain path-addressable.
  // No recursive delete is safe in the presence of arbitrary directory FDs.
}


export async function verifyPublishedPluginCache(receipt, pluginCacheOptions = {}) {
  if (!receipt) return;
  // Test-only injection point (beforeVerify): fires before the final
  // pre-commit re-read of the published target. Undefined in production:
  // zero behavior change.
  await pluginCacheOptions.beforeVerify?.({ receipt });
  const current = await stablePluginCacheSnapshot(receipt.target, receipt.packageVersion, {
    exactTree: receipt.published.tree
  });
  if (!samePluginCacheSnapshot(receipt.published, current)) {
    throw new Error(`Codex plugin cache changed before the install commit point: ${receipt.target}; concurrent state was preserved`);
  }
}


export function normalizedLocalRoot(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  const input = value.trim().replaceAll("\\", "/");
  const drive = input.match(/^([a-z]):\/(.*)$/i);
  return (drive ? `/mnt/${drive[1].toLowerCase()}/${drive[2]}` : resolve(input)).replace(/\/+$/, "");
}


export async function sameLocalRoot(left, right) {
  const actual = normalizedLocalRoot(left), expected = normalizedLocalRoot(right);
  if (!actual || !expected) return false;
  try {
    const canonical = async path => {
      try { return await realpath(path); }
      catch (error) {
        if (!/^\/mnt\/[a-z](?:\/|$)/i.test(path)) throw error;
        return realpath(path.toLowerCase());
      }
    };
    const [actualPath, expectedPath] = await Promise.all([canonical(actual), canonical(expected)]);
    const [actualStat, expectedStat] = await Promise.all([lstat(actualPath), lstat(expectedPath)]);
    return actualStat.isDirectory() && expectedStat.isDirectory()
      && actualStat.dev === expectedStat.dev && actualStat.ino === expectedStat.ino;
  } catch { return false; }
}


export async function trustedMusterMarketplace(item, repoRoot) {
  const source = item?.marketplaceSource;
  return source?.sourceType === "local"
    && await sameLocalRoot(item.root, repoRoot)
    && await sameLocalRoot(source.source, repoRoot);
}


export async function existingMusterMarketplace(execFile, repoRoot, runtimeIdentity, commandOptions) {
  const result = await runJson(execFile, ["plugin", "marketplace", "list", "--json"], runtimeIdentity, commandOptions);
  const matches = Array.isArray(result?.marketplaces) ? result.marketplaces.filter(item => item.name === "muster") : [];
  const trusted = await Promise.all(matches.map(item => trustedMusterMarketplace(item, repoRoot)));
  if (trusted.some(value => !value)) {
    throw new Error(`Codex marketplace conflict: "muster" is registered from an unexpected source. Run "codex plugin marketplace remove muster", then rerun muster install codex.`);
  }
  return matches[0];
}

// File-local, so the flag is an OPTIONS object rather than a positional
// boolean: `registerPlugin(execFile, root, { dryRun: true })` reads at the call
// site; the old `registerPlugin(execFile, true, root)` did not.

export async function registerPlugin(execFile, repoRoot, { dryRun, runtimeIdentity, afterRegister, commandOptions }) {
  if (dryRun) return [`codex plugin marketplace add ${repoRoot}`, `codex plugin add ${CODEX_PLUGIN}`];
  let marketplaceAdded = false, pluginAdded = false, pluginPreviouslyInstalled = false;
  try {
    const marketplace = await existingMusterMarketplace(execFile, repoRoot, runtimeIdentity, commandOptions);
    if (!marketplace) {
      await run(execFile, ["plugin", "marketplace", "add", repoRoot], runtimeIdentity, commandOptions);
      marketplaceAdded = true;
    }
    const inventory = await runJson(execFile, ["plugin", "list", "--available", "--json"], runtimeIdentity, commandOptions);
    pluginPreviouslyInstalled = Array.isArray(inventory?.installed) && inventory.installed.some(plugin =>
      plugin === CODEX_PLUGIN || plugin?.pluginId === CODEX_PLUGIN
        || (plugin?.name === "muster" && (plugin?.marketplace === "muster" || plugin?.source?.marketplace === "muster"))
    );
    await run(execFile, ["plugin", "add", CODEX_PLUGIN], runtimeIdentity, commandOptions);
    pluginAdded = true;
    await afterRegister?.();
    return [];
  } catch (error) {
    if (pluginAdded && !pluginPreviouslyInstalled) try { await run(execFile, ["plugin", "remove", CODEX_PLUGIN], runtimeIdentity, commandOptions); } catch { /* best-effort transaction rollback */ }
    if (marketplaceAdded) try { await run(execFile, ["plugin", "marketplace", "remove", "muster"], runtimeIdentity, commandOptions); } catch { /* best-effort transaction rollback */ }
    throw error;
  }
}

// Wave 2 teardown: profile materialization no longer reads a committed,
// pre-built generation. `generateCodexProfiles` (src/codex-release.js) is a
// pure, dependency-free reader of the frozen codex/agents.manifest.json plus
// its markdown sources, so `.codex/agents/` (the CONSTRAINT-protected
// project-scope surface the model-tiering wave depends on) always works with
// no build step, independent of the heavier plugin build below.