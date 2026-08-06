// codex-install-hooks.js -- hook trust/publication concern, split out of
// codex-install.js (split-codex-install). Owns Codex hook installation,
// hooks.json/[hooks.state] reconciliation, hook command parsing/shell-token
// analysis, and hook trust verification. Depends only on node builtins and
// codex-install-shared.js -- never on scope-lock/config-transactions/
// marketplace, and nothing in those depends back on this file.
import { lstat, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, parse, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  MANIFEST, codexHome, configDir, codexActivationConfigDirs, ordinaryDirectoryPath, safeExists, readSafe,
  physicalFileSnapshot, samePhysicalFile, readJson, validateScopeRegistry, readScopeRegistry, snapshot
} from "./codex-install-shared.js";
import { decodeTomlQuotedKey, inspectTomlHeader, scanTomlLine, splitTomlLines } from "./toml-lexer.js";
import { shellCommand, parseHookCommand, parsePosixShellTokens, parseWindowsShellTokens } from "./shell-command.js";

const HOOK_FILES = ["hooks/muster-hook.mjs", "hooks/action-guard.mjs"];

async function activationFileSnapshot(path) {
  try { return await physicalFileSnapshot(path); }
  catch (error) { return { unsafe: true, code: error.code || null, message: error.message }; }
}

async function activationDirectorySnapshot(path) {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`Codex activation directory must be an ordinary directory: ${path}`);
    return { exists: true, dev: String(metadata.dev), ino: String(metadata.ino), bytes: Buffer.alloc(0) };
  } catch (error) {
    if (error.code === "ENOENT") return { exists: false, dev: null, ino: null, bytes: null };
    return { unsafe: true, code: error.code || null, message: error.message };
  }
}

export async function hookActivationSnapshot({ home, cwd, inventoryCwd = cwd, userCodexHome = codexHome(home) }) {
  const registryPath = join(userCodexHome, "muster", "install-scopes.json");
  let registryFile = await activationFileSnapshot(registryPath);
  let entries = [];
  if (!registryFile.unsafe && registryFile.exists) {
    let registry;
    try {
      registry = JSON.parse(registryFile.bytes.toString("utf8"));
      entries = validateScopeRegistry(registryPath, registry);
    } catch (error) {
      registryFile = { unsafe: true, code: "INVALID_REGISTRY", message: error.message };
    }
  }
  const dirs = new Set([userCodexHome, join(cwd, ".codex"), ...entries.map(entry => resolve(entry.configDir))]);
  const activationConfigDirs = await codexActivationConfigDirs(cwd, inventoryCwd);
  for (const dir of activationConfigDirs) dirs.add(dir);
  const paths = [registryPath];
  for (const dir of dirs) paths.push(
    join(dir, "hooks.json"),
    join(dir, "config.toml"),
    join(dir, "muster", MANIFEST),
    join(dir, "muster", "hooks", "muster-hook.mjs"),
    join(dir, "muster", "hooks", "action-guard.mjs")
  );
  const files = new Map([[registryPath, registryFile]]);
  for (const path of [...new Set(paths)].sort()) if (path !== registryPath) files.set(path, await activationFileSnapshot(path));
  for (const activationConfigDir of activationConfigDirs) files.set(activationConfigDir, await activationDirectorySnapshot(activationConfigDir));
  return files;
}


export function sameHookActivationSnapshot(left, right) {
  if (left.size !== right.size) return false;
  for (const [path, file] of left) if (!right.has(path) || !samePhysicalFile(file, right.get(path))) return false;
  return true;
}


export function activationSnapshotMatchesWrites(activationSnapshot, written) {
  for (const [path, expected] of written) {
    if (activationSnapshot.has(path) && !samePhysicalFile(expected, activationSnapshot.get(path))) return false;
  }
  return true;
}


async function liveManagedHookScripts(home, extraConfigDirs = []) {
  const registry = await readScopeRegistry(home);
  const dirs = new Set([codexHome(home), ...extraConfigDirs, ...registry.entries.map(entry => entry.configDir)]);
  return [...dirs].map(dir => join(dir, "muster", "hooks", "muster-hook.mjs"));
}


export async function validateManagedHookAliasGraph({ home, cwd, inventoryCwd = cwd, entries, currentDir, currentConfig }) {
  const currentProjectDir = join(cwd, ".codex");
  const invocationProjectDirs = await codexActivationConfigDirs(cwd, inventoryCwd);
  const registeredDirs = new Set(entries.map(entry => resolve(entry.configDir)));
  const scopes = [
    { scope: "user", configDir: codexHome(home) },
    { scope: "project", configDir: currentProjectDir },
    ...invocationProjectDirs.filter(dir => resolve(dir) !== resolve(currentProjectDir)).map(configDir => ({ scope: "project", configDir })),
    ...entries,
    ...(currentDir ? [{ scope: currentDir === codexHome(home) ? "user" : "project", configDir: currentDir }] : [])
  ];
  const unique = new Map(scopes.map(entry => [resolve(entry.configDir), { ...entry, configDir: resolve(entry.configDir) }]));
  const runtimeScripts = [...unique.values()].map(entry => join(entry.configDir, "muster", "hooks", "muster-hook.mjs"));
  const projectCwds = [...unique.values()].filter(entry => entry.scope === "project").map(entry => dirname(entry.configDir));
  for (const entry of unique.values()) {
    const configPath = join(entry.configDir, "hooks.json");
    let config = currentDir && resolve(currentDir) === entry.configDir ? currentConfig : null;
    if (!config) {
      if (!(await safeExists(configPath))) continue;
      config = await readJson(configPath);
      if (!config || typeof config !== "object" || Array.isArray(config)) {
        throw new Error(`Codex hook configuration conflict: ${configPath} is malformed while validating managed runtime aliases.`);
      }
    }
    const invocationCwds = invocationProjectDirs.map(dirname);
    const cwds = entry.scope === "user" ? [...new Set([cwd, inventoryCwd, ...invocationCwds, ...projectCwds])]
      : [currentProjectDir, ...invocationProjectDirs].some(dir => entry.configDir === resolve(dir))
        ? [...new Set([cwd, inventoryCwd, ...invocationCwds])] : [dirname(entry.configDir)];
    const unownedCurrentProject = [currentProjectDir, ...invocationProjectDirs].some(dir => entry.configDir === resolve(dir))
      && entry.configDir !== resolve(currentDir || "") && !registeredDirs.has(entry.configDir);
    if (unownedCurrentProject && Object.values(config.hooks || {}).some(groups => Array.isArray(groups)
      && groups.some(group => groupCommands(group).some(isMusterHookCommand)))) {
      throw new Error(`Codex hook conflict: ${configPath} contains an unmanaged Muster hook in the unregistered current project.`);
    }
    if (await hasMusterHookCommandAlias(config, runtimeScripts, { cwds })) {
      throw new Error(`Codex hook conflict: ${configPath} contains a command aliased to a live managed Muster runtime.`);
    }
  }
}


const HOOK_STATE_HEADER = /^\s*\[hooks\.state\.((?:"(?:[^"\\]|\\.)*")|(?:'[^']*'))\]\s*(?:#.*)?$/;

const HOOK_STATE_KEY = /^(.*):([a-z][a-z0-9_]*):(\d+):(\d+)$/;



function parseConfigTomlTrustSections(text) {
  const { lines, endings } = splitTomlLines(text);
  const sections = [];
  let current = null;
  let multiline = null;
  let arrayDepth = 0;
  let safe = true;
  const closeCurrent = end => { if (current) { current.end = end; sections.push(current); current = null; } };
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index];
    const syntaxActive = multiline === null && arrayDepth === 0;
    const hookMatch = syntaxActive ? line.match(HOOK_STATE_HEADER) : null;
    const header = syntaxActive ? inspectTomlHeader(line) : { header: false, safe: true };
    safe &&= header.safe;
    if (syntaxActive && (hookMatch || header.header)) closeCurrent(index);
    if (hookMatch) current = { table: "hooks.state", key: decodeTomlQuotedKey(hookMatch[1]), headerLine: index };
    const scanned = header.header
      ? { multiline, arrayDepth, safe: true }
      : scanTomlLine(line, multiline, arrayDepth);
    multiline = scanned.multiline;
    arrayDepth = scanned.arrayDepth;
    safe &&= scanned.safe;
  }
  closeCurrent(lines.length);
  return { lines, endings, sections, safe, multiline, arrayDepth };
}


const renderConfigTomlTrustSections = state => state.lines.map((line, index) => line + state.endings[index]).join("");

// Converts a hooks.json event key (PascalCase, e.g. "SessionStart") to the
// snake_case form Codex records in a [hooks.state] key's <event> segment
// (e.g. "session_start") -- see docs/research/codex-cli.md section 4.1 and
// codex/hooks/hooks.json's event keys vs. the real fixture's trust keys.

const hookStateEventName = pascal => pascal.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();

// Computes the EXACT `<event>:<groupIndex>:<hookIndex>` compound keys a
// specific scope's OWN muster-authored hook groups currently occupy inside
// its live hooks.json -- fix iteration 1's answer to over-revocation blocker
// (b): locating a muster group by content (mirroring removeOwnedHookGroups'
// own `findIndex(candidate => same(candidate, group))` matching, including
// consumed-index tracking so two owned groups for the same event never
// collide on one position without shifting their original positions) rather than by hooksJsonPath alone means a
// co-located NON-muster hook definition -- sharing the same hooks.json but a
// different group/hook index -- is never included here, and so never gets
// swept up by a path-level prune.

function ownedHookStateEntries(config, hookGroups) {
  const entries = [];
  for (const [event, groups] of Object.entries(hookGroups || {})) {
    if (!Array.isArray(groups)) continue;
    const current = [...(Array.isArray(config?.hooks?.[event]) ? config.hooks[event] : [])];
    const consumed = new Set();
    const snakeEvent = hookStateEventName(event);
    for (const group of groups) {
      const index = current.findIndex((candidate, candidateIndex) => !consumed.has(candidateIndex) && same(candidate, group));
      if (index < 0) continue;
      consumed.add(index);
      const hooks = Array.isArray(group.hooks) ? group.hooks : [];
      for (let hookIndex = 0; hookIndex < hooks.length; hookIndex++) {
        entries.push({ key: `${snakeEvent}:${index}:${hookIndex}`, event, group, hook: hooks[hookIndex] });
      }
    }
  }
  return entries;
}


export function ownedHookStateKeys(config, hookGroups) {
  return ownedHookStateEntries(config, hookGroups).map(entry => entry.key);
}

// Reconciles config.toml's [hooks.state] trust cache against the
// Muster-known scope universe: `registeredEntries` is every scope Muster has
// ever recorded (the scope registry's raw entries, BEFORE its own
// reconcileScopeRegistryEntries pass -- the only place that still remembers
// a since-deleted scope's configDir at all), `keptEntries` is the subset
// that should still have a live trust-cache entry (typically that same
// reconcileScopeRegistryEntries' output for install/doctor, or the
// remaining scopes after removing the one being uninstalled). A hooks.state
// entry is pruned when its exact `<configDir>/hooks.json` prefix matches a
// REGISTERED entry that is NOT in `keptEntries` -- i.e. never touching an
// entry this pass cannot positively attribute to Muster (a plugin-bundled
// key such as "muster@muster:hooks/hooks.json:...", another tool's
// unrelated hooks.json, or any path this scope registry never recorded).
//
// A registered entry MAY additionally carry `ownedHookStateKeys` (an array
// of the exact compound keys `ownedHookStateKeys()` above computed for it):
// when present, pruning for THAT entry narrows to exactly those keys
// instead of every entry under its hooksJsonPath -- fix iteration 1's answer
// to over-revocation blocker (b), used by `muster uninstall codex` for the
// one scope actually departing (whose directory and hooks.json still fully
// exist). Every OTHER not-kept entry (a genuinely dead or case-duplicate
// scope reconciled away as a byproduct) has no such per-key attribution
// available or needed -- either its configDir no longer exists at all (no
// file left for any other tool to still depend on), or it is the exact same
// physical hooks.json as its kept survivor under a different on-disk casing
// -- so it keeps the original whole-path prune, unchanged from before this
// fix. `[projects."<root>"]` is never inspected or touched at all (see this
// section's header comment).
//
// A KEPT entry (present in `keptEntries`) with `ownedHookStateKeys` set is a
// second, narrower case (codex-hook-scope-collapse): `muster install codex`
// itself uses this when a canonical-scope collapse vacates every hook group
// a still-registered, still-live scope held (nothing re-added in its
// place) -- the scope's directory/registration survives (its profiles still
// install), but its now-orphaned hook trust does not. Without
// `ownedHookStateKeys` a kept entry is never a pruning candidate at all (an
// ordinary reinstall re-adding equivalent groups must never re-prompt
// Codex's own trust review); WITH it, pruning narrows to exactly those keys
// instead of being skipped outright.

export function reconcileConfigTomlHookState(text, registeredEntries, keptEntries, { onPrune = () => {} } = {}) {
  const state = parseConfigTomlTrustSections(text);
  if (!state.safe || state.multiline || state.arrayDepth !== 0) return { text, prunedHookState: [], prunedProjects: [], parseOk: false };
  const registered = (registeredEntries || []).map(entry => ({
    scope: entry.scope,
    configDir: entry.configDir,
    hooksJsonPath: join(entry.configDir, "hooks.json"),
    ownedHookStateKeys: Array.isArray(entry.ownedHookStateKeys) ? new Set(entry.ownedHookStateKeys) : null
  }));
  const keptHooksJsonPaths = new Set((keptEntries || []).map(entry => join(entry.configDir, "hooks.json")));
  const remove = new Array(state.lines.length).fill(false);
  const markRemoved = section => { for (let index = section.headerLine; index < section.end; index++) remove[index] = true; };
  const prunedHookState = [];
  for (const section of state.sections) {
    if (section.table !== "hooks.state" || section.key == null) continue;
    const match = section.key.match(HOOK_STATE_KEY);
    if (!match) continue;
    const [, prefix, event, groupIndex, hookIndex] = match;
    if (!isAbsolute(prefix)) continue;
    const known = registered.find(entry => entry.hooksJsonPath === prefix);
    if (!known) continue;
    if (keptHooksJsonPaths.has(known.hooksJsonPath) && !known.ownedHookStateKeys) continue;
    if (known.ownedHookStateKeys && !known.ownedHookStateKeys.has(`${event}:${groupIndex}:${hookIndex}`)) continue;
    markRemoved(section);
    const pruned = { type: "hooks.state", scope: known.scope, configDir: known.configDir, hooksJsonPath: known.hooksJsonPath, event, groupIndex: Number(groupIndex), hookIndex: Number(hookIndex) };
    prunedHookState.push(pruned);
    onPrune(pruned);
  }
  state.endings = state.endings.filter((_, index) => !remove[index]);
  state.lines = state.lines.filter((_, index) => !remove[index]);
  // prunedProjects is always empty: [projects] is never touched (see above).
  // Kept in the return shape for API stability with existing callers.
  return { text: renderConfigTomlTrustSections(state), prunedHookState, prunedProjects: [], parseOk: true };
}

// -- hook TRUST gaps: the inverse of the stale-entry reconciliation above -----
//
// Codex trusts hooks per CONTENT HASH and, per its docs, "records trust against
// the hook's current hash, so new or changed hooks are marked for review and
// SKIPPED until trusted". So the dangerous direction is not a leftover entry --
// reconcileConfigTomlHookState already handles that -- but a MISSING one: every
// `muster install codex` that alters a hook body silently stops that hook from
// firing until a human trusts it, and nothing in muster noticed. A gate that
// quietly stops firing is precisely the failure this project's guard design
// exists to prevent, so it must be reported loudly rather than inferred.
//

const HOOK_CONTEXT_EVENTS = new Set(["PreToolUse", "PostToolUse", "SessionStart", "UserPromptSubmit", "SubagentStart"]);

const MATCHER_IGNORED_EVENTS = new Set(["UserPromptSubmit", "Stop"]);

const DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT = 2_500;

const HOOK_INVENTORY_MAX_BYTES = 4 * 1024 * 1024;

const HOOK_INVENTORY_TIMEOUT_MS = 10_000;


function canonicalJson(value) {
  if (Array.isArray(value)) return value.map(canonicalJson);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalJson(value[key])]));
}

// Mirrors Codex's command_hook_hash in codex-rs/hooks/src/engine/discovery.rs:
// hash the canonical JSON serialization of a normalized, config-derived hook
// identity. Trust is deliberately verified, never created or bypassed here.

function currentCodexHookHash(event, group, hook) {
  const command = process.platform === "win32" ? (hook?.commandWindows ?? hook?.command) : hook?.command;
  const rawTimeout = Number.isSafeInteger(hook?.timeout) ? hook.timeout : null;
  const timeout = event === "SessionEnd"
    ? Math.min(3, Math.max(1, rawTimeout ?? 1))
    : Math.max(1, rawTimeout ?? 600);
  const normalizedHook = {
    type: "command",
    command,
    timeout,
    async: hook?.async === true
  };
  if (typeof hook?.statusMessage === "string") normalizedHook.statusMessage = hook.statusMessage;
  if (HOOK_CONTEXT_EVENTS.has(event)
    && Number.isSafeInteger(hook?.additionalContextLimit)
    && hook.additionalContextLimit >= 0
    && hook.additionalContextLimit !== DEFAULT_HOOK_OUTPUT_TOKEN_LIMIT) {
    normalizedHook.additionalContextLimit = hook.additionalContextLimit;
  }
  const identity = {
    event_name: hookStateEventName(event),
    hooks: [normalizedHook]
  };
  if (!MATCHER_IGNORED_EVENTS.has(event) && typeof group?.matcher === "string") identity.matcher = group.matcher;
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalJson(identity))).digest("hex")}`;
}


function hookTrustSectionState(state, section) {
  let enabled = true;
  let trustedHash = null;
  let malformed = false;
  let sawEnabled = false;
  let sawTrustedHash = false;
  for (let index = section.headerLine + 1; index < section.end; index++) {
    const line = state.lines[index];
    if (!line.trim() || /^\s*#/.test(line)) continue;
    const assignment = line.match(/^\s*((?:"(?:[^"\\]|\\.)*")|(?:'[^']*')|[A-Za-z0-9_-]+)\s*=\s*(.*?)\s*$/);
    const key = assignment ? (assignment[1][0] === "\"" || assignment[1][0] === "'"
      ? decodeTomlQuotedKey(assignment[1])
      : assignment[1]) : null;
    const enabledMatch = key === "enabled" ? assignment[2].match(/^(true|false)\s*(?:#.*)?$/) : null;
    if (key === "enabled" && enabledMatch) {
      if (sawEnabled) malformed = true;
      sawEnabled = true;
      enabled = enabledMatch[1] === "true";
      continue;
    }
    const hashMatch = key === "trusted_hash" ? assignment[2].match(/^(?:"([^"]*)"|'([^']*)')\s*(?:#.*)?$/) : null;
    if (key === "trusted_hash" && hashMatch) {
      if (sawTrustedHash) malformed = true;
      sawTrustedHash = true;
      trustedHash = hashMatch[1] ?? hashMatch[2];
      continue;
    }
    // A partial TOML interpretation must never certify this section. Unknown,
    // malformed, or future assignments fail closed until this reader can
    // model their effect on Codex hook activation.
    malformed = true;
  }
  return { enabled, trustedHash, malformed };
}


export async function readCodexHookInventory({ runtimeIdentity, cwds, env = process.env, spawnFn = spawn, timeoutMs = HOOK_INVENTORY_TIMEOUT_MS } = {}) {
  if (!runtimeIdentity?.node || !runtimeIdentity?.codex) return { ok: false, error: "pinned Codex runtime unavailable", data: [] };
  return new Promise(resolveInventory => {
    let settled = false, stdout = "", stderr = "", initialized = false;
    const finish = result => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (child.exitCode === null) child.kill();
      resolveInventory(result);
    };
    const child = spawnFn(runtimeIdentity.node, [runtimeIdentity.codex, "app-server"], {
      env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    const timer = setTimeout(() => finish({ ok: false, error: "Codex hooks/list timed out", data: [] }), timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", chunk => { stderr = (stderr + chunk).slice(-HOOK_INVENTORY_MAX_BYTES); });
    child.stdout.on("data", chunk => {
      stdout += chunk;
      if (Buffer.byteLength(stdout) > HOOK_INVENTORY_MAX_BYTES) return finish({ ok: false, error: "Codex hooks/list output exceeded its byte limit", data: [] });
      let newline;
      while ((newline = stdout.indexOf("\n")) >= 0) {
        const line = stdout.slice(0, newline); stdout = stdout.slice(newline + 1);
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1 && message.result && !initialized) {
          initialized = true;
          child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
          child.stdin.write(`${JSON.stringify({ method: "hooks/list", id: 2, params: { cwds } })}\n`);
        } else if (message.id === 1 && message.error) {
          finish({ ok: false, error: `Codex hooks/list initialize failed: ${message.error.message || "unknown error"}`, data: [] });
        } else if (message.id === 2 && message.result?.data) {
          finish({ ok: true, data: message.result.data });
        } else if (message.id === 2 && message.error) {
          finish({ ok: false, error: `Codex hooks/list failed: ${message.error.message || "unknown error"}`, data: [] });
        }
      }
    });
    child.on("error", error => finish({ ok: false, error: `Codex hooks/list launch failed: ${error.message}`, data: [] }));
    child.on("exit", code => {
      if (!settled) finish({ ok: false, error: `Codex hooks/list exited before a response (code ${code}; ${stderr.trim().slice(0, 300)})`, data: [] });
    });
    child.stdin.on("error", error => finish({ ok: false, error: `Codex hooks/list stdin failed: ${error.message}`, data: [] }));
    child.stdin.write(`${JSON.stringify({ method: "initialize", id: 1, params: { clientInfo: { name: "muster", title: "Muster", version: "0.6.0" } } })}\n`);
  });
}


const HOOK_INVENTORY_CONTROLS = /[\u0000-\u001F\u007F-\u009F]/u;

const HOOK_CONTENT_HASH = /^sha256:[0-9a-f]{64}$/;

const HOOK_RESULT_STATUSES = new Set(["invalid", "disabled", "trusted", "untrusted", "modified"]);

const validCanonicalHookPath = value => typeof value === "string" && value.length > 0
  && isAbsolute(value) && !HOOK_INVENTORY_CONTROLS.test(value) && resolve(value) === value;

const exactObject = (value, keys) => value && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && Reflect.ownKeys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

const denseArray = value => Array.isArray(value) && Reflect.ownKeys(value).every((key, index, keys) => {
  if (key === "length") return index === keys.length - 1;
  return typeof key === "string" && key === String(index);
}) && Reflect.ownKeys(value).length === value.length + 1;

function validHookPosition(value) {
  if (typeof value !== "string") return false;
  const match = value.match(/^([a-z][a-z0-9_]*):(0|[1-9]\d*):(0|[1-9]\d*)$/);
  return Boolean(match && Number.isSafeInteger(Number(match[2])) && Number.isSafeInteger(Number(match[3])));
}

function parseHookInventoryKey(value, { sourcePath, pluginId } = {}) {
  if (typeof value !== "string" || HOOK_INVENTORY_CONTROLS.test(value)) return null;
  const match = value.match(/^(.+):([a-z][a-z0-9_]*):(0|[1-9]\d*):(0|[1-9]\d*)$/);
  if (!match || !Number.isSafeInteger(Number(match[3])) || !Number.isSafeInteger(Number(match[4]))) return null;
  let path = match[1];
  if (!validCanonicalHookPath(path)) {
    const pluginPrefix = typeof pluginId === "string" ? `${pluginId}:hooks/` : null;
    const relativePluginPath = pluginPrefix && path.startsWith(pluginPrefix) ? path.slice(pluginPrefix.length) : null;
    if (!relativePluginPath || relativePluginPath.split(/[\\/]/).some(part => !part || part === "." || part === "..")
      || !validCanonicalHookPath(sourcePath)
      || !sourcePath.replaceAll("\\", "/").endsWith(`/hooks/${relativePluginPath.replaceAll("\\", "/")}`)) return null;
    path = sourcePath;
  }
  return { path, position: `${match[2]}:${match[3]}:${match[4]}` };
}


const parseInventoryHook = hook => parseHookInventoryKey(hook?.key, { sourcePath: hook?.sourcePath, pluginId: hook?.pluginId });


function validHookInventoryRecord(entry) {
  if (!exactObject(entry, ["cwd", "warnings", "errors", "hooks"])
    || !validCanonicalHookPath(entry.cwd)
    || !denseArray(entry.warnings) || !entry.warnings.every(item => typeof item === "string")
    || !denseArray(entry.errors) || !entry.errors.every(item => typeof item === "string")
    || !denseArray(entry.hooks)) return false;
  return entry.hooks.every(hook => {
    const parsed = parseInventoryHook(hook);
    const legacyShape = exactObject(hook, ["key", "enabled", "trustStatus", "currentHash"]);
    const currentShape = exactObject(hook, [
      "key", "eventName", "handlerType", "matcher", "command", "timeoutSec", "statusMessage",
      "additionalContextLimit", "sourcePath", "source", "pluginId", "displayOrder", "enabled",
      "isManaged", "currentHash", "trustStatus"
    ])
      && typeof hook.eventName === "string" && hook.eventName.length > 0 && !HOOK_INVENTORY_CONTROLS.test(hook.eventName)
      && hook.handlerType === "command"
      && (hook.matcher === null || typeof hook.matcher === "string")
      && typeof hook.command === "string" && hook.command.length > 0
      && Number.isSafeInteger(hook.timeoutSec) && hook.timeoutSec > 0
      && (hook.statusMessage === null || typeof hook.statusMessage === "string")
      && (hook.additionalContextLimit === null || (Number.isSafeInteger(hook.additionalContextLimit) && hook.additionalContextLimit >= 0))
      && validCanonicalHookPath(hook.sourcePath) && hook.sourcePath === parsed?.path
      && typeof hook.source === "string" && hook.source.length > 0 && !HOOK_INVENTORY_CONTROLS.test(hook.source)
      && (hook.pluginId === null || (typeof hook.pluginId === "string" && hook.pluginId.length > 0 && !HOOK_INVENTORY_CONTROLS.test(hook.pluginId)))
      && Number.isSafeInteger(hook.displayOrder) && hook.displayOrder >= 0
      && typeof hook.isManaged === "boolean";
    return (legacyShape || currentShape)
    && parsed !== null
    && typeof hook.enabled === "boolean"
    && typeof hook.trustStatus === "string" && hook.trustStatus.length > 0 && !HOOK_INVENTORY_CONTROLS.test(hook.trustStatus)
    && typeof hook.currentHash === "string" && HOOK_CONTENT_HASH.test(hook.currentHash);
  });
}


export function effectiveHookTrust(inventory, cwd, hooksJsonPath, results, { knownKeys } = {}) {
  if (inventory?.ok !== true) return { verified: false, ok: false, error: inventory?.error || "Codex hooks/list unavailable", results: [] };
  if (!exactObject(inventory, ["ok", "data"])) {
    return { verified: true, ok: false, error: "Codex hooks/list returned a malformed response envelope", results: [] };
  }
  if (!validCanonicalHookPath(cwd) || !validCanonicalHookPath(hooksJsonPath)) {
    return { verified: true, ok: false, error: "requested hook scope CWD or hooks.json path is malformed or noncanonical", results: [] };
  }
  if (!denseArray(results) || results.length === 0
    || !results.every(result => exactObject(result, ["key", "currentHash", "trustedHash", "enabled", "status"])
      && validHookPosition(result.key)
      && typeof result.currentHash === "string" && HOOK_CONTENT_HASH.test(result.currentHash)
      && (result.trustedHash === null || typeof result.trustedHash === "string")
      && typeof result.enabled === "boolean" && HOOK_RESULT_STATUSES.has(result.status))
    || new Set(results.map(result => result.key)).size !== results.length) {
    return { verified: true, ok: false, error: "no valid, unique expected Muster hooks were supplied for activation verification", results: [] };
  }
  if (knownKeys !== undefined && (!denseArray(knownKeys) || !knownKeys.every(validHookPosition)
    || new Set(knownKeys).size !== knownKeys.length || results.some(result => !knownKeys.includes(result.key)))) {
    return { verified: true, ok: false, error: "known hook positions are malformed, duplicate, or incomplete", results: [] };
  }
  if (!denseArray(inventory.data) || !inventory.data.every(validHookInventoryRecord)) {
    return { verified: true, ok: false, error: "Codex hooks/list returned a malformed scope or hook record", results: [] };
  }
  const inventoryCwds = inventory.data.map(entry => entry.cwd);
  if (new Set(inventoryCwds).size !== inventoryCwds.length
    || inventory.data.some(entry => new Set(entry.hooks.map(hook => hook.key)).size !== entry.hooks.length)) {
    return { verified: true, ok: false, error: "Codex hooks/list returned duplicate scope or hook records", results: [] };
  }
  const scopes = inventory.data.filter(entry => entry.cwd === cwd);
  if (scopes.length !== 1) {
    return { verified: true, ok: false, error: scopes.length ? `Codex hooks/list returned duplicate records for ${cwd}` : "Codex hooks/list omitted the requested scope", results: [] };
  }
  const scope = scopes[0];
  if (Array.isArray(scope.errors) && scope.errors.length) {
    return { verified: true, ok: false, error: scope?.errors?.join("; ") || "Codex hooks/list omitted the requested scope", results: [] };
  }
  const hooks = Array.isArray(scope.hooks) ? scope.hooks : [];
  const parsedHooks = hooks.map(hook => ({ hook, parsed: parseInventoryHook(hook) }));
  const foreignHooks = parsedHooks.filter(({ parsed }) => parsed.path !== hooksJsonPath);
  if (foreignHooks.some(({ hook }) => typeof hook.command !== "string" || isMusterHookCommand(hook.command)
    || hasUnresolvedShellExpansion(hook.command))) {
    return { verified: true, ok: false, error: "Codex hooks/list reported another source that may invoke the managed Muster runtime", results: [] };
  }
  const managedKeys = parsedHooks.filter(({ parsed }) => parsed.path === hooksJsonPath).map(({ parsed }) => parsed.position);
  if (new Set(managedKeys).size !== managedKeys.length) {
    return { verified: true, ok: false, error: `Codex hooks/list returned duplicate hook positions for ${hooksJsonPath}`, results: [] };
  }
  if (knownKeys) {
    const known = new Set(knownKeys);
    const unexpected = parsedHooks.find(({ parsed }) => parsed.path === hooksJsonPath && !known.has(parsed.position));
    if (unexpected) return { verified: true, ok: false, error: `Codex hooks/list reported an unexpected active hook position for ${hooksJsonPath}: ${unexpected.hook.key}`, results: [] };
  }
  const effectiveResults = results.map(result => {
    const expectedKey = `${hooksJsonPath}:${result.key}`;
    const hook = hooks.find(candidate => candidate?.key === expectedKey);
    const active = Boolean(hook && hook.enabled === true && hook.trustStatus === "trusted"
      && hook.currentHash === result.currentHash);
    return { key: result.key, expectedKey, present: Boolean(hook), enabled: hook?.enabled ?? null,
      trustStatus: hook?.trustStatus ?? null, currentHash: hook?.currentHash ?? null, status: active ? "active" : "inactive" };
  });
  return { verified: true, ok: effectiveResults.every(result => result.status === "active"), error: null, results: effectiveResults };
}

// Pure and text-scoped, mirroring reconcileConfigTomlHookState: verifies every
// exact owned hook against Codex's current content hash and enabled state.

export function musterHookTrustGaps({ configTomlText, hooksJsonPath, config, hookGroups } = {}) {
  const entries = ownedHookStateEntries(config, hookGroups);
  const owned = entries.map(entry => entry.key);
  if (!owned.length) return { owned: [], untrusted: [], trusted: [], results: [], stale: [] };
  const parsed = parseConfigTomlTrustSections(configTomlText ?? "");
  const states = new Map();
  const scopeKeys = [];
  for (const section of parsed.sections) {
    if (section.table !== "hooks.state" || section.key == null) continue;
    const match = section.key.match(HOOK_STATE_KEY);
    if (!match) continue;
    const [, prefix, event, groupIndex, hookIndex] = match;
    if (prefix !== hooksJsonPath) continue;
    const key = `${event}:${groupIndex}:${hookIndex}`;
    scopeKeys.push(key);
    const sectionState = hookTrustSectionState(parsed, section);
    if (states.has(key)) sectionState.malformed = true;
    states.set(key, sectionState);
  }
  const results = entries.map(({ key, event, group, hook }) => {
    const currentHash = currentCodexHookHash(event, group, hook);
    const state = states.get(key);
    const enabled = state?.enabled !== false;
    const trustedHash = state?.trustedHash ?? null;
    const status = !parsed.safe || parsed.multiline || parsed.arrayDepth !== 0 || state?.malformed ? "invalid"
      : !enabled ? "disabled"
      : trustedHash === currentHash ? "trusted"
      : trustedHash === null ? "untrusted"
      : "modified";
    return { key, currentHash, trustedHash, enabled, status };
  });
  const trusted = results.filter(result => result.status === "trusted").map(result => result.key);
  const untrusted = results.filter(result => result.status !== "trusted").map(result => result.key);
  // A state entry is stale only when its positional key no longer names ANY
  // current hook. Non-Muster hooks share this hooks.json and have legitimate
  // trust entries of their own; they are outside our exact-trust verdict but
  // must not be mistaken for removed Muster positions.
  const currentKeys = new Set();
  for (const [event, groups] of Object.entries(config?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const hooks = Array.isArray(groups[groupIndex]?.hooks) ? groups[groupIndex].hooks : [];
      for (let hookIndex = 0; hookIndex < hooks.length; hookIndex++) {
        currentKeys.add(`${hookStateEventName(event)}:${groupIndex}:${hookIndex}`);
      }
    }
  }
  const stale = [...new Set(scopeKeys.filter(key => !currentKeys.has(key)))];
  return { owned, untrusted, trusted, results, stale };
}


export function validateHookManifest(manifest, dir, manifestPath) {
  if (manifest?.owner !== "muster" || manifest.format !== 1 || !Array.isArray(manifest.files) || typeof manifest.hookGroups !== "object" || !manifest.hookGroups) {
    throw new Error(`Codex hook installation manifest conflict: ${manifestPath}. Move it or remove it, then rerun the command.`);
  }
  const base = resolve(dir), seen = new Set();
  for (const file of manifest.files) {
    const destination = typeof file === "string" ? resolve(base, file) : "";
    const rel = destination ? relative(base, destination) : "";
    if (typeof file !== "string" || !file || isAbsolute(file) || rel === ".." || rel.startsWith(`..${sep}`) || seen.has(file)) {
      throw new Error(`Invalid Muster-owned Codex hook runtime in ${manifestPath}: ${JSON.stringify(file)}. Remove the invalid manifest before retrying.`);
    }
    seen.add(file);
  }
  return { files: [...seen], hookGroups: manifest.hookGroups, hookConfigCreated: manifest.hookConfigCreated === true };
}


function clone(value) { return JSON.parse(JSON.stringify(value)); }

export const same = (left, right) => JSON.stringify(left) === JSON.stringify(right);

export const groupCommands = group => (group?.hooks || []).flatMap(hook => [hook?.command, hook?.commandWindows, hook?.command_windows]).filter(Boolean);

const MUSTER_HOOK_POSIX_SUFFIX = "/muster/hooks/muster-hook.mjs";

const MUSTER_HOOK_WINDOWS_SUFFIX = "\\muster\\hooks\\muster-hook.mjs";

export function isMusterHookCommand(command) {
  if (typeof command !== "string") return false;
  if (command.replaceAll("\\", "/").toLowerCase().includes("muster-hook.mjs")) return true;
  for (const windows of [false, true]) {
    const parsed = parseHookCommand(command, { windows });
    if (!parsed) continue;
    const script = parsed.script;
    if (posix.isAbsolute(script) && posix.normalize(script).endsWith(MUSTER_HOOK_POSIX_SUFFIX)) return true;
    if (win32.isAbsolute(script) && win32.normalize(script).toLowerCase().endsWith(MUSTER_HOOK_WINDOWS_SUFFIX)) return true;
  }
  return false;
}


function shellPathCandidates(command) {
  if (typeof command !== "string") return [];
  const candidates = new Set();
  const addCandidate = value => {
    if (!value) return;
    candidates.add(value);
    const assignment = value.match(/^[A-Za-z_][A-Za-z0-9_]*=(.+)$/s);
    if (assignment?.[1]) candidates.add(assignment[1].replace(/^["']+|["']+$/g, ""));
    const option = value.match(/^(?:--?|\/)[^:=\s]+[:=](.+)$/s);
    if (option?.[1]) candidates.add(option[1].replace(/^["']+|["']+$/g, ""));
  };
  for (const tokens of [parsePosixShellTokens(command), parseWindowsShellTokens(command)]) {
    if (tokens) for (const token of tokens) addCandidate(token);
  }
  for (const match of command.matchAll(/'([^']+)'|"([^"]+)"/g)) addCandidate(match[1] ?? match[2]);
  for (const token of command.split(/[\s;&|<>()]+/)) {
    const value = token.replace(/^["']+|["']+$/g, "");
    addCandidate(value);
  }
  return [...candidates].filter(value => value && !value.startsWith("-"));
}


function hasDynamicInterpreterEval(command) {
  for (const tokens of [parsePosixShellTokens(command), parseWindowsShellTokens(command)]) {
    if (!tokens) continue;
    for (let index = 0; index < tokens.length; index++) {
      const executable = tokens[index].replaceAll("\\", "/").split("/").pop().toLowerCase();
      const flags = [];
      for (const rawFlag of tokens.slice(index + 1)) {
        if (rawFlag === "--") break;
        flags.push(rawFlag.toLowerCase());
      }
      if (["sh", "bash", "dash", "fish", "ksh", "zsh", "sh.exe", "bash.exe", "dash.exe", "fish.exe", "ksh.exe", "zsh.exe"].includes(executable)
        && flags.some(flag => /^-[^-]*c/.test(flag))) return true;
      if (["cmd", "cmd.exe"].includes(executable) && flags.some(flag => /^\/(?:c|k)/i.test(flag))) return true;
      if (["powershell", "powershell.exe", "pwsh", "pwsh.exe"].includes(executable)
        && flags.some(flag => /^-(?:c|command|e|enc|encodedcommand)$/i.test(flag))) return true;
      if (/^(?:pythonw?|pypy)(?:\d+(?:\.\d+)*)?(?:\.exe)?$/.test(executable)
        && flags.some(flag => flag.startsWith("-c"))) return true;
      if (/^(?:ruby|perl|lua|luajit|r|rscript|osascript)(?:\.exe)?$/.test(executable)
        && flags.some(flag => /^-[^-]*e/i.test(flag))) return true;
      if (/^php(?:\.exe)?$/.test(executable) && flags.some(flag => /^-[^-]*r/i.test(flag))) return true;
      if (!["node", "node.exe", "nodejs", "nodejs.exe", "bun", "bun.exe", "deno", "deno.exe"].includes(executable)) continue;
      for (let flagIndex = 0; flagIndex < flags.length; flagIndex++) {
        const moduleOption = flags[flagIndex].match(/^--(?:experimental-loader|import|loader|preload)(?:=(.*))?$/);
        if (!moduleOption) continue;
        const specifier = moduleOption[1] ?? flags[flagIndex + 1];
        if (specifier && /^[a-z][a-z0-9+.-]*:/i.test(specifier)
          && !/^file:/i.test(specifier) && !win32.isAbsolute(specifier)) return true;
      }
      for (const flag of flags) {
        if (/^-[^-]*[ep]/.test(flag) || flag === "--eval" || flag.startsWith("--eval=")
          || flag === "--print" || flag.startsWith("--print=")
          || ((executable === "deno" || executable === "deno.exe") && flag === "eval")) return true;
      }
    }
  }
  return false;
}


const hasUnresolvedShellExpansion = command => typeof command === "string"
  && (/[\r\n]/.test(command)
    || /(^|[^\\])(?:\$[({A-Za-z_]|`)/.test(command)
    || /![^!\r\n]+!|%[^%\r\n]+%|%[0-9*~]/.test(command)
    || /(^|[\s=])~(?:[\\/]|$)|[*?]|\[[^\]\r\n]*\]/.test(command)
    || /(?:^|[;&|('"\s])(?:cd|chdir|pushd|popd)(?:\s|$)/i.test(command)
    || (!parsePosixShellTokens(command) && !parseWindowsShellTokens(command))
    || hasDynamicInterpreterEval(command));


async function physicalHookIdentity(path) {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (metadata.ino !== 0) return `inode:${metadata.dev}:${metadata.ino}`;
  return `path:${process.platform === "win32" ? canonical.toLowerCase() : canonical}`;
}


export async function hasMusterHookCommandAlias(config, expectedScripts, { cwds = [], includeDirect = false } = {}) {
  const expectedIdentities = new Set();
  for (const expectedScript of Array.isArray(expectedScripts) ? expectedScripts : [expectedScripts]) {
    try { expectedIdentities.add(await physicalHookIdentity(expectedScript)); } catch { /* absent managed runtimes cannot be alias targets */ }
  }
  if (!expectedIdentities.size) return false;
  for (const groups of Object.values(config?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (const group of groups) for (const command of groupCommands(group)) {
      if (!includeDirect && isMusterHookCommand(command)) continue;
      if (hasUnresolvedShellExpansion(command)) return true;
      for (const candidate of shellPathCandidates(command)) {
        let filesystemCandidate = candidate;
        if (/^file:/i.test(candidate)) {
          try { filesystemCandidate = fileURLToPath(candidate); }
          catch { return true; }
        }
        const paths = posix.isAbsolute(filesystemCandidate) || win32.isAbsolute(filesystemCandidate)
          ? [filesystemCandidate]
          : cwds.map(cwd => resolve(cwd, filesystemCandidate));
        for (const path of paths) try {
          if (expectedIdentities.has(await physicalHookIdentity(path))) return true;
        } catch { /* missing and foreign scripts are not managed aliases */ }
      }
    }
  }
  return false;
}


export async function hasManagedRuntimeInventoryAlias(inventory, { cwd, hooksJsonPath, activationSnapshot }) {
  const scope = Array.isArray(inventory?.data) ? inventory.data.find(entry => entry?.cwd === cwd) : null;
  if (!scope || !Array.isArray(scope.hooks)) return false;
  const commands = scope.hooks.flatMap(hook => {
    const parsed = parseInventoryHook(hook);
    return parsed && parsed.path !== hooksJsonPath && typeof hook.command === "string" ? [hook.command] : [];
  });
  if (!commands.length) return false;
  if (commands.some(hasUnresolvedShellExpansion)) return true;
  const expectedScripts = [...activationSnapshot.keys()].filter(path => path.endsWith(join("muster", "hooks", "muster-hook.mjs")));
  const config = { hooks: { Stop: commands.map(command => ({ hooks: [{ command }] })) } };
  return hasMusterHookCommandAlias(config, expectedScripts, { cwds: [cwd], includeDirect: true });
}


export async function inventoryAliasCandidateSnapshot(inventory, { cwd, hooksJsonPath }) {
  const scope = Array.isArray(inventory?.data) ? inventory.data.find(entry => entry?.cwd === cwd) : null;
  const paths = new Set();
  for (const hook of Array.isArray(scope?.hooks) ? scope.hooks : []) {
    const parsed = parseInventoryHook(hook);
    if (!parsed || parsed.path === hooksJsonPath || typeof hook.command !== "string") continue;
    for (const candidate of shellPathCandidates(hook.command)) {
      let filesystemCandidate = candidate;
      if (/^file:/i.test(candidate)) {
        try { filesystemCandidate = fileURLToPath(candidate); }
        catch { paths.add(`invalid:${candidate}`); continue; }
      }
      for (const path of posix.isAbsolute(filesystemCandidate) || win32.isAbsolute(filesystemCandidate)
        ? [filesystemCandidate] : [resolve(cwd, filesystemCandidate)]) paths.add(path);
    }
  }
  const snapshot = new Map();
  for (const path of [...paths].sort()) {
    if (path.startsWith("invalid:")) { snapshot.set(path, { invalid: true }); continue; }
    try {
      const linkMetadata = await lstat(path);
      const canonical = await realpath(path);
      const targetMetadata = await stat(canonical);
      snapshot.set(path, { canonical, linkDev: linkMetadata.dev, linkIno: linkMetadata.ino, targetDev: targetMetadata.dev, targetIno: targetMetadata.ino });
    } catch (error) {
      snapshot.set(path, { missing: error.code === "ENOENT", code: error.code || "ERROR" });
    }
  }
  return snapshot;
}


export const sameAliasCandidateSnapshot = (left, right) => same([...left], [...right]);


export async function verifiedHookInventory({ inventoryReader, inventoryArgs, cwd, hooksJsonPath, activationSnapshot }) {
  const first = await inventoryReader(inventoryArgs);
  const candidatesFirst = await inventoryAliasCandidateSnapshot(first, { cwd, hooksJsonPath });
  const inventory = await inventoryReader(inventoryArgs);
  const candidatesBeforeAlias = await inventoryAliasCandidateSnapshot(inventory, { cwd, hooksJsonPath });
  const alias = await hasManagedRuntimeInventoryAlias(inventory, { cwd, hooksJsonPath, activationSnapshot });
  const candidatesAfterAlias = await inventoryAliasCandidateSnapshot(inventory, { cwd, hooksJsonPath });
  return {
    inventory,
    alias,
    stable: same(first, inventory)
      && sameAliasCandidateSnapshot(candidatesFirst, candidatesBeforeAlias)
      && sameAliasCandidateSnapshot(candidatesBeforeAlias, candidatesAfterAlias)
  };
}


function exactMusterHookGroups(config, expectedHookGroups) {
  if (!config?.hooks || typeof config.hooks !== "object" || Array.isArray(config.hooks)) return false;
  const expected = [];
  for (const [event, groups] of Object.entries(expectedHookGroups || {})) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) {
      if (!groupCommands(group).some(isMusterHookCommand)) return false;
      expected.push({ event, group });
    }
  }
  const actual = [];
  for (const [event, groups] of Object.entries(config.hooks)) {
    if (!Array.isArray(groups)) return false;
    for (const group of groups) if (groupCommands(group).some(isMusterHookCommand)) actual.push({ event, group });
  }
  if (!expected.length || actual.length !== expected.length) return false;
  for (const item of expected) {
    const index = actual.findIndex(candidate => candidate.event === item.event && same(candidate.group, item.group));
    if (index < 0) return false;
    actual.splice(index, 1);
  }
  return actual.length === 0;
}


export function codexHookStateKeys(config) {
  const keys = [];
  for (const [event, groups] of Object.entries(config?.hooks || {})) {
    if (!Array.isArray(groups)) continue;
    for (let groupIndex = 0; groupIndex < groups.length; groupIndex++) {
      const hooks = Array.isArray(groups[groupIndex]?.hooks) ? groups[groupIndex].hooks : [];
      for (let hookIndex = 0; hookIndex < hooks.length; hookIndex++) keys.push(`${hookStateEventName(event)}:${groupIndex}:${hookIndex}`);
    }
  }
  return keys;
}


export function removeOwnedHookGroups(config, owned, configPath) {
  const next = clone(config);
  next.hooks ||= {};
  for (const [event, groups] of Object.entries(owned || {})) {
    if (!Array.isArray(groups)) throw new Error(`Invalid Muster-owned Codex hook groups in ${configPath}: ${event}`);
    const current = Array.isArray(next.hooks[event]) ? next.hooks[event] : [];
    for (const group of groups) {
      const exact = current.findIndex(candidate => same(candidate, group));
      if (exact >= 0) current.splice(exact, 1);
      else if (current.some(candidate => groupCommands(candidate).some(command => groupCommands(group).includes(command)))) {
        throw new Error(`Codex hook conflict: a Muster-owned hook was modified in ${configPath}. Restore it or remove the Muster hook manifest before retrying.`);
      }
    }
    if (current.length) next.hooks[event] = current;
    else delete next.hooks[event];
  }
  return next;
}


// Resolve the current Node executable to an absolute path and validate it is an
// ordinary regular file before it is baked into a hook command's interpreter
// slot. Follows symlinks (a nvm/homebrew node reached through a symlink is a
// legitimate interpreter) but rejects a missing path, a directory, or a
// non-absolute value so a bare/relative token can never be emitted.

async function validatedHookNode(execPath) {
  if (typeof execPath !== "string" || !execPath || !isAbsolute(execPath)) {
    throw new Error(`Cannot pin the Codex hook Node interpreter: ${JSON.stringify(execPath)} is not an absolute path. Rerun muster install codex from a normal Node installation.`);
  }
  let info;
  try { info = await stat(execPath); }
  catch (error) { throw new Error(`Cannot pin the Codex hook Node interpreter: ${execPath} is not accessible (${error.code || error.message}). Rerun muster install codex from a normal Node installation.`); }
  if (!info.isFile()) throw new Error(`Cannot pin the Codex hook Node interpreter: ${execPath} is not a regular file. Rerun muster install codex from a normal Node installation.`);
  return realpath(execPath);
}


// Canonical-scope collapse (2026-07-18 decision, doctor's codex-hooks-overlap
// check): the user scope is canonical for Codex hooks. A project-scope
// install skips writing its own hook runtime/config entirely once the USER
// scope already carries a healthy Muster hook install -- installing project
// hooks on top would only double-fire every event (hook-bombardment), and a
// REINSTALL is how a dual-scope machine converges to one firing scope
// instead of requiring a manual `muster uninstall codex --scope project`.
// Read-only and best-effort: any validation failure (corrupt manifest,
// missing/foreign hooks.json, a group that no longer matches exactly)
// reports "not healthy" rather than throwing, so a broken user scope never
// silently blocks a project-scope install -- that project scope just
// installs its own hooks exactly as it always has (prepareHooks below only
// calls this for scope === "project"; the user scope is never a candidate
// to skip its own hooks).
//
// Requires the user manifest's OWN recorded `packageVersion` to match the
// version about to be installed (review fix: a self-consistent-but-stale
// user manifest -- e.g. missing an event a newer template added -- used to
// report "healthy" purely from internal agreement between its own manifest
// and its own hooks.json, silently skipping the project scope's install and
// leaving that event firing from NEITHER scope with no signal at install
// time; `muster doctor --codex` would eventually catch the drift, but only
// if rerun). A version mismatch fails closed to "not healthy" here, exactly
// like every other validation failure above -- the project scope then
// installs its own (current) hooks rather than trusting a stale peer.

export async function expectedCodexHookInstall({ dir, hookSourceRoot, nodeExecPath }) {
  const runtimeDir = join(dir, "muster");
  const template = await readJson(join(hookSourceRoot, "hooks.json"));
  if (!template?.hooks || typeof template.hooks !== "object" || Array.isArray(template.hooks)) return null;
  const hookGroups = clone(template.hooks);
  const command = shellCommand(join(runtimeDir, "hooks", "muster-hook.mjs"), await validatedHookNode(nodeExecPath));
  let hookCount = 0;
  for (const groups of Object.values(hookGroups)) {
    if (!Array.isArray(groups) || !groups.length) return null;
    for (const group of groups) {
      if (!Array.isArray(group?.hooks) || !group.hooks.length) return null;
      for (const hook of group.hooks) {
        if (hook?.type !== "command") return null;
        hook.command = command.command;
        hook.commandWindows = command.commandWindows;
        hookCount++;
      }
    }
  }
  if (!hookCount) return null;
  const hash = createHash("sha256");
  for (const file of HOOK_FILES) hash.update(file).update("\0").update(await readSafe(join(hookSourceRoot, basename(file))));
  return { dir, runtimeDir, files: HOOK_FILES, hookGroups, hookCount, hookHash: hash.digest("hex") };
}


async function inspectUserScopeHooks({ home, packageVersion, expected, cwd }) {
  if (!expected?.hookCount || expected.hookCount < 1) return null;
  const dir = codexHome(home);
  const runtimeDir = join(dir, "muster"), manifestPath = join(runtimeDir, MANIFEST), configPath = join(dir, "hooks.json");
  if (!(await safeExists(manifestPath))) return null;
  let manifestText;
  try { manifestText = await readSafe(manifestPath); } catch { return null; }
  let manifestRaw;
  try { manifestRaw = JSON.parse(manifestText); } catch { return null; }
  if (manifestRaw?.packageVersion !== packageVersion) return null;
  let manifest;
  try { manifest = validateHookManifest(manifestRaw, runtimeDir, manifestPath); }
  catch { return null; }
  if (!same(manifest.files, HOOK_FILES) || !same(manifest.hookGroups, expected.hookGroups)
    || typeof manifestRaw.hookHash !== "string" || manifestRaw.hookHash !== expected.hookHash) return null;
  const runtimeHash = createHash("sha256"), snapshotHash = createHash("sha256").update(manifestText).update("\0");
  try {
    for (const file of HOOK_FILES) {
      const bytes = await readSafe(join(runtimeDir, file));
      runtimeHash.update(file).update("\0").update(bytes);
      snapshotHash.update(file).update("\0").update(bytes);
    }
  } catch { return null; }
  if (runtimeHash.digest("hex") !== manifestRaw.hookHash) return null;
  if (!(await safeExists(configPath))) return null;
  let configText, config;
  try { configText = await readSafe(configPath); config = JSON.parse(configText); }
  catch { return null; }
  if (!config || typeof config !== "object" || Array.isArray(config) || typeof config.hooks !== "object" || !config.hooks || Array.isArray(config.hooks)) return null;
  if (await hasMusterHookCommandAlias(config, await liveManagedHookScripts(home, [dir]), { cwds: [cwd] })) return null;
  if (!exactMusterHookGroups(config, expected.hookGroups)) return null;
  let matchedHookCount = 0;
  for (const [event, groups] of Object.entries(expected.hookGroups)) {
    const current = Array.isArray(config.hooks[event]) ? config.hooks[event] : [];
    for (const group of groups) {
      if (current.filter(candidate => same(candidate, group)).length !== 1) return null;
      matchedHookCount += group.hooks.length;
    }
    if (current.filter(group => groupCommands(group).some(isMusterHookCommand)).length !== groups.length) return null;
  }
  if (matchedHookCount !== expected.hookCount) return null;
  const configTomlPath = join(dir, "config.toml");
  const configTomlText = await safeExists(configTomlPath) ? await readSafe(configTomlPath) : "";
  const gaps = musterHookTrustGaps({ configTomlText, hooksJsonPath: configPath, config, hookGroups: manifest.hookGroups });
  snapshotHash.update("config\0").update(configText).update("\0toml\0").update(configTomlText);
  return { dir, configPath, config, hookGroups: manifest.hookGroups, gaps, knownKeys: codexHookStateKeys(config), snapshot: snapshotHash.digest("hex") };
}


export async function inspectEffectiveUserScopeHooks({ home, packageVersion, expected, cwd, activationCwd = cwd, runtimeIdentity, hookInventory }) {
  const before = await inspectUserScopeHooks({ home, packageVersion, expected, cwd });
  if (!before || before.gaps.untrusted.length || before.gaps.stale.length) return null;
  const activationBefore = await hookActivationSnapshot({ home, cwd: activationCwd, inventoryCwd: cwd });
  const inventoryReader = hookInventory || readCodexHookInventory;
  const proof = await verifiedHookInventory({ inventoryReader, inventoryArgs: {
    runtimeIdentity,
    cwds: [cwd],
    env: { ...process.env, CODEX_HOME: codexHome(home) }
  }, cwd, hooksJsonPath: before.configPath, activationSnapshot: activationBefore });
  const inspected = await inspectUserScopeHooks({ home, packageVersion, expected, cwd });
  const activationAfter = await hookActivationSnapshot({ home, cwd: activationCwd, inventoryCwd: cwd });
  if (!inspected || inspected.snapshot !== before.snapshot || inspected.gaps.untrusted.length || inspected.gaps.stale.length
    || inspected.gaps.results.length !== expected.hookCount
    || proof.alias || !proof.stable || !sameHookActivationSnapshot(activationBefore, activationAfter)) return null;
  const effective = effectiveHookTrust(proof.inventory, cwd, inspected.configPath, inspected.gaps.results, { knownKeys: inspected.knownKeys });
  return effective.ok ? { ...inspected, effective, activationSnapshot: activationAfter } : null;
}


export async function userScopeHooksHealthy(options) {
  return Boolean(await inspectEffectiveUserScopeHooks(options));
}


export async function prepareHooks({ scope, cwd, inventoryCwd = cwd, home, hookSourceRoot, packageVersion, nodeExecPath, canonicalUserHooksActive }) {
  const dir = configDir(scope, cwd, home);
  const runtimeDir = join(dir, "muster"), manifestPath = join(runtimeDir, MANIFEST), configPath = join(dir, "hooks.json");
  const runtimeScript = join(runtimeDir, "hooks", "muster-hook.mjs");
  await ordinaryDirectoryPath(dir);
  await ordinaryDirectoryPath(runtimeDir);
  const manifestExists = await safeExists(manifestPath), configExists = await safeExists(configPath);
  const manifestRaw = manifestExists ? await readJson(manifestPath) : null;
  const previous = manifestExists ? validateHookManifest(manifestRaw, runtimeDir, manifestPath) : null;
  let config = { hooks: {} };
  let configSnapshot = null;
  if (configExists) {
    try { configSnapshot = await readSafe(configPath); config = JSON.parse(configSnapshot); }
    catch { config = null; }
    if (!config || typeof config !== "object" || Array.isArray(config) || (config.hooks !== undefined && (typeof config.hooks !== "object" || Array.isArray(config.hooks)))) {
      throw new Error(`Codex hook configuration conflict: ${configPath} is not a valid hooks.json object. Repair it, then rerun the command.`);
    }
    config.hooks ||= {};
    for (const [event, groups] of Object.entries(config.hooks)) if (!Array.isArray(groups)) {
      throw new Error(`Codex hook configuration conflict: ${configPath} has a non-array ${event} hook group.`);
    }
  }
  if (!previous && Object.values(config.hooks).flat().some(group => groupCommands(group).some(isMusterHookCommand))) {
    throw new Error(`Codex hook conflict: ${configPath} contains an unmanaged Muster hook. Remove it or restore its Muster manifest, then rerun the command.`);
  }
  if (await hasMusterHookCommandAlias(config, await liveManagedHookScripts(home, [dir]), { cwds: [...new Set([cwd, inventoryCwd])] })) {
    throw new Error(`Codex hook conflict: ${configPath} contains an aliased Muster hook command. Remove the alias or restore the exact Muster hook manifest, then rerun the command.`);
  }
  const originalConfig = clone(config);
  const skipped = scope === "project" && canonicalUserHooksActive === true;
  // Captured BEFORE removeOwnedHookGroups mutates `config` below, at exactly
  // the group/hook indices this scope's PRIOR install currently occupies in
  // its own live hooks.json -- the same exact-key technique runCodexUninstall
  // uses for its own departingScopeOwnedHookStateKeys (see ownedHookStateKeys'
  // rationale above). Only consumed by runCodexInstall's writer, and only
  // when a canonical-scope collapse (skipped below) just vacated every owned
  // group this scope held with nothing re-added in its place -- an ordinary
  // reinstall that re-adds equivalent groups never reads this, so
  // config.toml's [hooks.state] trust cache stays untouched on every normal
  // reinstall exactly as before this feature.
  const previousOwnedHookStateKeys = previous ? ownedHookStateKeys(config, previous.hookGroups) : [];
  const previousExpectedOwnedCount = previous ? Object.values(previous.hookGroups || {}).reduce((total, groups) => total
    + (Array.isArray(groups) ? groups.reduce((groupTotal, group) => groupTotal
      + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0) : 0), 0) : 0;
  const previousLiveHookCount = previous ? codexHookStateKeys(config).length : 0;
  if (skipped && previous && previousLiveHookCount > 0 && previousOwnedHookStateKeys.length !== previousExpectedOwnedCount) {
    throw new Error(`Codex hook conflict: a Muster-owned hook was modified or removed in ${configPath}; not every Muster-owned hook position can be identified. Restore the managed hooks or remove unrelated hooks before retrying.`);
  }
  const pruneWholePreviousHookState = Boolean(skipped && previous && previousLiveHookCount === 0);
  if (previous) config = removeOwnedHookGroups(config, previous.hookGroups, configPath);
  if (Object.values(config.hooks).flat().some(group => groupCommands(group).some(isMusterHookCommand))) {
    throw new Error(`Codex hook conflict: ${configPath} contains a duplicate or unmanaged Muster hook outside manifest ownership. Remove the extra group, then rerun the command.`);
  }
  const templatePath = join(hookSourceRoot, "hooks.json");
  const template = await readJson(templatePath);
  if (!template?.hooks || typeof template.hooks !== "object") throw new Error(`Codex hook template is missing or malformed: ${templatePath}`);
  const command = skipped ? null : shellCommand(runtimeScript, await validatedHookNode(nodeExecPath));
  const hookGroups = skipped ? {} : clone(template.hooks);
  if (!skipped) {
    for (const groups of Object.values(hookGroups)) for (const group of groups) for (const hook of group.hooks || []) {
      hook.command = command.command;
      hook.commandWindows = command.commandWindows;
    }
    for (const [event, groups] of Object.entries(hookGroups)) config.hooks[event] = [...(config.hooks[event] || []), ...groups];
  }
  const hookFiles = skipped ? [] : HOOK_FILES;
  const sourcePaths = skipped ? new Map() : new Map([
    ["hooks/muster-hook.mjs", join(hookSourceRoot, "muster-hook.mjs")],
    ["hooks/action-guard.mjs", join(hookSourceRoot, "action-guard.mjs")]
  ]);
  const sourceFiles = new Map();
  const hookHash = createHash("sha256");
  for (const [file, sourcePath] of sourcePaths) {
    const bytes = await readSafe(sourcePath);
    sourceFiles.set(file, bytes);
    hookHash.update(file).update("\0").update(bytes);
  }
  return {
    dir, runtimeDir, manifestPath, manifestExists, configPath, configExists, config, configSnapshot, originalConfig,
    staleFiles: (previous?.files || []).filter(file => !hookFiles.includes(file)),
    manifest: { format: 1, owner: "muster", files: hookFiles, packageVersion, hookHash: hookHash.digest("hex"), hookConfigCreated: previous?.hookConfigCreated ?? !configExists, hookGroups },
    sourceFiles, hookFiles,
    skipped: skipped ? "user-scope-canonical" : null,
    previousOwnedHookStateKeys,
    pruneWholePreviousHookState
  };
}
