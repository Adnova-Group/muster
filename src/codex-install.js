import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { basename, dirname, join, parse, resolve } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { readdirSafe, exists } from "./fs-util.js";
import { codexAvailable } from "./codex-inventory.js";
import { codexMcpOverlay, resolveCodexRuntimeIdentity } from "./codex-runtime-identity.js";
import { escapeRe } from "./keyword.js";
import { assertRegularTree, generateCodexProfiles } from "./codex-release.js";
import {
  CODEX_THREAD_LIMIT_REMEDIATION,
  REQUIRED_CODEX_THREAD_LIMITS,
  codexThreadLimitConfigPath,
  codexThreadLimitManifestPath,
  ensureCodexThreadLimits,
  restoreCodexThreadLimits
} from "./codex-thread-limits.js";
import { runCodexStrictConfigCheck } from "./codex-strict-config.js";
import {
  execFileDefault, MANIFEST, codexHome, configDir, scopeRegistryPath, scopeRegistryLockPath,
  codexProjectRoot, codexInvocationRoot, codexActivationConfigDirs, ordinaryDirectoryPath,
  regularFileState, safeExists, readSafe, physicalFileSnapshot, samePhysicalFile, readJson,
  validateScopeRegistry, readScopeRegistry, scopeEntry, sameScopeEntry, registryText,
  canonicalDiskCasing, reconcileScopeRegistryEntries, atomicWriteSafe, removeSafe, run,
  snapshot, restoreFilesystem, exactFileSnapshot, sameExactFileSnapshot
} from "./codex-install-shared.js";
import {
  hookActivationSnapshot, sameHookActivationSnapshot, activationSnapshotMatchesWrites,
  validateManagedHookAliasGraph, decodeTomlQuotedKey, ownedHookStateKeys, reconcileConfigTomlHookState,
  readCodexHookInventory, effectiveHookTrust, musterHookTrustGaps, validateHookManifest, same,
  groupCommands, isMusterHookCommand, hasMusterHookCommandAlias, verifiedHookInventory,
  codexHookStateKeys, removeOwnedHookGroups, formatCodexWindowsPath, parseHookCommand,
  hasManagedRuntimeInventoryAlias, inventoryAliasCandidateSnapshot, sameAliasCandidateSnapshot,
  expectedCodexHookInstall, inspectEffectiveUserScopeHooks, userScopeHooksHealthy, prepareHooks
} from "./codex-install-hooks.js";
import { withScopeRegistryTransaction } from "./codex-install-scope-lock.js";
import {
  concurrentConfigError, verifyCodexConfigRetirementReceipt, retainConfigArtifacts,
  publishConfigCandidate, rollbackConfigCandidate
} from "./codex-install-config-transactions.js";
import {
  CODEX_PLUGIN, assertPrivatePluginCache, publishStagedPluginCache, rollbackPublishedPluginCache,
  verifyPublishedPluginCache, existingMusterMarketplace, registerPlugin
} from "./codex-install-marketplace.js";

// Re-export the pre-split public API unchanged: codex-install.js remains the
// facade every existing importer (tests, cli.js, codex-doctor.js,
// scripts/check-codex.mjs) uses without modification.
export {
  CODEX_PLUGIN, codexProjectRoot, codexInvocationRoot, codexActivationConfigDirs,
  hookActivationSnapshot, sameHookActivationSnapshot, reconcileScopeRegistryEntries,
  reconcileConfigTomlHookState, readCodexHookInventory, effectiveHookTrust, musterHookTrustGaps,
  isMusterHookCommand, hasMusterHookCommandAlias, hasManagedRuntimeInventoryAlias,
  inventoryAliasCandidateSnapshot, sameAliasCandidateSnapshot, codexHookStateKeys,
  formatCodexWindowsPath, parseHookCommand, expectedCodexHookInstall, verifyCodexConfigRetirementReceipt
};

const PROFILE_FILENAME = /^[a-z0-9]+(?:-[a-z0-9]+)*\.toml$/;

const AGENT_DECLARATIONS_START = "# >>> muster managed agent declarations >>>";

const AGENT_DECLARATIONS_END = "# <<< muster managed agent declarations <<<";


export const agentsDir = (scope, cwd, home) => scope === "user" ? join(codexHome(home), "agents") : join(cwd, ".codex", "agents");

export async function ownershipFileSnapshot(path) {
  if (!(await regularFileState(path))) return { exists: false, bytes: null };
  return { exists: true, bytes: await readFile(path) };
}

export async function physicalFilesSnapshot(paths) {
  const snapshot = new Map();
  for (const path of paths) snapshot.set(path, await physicalFileSnapshot(path));
  return snapshot;
}

export function samePhysicalFilesSnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, expected] of left) {
    const current = right.get(path);
    if (!current || !samePhysicalFile(expected, current)) return false;
  }
  return true;
}

export async function declarationOwnershipSnapshot(manifestPath, configPath) {
  const [manifest, config] = await Promise.all([
    ownershipFileSnapshot(manifestPath),
    ownershipFileSnapshot(configPath)
  ]);
  return { manifest, config };
}

export function ownershipSnapshotText(file) {
  if (!file.exists) return "";
  try { return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes); }
  catch { throw new Error("Codex config.toml contains invalid UTF-8"); }
}


export function configSnapshotText(snapshot, path) {
  if (!snapshot.exists) return "";
  try { return new TextDecoder("utf-8", { fatal: true }).decode(snapshot.bytes); }
  catch { throw new Error(`Codex config.toml contains invalid UTF-8: ${path}`); }
}

export function ownershipSnapshotManifest(file) {
  if (!file.exists) return null;
  try { return JSON.parse(file.bytes.toString("utf8")); }
  catch { return null; }
}

export function sameOwnershipFile(left, right) {
  return left.exists === right.exists
    && (!left.exists || left.bytes.equals(right.bytes));
}

export async function verifyDeclarationOwnershipSnapshot(expected, manifestPath, configPath) {
  const current = await declarationOwnershipSnapshot(manifestPath, configPath);
  if (!sameOwnershipFile(expected.manifest, current.manifest)
    || !sameOwnershipFile(expected.config, current.config)) {
    throw new Error("Codex agent declaration concurrent state change detected; no installation state was modified.");
  }
  return current;
}

export const profileFiles = async root => (await readdirSafe(root)).filter(name => name.endsWith(".toml")).sort();

export function assertContainedProfiles(files, dir) {
  const base = resolve(dir);
  for (const file of files) {
    if (typeof file !== "string" || file !== basename(file) || !PROFILE_FILENAME.test(file) || dirname(resolve(base, file)) !== base) {
      throw new Error(`Refusing to write a Codex profile outside ${dir}: ${JSON.stringify(file)}`);
    }
  }
}


export function validateManagedFiles(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files)) {
    throw new Error(`Codex installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  if ((manifest.declarationConfigCreated !== undefined && typeof manifest.declarationConfigCreated !== "boolean")
    || (manifest.declarationSeparatorAdded !== undefined && typeof manifest.declarationSeparatorAdded !== "boolean")
    || (manifest.declarationRegion !== undefined
      && (manifest.declarationRegion?.format !== 1
        || manifest.declarationRegion.algorithm !== "sha256"
        || !/^[a-f0-9]{64}$/.test(manifest.declarationRegion.digest)))) {
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


export function agentDescription(profile, file) {
  const match = String(profile).match(/^description\s*=\s*("(?:[^"\\]|\\.)*")\s*(?:#.*)?$/m);
  if (!match) throw new Error(`Codex profile ${file} has no valid description`);
  try {
    const description = JSON.parse(match[1]);
    if (typeof description !== "string" || !description) throw new Error("empty description");
    return description;
  } catch (error) {
    throw new Error(`Codex profile ${file} has no valid description`, { cause: error });
  }
}


export function declarationRegion(declarations, newline = "\n") {
  const lines = [AGENT_DECLARATIONS_START];
  for (const [name, description] of declarations) {
    lines.push(
      `[agents.${name}]`,
      `description = ${JSON.stringify(description)}`,
      `config_file = ${JSON.stringify(`agents/${name}.toml`)}`,
      ""
    );
  }
  lines.push(AGENT_DECLARATIONS_END);
  return lines.join(newline) + newline;
}


export function declarationBounds(text) {
  const markerLines = marker => [...text.matchAll(new RegExp(`^${escapeRe(marker)}\\r?$`, "gm"))];
  const starts = markerLines(AGENT_DECLARATIONS_START);
  const ends = markerLines(AGENT_DECLARATIONS_END);
  if (starts.length !== ends.length || starts.length > 1
    || (starts.length === 1 && ends[0].index < starts[0].index)) {
    throw new Error("Codex config.toml has malformed Muster agent declaration ownership markers");
  }
  if (!starts.length) return null;
  const start = starts[0].index;
  let end = ends[0].index + ends[0][0].length;
  if (text.startsWith("\r\n", end)) end += 2;
  else if (text.startsWith("\n", end)) end += 1;
  return { start, end };
}


export function declarationRegionReceipt(text) {
  const bounds = declarationBounds(text);
  if (!bounds) throw new Error("Cannot receipt a missing Muster agent declaration region");
  return {
    format: 1,
    algorithm: "sha256",
    digest: createHash("sha256").update(text.slice(bounds.start, bounds.end), "utf8").digest("hex")
  };
}


export function verifiedDeclarationBounds(text, receipt, manifestPath) {
  const bounds = declarationBounds(text);
  if (!receipt) {
    if (bounds) {
      throw new Error(`Codex config.toml has Muster agent declaration markers without an explicit ownership receipt in ${manifestPath}. Move or remove the ambiguous markers before retrying.`);
    }
    return null;
  }
  if (!bounds) {
    throw new Error(`Codex agent declaration integrity check failed: the receipted region from ${manifestPath} is missing.`);
  }
  const digest = createHash("sha256").update(text.slice(bounds.start, bounds.end), "utf8").digest("hex");
  if (digest !== receipt.digest) {
    throw new Error(`Codex agent declaration integrity check failed: the receipted region from ${manifestPath} was modified.`);
  }
  return bounds;
}


export function removeAgentDeclarations(text, { separatorAdded = false, receipt, manifestPath } = {}) {
  const bounds = verifiedDeclarationBounds(text, receipt, manifestPath);
  if (!bounds) return text;
  let start = bounds.start;
  if (separatorAdded && bounds.end === text.length) {
    if (text.slice(Math.max(0, start - 2), start) === "\r\n") start -= 2;
    else if (text[start - 1] === "\n") start -= 1;
    else throw new Error("Codex config.toml Muster agent declaration separator was modified");
  }
  return text.slice(0, start) + text.slice(bounds.end);
}


export function agentDeclarationHeaderPath(line) {
  let cursor = 0;
  const whitespace = () => { while (/\s/.test(line[cursor] ?? "")) cursor++; };
  const component = () => {
    const start = cursor;
    if (line[cursor] === "'" || line[cursor] === '"') {
      const quote = line[cursor++];
      while (cursor < line.length) {
        if (line[cursor] === quote) {
          cursor++;
          return decodeTomlQuotedKey(line.slice(start, cursor));
        }
        if (quote === '"' && line[cursor] === "\\") cursor++;
        cursor++;
      }
      return null;
    }
    const match = line.slice(cursor).match(/^[A-Za-z0-9_-]+/);
    if (!match) return null;
    cursor += match[0].length;
    return match[0];
  };

  whitespace();
  if (line[cursor++] !== "[") return null;
  whitespace();
  const first = component();
  if (first === null) return null;
  whitespace();
  if (line[cursor++] !== ".") return null;
  whitespace();
  const second = component();
  if (second === null) return null;
  whitespace();
  if (line[cursor++] !== "]") return null;
  whitespace();
  if (cursor < line.length && line[cursor] !== "#") return null;
  return [first, second];
}


export function foreignAgentDeclarationNames(text) {
  const names = new Set();
  for (const line of text.split(/\r?\n/)) {
    const path = agentDeclarationHeaderPath(line);
    if (path?.[0] === "agents") names.add(path[1]);
  }
  return names;
}


export function reconcileAgentDeclarations(text, declarations, { separatorAdded = false, receipt, manifestPath } = {}) {
  const unrelated = removeAgentDeclarations(text, { separatorAdded, receipt, manifestPath });
  const foreignNames = foreignAgentDeclarationNames(unrelated);
  for (const name of declarations.keys()) {
    if (foreignNames.has(name)) {
      throw new Error(`Codex agent declaration conflict for ${name}. Move or remove the unrelated [agents.${name}] table, then rerun muster install codex.`);
    }
  }
  const newline = unrelated.includes("\r\n") ? "\r\n" : "\n";
  const region = declarationRegion(declarations, newline);
  const nextSeparatorAdded = unrelated !== "" && !unrelated.endsWith("\n");
  return {
    text: unrelated + (nextSeparatorAdded ? newline : "") + region,
    separatorAdded: nextSeparatorAdded,
    receipt: declarationRegionReceipt(unrelated + (nextSeparatorAdded ? newline : "") + region)
  };
}


export function validateThreadLimitManifest(manifest, manifestPath, expectedConfigPath) {
  const currentKeys = Object.keys(REQUIRED_CODEX_THREAD_LIMITS);
  const legacyKeys = ["max_threads", "max_depth"];
  const receiptInteger = value => typeof value === "string"
    && /^[1-9]\d*$/.test(value)
    && BigInt(value) > BigInt(Number.MAX_SAFE_INTEGER)
    ? BigInt(value)
    : Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : null;
  const sameReceiptInteger = (left, right) => {
    const leftExact = receiptInteger(left);
    const rightExact = receiptInteger(right);
    return leftExact !== null && rightExact !== null && leftExact === rightExact;
  };
  const schemaFor = value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const keys = Object.keys(value).sort();
    const exact = schema => keys.length === schema.length
      && keys.every((key, index) => key === [...schema].sort()[index]);
    const schema = exact(currentKeys) ? "current" : exact(legacyKeys) ? "legacy" : null;
    return schema && Object.values(value).every(item => item === null || receiptInteger(item) !== null)
      ? schema
      : null;
  };
  const beforeSchema = schemaFor(manifest?.before);
  const installedSchema = schemaFor(manifest?.installed);
  const legacyInstalledValue = (before, floor) => {
    const exact = receiptInteger(before) ?? 0n;
    return exact > BigInt(floor) ? exact : BigInt(floor);
  };
  const validLegacyReceipt = beforeSchema !== "legacy" || (
    receiptInteger(manifest.installed.max_threads) === legacyInstalledValue(manifest.before.max_threads, 12)
    && receiptInteger(manifest.installed.max_depth) === legacyInstalledValue(manifest.before.max_depth, 2)
  );
  const validCurrentReceipt = beforeSchema !== "current" || (
    (manifest.before.max_concurrent_threads_per_session === null
      || (receiptInteger(manifest.before.max_concurrent_threads_per_session) > 0n
        && sameReceiptInteger(
          manifest.before.max_concurrent_threads_per_session,
          manifest.installed.max_concurrent_threads_per_session,
        )))
    && receiptInteger(manifest.installed.max_concurrent_threads_per_session) > 0n
  );
  if (manifest?.owner !== "muster" || manifest.format !== 1 || manifest.configPath !== expectedConfigPath
    || typeof manifest.configCreated !== "boolean" || typeof manifest.sectionCreated !== "boolean"
    || !beforeSchema || beforeSchema !== installedSchema || !validLegacyReceipt || !validCurrentReceipt) {
    throw new Error(`Codex thread-limit manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  return manifest;
}


export async function transactionWrite(written, path, content) {
  written.set(path, await atomicWriteSafe(path, content));
}


export async function transactionRemove(written, path) {
  await removeSafe(path);
  written.set(path, { exists: false, dev: null, ino: null, bytes: null });
}


export async function profileSource(root, isPluginRoot) {
  if (isPluginRoot) {
    const dir = join(root, "agents");
    const files = await profileFiles(dir);
    return { files, read: file => readFile(join(dir, file), "utf8") };
  }
  const generated = await generateCodexProfiles(root);
  return { files: [...generated.keys()].sort(), read: async file => generated.get(file) };
}

// Preparation phase for runCodexInstall: everything the transaction below
// needs to know, computed read-only (no snapshot()/atomicWriteSafe()/removeSafe()
// touches the rollback-covered filesystem here). Validation throws, source
// resolution, path derivation, hook preparation, conflict probes, the
// marketplace pre-flight, the (non-transactional) plugin staging build, and the
// planned-op listing all live here so the transactional core stays a pure
// snapshot/write/restore sequence. Ordering is preserved exactly: profile
// conflict probe precedes the marketplace + build pre-flight, which precede the
// transaction. The only side effects are the pre-existing esbuild staging build
// and ordinaryDirectoryPath probes (create:false) -- neither is rollback-owned.

export async function prepareCodexInstall({ scope, dryRun, cwd, inventoryCwd, home, repoRoot, execFile, runtimeIdentity, hookInventory, allowInjected, nodeExecPath }) {
  if (!["project", "user"].includes(scope)) throw new Error("codex install scope must be project or user");
  const root = repoRoot || fileURLToPath(new URL("../", import.meta.url));
  const pluginRoot = await exists(join(root, ".codex-plugin", "plugin.json"));
  const packageVersion = JSON.parse(await readSafe(join(root, "package.json"))).version;
  if (typeof packageVersion !== "string" || !packageVersion.trim()) throw new Error("Codex installation source is missing a coherent package version");
  const { files, read: readProfile } = await profileSource(root, pluginRoot);
  if (!files.length) throw new Error("Codex profiles are missing; run npm run build:codex first");
  const profileContents = new Map();
  for (const file of files) profileContents.set(file, await readProfile(file));
  const declarations = new Map(files.map(file => [file.slice(0, -".toml".length), agentDescription(profileContents.get(file), file)]));
  // The richer Codex "plugin" (skills/commands/MCP) is generated fresh at
  // install time into `<distributionRoot>/.agents/plugins/`, a gitignored
  // staging directory alongside muster's own source — never into a
  // git-tracked path. The other install-time-generation target this wave
  // names (the user's CODEX_HOME) is already where scope="user" profile
  // TOMLs land via `agentsDir`/`configDir` above; the plugin tree does not
  // need a second CODEX_HOME copy of itself per scope.
  const distributionRoot = pluginRoot ? resolve(root, "..") : root;
  const dir = agentsDir(scope, cwd, home), manifestPath = join(dir, MANIFEST);
  const declarationConfigPath = join(configDir(scope, cwd, home), "config.toml");
  // Contain every generated profile filename to agentsDir before it is used as
  // a write destination below (conflict probe, planned ops, write loop).
  assertContainedProfiles(files, dir);
  // Thread-limit enforcement targets the single shared CODEX_HOME
  // config.toml (Codex CLI/IDE/Desktop all read the same file -- see
  // docs/research/codex-desktop.md section 5), independent of the profile
  // install scope above: a project-scope install still raises the global
  // floor, since that is the file Codex itself actually reads it from.
  const threadLimitConfigPath = codexThreadLimitConfigPath(codexHome(home));
  const threadLimitManifestPath = codexThreadLimitManifestPath(codexHome(home));
  await ordinaryDirectoryPath(configDir(scope, cwd, home));
  await ordinaryDirectoryPath(dir);
  const declarationOwnership = await declarationOwnershipSnapshot(manifestPath, declarationConfigPath);
  const manifest = ownershipSnapshotManifest(declarationOwnership.manifest);
  const manifestExists = declarationOwnership.manifest.exists;
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const declarationConfigExists = declarationOwnership.config.exists;
  const declarationSeparatorAdded = manifestExists && manifest.declarationSeparatorAdded === true;
  reconcileAgentDeclarations(
    ownershipSnapshotText(declarationOwnership.config),
    declarations,
    {
      separatorAdded: declarationSeparatorAdded,
      receipt: manifest?.declarationRegion,
      manifestPath
    }
  );
  const hookSourceRoot = pluginRoot ? join(root, "runtime", "install-hooks") : join(root, "codex", "hooks");
  // Canonical collapse removes the project fallback, so it is authorized only
  // by a pre-mutation persisted AND effective user-hook verdict. A later
  // hooks/list failure may block install success, but can never retroactively
  // justify deleting the fallback that was active when the command began.
  const canonicalUserExpected = scope === "project"
    ? await expectedCodexHookInstall({ dir: codexHome(home), hookSourceRoot, nodeExecPath })
    : null;
  const canonicalUserHooksActive = scope === "project" && await userScopeHooksHealthy({
    home, packageVersion, expected: canonicalUserExpected, cwd: inventoryCwd, activationCwd: cwd, runtimeIdentity, hookInventory
  });
  const hooks = await prepareHooks({ scope, cwd, inventoryCwd, home, hookSourceRoot, packageVersion, nodeExecPath, canonicalUserHooksActive });
  const managed = new Set(managedFiles.map(file => resolve(dir, file)));
  const staleFiles = managedFiles.filter(file => !files.includes(file));
  for (const file of files) {
    const destination = join(dir, file);
    if (await safeExists(destination) && !managed.has(resolve(destination))) throw new Error(`Codex profile conflict: ${destination}. Move it or remove it, then rerun muster install codex.`);
  }
  const present = await codexAvailable({ execFile, runtimeIdentity, allowInjected });
  if (present && !dryRun) {
    await existingMusterMarketplace(execFile, distributionRoot, runtimeIdentity);
    if (pluginRoot) {
      await atomicWriteSafe(join(root, ".mcp.json"), JSON.stringify(codexMcpOverlay(nodeExecPath), null, 2) + "\n");
    } else {
      // buildCodexPlugin is itself idempotent (skips regeneration when
      // outDir already holds a current-version plugin), so this fires an
      // esbuild rebuild only when actually needed — including for the many
      // tests whose actual subject is unrelated registry/hook transaction
      // behavior, not plugin generation.
      const { buildCodexPlugin } = await import("../scripts/build-codex.mjs");
      await buildCodexPlugin({ root, outDir: join(distributionRoot, ".agents", "plugins"), nodeExecPath });
    }
  }
  const planned = [
    ...files.map(file => ({ op: "write", path: join(dir, file) })),
    ...staleFiles.map(file => ({ op: "remove", path: join(dir, file) })),
    // Follows hooks.hookFiles (empty under a canonical-scope collapse), not
    // the constant HOOK_FILES -- a skipped scope writes no hook runtime.
    ...hooks.hookFiles.map(file => ({ op: "write", path: join(hooks.runtimeDir, file) })),
    ...hooks.staleFiles.map(file => ({ op: "remove", path: join(hooks.runtimeDir, file) })),
    { op: "merge", path: hooks.configPath },
    { op: "merge", path: declarationConfigPath },
    { op: "merge", path: threadLimitConfigPath }
  ];
  const pluginCacheSourceRoot = pluginRoot
    ? root
    : join(distributionRoot, ".agents", "plugins", "plugin");
  return { files, profileContents, declarations, distributionRoot, pluginCacheSourceRoot, dir, manifestPath, declarationConfigPath, declarationOwnership, threadLimitConfigPath, threadLimitManifestPath, packageVersion, canonicalUserExpected, hooks, staleFiles, present, planned };
}


export async function runCodexInstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir(), repoRoot, execFile, strictConfigRunner, runtimeIdentity, hookInventory, scopeLockOptions, nodeExecPath = process.execPath } = {}) {
  const inventoryCwd = resolve(cwd);
  cwd = await codexProjectRoot(cwd);
  const executor = execFile || execFileDefault;
  let identity = runtimeIdentity;
  if (!identity && !execFile) try { identity = resolveCodexRuntimeIdentity({ nodeExecPath }); } catch (error) {
    // An explicitly managed package root is a trust declaration, not an
    // optional availability hint. A broken declared runtime must fail closed
    // instead of silently bypassing native strict validation as "absent".
    if (process.env.CODEX_MANAGED_PACKAGE_ROOT) throw error;
    /* Codex genuinely absent: local install still proceeds without PATH probing. */
  }
  const { files, profileContents, declarations, distributionRoot, pluginCacheSourceRoot, dir, manifestPath, declarationConfigPath, declarationOwnership, threadLimitConfigPath, threadLimitManifestPath, packageVersion, canonicalUserExpected, hooks, staleFiles, present, planned } =
    await prepareCodexInstall({ scope, dryRun, cwd, inventoryCwd, home, repoRoot, execFile: executor, runtimeIdentity: identity, hookInventory, allowInjected: Boolean(execFile), nodeExecPath });
  const trustedPluginCacheTree = present && identity && !execFile
    ? await assertRegularTree(pluginCacheSourceRoot)
    : null;
  let originals, changed, written, activationProofStart, activationTransactionStable = true;
  const publishedConfigCandidates = new Map();
  const configCandidates = new Map();
  const configCandidateSources = new Map();
  let pluginStagingHome = null;
  let stagedPluginCachePath = null;
  let publishedPluginCache = null;
  const authoritativeRollbackPaths = new Set();
  let actions = [];
  let canonicalUserTrust = null;
  const prunedScopes = [], prunedHookState = [], prunedProjectTrust = [];
  if (!dryRun) {
    originals = new Map(); changed = []; written = new Map();
    await withScopeRegistryTransaction(home, async registry => {
      const checkedOwnership = await verifyDeclarationOwnershipSnapshot(
        declarationOwnership, manifestPath, declarationConfigPath
      );
      const manifest = ownershipSnapshotManifest(checkedOwnership.manifest);
      const manifestExists = checkedOwnership.manifest.exists;
      const declarationConfigExists = checkedOwnership.config.exists;
      const declarationSeparatorAdded = manifestExists && manifest.declarationSeparatorAdded === true;
      const currentHookConfigSnapshot = await safeExists(hooks.configPath) ? await readSafe(hooks.configPath) : null;
      if (currentHookConfigSnapshot !== hooks.configSnapshot) {
        throw new Error(`Codex hook configuration concurrent state change detected at ${hooks.configPath}; no installation state was modified.`);
      }
      await validateManagedHookAliasGraph({ home, cwd, inventoryCwd, entries: registry.entries, currentDir: dir, currentConfig: hooks.originalConfig });
      await ordinaryDirectoryPath(dir, { create: true });
      for (const configPath of new Set([threadLimitConfigPath, declarationConfigPath])) {
        await verifyCodexConfigRetirementReceipt(configPath);
      }
      try {
        // Codex's own plugin registration rewrites config.toml. Preserve the
        // exact pre-registration bytes here; the config transaction below is
        // deliberately derived only after registration has completed.
        for (const configPath of new Set([threadLimitConfigPath, declarationConfigPath])) {
          await snapshot(originals, changed, configPath);
        }
        const currentScope = await scopeEntry(scope, cwd, home);
        await snapshot(originals, changed, registry.path);
        // Reconcile on every install: prune scopes whose configDir no
        // longer exists (deleted worktrees) and collapse any case-duplicate
        // scope (e.g. a WSL /mnt/c path registered under two castings) into
        // one canonical-case survivor. currentScope is appended, not
        // pre-filtered against the existing entries: reconcileScopeRegistryEntries'
        // dev/ino keying (order-preserving, first physical occurrence wins)
        // already collapses a plain reinstall's already-registered scope
        // with the freshly appended currentScope for the same physical
        // directory, so a separate sameScopeEntry pre-filter here would be
        // redundant -- proven by the reinstall/dedup assertions in
        // test/codex.test.js, which stay green without it.
        // Every pruned entry is reported below (path + reason) instead of
        // removed silently, since a prune is a best-effort guess (see
        // reconcileScopeRegistryEntries).
        const candidateScopeEntries = [...registry.entries, currentScope];
        const reconciled = await reconcileScopeRegistryEntries(
          candidateScopeEntries,
          { onPrune: pruned => prunedScopes.push(pruned) }
        );
        await transactionWrite(written, registry.path, registryText(reconciled));
        for (const file of files) {
          const destination = join(dir, file);
          await snapshot(originals, changed, destination);
          await transactionWrite(written, destination, profileContents.get(file));
        }
        for (const file of staleFiles) {
          const destination = join(dir, file);
          await snapshot(originals, changed, destination);
          await transactionRemove(written, destination);
        }
        const declarationConfigCreated = manifestExists && manifest.declarationConfigCreated !== undefined
          ? manifest.declarationConfigCreated
          : !declarationConfigExists;
        for (const [file, sourceBytes] of hooks.sourceFiles) {
          const destination = join(hooks.runtimeDir, file);
          await snapshot(originals, changed, destination);
          await transactionWrite(written, destination, sourceBytes);
        }
        for (const file of hooks.staleFiles) {
          const destination = join(hooks.runtimeDir, file);
          await snapshot(originals, changed, destination);
          await transactionRemove(written, destination);
        }
        await snapshot(originals, changed, hooks.configPath);
        await transactionWrite(written, hooks.configPath, JSON.stringify(hooks.config, null, 2) + "\n");
        await snapshot(originals, changed, hooks.manifestPath);
        await transactionWrite(written, hooks.manifestPath, JSON.stringify(hooks.manifest, null, 2) + "\n");
        const installConfig = async () => {
          let verifyUnpublishedLive = null;
          try {
          try {
          const threadLimitOriginal = await exactFileSnapshot(threadLimitConfigPath);
          const configExistedBefore = threadLimitOriginal.exists;
          const existingConfigText = configSnapshotText(threadLimitOriginal, threadLimitConfigPath);
          // Reconcile config.toml's [hooks.state] trust cache against the
          // SAME candidate/survivor scope sets the registry reconciliation
          // above just computed, before raising the thread limits on the
          // result -- see reconcileConfigTomlHookState's own rationale: this
          // is the fix for codex-hook-bombardment (a dead or case-duplicated
          // scope's hook definitions stay trusted, and thus still fire,
          // forever without this). No ownedHookStateKeys is threaded through
          // here for an ORDINARY reinstall: the current scope is always in
          // `reconciled` (kept), so it is never a pruning candidate in the
          // first place -- a plain reinstall that re-adds equivalent groups
          // must never re-prompt Codex's own hook trust review.
          //
          // A canonical-scope collapse (hooks.skipped, see prepareHooks'
          // userScopeHooksHealthy) is the one install-time exception: it just
          // vacated every owned group this scope held with nothing re-added
          // in its place, so its now-orphaned trust-cache entries must be
          // pruned too -- exactly like runCodexUninstall's own departing-
          // scope prune, narrowed to the EXACT keys previousOwnedHookStateKeys
          // captured (see that field's rationale in prepareHooks) so a
          // co-located non-muster hooks.state entry at this same path is
          // never swept up. `reconciled` (kept) is unchanged either way --
          // this scope's profiles/registration stay live; only its own
          // vacated hook trust is eligible for narrowed pruning.
          const hookStateEntries = hooks.skipped && hooks.previousOwnedHookStateKeys.length
            ? candidateScopeEntries.map(entry => sameScopeEntry(entry, currentScope)
                ? { ...entry, ownedHookStateKeys: hooks.previousOwnedHookStateKeys }
                : entry)
            : candidateScopeEntries;
          const hookStateKeptEntries = hooks.skipped && hooks.pruneWholePreviousHookState
            ? reconciled.filter(entry => !sameScopeEntry(entry, currentScope))
            : reconciled;
          const hookStateReconcile = reconcileConfigTomlHookState(existingConfigText, hookStateEntries, hookStateKeptEntries, {
            onPrune: pruned => (pruned.type === "hooks.state" ? prunedHookState : prunedProjectTrust).push(pruned)
          });
          if (!hookStateReconcile.parseOk) throw new Error("Codex config.toml cannot be safely reconciled because its TOML string, array, or table boundaries are malformed or unsupported");
          const previousManifest = await safeExists(threadLimitManifestPath)
            ? validateThreadLimitManifest(
              await readJson(threadLimitManifestPath),
              threadLimitManifestPath,
              threadLimitConfigPath,
            )
            : null;
          const legacyManifest = Object.hasOwn(previousManifest?.installed || {}, "max_threads");
          const reconciledThreadText = legacyManifest
            ? restoreCodexThreadLimits(hookStateReconcile.text, previousManifest)
            : hookStateReconcile.text;
          const threadLimits = ensureCodexThreadLimits(reconciledThreadText);
          // A repeat install must not re-derive before/sectionCreated/
          // configCreated from the already-managed file -- that would
          // permanently lose the true pre-Muster baseline the very first
          // install recorded, so an eventual last-scope uninstall could
          // never fully restore it. Mirrors prepareHooks' identical
          // `previous?.hookConfigCreated ?? !configExists` guard above.
          const currentCanonicalValue = threadLimits.before.max_concurrent_threads_per_session;
          // A missing live key is an authoritative user deletion, not an
          // unchanged managed value. Rebase this key's ownership so the
          // default added by this reinstall is removed on uninstall instead
          // of resurrecting the stale pre-deletion user value.
          const before = previousManifest && !legacyManifest && currentCanonicalValue !== null
            ? previousManifest.before
            : threadLimits.before;
          const installed = previousManifest && !legacyManifest && currentCanonicalValue !== null
            ? previousManifest.installed
            : threadLimits.installed;
          const ownershipRebased = previousManifest && !legacyManifest && currentCanonicalValue === null;
          const sectionCreated = previousManifest && !legacyManifest && !ownershipRebased
            ? previousManifest.sectionCreated
            : threadLimits.sectionCreated;
          const configCreated = previousManifest && !ownershipRebased
            ? previousManifest.configCreated
            : !(scope === "user" ? declarationConfigExists : configExistedBefore);
          await snapshot(originals, changed, threadLimitConfigPath);
          configCandidates.set(threadLimitConfigPath, Buffer.from(threadLimits.text));
          configCandidateSources.set(threadLimitConfigPath, threadLimitOriginal);
          await snapshot(originals, changed, threadLimitManifestPath);
          await transactionWrite(written, threadLimitManifestPath, JSON.stringify({
            format: 1, owner: "muster", configPath: threadLimitConfigPath,
            before, installed,
            sectionCreated, configCreated
          }, null, 2) + "\n");
        } catch (error) {
          throw new Error(`Codex config.toml thread limits could not be enforced at ${threadLimitConfigPath}: ${error.message}. ${CODEX_THREAD_LIMIT_REMEDIATION}`);
        }
        // Declarations are appended only after the shared [agents] thread-limit
        // table is reconciled. This keeps pre-existing root assignments at the
        // TOML root and also makes the first user-scope install byte-identical
        // to every reinstall.
        const declarationOriginal = await exactFileSnapshot(declarationConfigPath);
        const currentDeclarationText = configCandidates.has(declarationConfigPath)
          ? new TextDecoder("utf-8", { fatal: true }).decode(configCandidates.get(declarationConfigPath))
          : configSnapshotText(declarationOriginal, declarationConfigPath);
        const declarationReconcile = reconcileAgentDeclarations(
          currentDeclarationText,
          declarations,
          {
            separatorAdded: declarationSeparatorAdded,
            receipt: manifest?.declarationRegion,
            manifestPath
          }
        );
        await snapshot(originals, changed, declarationConfigPath);
        configCandidates.set(declarationConfigPath, Buffer.from(declarationReconcile.text));
        if (!configCandidateSources.has(declarationConfigPath)) {
          configCandidateSources.set(declarationConfigPath, declarationOriginal);
        }
        await snapshot(originals, changed, manifestPath);
        await transactionWrite(written, manifestPath, JSON.stringify({
          format: 1, owner: "muster", files, packageVersion,
          declarationConfigCreated,
          declarationSeparatorAdded: declarationReconcile.separatorAdded,
          declarationRegion: declarationReconcile.receipt
        }, null, 2) + "\n");
        await validateManagedHookAliasGraph({ home, cwd, inventoryCwd, entries: reconciled, currentDir: dir, currentConfig: hooks.config });
        if (hooks.skipped) {
          canonicalUserTrust = await inspectEffectiveUserScopeHooks({
            home, packageVersion, expected: canonicalUserExpected, cwd: inventoryCwd, activationCwd: cwd,
            runtimeIdentity: identity, hookInventory
          });
          if (!canonicalUserTrust) {
            throw new Error("The canonical user hook scope changed or became inactive during install; cannot remove the project hook fallback");
          }
          await scopeLockOptions?.afterCanonicalVerification?.();
        }
        const hookMutationProof = await hookActivationSnapshot({ home, cwd, inventoryCwd });
        if (hooks.skipped && !sameHookActivationSnapshot(canonicalUserTrust.activationSnapshot, hookMutationProof)) {
          throw new Error("The canonical user hook scope changed after effective verification; cannot remove the project hook fallback");
        }
        if (!activationSnapshotMatchesWrites(hookMutationProof, written)) {
          throw new Error("Codex hook activation state diverged from the transaction's exact writes before verification");
        }

        // Parse after every shared and scoped config candidate is complete.
        // Plugin registration then runs only against a private CODEX_HOME;
        // its resulting config is parsed again before the exact bytes are
        // exclusively published to the real configuration paths.
        // Production always takes the bounded native parser path; tests with an
        // injected command runner opt into this boundary explicitly.
        const configParser = strictConfigRunner || (!execFile && identity ? runCodexStrictConfigCheck : null);
        {
          const transactionTargets = [...new Set([threadLimitConfigPath, declarationConfigPath])];
          const candidateSnapshots = new Map();
          for (const path of transactionTargets) candidateSnapshots.set(path, {
            exists: true, bytes: configCandidates.get(path), dev: null, ino: null
          });
          const projectConfigPath = join(cwd, ".codex", "config.toml");
          const liveExpected = new Map();
          for (const path of transactionTargets) liveExpected.set(path, configCandidateSources.get(path));
          if (!liveExpected.has(projectConfigPath)) liveExpected.set(projectConfigPath, await exactFileSnapshot(projectConfigPath));
          const runConfigParser = async () => {
            if (!configParser) return;
            const projectCandidate = candidateSnapshots.get(projectConfigPath) || liveExpected.get(projectConfigPath);
            await configParser({
              cwd,
              codexHome: codexHome(home),
              runtimeIdentity: identity,
              configSnapshots: {
                shared: { path: threadLimitConfigPath, ...candidateSnapshots.get(threadLimitConfigPath) },
                project: { path: projectConfigPath, ...projectCandidate }
              }
            });
          };
          const verifyLive = async phase => {
            const concurrent = [];
            for (const [path, expected] of liveExpected) {
              let current;
              try { current = await exactFileSnapshot(path); }
              catch { current = { exists: false, bytes: null, dev: null, ino: null }; }
              if (!sameExactFileSnapshot(expected, current)) concurrent.push(path);
            }
            if (concurrent.length) throw concurrentConfigError(`Codex config changed during ${phase}: ${concurrent.join(", ")}; concurrent bytes were preserved`);
          };
          verifyUnpublishedLive = verifyLive;
          const runVerifiedConfigParser = async phase => {
            try { await runConfigParser(); }
            catch (error) {
              await verifyLive(`${phase} failure`);
              throw error;
            }
            await verifyLive(phase);
          };
          await runVerifiedConfigParser("strict validation");
          if (present) {
            await ordinaryDirectoryPath(dirname(codexHome(home)), { create: true });
            pluginStagingHome = await mkdtemp(join(dirname(codexHome(home)), ".muster-codex-plugin-config-"));
            try {
              const stagedConfigPath = join(pluginStagingHome, "config.toml");
              await atomicWriteSafe(stagedConfigPath, candidateSnapshots.get(threadLimitConfigPath).bytes);
              actions = await registerPlugin(executor, distributionRoot, {
                dryRun: false,
                runtimeIdentity: identity,
                commandOptions: { env: { ...process.env, CODEX_HOME: pluginStagingHome } }
              });
              const registered = await exactFileSnapshot(stagedConfigPath);
              if (!registered.exists) throw new Error("Codex staged plugin registration removed config.toml");
              const finalShared = { exists: true, bytes: registered.bytes, dev: null, ino: null };
              candidateSnapshots.set(threadLimitConfigPath, finalShared);
              configCandidates.set(threadLimitConfigPath, registered.bytes);
              if (identity && !execFile) {
                stagedPluginCachePath = join(pluginStagingHome, "plugins", "cache", "muster", "muster", packageVersion);
                await assertPrivatePluginCache(stagedPluginCachePath, packageVersion, {
                  sourceRoot: pluginCacheSourceRoot, sourceTree: trustedPluginCacheTree
                });
              }
            } catch (error) {
              await rm(pluginStagingHome, { recursive: true, force: true });
              pluginStagingHome = null;
              throw error;
            }
            await verifyLive("staged plugin registration");
            await runVerifiedConfigParser("final strict validation");
          }

          if (stagedPluginCachePath) {
            publishedPluginCache = await publishStagedPluginCache(
              stagedPluginCachePath, codexHome(home), packageVersion,
              pluginCacheSourceRoot, trustedPluginCacheTree
            );
            stagedPluginCachePath = null;
          }

          // Retire the expected name and publish by exclusive hard-link. Any
          // writer that wins after validation remains authoritative and blocks
          // this install instead of being overwritten.
          for (const path of transactionTargets) {
            const current = await exactFileSnapshot(path);
            if (!sameExactFileSnapshot(liveExpected.get(path), current)) {
              throw concurrentConfigError(`Codex config changed before strict candidate publication: ${path}; concurrent bytes were preserved`);
            }
            publishedConfigCandidates.set(path, await publishConfigCandidate(
              path, liveExpected.get(path), candidateSnapshots.get(path).bytes
            ));
          }
          for (const [path, receipt] of publishedConfigCandidates) {
            if (!sameExactFileSnapshot(receipt.published, await exactFileSnapshot(path))) {
              throw concurrentConfigError(`Codex config changed during strict candidate publication: ${path}; concurrent bytes were preserved`);
            }
          }
        }
        for (const [path, receipt] of publishedConfigCandidates) {
          if (!sameExactFileSnapshot(receipt.published, await exactFileSnapshot(path))) {
            throw concurrentConfigError(`Codex config changed at the strict config commit point: ${path}; concurrent bytes were preserved`);
          }
          if (receipt.retired && !sameExactFileSnapshot(receipt.expected, await exactFileSnapshot(receipt.retired))) {
            throw concurrentConfigError(`Codex config writer changed the retired baseline before the commit point: ${path}; concurrent bytes will be restored`);
          }
        }
        await verifyPublishedPluginCache(publishedPluginCache);
        for (const [path, receipt] of publishedConfigCandidates) {
          if (!receipt.retired) continue;
          await retainConfigArtifacts(path, [receipt.retired]);
        }
        if (pluginStagingHome) {
          await rm(pluginStagingHome, { recursive: true, force: true });
          pluginStagingHome = null;
        }
        await verifyPublishedPluginCache(publishedPluginCache);
        for (const configPath of new Set([threadLimitConfigPath, declarationConfigPath])) {
          await verifyCodexConfigRetirementReceipt(configPath);
        }
          } catch (error) {
            const rollbackErrors = [];
            if (!publishedConfigCandidates.size && verifyUnpublishedLive && !error?.musterConcurrentConfig) {
              try { await verifyUnpublishedLive("failed config transaction"); }
              catch (concurrentError) { error = concurrentError; }
            }
            for (const receipt of [...publishedConfigCandidates.values()].reverse()) {
              try {
                await rollbackConfigCandidate(receipt);
                if (!sameExactFileSnapshot(receipt.expected, await exactFileSnapshot(receipt.path))) {
                  authoritativeRollbackPaths.add(receipt.path);
                }
              } catch (rollbackError) {
                // Once candidate rollback cannot prove the expected bytes at
                // this path, the outer snapshot rollback must not overwrite
                // whatever a concurrent writer left there.
                authoritativeRollbackPaths.add(receipt.path);
                rollbackErrors.push(rollbackError);
              }
            }
            try { await rollbackPublishedPluginCache(publishedPluginCache); }
            catch (rollbackError) { rollbackErrors.push(rollbackError); }
            publishedPluginCache = null;
            if (pluginStagingHome) {
              try { await rm(pluginStagingHome, { recursive: true, force: true }); }
              catch (rollbackError) { rollbackErrors.push(rollbackError); }
              pluginStagingHome = null;
            }
            publishedConfigCandidates.clear();
            if (rollbackErrors.length) {
              throw new AggregateError([error, ...rollbackErrors],
                `${error.message}; ${rollbackErrors.length} config rollback operation(s) also failed`, { cause: error });
            }
            throw error;
          }
        };
        if (!present) actions = [];
        await installConfig();
        // Strict config publication intentionally changes config.toml after the
        // hook transaction is proven. Start the hooks/list stability window
        // only once every intentional activation input is at its committed
        // identity, while still requiring all transaction-managed hook writes
        // to match their exact receipts.
        activationProofStart = await hookActivationSnapshot({ home, cwd, inventoryCwd });
        activationTransactionStable = activationSnapshotMatchesWrites(activationProofStart, written);
      } catch (error) {
        const rollbackErrors = [];
        // Config candidates are never written by the generic transaction:
        // before publication these live paths remain untouched, and after
        // publication the identity-aware candidate rollback above owns them.
        // Always excluding them also closes the post-verification window in
        // which a concurrent writer could otherwise be overwritten while
        // unrelated managed files are being restored.
        const skip = new Set([
          threadLimitConfigPath, declarationConfigPath, ...authoritativeRollbackPaths
        ]);
        try { await restoreFilesystem(originals, changed, { skip, written }); }
        catch (rollbackError) { rollbackErrors.push(rollbackError); }
        if (rollbackErrors.length) {
          throw new AggregateError([error, ...rollbackErrors],
            `${error.message}; ${rollbackErrors.length} rollback operation(s) also failed`, { cause: error });
        }
        throw error;
      }
    }, scopeLockOptions);
  } else {
    actions = present ? await registerPlugin(executor, distributionRoot, { dryRun: true, runtimeIdentity: identity }) : [];
  }
  const trustRemediation = "Open Codex, run /hooks, and trust the exact current Muster hook definitions, then rerun muster install codex to verify them";
  let hookTrust;
  if (dryRun) {
    hookTrust = { ok: false, blocking: false, verified: false, results: [], stale: [], effective: { verified: false, ok: false, results: [], error: "dry-run does not verify effective hook activation" }, remediation: null };
  } else {
    if (hooks.skipped) canonicalUserTrust = await inspectEffectiveUserScopeHooks({
      home, packageVersion, expected: canonicalUserExpected, cwd: inventoryCwd, activationCwd: cwd,
      runtimeIdentity: identity, hookInventory
    });
    const trustTarget = hooks.skipped ? canonicalUserTrust : {
      configPath: hooks.configPath,
      config: hooks.config,
      hookGroups: hooks.manifest.hookGroups,
      knownKeys: codexHookStateKeys(hooks.config),
      gaps: musterHookTrustGaps({
        configTomlText: await readSafe(threadLimitConfigPath),
        hooksJsonPath: hooks.configPath,
        config: hooks.config,
        hookGroups: hooks.manifest.hookGroups
      })
    };
    const gaps = trustTarget?.gaps ?? { results: [], untrusted: ["canonical-scope-invalid"], stale: [] };
    const inventoryReader = hookInventory || readCodexHookInventory;
    const activationBefore = activationProofStart;
    const inventoryArgs = {
      runtimeIdentity: identity,
      cwds: [inventoryCwd],
      env: { ...process.env, CODEX_HOME: codexHome(home) }
    };
    const proof = hooks.skipped ? null : await verifiedHookInventory({
      inventoryReader, inventoryArgs, cwd: inventoryCwd,
      hooksJsonPath: trustTarget.configPath, activationSnapshot: activationBefore
    });
    const activationAfter = await hookActivationSnapshot({ home, cwd, inventoryCwd });
    const activationStable = activationTransactionStable
      && sameHookActivationSnapshot(activationBefore, activationAfter);
    const effective = hooks.skipped
      ? trustTarget && activationStable
        ? canonicalUserTrust.effective
        : { verified: true, ok: false, error: "Codex canonical user hooks changed or became inactive after project fallback removal", results: [] }
      : proof.alias
        ? { verified: true, ok: false, error: "Codex hooks/list reported another source invoking the managed Muster runtime", results: [] }
        : !activationStable || !proof.stable
        ? { verified: true, ok: false, error: "Codex hook activation state changed during hooks/list verification", results: [] }
        : effectiveHookTrust(proof.inventory, inventoryCwd, trustTarget.configPath, gaps.results, { knownKeys: trustTarget.knownKeys });
    const persistedOk = gaps.untrusted.length === 0 && gaps.stale.length === 0;
    hookTrust = {
      ok: persistedOk && effective.ok,
      blocking: !persistedOk || !effective.ok,
      verified: true,
      results: gaps.results,
      stale: gaps.stale,
      effective,
      remediation: !persistedOk || !effective.ok ? trustRemediation : null
    };
  }
  return { ok: dryRun ? true : hookTrust.ok, target: "codex", scope, dryRun, profiles: files.length, hooks: Object.keys(hooks.manifest.hookGroups).length, files: planned,
    hooksSkipped: hooks.skipped,
    hookTrust,
    prunedScopes, prunedHookState, prunedProjectTrust,
    plugin: present ? { registered: !dryRun, actions } : { registered: false, skipped: "codex-not-found" },
    nextSteps: [
      ...(present ? [] : ["npm install -g @openai/codex", `muster install codex --scope ${scope}`]),
      ...(hookTrust.remediation ? [hookTrust.remediation] : [])
    ] };
}


export async function remainingManagedScopes(registry, currentScope) {
  const liveScopes = [];
  for (const entry of registry.entries) {
    if (sameScopeEntry(entry, currentScope)) continue;
    if (!(await ordinaryDirectoryPath(entry.configDir))) continue;
    const entryAgents = join(entry.configDir, "agents"), entryManifest = join(entryAgents, MANIFEST);
    if (!(await ordinaryDirectoryPath(entryAgents))) continue;
    if (!(await safeExists(entryManifest))) continue;
    validateManagedFiles(await readJson(entryManifest), entryAgents, entryManifest);
    liveScopes.push(entry);
  }
  return liveScopes;
}

// Preparation phase for runCodexUninstall: resolve profile/hook/thread-limit
// state and the removal decisions read-only, before the transaction. No
// snapshot()/atomicWriteSafe()/removeSafe() runs here -- every rollback-covered
// mutation stays inside uninstallScope's try/restore boundary. Order-sensitive
// steps are preserved exactly: departingScopeOwnedHookStateKeys is captured from
// the raw hooks.json BEFORE removeOwnedHookGroups strips muster's own groups.

export async function prepareCodexUninstall({ scope, cwd, activationCwds = [], home, execFile, runtimeIdentity, allowInjected }) {
  if (!["project", "user"].includes(scope)) throw new Error("codex uninstall scope must be project or user");
  const dir = agentsDir(scope, cwd, home), manifestPath = join(dir, MANIFEST);
  const declarationConfigPath = join(configDir(scope, cwd, home), "config.toml");
  await ordinaryDirectoryPath(configDir(scope, cwd, home));
  await ordinaryDirectoryPath(dir);
  const declarationOwnership = await declarationOwnershipSnapshot(manifestPath, declarationConfigPath);
  const manifest = ownershipSnapshotManifest(declarationOwnership.manifest);
  const manifestExists = declarationOwnership.manifest.exists;
  const managedFiles = manifestExists ? validateManagedFiles(manifest, dir, manifestPath) : [];
  const files = managedFiles.map(file => join(dir, file));
  const declarationConfigExists = declarationOwnership.config.exists;
  const declarationSeparatorAdded = manifestExists && manifest.declarationSeparatorAdded === true;
  const declarationConfig = manifestExists
    ? removeAgentDeclarations(
      ownershipSnapshotText(declarationOwnership.config),
      {
        separatorAdded: declarationSeparatorAdded,
        receipt: manifest.declarationRegion,
        manifestPath
      }
    )
    : null;
  const declarationConfigCreated = manifestExists && manifest.declarationConfigCreated === true;
  const hookDir = configDir(scope, cwd, home), hookRuntimeDir = join(hookDir, "muster"), hookManifestPath = join(hookRuntimeDir, MANIFEST), hookConfigPath = join(hookDir, "hooks.json");
  await ordinaryDirectoryPath(hookRuntimeDir);
  const hookManifestExists = await safeExists(hookManifestPath), hookConfigExists = await safeExists(hookConfigPath);
  const hookManifest = hookManifestExists ? validateHookManifest(await readJson(hookManifestPath), hookRuntimeDir, hookManifestPath) : null;
  const hookFiles = hookManifest ? hookManifest.files.map(file => join(hookRuntimeDir, file)) : [];
  let hookConfig = null, removeHookConfig = false, departingScopeOwnedHookStateKeys = null;
  if (hookManifest) {
    const rawHookConfig = hookConfigExists ? await readJson(hookConfigPath) : { hooks: {} };
    if (!rawHookConfig || typeof rawHookConfig !== "object" || Array.isArray(rawHookConfig)) throw new Error(`Codex hook configuration conflict: ${hookConfigPath} is not valid JSON.`);
    // Fix iteration 1 (over-revocation blocker b): compute the departing
    // scope's EXACT owned [hooks.state] keys from its hooks.json BEFORE
    // muster's own groups are stripped out below, so a co-located non-muster
    // hook definition sharing this same hooksJsonPath (a different group or
    // hook index) is never conflated with muster's own and survives.
    const derivedOwnedKeys = hookConfigExists ? ownedHookStateKeys(rawHookConfig, hookManifest.hookGroups) : [];
    const expectedOwnedCount = Object.values(hookManifest.hookGroups || {}).reduce((total, groups) => total
      + (Array.isArray(groups) ? groups.reduce((groupTotal, group) => groupTotal
        + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0) : 0), 0);
    const liveHookCount = hookConfigExists ? codexHookStateKeys(rawHookConfig).length : 0;
    if (hookConfigExists && liveHookCount > 0 && derivedOwnedKeys.length !== expectedOwnedCount) {
      throw new Error(`Codex hook conflict: a Muster-owned hook was modified or removed in ${hookConfigPath}; not every Muster-owned hook position can be identified. Restore the managed hooks or remove unrelated hooks before retrying.`);
    }
    departingScopeOwnedHookStateKeys = hookConfigExists && liveHookCount > 0 ? derivedOwnedKeys : null;
    hookConfig = removeOwnedHookGroups(rawHookConfig, hookManifest.hookGroups, hookConfigPath);
    if (Object.values(hookConfig.hooks || {}).flat().some(group => groupCommands(group).some(isMusterHookCommand))) {
      throw new Error(`Codex hook conflict: ${hookConfigPath} contains a duplicate or unmanaged Muster hook outside manifest ownership. Remove the extra group, then rerun the command.`);
    }
    if (await hasMusterHookCommandAlias(hookConfig, hookFiles, { cwds: [...new Set([cwd, ...activationCwds])] })) {
      throw new Error(`Codex hook conflict: ${hookConfigPath} contains an aliased Muster hook outside manifest ownership. Remove the alias, then rerun the command.`);
    }
    const otherKeys = Object.keys(hookConfig).filter(key => key !== "hooks");
    removeHookConfig = hookManifest.hookConfigCreated && otherKeys.length === 0 && Object.keys(hookConfig.hooks || {}).length === 0;
  }
  const hookOwnershipPaths = [...new Set([hookManifestPath, hookConfigPath, ...hookFiles])];
  const hookOwnershipSnapshot = await physicalFilesSnapshot(hookOwnershipPaths);
  const present = await codexAvailable({ execFile, runtimeIdentity, allowInjected });
  const ownsScope = manifestExists || hookManifestExists;
  const currentScope = await scopeEntry(scope, cwd, home);
  // Thread limits target the single shared CODEX_HOME config.toml (see
  // runCodexInstall), so restoring them on uninstall is gated on this being
  // the LAST Muster-managed scope -- the same "shared, not per-scope"
  // signal `removePlugin` already uses -- rather than on this scope's own
  // profile/hook ownership: uninstalling one of two managed scopes must not
  // silently lower a floor the other scope still relies on.
  const threadLimitConfigPath = codexThreadLimitConfigPath(codexHome(home));
  const threadLimitManifestPath = codexThreadLimitManifestPath(codexHome(home));
  const threadLimitManifestExists = await safeExists(threadLimitManifestPath);
  const threadLimitManifest = threadLimitManifestExists
    ? validateThreadLimitManifest(
      await readJson(threadLimitManifestPath),
      threadLimitManifestPath,
      threadLimitConfigPath,
    )
    : null;
  return { dir, manifestPath, files, declarationConfigPath, declarationOwnership, declarationConfig, declarationConfigCreated, hookRuntimeDir, hookManifestPath, hookConfigPath, hookManifestExists, hookManifest, hookConfig, removeHookConfig, departingScopeOwnedHookStateKeys, hookFiles, hookOwnershipPaths, hookOwnershipSnapshot, present, ownsScope, currentScope, threadLimitConfigPath, threadLimitManifestPath, threadLimitManifest };
}


export async function runCodexUninstall({ scope = "project", dryRun = false, cwd = process.cwd(), home = homedir(), execFile, runtimeIdentity } = {}) {
  const invocationCwd = resolve(cwd);
  const canonicalRoot = await codexProjectRoot(cwd);
  if (scope === "project") {
    const candidateRoots = [...new Set((await codexActivationConfigDirs(canonicalRoot, invocationCwd)).map(dirname))];
    const ownedRoots = [];
    for (const root of candidateRoots) if (await safeExists(join(root, ".codex", "agents", MANIFEST))
      || await safeExists(join(root, ".codex", "muster", MANIFEST))) ownedRoots.push(root);
    if (ownedRoots.length > 1) throw new Error(`Multiple Muster-owned Codex project scopes match this checkout: ${ownedRoots.join(", ")}. Uninstall each legacy scope from its own root.`);
    cwd = ownedRoots[0] || canonicalRoot;
  } else {
    cwd = canonicalRoot;
  }
  const executor = execFile || execFileDefault;
  let identity = runtimeIdentity;
  if (!identity && !execFile) try { identity = resolveCodexRuntimeIdentity(); } catch { /* Codex absent: local cleanup still proceeds without PATH probing */ }
  const { dir, manifestPath, files, declarationConfigPath, declarationOwnership, declarationConfig: preflightDeclarationConfig, declarationConfigCreated: preflightDeclarationConfigCreated, hookRuntimeDir, hookManifestPath, hookConfigPath, hookManifestExists, hookManifest, hookConfig, removeHookConfig, departingScopeOwnedHookStateKeys, hookFiles, hookOwnershipPaths, hookOwnershipSnapshot, present, ownsScope: preflightOwnsScope, currentScope, threadLimitConfigPath, threadLimitManifestPath, threadLimitManifest } =
    await prepareCodexUninstall({ scope, cwd, activationCwds: [invocationCwd], home, execFile: executor, runtimeIdentity: identity, allowInjected: Boolean(execFile) });
  let liveScopes = [], ownershipCertain = false, removePlugin = false, restoreThreadLimits = false, removeThreadLimitConfig = false;
  let manifestExists = declarationOwnership.manifest.exists;
  let ownsScope = preflightOwnsScope;
  let declarationConfigExists = declarationOwnership.config.exists;
  let declarationConfig = preflightDeclarationConfig;
  let declarationConfigCreated = preflightDeclarationConfigCreated;
  let removeDeclarationConfig = declarationConfigExists && declarationConfigCreated && declarationConfig?.trim() === "";
  const prunedHookState = [], prunedProjectTrust = [];
  const uninstallScope = async registry => {
    if (!dryRun) {
      const checkedHookOwnership = await physicalFilesSnapshot(hookOwnershipPaths);
      if (!samePhysicalFilesSnapshot(hookOwnershipSnapshot, checkedHookOwnership)) {
        throw new Error("Codex hook ownership concurrent state change detected; no installation state was modified.");
      }
      const registeredActivationCwds = registry.entries
        .filter(entry => entry.scope === "project")
        .map(entry => dirname(entry.configDir));
      if (hookManifest && await hasMusterHookCommandAlias(hookConfig, hookFiles, {
        cwds: [...new Set([cwd, invocationCwd, ...registeredActivationCwds])]
      })) {
        throw new Error(`Codex hook conflict: ${hookConfigPath} contains an aliased Muster hook outside manifest ownership. Remove the alias, then rerun the command.`);
      }
      const checkedOwnership = await verifyDeclarationOwnershipSnapshot(
        declarationOwnership, manifestPath, declarationConfigPath
      );
      const checkedManifest = ownershipSnapshotManifest(checkedOwnership.manifest);
      manifestExists = checkedOwnership.manifest.exists;
      ownsScope = manifestExists || hookManifestExists;
      declarationConfigExists = checkedOwnership.config.exists;
      declarationConfigCreated = manifestExists && checkedManifest.declarationConfigCreated === true;
      declarationConfig = manifestExists
        ? removeAgentDeclarations(ownershipSnapshotText(checkedOwnership.config), {
          separatorAdded: checkedManifest.declarationSeparatorAdded === true,
          receipt: checkedManifest.declarationRegion,
          manifestPath
        })
        : null;
      removeDeclarationConfig = declarationConfigExists && declarationConfigCreated && declarationConfig?.trim() === "";
    }
    liveScopes = await remainingManagedScopes(registry, currentScope);
    ownershipCertain = registry.present;
    removePlugin = present && ownsScope && ownershipCertain && liveScopes.length === 0;
    restoreThreadLimits = Boolean(threadLimitManifest) && ownershipCertain && liveScopes.length === 0;
    if (dryRun) return;
    const originals = new Map(), changed = [], written = new Map();
    try {
      await snapshot(originals, changed, registry.path);
      await transactionWrite(written, registry.path, registryText(liveScopes));
      for (const file of files) { await snapshot(originals, changed, file); await transactionRemove(written, file); }
      if (manifestExists) { await snapshot(originals, changed, manifestPath); await transactionRemove(written, manifestPath); }
      if (manifestExists && declarationConfigExists) {
        await snapshot(originals, changed, declarationConfigPath);
        if (removeDeclarationConfig) await transactionRemove(written, declarationConfigPath);
        else await transactionWrite(written, declarationConfigPath, declarationConfig);
      }
      for (const file of hookFiles) { await snapshot(originals, changed, file); await transactionRemove(written, file); }
      if (hookManifestExists) { await snapshot(originals, changed, hookManifestPath); await transactionRemove(written, hookManifestPath); }
      if (hookManifest) {
        await snapshot(originals, changed, hookConfigPath);
        if (removeHookConfig) await transactionRemove(written, hookConfigPath);
        else await transactionWrite(written, hookConfigPath, JSON.stringify(hookConfig, null, 2) + "\n");
      }
      // Fix for codex-hook-bombardment: the scope being uninstalled just had
      // its OWN hooks.json rewritten/removed above, so its config.toml
      // [hooks.state] entries are now orphaned -- registeredEntries (the
      // full pre-removal registry) minus liveScopes (registry.entries with
      // currentScope already excluded) makes reconcileConfigTomlHookState
      // prune exactly that scope's entries regardless of whether its
      // configDir directory still physically exists, plus any other
      // already-stale/duplicate entries as a reconciliation bonus. This
      // scope's own registry entry additionally carries
      // departingScopeOwnedHookStateKeys (fix iteration 1, blocker b) so
      // that -- unlike the OTHER stale/duplicate entries reconciled away as
      // a byproduct, whose whole hooksJsonPath prefix is pruned exactly as
      // before -- only the EXACT keys muster itself registered here are
      // removed; any co-located non-muster hooks.state entry sharing this
      // hooksJsonPath survives. This runs on every uninstall, not only the
      // last-scope thread-limit-restoring one. [projects] is never touched
      // (see reconcileConfigTomlHookState's header comment).
      const configTomlExistedBefore = await safeExists(threadLimitConfigPath);
      if (configTomlExistedBefore || restoreThreadLimits) {
        try {
          await snapshot(originals, changed, threadLimitConfigPath);
          let currentConfigText = configTomlExistedBefore ? await readSafe(threadLimitConfigPath) : "";
          const registeredEntries = registry.entries.map(entry => sameScopeEntry(entry, currentScope) && departingScopeOwnedHookStateKeys
            ? { ...entry, ownedHookStateKeys: departingScopeOwnedHookStateKeys }
            : entry);
          const hookStateReconcile = reconcileConfigTomlHookState(currentConfigText, registeredEntries, liveScopes, {
            onPrune: pruned => (pruned.type === "hooks.state" ? prunedHookState : prunedProjectTrust).push(pruned)
          });
          if (!hookStateReconcile.parseOk) throw new Error("Codex config.toml cannot be safely reconciled because its TOML string, array, or table boundaries are malformed or unsupported");
          currentConfigText = hookStateReconcile.text;
          if (restoreThreadLimits) currentConfigText = restoreCodexThreadLimits(currentConfigText, threadLimitManifest);
          removeThreadLimitConfig = restoreThreadLimits && threadLimitManifest.configCreated && currentConfigText.trim() === "";
          if (removeThreadLimitConfig) await transactionRemove(written, threadLimitConfigPath);
          else await transactionWrite(written, threadLimitConfigPath, currentConfigText);
          if (restoreThreadLimits) {
            await snapshot(originals, changed, threadLimitManifestPath);
            await transactionRemove(written, threadLimitManifestPath);
          }
        } catch (error) {
          throw new Error(`Codex config.toml hook-state/thread-limit reconciliation could not complete at ${threadLimitConfigPath}: ${error.message}. ${CODEX_THREAD_LIMIT_REMEDIATION}`);
        }
      }
      if (removePlugin) await run(executor, ["plugin", "remove", CODEX_PLUGIN], identity);
    } catch (error) {
      await restoreFilesystem(originals, changed, { written });
      throw error;
    }
    for (const empty of [join(hookRuntimeDir, "hooks"), hookRuntimeDir]) try {
      await ordinaryDirectoryPath(empty);
      await rmdir(empty);
    } catch { /* preserve non-empty user content */ }
  };
  if (dryRun) await uninstallScope(await readScopeRegistry(home));
  else await withScopeRegistryTransaction(home, uninstallScope);
  const planned = [
    ...files.map(path => ({ op: "remove", path })),
    ...(manifestExists && declarationConfigExists ? [{ op: removeDeclarationConfig ? "remove" : "merge", path: declarationConfigPath }] : []),
    ...hookFiles.map(path => ({ op: "remove", path })),
    ...(hookManifest ? [{ op: removeHookConfig ? "remove" : "merge", path: hookConfigPath }] : []),
    ...(restoreThreadLimits ? [{ op: removeThreadLimitConfig ? "remove" : "merge", path: threadLimitConfigPath }] : [])
  ];
  return { ok: true, target: "codex", scope, dryRun, files: planned,
    prunedHookState, prunedProjectTrust,
    plugin: present ? { removed: !dryRun && removePlugin, retained: liveScopes.length > 0, ownershipCertain } : { removed: false, skipped: "codex-not-found" },
    nextSteps: present ? [] : ["npm install -g @openai/codex", `muster uninstall codex --scope ${scope}`] };
}
