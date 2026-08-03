import { constants as fsConstants } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { link, lstat, mkdir, open, readFile, readdir, realpath, rename, rmdir, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readdirSafe, readJson } from "./fs-util.js";
import { atomicWrite, isContainedLexical, readNoFollowRegular, withFileMutationLock } from "./fs-safe.js";
import { matchFrontmatter } from "./frontmatter.js";
import { KIMI_LANES, kimiLaneEnv, kimiPreferenceForAgentId } from "./kimi.js";

// --- Kimi Code CLI install adapter -------------------------------------------
// The write side of the Kimi harness leg (docs/research/kimi-code-cli.md). Kimi
// loads Claude-Code-format agent .md files and SKILL.md skills natively (the
// research's "closest structural clone" finding), so `muster install kimi`
// places muster's agents, orchestration skills, and catalog-backed builtin
// skills into the gen2 data root (`$KIMI_CODE_HOME`, or ~/.kimi-code) where a
// Kimi session discovers them.
//
// Why this is a lean file copy, NOT the codex-install.js fortress: Kimi is
// hooks-free by muster's design (see memory codex-plugin-hooks-free -- Codex's
// hook-bombardment fortress exists to reconcile a shared config.toml trust
// cache muster must never double-register; Kimi has no such surface here). So
// there is no scope registry, no [hooks.state] reconciliation, no per-event
// firing source to converge -- only files to write, ONE marker-delimited
// config block (the action-class fence below -- Kimi's own declarative
// [[permission.rules]] deny, which is exactly how Kimi wants the fence
// expressed: no hook shim, survives --yolo/-p), and a manifest to remove them
// by. The safety posture that remains: a manifest scopes uninstall to
// muster's OWN files (never a wholesale rmdir over a dir the user also uses),
// every written path is containment-checked inside the dest, a symlinked
// agents/ or skills/ dest is refused rather than written through, and the
// config.toml block is merged between ownership markers so a user's own
// entries before/after it pass through byte-untouched.
//
// The agent `model:` frontmatter is left as-is and is inert on Kimi (the docs
// state Claude Code's `model` field is ignored). What Kimi DOES honour is
// `model_preference: primary | secondary`, so the install STAMPS that field on
// every agent from its manifest tier (see src/kimi.js's KIMI_LANES). Copying
// agents through untouched would be actively wrong: with a `[secondary_model]`
// configured, an agent that omits the field defaults to the SECONDARY (cheap)
// lane, which would silently demote every judgment agent.

export const KIMI_MANIFEST = ".muster-managed.json";
const KIMI_MANIFEST_QUARANTINE = ".muster-uninstall-manifest";

// Live-probed 2026-07-24 (GET https://api.kimi.com/coding/v1/models, HTTP 200):
// the managed coding plan serves EXACTLY these four, all supports_thinking_type
// "only" (always-thinking). No k2.6/k2.5, no non-thinking/general model -- so the
// scout lane rides kimi-for-coding (there is nothing cheaper to remap to).
// kimi-for-coding-highspeed is served but muster never ROUTES to it: it is the
// identical K2.7 model at ~3x plan usage, so it stays in this served-set list
// (the probe confirms the plan offers it) but never in KIMI_TIERS. See
// src/kimi.js's KIMI_TIERS and docs/research/kimi-code-cli.md 11.6-11.7.
export const KIMI_MODELS_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_EXPECTED_MODEL_IDS = Object.freeze([
  "kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"
]);

// What has to be true for the stamped model_preference lanes to actually bind.
// muster does NOT write the MODEL half of config.toml: model aliases are a
// shared, user-owned surface, and the hook-bombardment diagnosis (see
// codex-install.js) is the standing lesson about muster mutating shared
// harness config. (The one config write muster DOES make is the
// marker-delimited [[permission.rules]] fence below -- a pure add/remove of
// muster's own block, never an edit of the user's model settings.) Declining
// the model config is safe: with no secondary model configured, every agent
// inherits the caller's model and the stamps are simply inert.
//
// Two routes, and the ENV one is preferred precisely because it touches nothing
// shared: `KIMI_SECONDARY_MODEL` / `KIMI_SECONDARY_EFFORT` are per-process, so a
// muster-launched `kimi -p` gets the lanes without editing the user's config at
// all (and without changing what their interactive sessions do).
//
// The experiment gate is not optional: model_preference "applies only to newly
// spawned subagents when the secondary-model experiment is enabled", and "The TUI
// currently ignores this field" -- so lanes bind under `kimi -p` /`kimi web`, never
// in the interactive TUI.
const KIMI_SECONDARY_MODEL_CONFIG = Object.freeze({
  // Preferred: per-process, mutates nothing. Derived from the single source in
  // src/kimi.js -- the same pair kimiGoalInvocation sets on a live `kimi -p`
  // run -- so the install report can never describe a different bind than the
  // run loop actually applies.
  env: Object.freeze(kimiLaneEnv()),
  // Alternative: persistent, but edits the user's shared config.toml.
  default_model: KIMI_LANES.primary,
  toml: `[secondary_model]\nmodel = "${KIMI_LANES.secondary}"\n`
});

// Why there is NO [loop_control]/[background] emission alongside the fence:
// muster's chosen values for long unattended `/goal` runs (pinned in
// plugin/commands/go.md step 6, rationale + binary-probed defaults in
// docs/research/kimi-code-cli.md 11.10) are the v0.30.0 binary defaults (re-probed
// 2026-07-29, unchanged from v0.29.1) in
// all five cases (the four-of-five count in earlier drafts owed solely to the
// legacy keep_alive_on_exit conditional, which can downgrade an unset
// print_background_mode to drain) -- emitting them would write no-op overrides
// into the
// user-global config.toml (no project-level override exists) that leak into
// non-muster interactive sessions and go stale when Kimi changes a default.
// The per-process env overrides (KIMI_LOOP_MAX_STEPS_PER_TURN,
// KIMI_LOOP_MAX_RETRIES_PER_STEP, KIMI_CODE_BACKGROUND_MAX_RUNNING_TASKS)
// cover the one run that wants a non-default -- the same env-over-shared-config
// posture as the lane bind above. The [[permission.rules]] fence is different
// in kind: a declarative deny that does not exist by default, not a
// restatement of tuning defaults.

const kimiHome = home => process.env.KIMI_CODE_HOME || join(home, ".kimi-code");

// Resolve the plugin content root that carries agents/ and skills/. In the dev
// checkout that is <repoRoot>/plugin; in the bundled plugin runtime the runtime
// module already sits inside plugin/, so agents/ is one level up. Probe both.
async function resolvePluginRoot(root) {
  for (const candidate of [join(root, "plugin"), root]) {
    if (await exists(join(candidate, "agents"))) return candidate;
  }
  return join(root, "plugin");
}

// A dest subtree muster writes into (agents/, skills/) must be an ordinary
// directory or absent -- never a symlink we would write THROUGH to somewhere
// off the kimi root. Mirrors codex-install.js's ordinary-directory discipline,
// scoped to the one check kimi needs.
async function assertWritableDir(path) {
  let stat;
  try { stat = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Refusing to write through a non-ordinary Kimi directory: ${path}`);
  }
}

// Preflight every managed-file target before the first mutation. Lexical
// containment alone cannot see `skills/foo -> /outside`; walk each existing
// ancestor with lstat (never following links), require ordinary directories,
// then compare its canonical location with the canonical Kimi root. Final
// components must be ordinary files or absent so writeFile/copyFile cannot
// follow a file symlink either. Missing ancestry is safe to create beneath the
// already-validated ordinary prefix.
async function assertSafeManagedFiles(dest, targets) {
  const base = resolve(dest);
  let baseStat;
  try { baseStat = await lstat(base); }
  catch (error) {
    if (error.code === "ENOENT") return;
    throw error;
  }
  if (baseStat.isSymbolicLink() || !baseStat.isDirectory()) {
    throw new Error(`Refusing to mutate through a non-ordinary Kimi directory: ${base}`);
  }
  const canonicalBase = await realpath(base);

  for (const target of targets) {
    const absolute = resolve(target);
    if (!isContainedLexical(base, absolute) || absolute === base) {
      throw new Error(`Refusing a Kimi path outside ${dest}: ${JSON.stringify(target)}`);
    }

    const parentRel = relative(base, dirname(absolute));
    let current = base;
    let parentMissing = false;
    for (const part of parentRel.split(sep).filter(Boolean)) {
      current = join(current, part);
      let stat;
      try { stat = await lstat(current); }
      catch (error) {
        if (error.code === "ENOENT") { parentMissing = true; break; }
        throw error;
      }
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        throw new Error(`Refusing to mutate through a non-ordinary Kimi directory: ${current}`);
      }
      const canonical = await realpath(current);
      if (!isContainedLexical(canonicalBase, canonical)) {
        throw new Error(`Refusing a canonical Kimi path outside ${dest}: ${current}`);
      }
    }
    if (parentMissing) continue;

    let stat;
    try { stat = await lstat(absolute); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (stat.isSymbolicLink() || !stat.isFile()) {
      throw new Error(`Refusing to mutate a non-ordinary Kimi file: ${absolute}`);
    }
    const canonical = await realpath(absolute);
    if (!isContainedLexical(canonicalBase, canonical)) {
      throw new Error(`Refusing a canonical Kimi path outside ${dest}: ${absolute}`);
    }
  }
}

// Every manifest-recorded relative path must resolve strictly inside dest -- a
// defense-in-depth containment gate so a crafted manifest (uninstall) or a
// traversing source name (install) can never read/write outside the kimi root.
// The string-shape checks stay local; the resolved-path escape check delegates
// to fs-safe.js's lexical containment (audit S4). Note `target === base` is
// REJECTED even though isContainedLexical is deliberately base-inclusive: a
// rel of "." resolves to dest itself, and no manifest entry may name the kimi
// root as a file to write/unlink (the pre-S4 guard rejected it; restored).
function assertContained(relPaths, dest) {
  const base = resolve(dest);
  for (const rel of relPaths) {
    const target = resolve(base, rel);
    if (typeof rel !== "string" || rel === "" || rel.startsWith(sep) || rel.split("/").includes("..")
      || !isContainedLexical(base, target) || target === base) {
      throw new Error(`Refusing a Kimi path outside ${dest}: ${JSON.stringify(rel)}`);
    }
  }
}

// Recursively list a directory's files as paths relative to `from` (POSIX-joined
// so manifest entries are stable across platforms).
async function walkFiles(dir, from = dir) {
  const out = [];
  for (const name of await readdirSafe(dir)) {
    const full = join(dir, name);
    const stat = await lstat(full);
    if (stat.isDirectory()) out.push(...await walkFiles(full, from));
    else if (stat.isFile()) out.push(relative(from, full).split(sep).join("/"));
  }
  return out;
}

async function readPackageVersion(root) {
  const pkg = await readJson(join(root, "package.json"));
  if (typeof pkg?.version === "string" && pkg.version.trim()) return pkg.version;
  throw new Error("Kimi installation source is missing a coherent package version");
}

async function copyInto(srcFile, destFile, dest, beforeManagedMutation) {
  await writeManaged(dest, destFile, await readFile(srcFile), beforeManagedMutation);
}

// Publish managed content via an exclusive no-follow temp and atomic rename.
// The final ancestry recheck happens after staging and immediately before the
// rename, so a directory swapped to a symlink during preparation fails closed.
// Rename also replaces (rather than writes through) a hard-linked destination,
// leaving every outside alias byte-identical.
async function writeManaged(dest, path, bytes, beforeManagedMutation) {
  await mkdir(dirname(path), { recursive: true });
  await assertSafeManagedFiles(dest, [path]);
  await atomicWrite(path, bytes, {
    fsync: false,
    beforeRename: async temporary => {
      await beforeManagedMutation?.({ operation: "publish", path, temporary });
      await assertSafeManagedFiles(dest, [path]);
    }
  });
}

function sameFileIdentity(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.isDirectory() === right.isDirectory() && left.isFile() === right.isFile();
}

// Capture the identity of every directory from the Kimi root through the
// target's parent, plus the target itself. The delete path later re-opens that
// chain one component at a time with O_NOFOLLOW and compares each descriptor,
// so an ancestor rename/symlink swap cannot redirect the mutation.
async function captureManagedDeleteIdentity(dest, path) {
  const parent = await captureManagedParentIdentity(dest, path);
  return { ...parent, target: await lstat(path) };
}

async function captureManagedParentIdentity(dest, path) {
  const base = resolve(dest);
  const parentRel = relative(base, dirname(resolve(path)));
  const directories = [];
  let current = base;
  directories.push({ name: null, info: await lstat(current) });
  for (const name of parentRel.split(sep).filter(Boolean)) {
    current = join(current, name);
    directories.push({ name, info: await lstat(current) });
  }
  return { base, directories };
}

function changedDuringSafeDeletion(path) {
  return new Error(`Kimi managed path changed during safe deletion: ${path}`);
}

async function openPinnedDirectory(path, managedPath) {
  try {
    return await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  } catch (error) {
    if (["ELOOP", "ENOENT", "ENOTDIR"].includes(error.code)) throw changedDuringSafeDeletion(managedPath);
    throw error;
  }
}

// Linux exposes an already-open directory as /proc/self/fd/<fd>. Walking from
// those descriptors gives Node the openat-style property its fs API otherwise
// lacks. The target is atomically moved into a fresh mode-0700 directory under
// the pinned parent, identity-checked there, and only then unlinked. Thus the
// final unlink is under private owned ancestry and can only name the exact
// inode captured before the mutation boundary. Other platforms fail closed;
// a pathname-only fallback would recreate the race this helper exists to close.
async function unlinkPinnedManaged(path, expected, quarantineRecord, beforeManagedMutation, platform = process.platform) {
  if (platform !== "linux" || !fsConstants.O_DIRECTORY || !fsConstants.O_NOFOLLOW) {
    throw new Error(`Safe Kimi uninstall is unavailable on ${platform}: directory-relative deletion is required`);
  }

  const handles = [];
  let quarantinePath = null;
  try {
    let directory = await openPinnedDirectory(expected.base, path);
    handles.push(directory);
    let info = await directory.stat();
    if (!sameFileIdentity(info, expected.directories[0].info) || !info.isDirectory()) {
      throw changedDuringSafeDeletion(path);
    }

    for (const expectedDirectory of expected.directories.slice(1)) {
      directory = await openPinnedDirectory(
        join("/proc/self/fd", String(directory.fd), expectedDirectory.name),
        path
      );
      handles.push(directory);
      info = await directory.stat();
      if (!sameFileIdentity(info, expectedDirectory.info) || !info.isDirectory()) {
        throw changedDuringSafeDeletion(path);
      }
    }

    const parentFdPath = join("/proc/self/fd", String(directory.fd));
    const sourcePath = join(parentFdPath, basename(path));
    quarantinePath = join(parentFdPath, quarantineRecord.directory);
    await mkdir(quarantinePath, { mode: 0o700 });
    const quarantine = await openPinnedDirectory(quarantinePath, path);
    handles.push(quarantine);
    const quarantinedPath = join("/proc/self/fd", String(quarantine.fd), basename(path));

    await rename(sourcePath, quarantinedPath);
    await beforeManagedMutation?.({ operation: "delete-quarantined", path, quarantine: quarantineRecord.directory });
    const moved = await lstat(quarantinedPath);
    if (!sameFileIdentity(moved, expected.target) || !moved.isFile()) {
      // Restore without overwrite: link() is exclusive at the destination.
      // If a concurrent writer filled the name, leave the moved entry in the
      // private quarantine for recovery rather than delete either file.
      await link(quarantinedPath, sourcePath);
      await unlink(quarantinedPath);
      throw changedDuringSafeDeletion(path);
    }
    await unlink(quarantinedPath);
    await rmdir(quarantinePath);
    quarantinePath = null;
  } catch (error) {
    // The only benign ENOENT is handled before entering this helper, when
    // uninstall preflight proved the final target was already absent. Here an
    // ENOENT can mean a captured ancestor was renamed, /proc/self/fd became
    // unavailable, or the final target changed after capture. All are
    // uncertainty: fail closed and retain the ownership manifest.
    if (error.code === "ENOENT") throw changedDuringSafeDeletion(path);
    throw error;
  } finally {
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
    if (quarantinePath) await rmdir(quarantinePath).catch(() => {});
  }
}

async function unlinkManaged(
  dest,
  path,
  beforeManagedMutation,
  expectedIdentity = undefined,
  platform = process.platform,
  quarantineRecord = null,
  skipDeleteHook = false
) {
  await assertSafeManagedFiles(dest, [path]);
  if (expectedIdentity === null) {
    const error = new Error(`Kimi managed path was absent at uninstall preflight: ${path}`);
    error.code = "ENOENT";
    throw error;
  }
  if (!skipDeleteHook) await beforeManagedMutation?.({ operation: "delete", path });
  await assertSafeManagedFiles(dest, [path]);
  const expected = expectedIdentity ?? await captureManagedDeleteIdentity(dest, path);
  await beforeManagedMutation?.({ operation: "delete-ready", path });
  await unlinkPinnedManaged(
    path,
    expected,
    quarantineRecord || { directory: `.muster-uninstall-${randomBytes(12).toString("hex")}` },
    beforeManagedMutation,
    platform
  );
}

// muster's VERBS (plugin/commands/*.md) are the entry points -- without them
// muster cannot be invoked at all, which is exactly the state the first Kimi
// install shipped in. Kimi has no separate "command" surface: it auto-registers
// SKILLS as slash commands, so a verb installs as a skill and surfaces as
// `/skill:<name>` (or bare `/<name>` when nothing system-level takes it).
//
// They are namespaced `muster-<verb>` rather than installed bare, for one
// concrete reason: Kimi already owns `/plan` (its Plan-mode toggle), and a bare
// `plan` verb would collide with it. Prefixing sidesteps that collision for
// every verb at once and keeps the verb namespace legible next to Kimi's own
// commands -- `/muster-go`, `/muster-diagnose`.
export const KIMI_VERB_PREFIX = "muster-";

// Stamp `<key>: <value>` into a file's YAML frontmatter, replacing an existing
// line or appending one (audit S11: the one routine behind both stamps below).
// Deliberately line-scoped rather than a parse/re-serialize round trip (the
// same discipline codex-install.js applies to config.toml): every other byte
// of the file passes through untouched, so a hand-authored file never gets
// silently reformatted. Returns null when the file has no frontmatter at all
// -- Kimi requires a `description`, so such a file is already malformed for
// Kimi and the caller surfaces it rather than inventing a frontmatter block.
// `key` is a fixed internal literal (name, model_preference), never user
// input, so interpolating it into the line regex is safe.
function stampFrontmatterField(text, key, value) {
  const fm = matchFrontmatter(text);
  if (!fm) return null;
  const newline = fm.raw.includes("\r\n") ? "\r\n" : "\n";
  const line = `${key}: ${value}`;
  const keyLine = new RegExp(`^${key}[ \\t]*:.*$`, "m");
  const body = keyLine.test(fm.body) ? fm.body.replace(keyLine, line) : `${fm.body}${newline}${line}`;
  return `---${newline}${body}${newline}---${newline}${fm.rest}`;
}

// Kimi resolves a directory-form skill by its FRONTMATTER `name`, not its
// directory, so the prefix has to be written into the file -- renaming only the
// directory would still register the verb as bare `go`/`plan`.
export function stampSkillName(text, name) {
  return stampFrontmatterField(text, "name", name);
}

// Stamp `model_preference: <lane>` into an agent file's frontmatter (see the
// header note -- an un-stamped agent would silently bind to the
// secondary/cheap lane once a [secondary_model] is configured).
export function stampModelPreference(text, lane) {
  return stampFrontmatterField(text, "model_preference", lane);
}

// --- Declarative action-class fence: [[permission.rules]] deny ---------------
// Kimi's declarative permission rules (docs/research/kimi-code-cli.md 4.2) are
// the harder bind for the action-class fence that plugin/hooks/pre-tool-use.js
// + action-guard.js enforce on other harnesses: a config-level deny that does
// not depend on a hook firing, survives --yolo/-p, and needs no stdin-contract
// shim. The classes are the same fixed set the hook fence classifies:
//   send | sign | submit | publish | purchase | delete-remote
// covering the same two surfaces: external-effect Bash commands (git push,
// npm publish, gh release create, gh pr merge, curl -X POST) and mcp__* tool
// names carrying a class keyword.
//
// Pattern semantics first verified against kimi 0.29.1's bundled matcher
// (2026-07-27), re-probed UNCHANGED on the installed 0.30.0 binary
// (2026-07-30 strings probe: same packages/agent-core*/.../matches-rule.ts +
// rule-match.ts, and the ordered policy chain still evaluates
// user-configured-deny before yolo-mode-approve): the tool-name
// part of a pattern is picomatch-globbed, and a Bash(...) arg pattern is
// picomatch-globbed against the RAW command string with default options, so
// `*` never crosses `/`. Two idioms follow from that:
//   - `{*,*/**}` is the slash-crossing "contains" wildcard (a bare `*foo*`
//     silently stops matching as soon as the command carries a path or URL --
//     `git push https://...` would slip through).
//   - `[^a-zA-Z]` is the non-letter word boundary from the hook's
//     hasWordBoundaryMatch, so "sign" cannot fire on "assign"/"assignments".
// Class keywords are emitted as case-insensitive character classes
// ([sS][eE][nN][dD]) to match the hook regex's /i flag.
// Ordering mirrors the hook's BASH_PATTERNS: the delete-remote push entries
// precede the plain `git push` publish entry (first match wins, and the more
// specific class should own the reason).
const CONTAINS = fragment => `{*,*/**}${fragment}{*,*/**}`;
const CI = word => [...word].map(c => `[${c.toLowerCase()}${c.toUpperCase()}]`).join("");
// An MCP tool name always starts "mcp__", so a class keyword is always
// preceded by at least the "__" delimiter -- two shapes (mid-name, name-end)
// cover every word-bounded occurrence.
const MCP_WORD = cls => [`mcp__*[^a-zA-Z]${CI(cls)}[^a-zA-Z]*`, `mcp__*[^a-zA-Z]${CI(cls)}`];

export const KIMI_PERMISSION_RULES = Object.freeze([
  // Bash -- mirrors plugin/hooks/action-guard.js's BASH_PATTERNS.
  { cls: "delete-remote", pattern: `Bash(${CONTAINS("git push*--delete")})` },
  { cls: "delete-remote", pattern: `Bash(${CONTAINS("git push* -d *")})` },
  { cls: "publish", pattern: `Bash(${CONTAINS("gh release create")})` },
  { cls: "publish", pattern: `Bash(${CONTAINS("npm publish")})` },
  { cls: "publish", pattern: `Bash(${CONTAINS("git push")})` },
  { cls: "send", pattern: `Bash(${CONTAINS("curl{*,*/**}-X*[pP][oO][sS][tT]")})` },
  { cls: "submit", pattern: `Bash(${CONTAINS("gh pr merge")})` },
  // MCP -- mirrors classifyToolName's word-bounded keyword match (name-only;
  // Kimi supports no argument patterns for MCP tools).
  ...["send", "sign", "submit", "publish", "purchase"].flatMap(cls =>
    MCP_WORD(cls).map(pattern => ({ cls, pattern })))
]);

// Ownership markers delimiting muster's block inside the user's config.toml.
// Everything between them is muster-owned; everything outside is the user's
// and passes through byte-untouched (the same line-scoped discipline
// codex-install.js applies to its config.toml declarations).
export const KIMI_RULES_MARKER_BEGIN = "# >>> muster action-class fence (managed by muster install kimi; do not edit between the markers) >>>";
export const KIMI_RULES_MARKER_END = "# <<< muster action-class fence <<<";

// The TOML block muster owns, markers included. `pattern` values are rendered
// with JSON.stringify -- a JSON string is a valid TOML basic string for every
// character these globs use.
export function renderPermissionRulesBlock() {
  const lines = [
    KIMI_RULES_MARKER_BEGIN,
    "# Declarative hard-deny of the external-effect action classes (send/sign/",
    "# submit/publish/purchase/delete-remote) -- the Kimi-native form of the fence",
    "# muster's PreToolUse action-guard enforces on other harnesses. Config-level:",
    "# no hook has to fire, and it survives --yolo/-p. First match wins, so a rule",
    "# of the user's placed BEFORE this block still takes precedence over it.",
    "# `{*,*/**}` = slash-crossing wildcard (picomatch `*` never crosses `/`);",
    "# `[^a-zA-Z]` = non-letter word boundary (\"sign\" must not fire on \"assign\")."
  ];
  for (const { cls, pattern } of KIMI_PERMISSION_RULES) {
    lines.push("", "[[permission.rules]]", `decision = "deny"`, `pattern = ${JSON.stringify(pattern)}`, `reason = "muster action-class fence: ${cls}"`);
  }
  lines.push("", KIMI_RULES_MARKER_END);
  return lines.join("\n");
}

// Locate muster's marker-delimited block. Returns {begin, end} line indexes
// (inclusive), or null when no markers exist. A lone/duplicated/inverted
// marker is a hand-edit muster must not guess around -- fail loud.
function findMarkerBlock(text) {
  const lines = text.split("\n");
  const begin = lines.indexOf(KIMI_RULES_MARKER_BEGIN);
  const end = lines.indexOf(KIMI_RULES_MARKER_END);
  const malformed = begin === -1 || end === -1 || begin > end
    || lines.lastIndexOf(KIMI_RULES_MARKER_BEGIN) !== begin
    || lines.lastIndexOf(KIMI_RULES_MARKER_END) !== end;
  if (begin === -1 && end === -1) return null;
  if (malformed) {
    throw new Error("Kimi config.toml has malformed Muster action-class fence markers. Fix or remove the markers, then rerun.");
  }
  return { begin, end };
}

// Merge muster's block into existing config.toml text (null = file absent):
// replace a prior block in place (idempotent reinstall), else append after a
// blank-line separator. Returns {text, created} -- `created` records whether
// muster owns the file itself, so uninstall can remove a file it made.
export function mergePermissionRules(existing) {
  const block = renderPermissionRulesBlock();
  if (existing === null) return { text: `${block}\n`, created: true };
  const span = findMarkerBlock(existing);
  if (!span) {
    const separator = existing === "" || existing.endsWith("\n\n") ? "" : existing.endsWith("\n") ? "\n" : "\n\n";
    return { text: `${existing}${separator}${block}\n`, created: false };
  }
  const lines = existing.split("\n");
  lines.splice(span.begin, span.end - span.begin + 1, block);
  return { text: lines.join("\n"), created: false };
}

// Reverse mergePermissionRules: remove exactly muster's block (plus the one
// separator blank line the merge added). Returns {text} with the block
// stripped, or null when the remaining content is empty AND muster created
// the file -- the caller then deletes the file rather than leaving a husk.
export function stripPermissionRules(existing, { created }) {
  const span = findMarkerBlock(existing);
  if (!span) return { text: existing };
  const lines = existing.split("\n");
  lines.splice(span.begin, span.end - span.begin + 1);
  if (span.begin > 0 && lines[span.begin - 1] === "") lines.splice(span.begin - 1, 1);
  const text = lines.join("\n");
  if (created && text.trim() === "") return null;
  return { text };
}

const KIMI_CONFIG_MAX_BYTES = 16 * 1024 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function syncDirectory(path) {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

async function managedFileSnapshot(dest, path, maxBytes, label) {
  await assertSafeManagedFiles(dest, [path]);
  const parent = await captureManagedParentIdentity(dest, path);
  let info;
  try { info = await lstat(path); }
  catch (error) { if (error.code === "ENOENT") return { bytes: null, info: null, parent }; throw error; }
  const { bytes } = await readNoFollowRegular(path, { maxBytes, label, expectedInfo: info });
  return { bytes, info, parent };
}

async function configSnapshot(dest, configPath) {
  await assertSafeManagedFiles(dest, [configPath]);
  const parent = await captureManagedParentIdentity(dest, configPath);
  let info;
  try { info = await lstat(configPath); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  const { bytes } = await readNoFollowRegular(configPath, {
    maxBytes: KIMI_CONFIG_MAX_BYTES,
    label: `Kimi config.toml at ${configPath}`,
    expectedInfo: info
  });
  return { bytes, info, parent };
}

async function assertConfigSnapshot(dest, configPath, expected) {
  const current = await configSnapshot(dest, configPath);
  if (!expected && !current) return;
  if (!expected || !current || !sameFileIdentity(expected.info, current.info)
      || !expected.bytes.equals(current.bytes)) {
    throw new Error(`Kimi config.toml changed during safe publication: ${configPath}`);
  }
}

async function publishConfigBytes(dest, configPath, bytes, expected, beforeManagedMutation, operation = "publish", commitReceipt = null) {
  if (process.platform !== "linux" || !fsConstants.O_DIRECTORY || !fsConstants.O_NOFOLLOW) {
    throw new Error(`Safe Kimi config.toml publication is unavailable on ${process.platform}: directory-relative publication is required`);
  }
  const mode = expected ? expected.info.mode & 0o777 : 0o666 & ~process.umask();
  const parentIdentity = expected?.parent ?? await captureManagedParentIdentity(dest, configPath);
  const temporary = join(dirname(configPath), `.muster-config-tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  let temporaryHandle, stagedInfo;
  let receiptData;
  const directoryHandles = [];
  const manifestDirectoryHandles = [];
  let manifestSourcePath, manifestDirectoryHandle;
  let stagedPath, quarantinePath, receiptPath, originalPath, failedPath;
  let manifestOriginalPath, manifestFailedPath, manifestPublishedInfo, manifestPublishedBytes;
  let retired = false, published = false, publishedInfo = null;
  let handedOff = false;
  const persistReceipt = async () => atomicWrite(
    receiptPath,
    JSON.stringify(receiptData) + "\n",
    { fsync: true, fsyncDir: true, mode: 0o600 }
  );

  const changed = () => new Error(`Kimi config.toml changed during safe publication: ${configPath}`);
  const restoreManifest = async () => {
    if (!manifestPublishedInfo) return;
    const manifestPath = commitReceipt.path;
    const manifestTarget = manifestSourcePath ?? manifestPath;
    if (!manifestSourcePath) await assertSafeManagedFiles(dest, [manifestPath]);
    let current;
    try { current = await lstat(manifestTarget); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    if (!current && !commitReceipt.info) {
      manifestPublishedInfo = null;
      return;
    }
    if (!current && commitReceipt.info) {
      const originalManifest = await readNoFollowRegular(manifestOriginalPath, {
        maxBytes: 1024 * 1024,
        label: `original Kimi manifest at ${manifestOriginalPath}`,
        expectedInfo: commitReceipt.info
      });
      if (!originalManifest.bytes.equals(commitReceipt.bytes)) {
        throw new Error(`Kimi manifest changed during config rollback: ${manifestPath}`);
      }
      await link(manifestOriginalPath, manifestTarget);
      await (manifestDirectoryHandle?.sync() ?? syncDirectory(dirname(manifestPath)));
      manifestPublishedInfo = null;
      return;
    }
    if (current && commitReceipt.info && sameFileIdentity(current, commitReceipt.info)) {
      manifestPublishedInfo = null;
      return;
    }
    if (!current || !sameFileIdentity(current, manifestPublishedInfo)) {
      throw new Error(`Kimi manifest changed during config rollback: ${manifestPath}`);
    }
    await rename(manifestTarget, manifestFailedPath);
    await beforeManagedMutation?.({ operation: "manifest-rollback-retired", path: manifestPath });
    const moved = await readNoFollowRegular(manifestFailedPath, {
      maxBytes: 1024 * 1024,
      label: `failed Kimi manifest publication at ${manifestFailedPath}`,
      expectedInfo: manifestPublishedInfo
    });
    if (commitReceipt.info) await link(manifestOriginalPath, manifestTarget);
    await unlink(manifestFailedPath);
    await (manifestDirectoryHandle?.sync() ?? syncDirectory(dirname(manifestPath)));
    await syncDirectory(quarantinePath);
    manifestPublishedInfo = null;
  };
  const restore = async () => {
    await restoreManifest();
    const sourcePath = join("/proc/self/fd", String(directoryHandles.at(-1).fd), basename(configPath));
    if (published) {
      await rename(sourcePath, failedPath);
      const moved = await lstat(failedPath);
      if (!sameFileIdentity(moved, publishedInfo)) {
        await link(failedPath, sourcePath);
        await unlink(failedPath);
        throw changed();
      }
    }
    if (retired) {
      await link(originalPath, sourcePath);
      await directoryHandles.at(-1).sync();
      await unlink(originalPath);
    }
    if (published) await unlink(failedPath);
    if (manifestOriginalPath) await unlink(manifestOriginalPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    await syncDirectory(quarantinePath);
    if (receiptPath) await unlink(receiptPath);
    await syncDirectory(quarantinePath);
    await rmdir(quarantinePath);
    await directoryHandles.at(-1).sync();
  };
  const validateRetired = async () => {
    if (!retired) return;
    const snapshot = await readNoFollowRegular(originalPath, {
      maxBytes: KIMI_CONFIG_MAX_BYTES,
      label: `retired Kimi config.toml at ${originalPath}`,
      expectedInfo: expected.info
    });
    if (!snapshot.bytes.equals(expected.bytes)) throw changed();
  };
  const validatePublished = async () => {
    const sourcePath = join("/proc/self/fd", String(directoryHandles.at(-1).fd), basename(configPath));
    const snapshot = await readNoFollowRegular(sourcePath, {
      maxBytes: KIMI_CONFIG_MAX_BYTES,
      label: `published Kimi config.toml at ${configPath}`,
      expectedInfo: publishedInfo
    });
    if (!snapshot.bytes.equals(bytes)) throw changed();
  };
  const validateManifestPublished = async () => {
    if (!commitReceipt) return;
    if (!manifestPublishedInfo) throw new Error(`Kimi manifest publication state is missing: ${commitReceipt.path}`);
    const snapshot = await readNoFollowRegular(manifestSourcePath ?? commitReceipt.path, {
      maxBytes: 1024 * 1024,
      label: `published Kimi manifest at ${commitReceipt.path}`,
      expectedInfo: manifestPublishedInfo
    });
    if (!snapshot.bytes.equals(manifestPublishedBytes)) {
      throw new Error(`Kimi manifest changed during safe publication: ${commitReceipt.path}`);
    }
  };
  const closeDirectories = async () => {
    for (const handle of manifestDirectoryHandles.reverse()) await handle.close();
    for (const handle of directoryHandles.reverse()) await handle.close();
  };

  try {
    temporaryHandle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      mode
    );
    await temporaryHandle.chmod(mode);
    await temporaryHandle.writeFile(bytes);
    await temporaryHandle.sync();
    stagedInfo = await temporaryHandle.stat();
    await temporaryHandle.close();
    temporaryHandle = null;

    await beforeManagedMutation?.({ operation, path: configPath, temporary });
    await assertSafeManagedFiles(dest, [configPath]);

    let directory = await openPinnedDirectory(parentIdentity.base, configPath);
    directoryHandles.push(directory);
    let directoryInfo = await directory.stat();
    if (!sameFileIdentity(directoryInfo, parentIdentity.directories[0].info) || !directoryInfo.isDirectory()) throw changed();
    for (const expectedDirectory of parentIdentity.directories.slice(1)) {
      directory = await openPinnedDirectory(
        join("/proc/self/fd", String(directory.fd), expectedDirectory.name),
        configPath
      );
      directoryHandles.push(directory);
      directoryInfo = await directory.stat();
      if (!sameFileIdentity(directoryInfo, expectedDirectory.info) || !directoryInfo.isDirectory()) throw changed();
    }

    const parentFdPath = join("/proc/self/fd", String(directory.fd));
    const sourcePath = join(parentFdPath, basename(configPath));
    stagedPath = join(parentFdPath, basename(temporary));
    const staged = await readNoFollowRegular(stagedPath, {
      maxBytes: KIMI_CONFIG_MAX_BYTES,
      label: `staged Kimi config.toml at ${temporary}`,
      expectedInfo: stagedInfo
    });
    if (!staged.bytes.equals(bytes)) throw new Error(`Staged Kimi config.toml failed byte validation: ${temporary}`);

    quarantinePath = join(parentFdPath, `.muster-config-txn-${randomBytes(12).toString("hex")}`);
    await mkdir(quarantinePath, { mode: 0o700 });
    receiptPath = join(quarantinePath, "receipt.json");
    originalPath = join(quarantinePath, "original");
    failedPath = join(quarantinePath, "failed-publication");
    manifestOriginalPath = join(quarantinePath, "manifest-original");
    manifestFailedPath = join(quarantinePath, "failed-manifest");
    receiptData = {
      format: 2,
      target: basename(configPath),
      expected: expected ? { dev: String(expected.info.dev), ino: String(expected.info.ino) } : null,
      staged: { name: basename(temporary), dev: String(stagedInfo.dev), ino: String(stagedInfo.ino) },
      stagedSha256: sha256(bytes),
      manifestBefore: commitReceipt?.info
        ? { dev: String(commitReceipt.info.dev), ino: String(commitReceipt.info.ino) }
        : commitReceipt ? null : undefined,
      manifestParent: commitReceipt ? {
        base: commitReceipt.parent.base,
        directories: commitReceipt.parent.directories.map(directory => ({
          name: directory.name,
          dev: String(directory.info.dev),
          ino: String(directory.info.ino)
        }))
      } : undefined
    };
    await persistReceipt();
    // Persist the transaction directory entry and its receipt before the first
    // destructive rename, then persist both sides of that rename.
    await directory.sync();
    if (expected) {
      await rename(sourcePath, originalPath);
      retired = true;
      const moved = await lstat(originalPath);
      if (!sameFileIdentity(moved, expected.info) || !moved.isFile()) {
        await link(originalPath, sourcePath);
        await unlink(originalPath);
        retired = false;
        throw changed();
      }
    } else {
      try { await lstat(sourcePath); throw changed(); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    await directory.sync();
    await syncDirectory(quarantinePath);
    await beforeManagedMutation?.({ operation: "config-retired", path: configPath });
    await validateRetired();

    // link() is the publication CAS: it creates the final name only when it
    // is still absent, and therefore never overwrites a concurrent writer.
    await link(stagedPath, sourcePath);
    // link() is the commit point. Record it before any later fallible call so
    // every post-link error takes the published rollback path.
    publishedInfo = stagedInfo;
    published = true;
    await beforeManagedMutation?.({ operation: "config-linked", path: configPath });
    const linkedInfo = await lstat(sourcePath);
    if (!sameFileIdentity(linkedInfo, publishedInfo) || !linkedInfo.isFile()) throw changed();
    await unlink(stagedPath);
    stagedPath = null;
    await beforeManagedMutation?.({ operation: "config-fsync", path: configPath });
    await directory.sync();
    await validatePublished();
    await validateRetired();
    handedOff = true;
  } catch (publicationError) {
    if (retired || published) {
      try { await restore(); }
      catch (rollbackError) {
        throw new AggregateError(
          [publicationError, rollbackError],
          `Kimi config.toml rollback failed after publication failure: ${configPath}`
        );
      }
    }
    throw publicationError;
  } finally {
    await temporaryHandle?.close();
    if (stagedPath) await unlink(stagedPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    if (!handedOff) await closeDirectories();
    if (!handedOff && stagedInfo && !stagedPath) {
      try {
        await assertSafeManagedFiles(dest, [temporary]);
        const leftover = await lstat(temporary);
        if (sameFileIdentity(leftover, stagedInfo)) await unlink(temporary);
      } catch (error) { if (error.code !== "ENOENT") { /* fail closed: leave uncertain debris */ } }
    }
  }
  let settled = false;
  return {
    bytes,
    info: publishedInfo,
    parent: parentIdentity,
    manifestParent: commitReceipt?.parent ?? null,
    validate: validatePublished,
    commit: async () => {
      if (settled) return;
      await validatePublished();
      await validateManifestPublished();
      await validateRetired();
      if (!commitReceipt) {
        receiptData.configOnlyCommitted = true;
        await persistReceipt();
        await syncDirectory(quarantinePath);
        await beforeManagedMutation?.({ operation: "config-only-committed", path: configPath });
      }
      // Past this point the config and durable manifest agree. Cleanup is
      // replayable by reconciliation, but rollback state must remain open for
      // either validation failure above.
      settled = true;
      try {
        if (retired) await unlink(originalPath);
        if (manifestOriginalPath) await unlink(manifestOriginalPath).catch(error => { if (error.code !== "ENOENT") throw error; });
        await syncDirectory(quarantinePath);
        await unlink(receiptPath);
        await beforeManagedMutation?.({ operation: "config-cleanup-receipt-cleared", path: configPath });
        await syncDirectory(quarantinePath);
        await rmdir(quarantinePath);
        await directoryHandles.at(-1).sync();
      } finally { await closeDirectories(); }
    },
    recordManifest: (info, publishedBytes) => {
      manifestPublishedInfo = info;
      manifestPublishedBytes = publishedBytes;
    },
    recordManifestIntent: async (info, publishedBytes) => {
      manifestPublishedInfo = info;
      manifestPublishedBytes = publishedBytes;
      receiptData.manifestPublished = {
        dev: String(info.dev), ino: String(info.ino), sha256: sha256(publishedBytes)
      };
      await persistReceipt();
      await directoryHandles.at(-1).sync();
    },
    attachManifestDirectory: (handles, sourcePath, directoryHandle) => {
      manifestDirectoryHandles.push(...handles);
      manifestSourcePath = sourcePath;
      manifestDirectoryHandle = directoryHandle;
    },
    prepareManifestCommit: async () => {
      let currentInfo;
      try { currentInfo = await lstat(manifestSourcePath); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      const current = currentInfo ? {
        info: currentInfo,
        bytes: (await readNoFollowRegular(manifestSourcePath, {
          maxBytes: 1024 * 1024,
          label: `Kimi installation manifest at ${commitReceipt.path}`,
          expectedInfo: currentInfo
        })).bytes
      } : { info: null, bytes: null };
      if (Boolean(current.info) !== Boolean(commitReceipt.info)
          || (current.info && (!sameFileIdentity(current.info, commitReceipt.info)
            || !current.bytes.equals(commitReceipt.bytes)))) {
        throw new Error(`Kimi manifest changed during safe publication: ${commitReceipt.path}`);
      }
      if (!commitReceipt.info) return;
      await beforeManagedMutation?.({ operation: "manifest-retire-ready", path: commitReceipt.path });
      await rename(manifestSourcePath, manifestOriginalPath);
      await beforeManagedMutation?.({ operation: "manifest-retired", path: commitReceipt.path });
      let retiredManifest;
      try {
        retiredManifest = await readNoFollowRegular(manifestOriginalPath, {
          maxBytes: 1024 * 1024,
          label: `retired Kimi manifest at ${manifestOriginalPath}`,
          expectedInfo: commitReceipt.info
        });
      } catch {
        await link(manifestOriginalPath, manifestSourcePath);
        await unlink(manifestOriginalPath);
        await manifestDirectoryHandle.sync();
        throw new Error(`Kimi manifest changed during safe publication: ${commitReceipt.path}`);
      }
      if (!retiredManifest.bytes.equals(commitReceipt.bytes)) {
        await link(manifestOriginalPath, manifestSourcePath);
        await unlink(manifestOriginalPath);
        await manifestDirectoryHandle.sync();
        throw new Error(`Kimi manifest changed during safe publication: ${commitReceipt.path}`);
      }
      await syncDirectory(quarantinePath);
      await manifestDirectoryHandle.sync();
    },
    rollback: async () => {
      if (settled) return;
      try { await restore(); settled = true; }
      finally { await closeDirectories(); }
    }
  };
}

async function removePublishedConfig(dest, configPath, expected, beforeManagedMutation, operation = "delete") {
  const handles = [];
  let transaction;
  try {
    let directory = await openPinnedDirectory(expected.parent.base, configPath);
    handles.push(directory);
    let info = await directory.stat();
    if (!sameFileIdentity(info, expected.parent.directories[0].info) || !info.isDirectory()) {
      throw new Error(`Kimi config.toml changed during safe deletion: ${configPath}`);
    }
    for (const expectedDirectory of expected.parent.directories.slice(1)) {
      directory = await openPinnedDirectory(join("/proc/self/fd", String(directory.fd), expectedDirectory.name), configPath);
      handles.push(directory);
      info = await directory.stat();
      if (!sameFileIdentity(info, expectedDirectory.info) || !info.isDirectory()) {
        throw new Error(`Kimi config.toml changed during safe deletion: ${configPath}`);
      }
    }
    const parentFdPath = join("/proc/self/fd", String(directory.fd));
    const sourcePath = join(parentFdPath, basename(configPath));
    const transactionPath = join(parentFdPath, `.muster-config-txn-${randomBytes(12).toString("hex")}`);
    await mkdir(transactionPath, { mode: 0o700 });
    transaction = await open(transactionPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const txnFdPath = join("/proc/self/fd", String(transaction.fd));
    const receiptPath = join(txnFdPath, "receipt.json");
    const originalPath = join(txnFdPath, "original");
    await atomicWrite(receiptPath, JSON.stringify({
      format: 2,
      target: basename(configPath),
      delete: true,
      expected: { dev: String(expected.info.dev), ino: String(expected.info.ino) },
      expectedSha256: sha256(expected.bytes)
    }) + "\n", { fsync: true, fsyncDir: true, mode: 0o600 });
    await directory.sync();
    await beforeManagedMutation?.({ operation, path: configPath });
    await beforeManagedMutation?.({ operation: "config-delete-ready", path: configPath });
    await rename(sourcePath, originalPath);
    let retired;
    try {
      retired = await readNoFollowRegular(originalPath, {
        maxBytes: KIMI_CONFIG_MAX_BYTES,
        label: `retired Kimi config.toml at ${originalPath}`,
        expectedInfo: expected.info
      });
    } catch {
      await link(originalPath, sourcePath);
      await directory.sync();
      await unlink(originalPath);
      await transaction.sync();
      await unlink(receiptPath);
      await transaction.sync();
      await transaction.close();
      transaction = null;
      await rmdir(transactionPath);
      await directory.sync();
      throw new Error(`Kimi config.toml changed during safe deletion: ${configPath}`);
    }
    if (!retired.bytes.equals(expected.bytes)) {
      await link(originalPath, sourcePath);
      await directory.sync();
      await unlink(originalPath);
      await transaction.sync();
      await unlink(receiptPath);
      await transaction.sync();
      await transaction.close();
      transaction = null;
      await rmdir(transactionPath);
      await directory.sync();
      throw new Error(`Kimi config.toml changed during safe deletion: ${configPath}`);
    }
    await directory.sync();
    await transaction.sync();
    await beforeManagedMutation?.({ operation: "config-delete-retired", path: configPath });
    await unlink(originalPath);
    await transaction.sync();
    await unlink(receiptPath);
    await transaction.sync();
    await transaction.close();
    transaction = null;
    await rmdir(transactionPath);
    await directory.sync();
  } finally {
    await transaction?.close().catch(() => {});
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
  }
}

async function rollbackConfig(dest, configPath, original, published, beforeManagedMutation) {
  await published.rollback();
}

async function reconcileConfigTransactions(dest, configPath, manifestPath, beforeManagedMutation = null) {
  let destInfo;
  try { destInfo = await lstat(dest); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (destInfo.isSymbolicLink() || !destInfo.isDirectory()) {
    throw new Error(`Refusing to reconcile Kimi config.toml through a non-ordinary directory: ${dest}`);
  }
  const names = (await readdir(dest)).filter(name => name.startsWith(".muster-config-txn-")).sort();
  for (const name of names) {
    const directory = await openPinnedDirectory(dest, configPath);
    let transaction;
    const manifestHandles = [];
    try {
      const parentInfo = await directory.stat();
      if (!sameFileIdentity(parentInfo, destInfo)) throw new Error(`Kimi config.toml transaction ancestry changed: ${dest}`);
      const parentFdPath = join("/proc/self/fd", String(directory.fd));
      const quarantinePath = join(parentFdPath, name);
      const quarantineInfo = await lstat(quarantinePath);
      if (quarantineInfo.isSymbolicLink() || !quarantineInfo.isDirectory()) {
        throw new Error(`Malformed Kimi config.toml transaction: ${join(dest, name)}`);
      }
      transaction = await open(
        quarantinePath,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW
      );
      const transactionInfo = await transaction.stat();
      if (!sameFileIdentity(transactionInfo, quarantineInfo) || !transactionInfo.isDirectory()) {
        throw new Error(`Kimi config.toml transaction changed: ${join(dest, name)}`);
      }
      const transactionFdPath = join("/proc/self/fd", String(transaction.fd));
      const receiptPath = join(transactionFdPath, "receipt.json");
      let receiptBytes;
      try {
        receiptBytes = (await readNoFollowRegular(receiptPath, {
          maxBytes: 4096,
          label: `Kimi config.toml transaction receipt at ${receiptPath}`
        })).bytes;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
        if ((await readdir(transactionFdPath)).length !== 0) {
          throw new Error(`Malformed Kimi config.toml transaction without receipt: ${join(dest, name)}`);
        }
        const named = await lstat(quarantinePath);
        if (!sameFileIdentity(named, transactionInfo)) throw new Error(`Kimi config.toml transaction changed: ${join(dest, name)}`);
        await rmdir(quarantinePath);
        await directory.sync();
        continue;
      }
      const receipt = JSON.parse(receiptBytes.toString("utf8"));
      const deletionReceipt = receipt?.delete === true;
      if (receipt?.format !== 2 || receipt.target !== basename(configPath)
          || (deletionReceipt
            ? (!receipt.expected || !/^[0-9a-f]{64}$/.test(receipt.expectedSha256))
            : (!receipt.staged || typeof receipt.staged.name !== "string"
              || !receipt.staged.name.startsWith(".muster-config-tmp-")
              || receipt.staged.name.includes(sep)
              || !/^[0-9a-f]{64}$/.test(receipt.stagedSha256)))) {
        throw new Error(`Malformed Kimi config.toml transaction receipt: ${join(dest, name)}`);
      }
      const matches = (info, identity) => info && identity
        && String(info.dev) === identity.dev && String(info.ino) === identity.ino;
      const statOrNull = async path => {
        try { return await lstat(path); }
        catch (error) { if (error.code === "ENOENT") return null; throw error; }
      };
      let manifestDirectory = null;
      let manifestRecoveryPath = manifestPath;
      if (receipt.manifestParent) {
        const expectedNames = [null, ...relative(resolve(dest), dirname(resolve(manifestPath))).split(sep).filter(Boolean)];
        if (receipt.manifestParent.base !== resolve(dest)
            || !Array.isArray(receipt.manifestParent.directories)
            || receipt.manifestParent.directories.length !== expectedNames.length
            || receipt.manifestParent.directories.some((entry, index) => entry.name !== expectedNames[index])) {
          throw new Error(`Malformed Kimi manifest parent receipt: ${join(dest, name)}`);
        }
        manifestDirectory = await openPinnedDirectory(receipt.manifestParent.base, manifestPath);
        manifestHandles.push(manifestDirectory);
        let info = await manifestDirectory.stat();
        if (!matches(info, receipt.manifestParent.directories[0]) || !info.isDirectory()) {
          throw new Error(`Kimi manifest ancestry changed during recovery: ${manifestPath}`);
        }
        for (const expectedDirectory of receipt.manifestParent.directories.slice(1)) {
          manifestDirectory = await openPinnedDirectory(
            join("/proc/self/fd", String(manifestDirectory.fd), expectedDirectory.name),
            manifestPath
          );
          manifestHandles.push(manifestDirectory);
          info = await manifestDirectory.stat();
          if (!matches(info, expectedDirectory) || !info.isDirectory()) {
            throw new Error(`Kimi manifest ancestry changed during recovery: ${manifestPath}`);
          }
        }
        manifestRecoveryPath = join("/proc/self/fd", String(manifestDirectory.fd), basename(manifestPath));
      }
      const syncManifestRecovery = () => manifestDirectory
        ? manifestDirectory.sync()
        : syncDirectory(dirname(manifestPath));
      const sourcePath = join(parentFdPath, basename(configPath));
      const originalPath = join(transactionFdPath, "original");
      const failedPath = join(transactionFdPath, "failed-publication");
      const manifestOriginalPath = join(transactionFdPath, "manifest-original");
      const manifestFailedPath = join(transactionFdPath, "failed-manifest");
      const stagedPath = deletionReceipt ? null : join(parentFdPath, receipt.staged.name);
      let source = await statOrNull(sourcePath);
      let original = await statOrNull(originalPath);
      if (deletionReceipt) {
        const abandonDeletion = async () => {
          const publicNow = await statOrNull(sourcePath);
          const retiredNow = await statOrNull(originalPath);
          if (!publicNow && retiredNow) {
            await link(originalPath, sourcePath);
            await directory.sync();
          }
          if (retiredNow) await unlink(originalPath);
          await transaction.sync();
          await unlink(receiptPath);
          await transaction.sync();
          const named = await lstat(quarantinePath);
          if (!sameFileIdentity(named, transactionInfo)) throw new Error(`Kimi config.toml transaction changed: ${join(dest, name)}`);
          await rmdir(quarantinePath);
          await directory.sync();
        };
        if (source && !matches(source, receipt.expected)) {
          throw new Error(`Kimi config.toml deletion transaction conflicts with ${configPath}`);
        }
        if (source && !original) {
          await beforeManagedMutation?.({ operation: "config-delete-recovery-ready", path: configPath });
          await rename(sourcePath, originalPath);
          await directory.sync();
          await transaction.sync();
          source = null;
          original = await statOrNull(originalPath);
        }
        if (original) {
          let retired;
          try {
            if (!matches(original, receipt.expected)) throw new Error("identity mismatch");
            retired = await readNoFollowRegular(originalPath, {
              maxBytes: KIMI_CONFIG_MAX_BYTES,
              label: `retired Kimi config.toml at ${originalPath}`,
              expectedInfo: original
            });
            if (sha256(retired.bytes) !== receipt.expectedSha256) throw new Error("digest mismatch");
          } catch {
            await abandonDeletion();
            throw new Error(`Kimi config.toml deletion transaction changed: ${configPath}`);
          }
          await unlink(originalPath);
          await transaction.sync();
        }
        await unlink(receiptPath);
        await transaction.sync();
        const named = await lstat(quarantinePath);
        if (!sameFileIdentity(named, transactionInfo)) throw new Error(`Kimi config.toml transaction changed: ${join(dest, name)}`);
        await rmdir(quarantinePath);
        await directory.sync();
        continue;
      }
      let manifest = await statOrNull(manifestRecoveryPath);
      let failedManifest = await statOrNull(manifestFailedPath);
      if (!manifest && !failedManifest && receipt.manifestPublished && receipt.manifestBefore) {
        const manifestOriginal = await statOrNull(manifestOriginalPath);
        if (!matches(manifestOriginal, receipt.manifestBefore)) {
          throw new Error(`Kimi config.toml recovery lost its original manifest: ${manifestPath}`);
        }
        await link(manifestOriginalPath, manifestRecoveryPath);
        await syncManifestRecovery();
        await beforeManagedMutation?.({ operation: "config-recovery-manifest-durable", path: manifestPath });
        manifest = await statOrNull(manifestRecoveryPath);
      }
      if (!manifest && receipt.manifestPublished && matches(failedManifest, receipt.manifestPublished)) {
        const failedBytes = await readNoFollowRegular(manifestFailedPath, {
          maxBytes: 1024 * 1024,
          label: `failed Kimi manifest publication at ${manifestFailedPath}`,
          expectedInfo: failedManifest
        });
        if (sha256(failedBytes.bytes) !== receipt.manifestPublished.sha256) {
          throw new Error(`Kimi manifest changed during config recovery: ${manifestPath}`);
        }
        if (receipt.manifestBefore) {
          const manifestOriginal = await statOrNull(manifestOriginalPath);
          if (!matches(manifestOriginal, receipt.manifestBefore)) {
            throw new Error(`Kimi config.toml recovery lost its original manifest: ${manifestPath}`);
          }
          await link(manifestOriginalPath, manifestRecoveryPath);
          manifest = await statOrNull(manifestRecoveryPath);
        }
        await syncManifestRecovery();
      }
      const manifestCommitted = receipt.manifestPublished && matches(manifest, receipt.manifestPublished);
      let committed = receipt.configOnlyCommitted === true || manifestCommitted;
      let manifestBytesValid = false;
      if (manifestCommitted) {
        const currentManifest = await readNoFollowRegular(manifestRecoveryPath, {
          maxBytes: 1024 * 1024,
          label: `published Kimi manifest at ${manifestPath}`,
          expectedInfo: manifest
        });
        manifestBytesValid = sha256(currentManifest.bytes) === receipt.manifestPublished.sha256;
      }

      let configBytesValid = false;
      if (matches(source, receipt.staged)) {
        const current = await readNoFollowRegular(sourcePath, {
          maxBytes: KIMI_CONFIG_MAX_BYTES,
          label: `published Kimi config.toml at ${configPath}`,
          expectedInfo: source
        });
        configBytesValid = sha256(current.bytes) === receipt.stagedSha256;
      }

      if (manifestCommitted && (!configBytesValid || !manifestBytesValid)) {
        await rename(manifestRecoveryPath, manifestFailedPath);
        await readNoFollowRegular(manifestFailedPath, {
          maxBytes: 1024 * 1024,
          label: `failed Kimi manifest publication at ${manifestFailedPath}`,
          expectedInfo: manifest
        });
        if (receipt.manifestBefore) {
          const manifestOriginal = await statOrNull(manifestOriginalPath);
          if (!matches(manifestOriginal, receipt.manifestBefore)) {
            throw new Error(`Kimi config.toml recovery lost its original manifest: ${manifestPath}`);
          }
          await link(manifestOriginalPath, manifestRecoveryPath);
        }
        await syncManifestRecovery();
        await beforeManagedMutation?.({ operation: "config-recovery-manifest-durable", path: manifestPath });
        await transaction.sync();
        manifest = await statOrNull(manifestRecoveryPath);
        committed = false;
      } else if (receipt.manifestPublished && manifest
          && !matches(manifest, receipt.manifestPublished)
          && !(receipt.manifestBefore && matches(manifest, receipt.manifestBefore))) {
        throw new Error(`Kimi manifest transaction conflicts with ${manifestPath}`);
      }

      if (committed) {
        await syncManifestRecovery();
        await beforeManagedMutation?.({ operation: "config-recovery-manifest-durable", path: manifestPath });
      }

      if (committed) {
        if (!configBytesValid) throw new Error(`Kimi config.toml committed transaction conflicts with ${configPath}`);
      } else {
        const alreadyRestored = receipt.expected && matches(source, receipt.expected);
        if (matches(source, receipt.staged)) {
          await beforeManagedMutation?.({ operation: "config-recovery-retire-ready", path: configPath });
          await rename(sourcePath, failedPath);
          source = null;
          try {
            const failedInfo = await lstat(failedPath);
            if (!matches(failedInfo, receipt.staged)) throw new Error("identity mismatch");
            const moved = await readNoFollowRegular(failedPath, {
              maxBytes: KIMI_CONFIG_MAX_BYTES,
              label: `failed Kimi config.toml publication at ${failedPath}`,
              expectedInfo: failedInfo
            });
            if (sha256(moved.bytes) !== receipt.stagedSha256) throw new Error("digest mismatch");
          } catch {
            await link(failedPath, sourcePath);
            await directory.sync();
            await unlink(failedPath);
            const abandonedOriginal = await statOrNull(originalPath);
            if (abandonedOriginal) await unlink(originalPath);
            const abandonedStaged = await statOrNull(stagedPath);
            if (abandonedStaged) await unlink(stagedPath);
            const abandonedManifestOriginal = await statOrNull(manifestOriginalPath);
            if (abandonedManifestOriginal) await unlink(manifestOriginalPath);
            const abandonedManifestFailed = await statOrNull(manifestFailedPath);
            if (abandonedManifestFailed) await unlink(manifestFailedPath);
            await transaction.sync();
            await unlink(receiptPath);
            await transaction.sync();
            const named = await lstat(quarantinePath);
            if (!sameFileIdentity(named, transactionInfo)) throw new Error(`Kimi config.toml transaction changed: ${join(dest, name)}`);
            await rmdir(quarantinePath);
            await directory.sync();
            throw new Error(`Kimi config.toml recovery found a concurrent replacement: ${configPath}`);
          }
        } else if (source && receipt.expected && !alreadyRestored) {
          throw new Error(`Kimi config.toml recovery found a concurrent replacement: ${configPath}`);
        }
        if (receipt.expected && !alreadyRestored) {
          if (!matches(original, receipt.expected)) throw new Error(`Kimi config.toml recovery lost its original: ${configPath}`);
          if (!source) {
            await link(originalPath, sourcePath);
            await directory.sync();
            await beforeManagedMutation?.({ operation: "config-recovery-restored", path: configPath });
          }
        }
      }

      const failed = await statOrNull(failedPath);
      if (failed && !matches(failed, receipt.staged)) throw new Error(`Malformed Kimi config.toml failed publication: ${failedPath}`);
      if (failed) await unlink(failedPath);
      const staged = await statOrNull(stagedPath);
      if (staged && !matches(staged, receipt.staged)) throw new Error(`Kimi config.toml staged transaction changed: ${stagedPath}`);
      if (staged) await unlink(stagedPath);
      if (original) await unlink(originalPath);
      const manifestOriginal = await statOrNull(manifestOriginalPath);
      if (manifestOriginal) await unlink(manifestOriginalPath);
      failedManifest = await statOrNull(manifestFailedPath);
      if (failedManifest) await unlink(manifestFailedPath);
      await transaction.sync();
      await unlink(receiptPath);
      await transaction.sync();
      const named = await lstat(quarantinePath);
      if (!sameFileIdentity(named, transactionInfo)) throw new Error(`Kimi config.toml transaction changed: ${join(dest, name)}`);
      await rmdir(quarantinePath);
      await directory.sync();
    } finally {
      for (const handle of manifestHandles.reverse()) await handle.close().catch(() => {});
      await transaction?.close().catch(() => {});
      await directory.close();
    }
  }
}

async function readManifest(manifestPath, dest) {
  const raw = await readJson(manifestPath);
  if (!raw) return null;
  if (raw.owner !== "muster" || raw.format !== 1 || !Array.isArray(raw.agents) || !Array.isArray(raw.skills)) {
    throw new Error(`Kimi installation manifest conflict: ${manifestPath}. Move or remove it, then rerun.`);
  }
  // `verbs` is optional: a manifest written before verbs shipped has none, and
  // must still uninstall cleanly rather than being rejected as malformed.
  if (raw.verbs !== undefined && !Array.isArray(raw.verbs)) {
    throw new Error(`Kimi installation manifest conflict: ${manifestPath}. Move or remove it, then rerun.`);
  }
  // `permissionRules` is optional for the same reason (pre-fence manifests).
  if (raw.permissionRules !== undefined
    && (typeof raw.permissionRules !== "object" || raw.permissionRules === null
      || typeof raw.permissionRules.created !== "boolean")) {
    throw new Error(`Kimi installation manifest conflict: ${manifestPath}. Move or remove it, then rerun.`);
  }
  const owned = [...raw.agents, ...raw.skills, ...(raw.verbs || [])];
  if (raw.quarantines !== undefined && (!Array.isArray(raw.quarantines)
    || raw.quarantines.some(record =>
      typeof record !== "object" || record === null
      || !owned.includes(record.rel)
      || !/^\.muster-uninstall-[0-9a-f]{24}$/.test(record.directory)
      || !/^\d+$/.test(record.dev)
      || !/^\d+$/.test(record.ino)))) {
    throw new Error(`Kimi installation manifest conflict: ${manifestPath}. Move or remove it, then rerun.`);
  }
  assertContained(owned, dest);
  return raw;
}

// Prune a directory only if it is now empty (best-effort). Used to tidy the
// agents/ and skills/<name>/ dirs muster created, never a wholesale removal.
async function rmdirIfEmpty(path) {
  try { await rmdir(path); return true; }
  catch (error) { if (["ENOTEMPTY", "ENOENT", "EEXIST"].includes(error.code)) return false; throw error; }
}

// Classify a served model id: a "cheaper" scout-lane candidate is a served
// model that is NEITHER a coding model (kimi-for-coding*) NOR a k3* frontier
// model -- i.e. a general k2.x family alias, should the plan ever list one.
//
// NOTE (2026-07-25 doc sweep): K2.6 IS reachable on this endpoint, but never as
// a served model id -- "K3 / K2.7 without Thinking routes to K2.6", i.e. it is
// reached by DISABLING thinking (effort `none`), not by selecting an alias. So
// this probe correctly never finds it, and muster does not route there: every
// managed model is `always_thinking`, K2.7-Code already uses "30% lower
// reasoning-token usage compared to K2.6", and no quota multiplier is published
// for K2.6 -- so a thinking-off K2.6 lane is not a documented saving.
function cheaperHaikuCandidates(servedIds) {
  return servedIds.filter(id => !id.startsWith("kimi-for-coding") && !id.startsWith("k3"));
}

// The headline probe: GET <base>/models with the on-disk OAuth token, read-only.
// Injectable fetch + credential path keep it hermetically testable; the live
// call is opt-in (`muster install kimi --probe`) so a default install never
// depends on a network round-trip or a fresh token. The token is read into a
// local and passed only in the Authorization header -- never returned or logged.
export async function probeKimiModels({
  home = homedir(),
  fetchImpl = globalThis.fetch,
  baseUrl = KIMI_MODELS_BASE_URL,
  credPath
} = {}) {
  const cred = await readJson(credPath || join(kimiHome(home), "credentials", "kimi-code.json"));
  const token = typeof cred?.access_token === "string" ? cred.access_token : "";
  if (!token) return { ok: false, reason: "no-token", served: [], cheaperCandidates: [], remapHaiku: false, matchesPolicy: false };
  let response;
  try {
    response = await fetchImpl(`${baseUrl}/models`, {
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }
    });
  } catch (error) {
    return { ok: false, reason: `request-failed: ${error.code || error.message}`, served: [], cheaperCandidates: [], remapHaiku: false, matchesPolicy: false };
  }
  if (!response.ok) return { ok: false, reason: `http-${response.status}`, status: response.status, served: [], cheaperCandidates: [], remapHaiku: false, matchesPolicy: false };
  const body = await response.json();
  const served = Array.isArray(body?.data) ? body.data.map(m => m?.id).filter(id => typeof id === "string").sort() : [];
  const cheaperCandidates = cheaperHaikuCandidates(served);
  const expected = [...KIMI_EXPECTED_MODEL_IDS].sort();
  return {
    ok: true,
    status: response.status ?? 200,
    served,
    cheaperCandidates,
    remapHaiku: cheaperCandidates.length > 0,
    matchesPolicy: served.length === expected.length && served.every((id, i) => id === expected[i])
  };
}

// Enumerate the source agents/skills without writing -- shared by install and
// its --dry-run. Agent files are agents/*.md; a skill is any
// skills/<name>/ or builtins/<name>/ that carries a SKILL.md, copied whole
// (SKILL.md plus any sibling assets, e.g. review-gate/verdict.schema.json).
async function collectSource(pluginRoot) {
  const agentsSrc = join(pluginRoot, "agents");
  const agentFiles = (await readdirSafe(agentsSrc)).filter(f => f.endsWith(".md")).sort();
  // Each agent carries the Kimi lane its manifest tier resolves to; a file with
  // no manifest entry gets lane null and is copied through unstamped (surfaced
  // in the install result, never silently defaulted).
  const agents = agentFiles.map(f => {
    const id = f.slice(0, -3);
    return { rel: `agents/${f}`, src: join(agentsSrc, f), id, lane: kimiPreferenceForAgentId(id) };
  });
  const skills = [];
  const seenSkillNames = new Set();
  // Kimi natively loads the same Agent-Skills directory format used by both
  // trees. Catalog builtins are dispatch payloads, so omitting builtins/ while
  // capabilities --kimi advertised them made the resolver's output
  // unreachable. Materialize them instead of silently weakening the catalog.
  for (const [sourceKind, skillsSrc] of [
    ["orchestration", join(pluginRoot, "skills")],
    ["builtin", join(pluginRoot, "builtins")]
  ]) {
    for (const name of (await readdirSafe(skillsSrc)).sort()) {
      const skillDir = join(skillsSrc, name);
      if (!(await exists(join(skillDir, "SKILL.md")))) continue;
      if (seenSkillNames.has(name)) {
        throw new Error(`Duplicate Kimi skill source: ${name}`);
      }
      seenSkillNames.add(name);
      for (const rel of (await walkFiles(skillDir)).sort()) {
        skills.push({
          rel: `skills/${name}/${rel}`,
          src: join(skillDir, rel),
          skill: name,
          // Kimi invokes a skill by frontmatter name, while many vendored
          // builtins retain their upstream name. The catalog/directory id is
          // muster's dispatch contract, so stamp that id at install time.
          dispatchName: sourceKind === "builtin" && rel === "SKILL.md" ? name : null
        });
      }
    }
  }

  // The verbs, installed as skills under the muster- namespace (see
  // KIMI_VERB_PREFIX). Each becomes skills/muster-<verb>/SKILL.md with its
  // frontmatter `name` rewritten to match.
  const commandsSrc = join(pluginRoot, "commands");
  const verbs = (await readdirSafe(commandsSrc)).filter(f => f.endsWith(".md")).sort().map(f => {
    const verb = f.slice(0, -3), name = `${KIMI_VERB_PREFIX}${verb}`;
    return { rel: `skills/${name}/SKILL.md`, src: join(commandsSrc, f), skill: name, verb, name };
  });
  return { agents, skills, verbs };
}

// Install muster's agents + builtin skills into the Kimi Code data root, plus
// the declarative action-class fence in config.toml. Idempotent: a reinstall
// overwrites owned files, prunes any file the PRIOR manifest owned that this
// install no longer ships, and replaces the marker-delimited permission-rules
// block in place. Returns a glass-box summary (agent/skill counts, the dest,
// the fence rules, and the probe verdict when --probe is set).
async function runKimiInstallUnlocked({
  home = homedir(), repoRoot, dryRun = false, probe = false, fetchImpl,
  _beforeManagedMutation = null
} = {}) {
  const root = repoRoot || fileURLToPath(new URL("../", import.meta.url));
  const pluginRoot = await resolvePluginRoot(root);
  const dest = kimiHome(home);
  const packageVersion = await readPackageVersion(root);

  const { agents, skills, verbs } = await collectSource(pluginRoot);
  const skillNames = [...new Set(skills.map(s => s.skill))];
  const ownedRel = [...agents.map(a => a.rel), ...skills.map(s => s.rel), ...verbs.map(v => v.rel)];
  assertContained(ownedRel, dest);

  const probeResult = probe ? await probeKimiModels({ home, fetchImpl }) : null;

  const configPath = join(dest, "config.toml");
  const rulesSummary = () => ({
    config: configPath,
    rules: KIMI_PERMISSION_RULES.map(r => ({ decision: "deny", ...r }))
  });

  if (dryRun) {
    return {
      dryRun: true, dest, packageVersion,
      agents: agents.map(a => basename(a.rel)), skills: skillNames,
      verbs: verbs.map(v => v.name),
      fileCount: ownedRel.length,
      permissionRules: { ...rulesSummary(), created: !(await exists(configPath)) },
      ...(probeResult ? { probe: probeResult } : {})
    };
  }

  await assertWritableDir(join(dest, "agents"));
  await assertWritableDir(join(dest, "skills"));

  // Prune stale files a prior install owned but this one no longer ships.
  const manifestPath = join(dest, "muster", KIMI_MANIFEST);
  await reconcileConfigTransactions(dest, configPath, manifestPath, _beforeManagedMutation);
  await reconcileOrphanedManifestQuarantine(dest, manifestPath);
  const previous = await readManifest(manifestPath, dest);
  const reconciliation = previous
    ? await reconcileManifestQuarantines(dest, manifestPath, previous, process.platform)
    : { skip: new Set(), manifestIdentity: null };
  const ownedSet = new Set(ownedRel);
  const staleRel = (previous ? [...previous.agents, ...previous.skills, ...(previous.verbs || [])] : [])
    .filter(rel => !ownedSet.has(rel));
  await assertSafeManagedFiles(dest, [
    ...ownedRel.map(rel => join(dest, rel)),
    ...staleRel.map(rel => join(dest, rel)),
    manifestPath
  ]);
  const removedStale = [];
  for (const rel of staleRel) {
    if (reconciliation.skip.has(rel)) {
      removedStale.push(rel);
      continue;
    }
    const path = join(dest, rel);
    try {
      const expected = await captureManagedDeleteIdentity(dest, path);
      const record = {
        rel,
        directory: `.muster-uninstall-${randomBytes(12).toString("hex")}`,
        dev: String(expected.target.dev),
        ino: String(expected.target.ino)
      };
      await _beforeManagedMutation?.({ operation: "delete", path });
      await assertSafeManagedFiles(dest, [path]);
      previous.quarantines = [...(previous.quarantines || []), record];
      await persistUninstallManifest(manifestPath, previous, dest);
      await _beforeManagedMutation?.({
        operation: "receipt-durable",
        path,
        manifestPath,
        quarantine: record.directory
      });
      await unlinkManaged(dest, path, _beforeManagedMutation, expected, process.platform, record, true);
      previous.quarantines = previous.quarantines.filter(candidate => candidate !== record);
      await persistUninstallManifest(manifestPath, previous, dest);
      removedStale.push(rel);
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  // Orchestration skills and skill assets copy byte-for-byte. Catalog builtins'
  // SKILL.md names are stamped to their catalog ids because Kimi dispatches by
  // frontmatter name, not directory. Known agents are likewise stamped to
  // their manifest/file ids as well as their model_preference lane (see the
  // header note -- an un-stamped agent would silently bind to the
  // secondary/cheap lane once configured).
  for (const { rel, src, dispatchName } of skills) {
    const destFile = join(dest, rel);
    if (!dispatchName) {
      await copyInto(src, destFile, dest, _beforeManagedMutation);
      continue;
    }
    const stamped = stampSkillName(await readFile(src, "utf8"), dispatchName);
    if (stamped === null) throw new Error(`Kimi builtin skill has no frontmatter: ${src}`);
    await writeManaged(dest, destFile, stamped, _beforeManagedMutation);
  }
  const lanes = { primary: [], secondary: [] }, unstamped = [];
  for (const { rel, src, id, lane } of agents) {
    const destFile = join(dest, rel);
    const sourceText = await readFile(src, "utf8");
    const named = lane ? stampFrontmatterField(sourceText, "name", id) : null;
    const stamped = named === null ? null : stampModelPreference(named, lane);
    if (stamped === null) {
      await copyInto(src, destFile, dest, _beforeManagedMutation);
      unstamped.push({ id, reason: lane ? "no frontmatter" : "no manifest entry" });
      continue;
    }
    await writeManaged(dest, destFile, stamped, _beforeManagedMutation);
    lanes[lane].push(id);
  }

  // The verbs: muster's entry points. Each is written with its frontmatter
  // `name` rewritten to the muster- namespace, since Kimi registers a skill by
  // its frontmatter name (not its directory) and `/plan` is already Kimi's own.
  const installedVerbs = [];
  for (const { rel, src, name } of verbs) {
    const destFile = join(dest, rel);
    const stamped = stampSkillName(await readFile(src, "utf8"), name);
    await writeManaged(dest, destFile, stamped ?? await readFile(src, "utf8"), _beforeManagedMutation);
    installedVerbs.push(name);
  }

  await mkdir(dirname(manifestPath), { recursive: true });
  await assertSafeManagedFiles(dest, [manifestPath]);
  // The action-class fence is a single locked read/merge/publish/manifest
  // transaction. The read is descriptor-pinned and no-follow; every ancestor
  // is checked before lock acquisition and immediately before atomic rename.
  // The staged bytes are read back and compared before publication. If the
  // manifest commit fails, restore the exact original bytes (or exact absence)
  // while still holding the same lock so an unreceipted fence is never left.
  let configCreated;
  const configGuard = () => assertSafeManagedFiles(dest, [configPath]);
  await configGuard();
  await _beforeManagedMutation?.({ operation: "config-lock-ready", path: configPath });
  await configGuard();
  const original = await configSnapshot(dest, configPath);
    const mergedConfig = mergePermissionRules(original ? original.bytes.toString("utf8") : null);
    // `created` is sticky across reinstalls: once muster made the file, a later
    // merge (file now present) must not flip the receipt, or uninstall would
    // leave an empty config.toml husk behind.
    const lockedPrevious = await readManifest(manifestPath, dest);
    configCreated = mergedConfig.created || lockedPrevious?.permissionRules?.created === true;
    const manifestBefore = await managedFileSnapshot(
      dest,
      manifestPath,
      1024 * 1024,
      `Kimi installation manifest at ${manifestPath}`
    );
    const published = await publishConfigBytes(
      dest,
      configPath,
      Buffer.from(mergedConfig.text),
      original,
      _beforeManagedMutation,
      "publish",
      { path: manifestPath, ...manifestBefore }
    );
    const manifestValue = {
      format: 1, owner: "muster", packageVersion,
      agents: agents.map(a => a.rel), skills: skills.map(s => s.rel), verbs: verbs.map(v => v.rel),
      permissionRules: { created: configCreated }
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifestValue, null, 2) + "\n");
    try {
      const manifestInfo = await publishConfigManifest(
        manifestPath,
        manifestBytes,
        dest,
        _beforeManagedMutation,
        published
      );
      published.recordManifest(manifestInfo, manifestBytes);
      await _beforeManagedMutation?.({ operation: "manifest-published", path: manifestPath });
      await published.commit();
    } catch (publicationError) {
      try {
        await rollbackConfig(dest, configPath, original, published, _beforeManagedMutation);
      } catch (rollbackError) {
        throw new AggregateError(
          [publicationError, rollbackError],
          `Kimi config.toml rollback failed after manifest publication failure: ${configPath}`
        );
      }
      throw publicationError;
    }

  return {
    dest, packageVersion, agents: agents.map(a => basename(a.rel)), skills: skillNames,
    verbs: installedVerbs,
    fileCount: ownedRel.length, removedStale,
    permissionRules: { ...rulesSummary(), created: configCreated },
    modelPreference: {
      primary: lanes.primary.length, secondary: lanes.secondary.length, unstamped,
      requiredConfig: KIMI_SECONDARY_MODEL_CONFIG,
      note: "model_preference is experimental: muster's `kimi -p` run loop binds the lanes LIVE -- kimiGoalInvocation (src/kimi-dispatch.js) sets KIMI_CODE_EXPERIMENTAL_FLAG=1 + KIMI_SECONDARY_MODEL per process, derived from src/kimi.js's kimiLaneEnv. The interactive TUI ignores the field; a `kimi web` session needs KIMI_CODE_EXPERIMENTAL_SECONDARY_MODEL=1."
    },
    ...(probeResult ? { probe: probeResult } : {})
  };
}

export async function runKimiInstall(options = {}) {
  if (options.dryRun) return runKimiInstallUnlocked(options);
  const dest = kimiHome(options.home ?? homedir());
  const configPath = join(dest, "config.toml");
  await assertWritableDir(dest);
  await mkdir(dest, { recursive: true });
  await assertWritableDir(dest);
  const lifecycleGuard = () => assertSafeManagedFiles(dest, [configPath]);
  await lifecycleGuard();
  await options._beforeManagedMutation?.({ operation: "lifecycle-lock-ready", path: configPath });
  return withFileMutationLock(
    configPath,
    () => runKimiInstallUnlocked(options),
    { beforeOpen: lifecycleGuard, staleMs: 1_000 }
  );
}

function quarantineIdentityMatches(info, record) {
  return info.isFile() && String(info.dev) === record.dev && String(info.ino) === record.ino;
}

async function persistUninstallManifest(manifestPath, manifest, dest) {
  return atomicWriteJson(manifestPath, manifest, dest, null, { fsync: true, fsyncDir: true });
}

async function publishConfigManifest(path, bytes, dest, beforeManagedMutation, published) {
  const handles = [];
  let directory = await openPinnedDirectory(published.manifestParent.base, path);
  handles.push(directory);
  let directoryInfo = await directory.stat();
  if (!sameFileIdentity(directoryInfo, published.manifestParent.directories[0].info) || !directoryInfo.isDirectory()) {
    throw new Error(`Kimi manifest ancestry changed during safe publication: ${path}`);
  }
  for (const expectedDirectory of published.manifestParent.directories.slice(1)) {
    directory = await openPinnedDirectory(join("/proc/self/fd", String(directory.fd), expectedDirectory.name), path);
    handles.push(directory);
    directoryInfo = await directory.stat();
    if (!sameFileIdentity(directoryInfo, expectedDirectory.info) || !directoryInfo.isDirectory()) {
      throw new Error(`Kimi manifest ancestry changed during safe publication: ${path}`);
    }
  }
  const parentFdPath = join("/proc/self/fd", String(directory.fd));
  const target = join(parentFdPath, basename(path));
  const temporary = join(parentFdPath, `.muster-manifest-tmp-${process.pid}-${randomBytes(8).toString("hex")}`);
  published.attachManifestDirectory(handles, target, directory);
  let handle;
  let linked = false;
  try {
    handle = await open(
      temporary,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600
    );
    await handle.writeFile(bytes);
    await handle.sync();
    const info = await handle.stat();
    await handle.close();
    handle = null;
    await beforeManagedMutation?.({ operation: "publish", path, temporary });
    await assertSafeManagedFiles(dest, [path]);
    await published.validate();
    await published.recordManifestIntent(info, bytes);
    await published.prepareManifestCommit();
    // Exclusive link is the manifest CAS: after retiring the exact prior
    // inode, a concurrent writer wins with EEXIST and is never overwritten.
    await link(temporary, target);
    linked = true;
    await unlink(temporary);
    await beforeManagedMutation?.({ operation: "manifest-durability", path });
    await directory.sync();
    return info;
  } finally {
    await handle?.close();
    if (!linked) await unlink(temporary).catch(error => { if (error.code !== "ENOENT") throw error; });
  }
}

async function reconcileQuarantine(dest, record, platform = process.platform) {
  if (platform !== "linux" || !fsConstants.O_DIRECTORY || !fsConstants.O_NOFOLLOW) {
    throw new Error(`Safe Kimi uninstall is unavailable on ${platform}: directory-relative deletion is required`);
  }

  const path = join(dest, record.rel);
  await assertSafeManagedFiles(dest, [path]);
  const expectedParent = await captureManagedParentIdentity(dest, path);
  const handles = [];
  try {
    let directory = await openPinnedDirectory(expectedParent.base, path);
    handles.push(directory);
    let info = await directory.stat();
    if (!sameFileIdentity(info, expectedParent.directories[0].info) || !info.isDirectory()) {
      throw changedDuringSafeDeletion(path);
    }
    for (const expectedDirectory of expectedParent.directories.slice(1)) {
      directory = await openPinnedDirectory(
        join("/proc/self/fd", String(directory.fd), expectedDirectory.name),
        path
      );
      handles.push(directory);
      info = await directory.stat();
      if (!sameFileIdentity(info, expectedDirectory.info) || !info.isDirectory()) {
        throw changedDuringSafeDeletion(path);
      }
    }

    const parentFdPath = join("/proc/self/fd", String(directory.fd));
    const quarantinePath = join(parentFdPath, record.directory);
    let quarantine;
    try {
      quarantine = await open(quarantinePath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      if (error.code !== "ENOENT") throw changedDuringSafeDeletion(path);
    }

    if (!quarantine) {
      let source;
      try { source = await lstat(join(parentFdPath, basename(path))); }
      catch (error) {
        if (error.code === "ENOENT") return { skipSource: true };
        throw error;
      }
      if (quarantineIdentityMatches(source, record)) return { skipSource: false };
      throw new Error(`Kimi uninstall quarantine state is uncertain for ${path}`);
    }

    handles.push(quarantine);
    const quarantineInfo = await quarantine.stat();
    const quarantinedPath = join("/proc/self/fd", String(quarantine.fd), basename(path));
    let moved;
    try { moved = await lstat(quarantinedPath); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    if (moved && !quarantineIdentityMatches(moved, record)) {
      throw new Error(`Kimi uninstall quarantine identity changed for ${path}`);
    }
    if (moved) await unlink(quarantinedPath);
    let skipSource = Boolean(moved);
    if (!moved) {
      let source;
      try { source = await lstat(join(parentFdPath, basename(path))); }
      catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // An empty receipted quarantine can mean either interruption after
      // mkdir but before rename (the matching source is still ours), or after
      // the quarantined file was unlinked (any different source is recreated).
      skipSource = !source || !quarantineIdentityMatches(source, record);
    }

    const namedQuarantine = await lstat(quarantinePath).catch(error => {
      if (error.code === "ENOENT") throw changedDuringSafeDeletion(path);
      throw error;
    });
    if (!sameFileIdentity(namedQuarantine, quarantineInfo)) throw changedDuringSafeDeletion(path);
    try { await rmdir(quarantinePath); }
    catch (error) {
      if (["EEXIST", "ENOTEMPTY"].includes(error.code)) {
        throw new Error(`Kimi uninstall quarantine contains unexpected entries for ${path}`);
      }
      throw error;
    }
    return { skipSource };
  } finally {
    for (const handle of handles.reverse()) await handle.close().catch(() => {});
  }
}

async function reconcileManifestQuarantines(dest, manifestPath, manifest, platform) {
  const skip = new Set();
  let manifestIdentity = null;
  while (manifest.quarantines?.length) {
    const record = manifest.quarantines[0];
    const result = await reconcileQuarantine(dest, record, platform);
    if (result.skipSource) skip.add(record.rel);
    manifest.quarantines.shift();
    manifestIdentity = await persistUninstallManifest(manifestPath, manifest, dest);
  }
  return { skip, manifestIdentity };
}

// The ownership manifest is the final managed file removed. Its quarantine
// therefore cannot be receipted inside itself: after rename, a retry would have
// no pathname from which to discover that receipt. Give this one quarantine a
// fixed, validated name and reconcile it before either install or uninstall
// reads/replaces the manifest. The quarantined manifest itself supplies the
// inode identity; an empty fixed quarantine is also safe to retire (it means
// the file unlink completed and interruption landed before rmdir).
async function reconcileOrphanedManifestQuarantine(dest, manifestPath, platform = process.platform) {
  const quarantinePath = join(dirname(manifestPath), KIMI_MANIFEST_QUARANTINE);
  let quarantineInfo;
  try { quarantineInfo = await lstat(quarantinePath); }
  catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
  if (!quarantineInfo.isDirectory() || quarantineInfo.isSymbolicLink()) {
    throw new Error(`Kimi uninstall quarantine state is uncertain for ${manifestPath}`);
  }

  const quarantinedManifest = join(quarantinePath, basename(manifestPath));
  let moved;
  try { moved = await lstat(quarantinedManifest); }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (moved) await readManifest(quarantinedManifest, dest);

  await reconcileQuarantine(dest, {
    rel: relative(dest, manifestPath).split(sep).join("/"),
    directory: KIMI_MANIFEST_QUARANTINE,
    dev: String(moved?.dev ?? 0),
    ino: String(moved?.ino ?? 0)
  }, platform);
  return true;
}

// Reverse runKimiInstall: remove exactly the manifest-owned files (never a
// wholesale directory removal -- a user's own agents/skills sharing those dirs
// are untouched), strip muster's marker-delimited permission-rules block from
// config.toml (deleting the file only when muster created it), prune the
// now-empty muster-created dirs, and drop the manifest.
async function runKimiUninstallUnlocked({
  home = homedir(),
  dryRun = false,
  _beforeManagedMutation = null,
  _platform = process.platform
} = {}) {
  const dest = kimiHome(home);
  const manifestPath = join(dest, "muster", KIMI_MANIFEST);
  const configPath = join(dest, "config.toml");
  await reconcileConfigTransactions(dest, configPath, manifestPath, _beforeManagedMutation);
  const recoveredManifestDeletion = await reconcileOrphanedManifestQuarantine(dest, manifestPath, _platform);
  const manifest = await readManifest(manifestPath, dest);
  if (!manifest) {
    if (recoveredManifestDeletion) await rmdirIfEmpty(dirname(manifestPath));
    return { dest, removed: [], note: "no muster install found" };
  }

  const owned = [...manifest.agents, ...manifest.skills, ...(manifest.verbs || [])];
  if (dryRun) {
    return {
      dryRun: true, dest, wouldRemove: owned, fileCount: owned.length,
      ...(manifest.permissionRules ? { wouldStripPermissionRules: await exists(configPath) } : {})
    };
  }

  const reconciliation = await reconcileManifestQuarantines(dest, manifestPath, manifest, _platform);
  let finalManifestTarget = reconciliation.manifestIdentity;
  const managedPaths = [...owned.map(rel => join(dest, rel)), manifestPath];
  await assertSafeManagedFiles(dest, managedPaths);
  const deleteIdentities = new Map();
  for (const path of owned.map(rel => join(dest, rel))) {
    try { deleteIdentities.set(path, await captureManagedDeleteIdentity(dest, path)); }
    catch (error) {
      if (error.code === "ENOENT") deleteIdentities.set(path, null);
      else throw error;
    }
  }

  const removed = [];
  for (const rel of owned) {
    if (reconciliation.skip.has(rel)) {
      removed.push(rel);
      continue;
    }
    const path = join(dest, rel);
    try {
      const expected = deleteIdentities.get(path);
      if (expected === null) continue;
      const record = {
        rel,
        directory: `.muster-uninstall-${randomBytes(12).toString("hex")}`,
        dev: String(expected.target.dev),
        ino: String(expected.target.ino)
      };
      await _beforeManagedMutation?.({ operation: "delete", path });
      await assertSafeManagedFiles(dest, [path]);
      manifest.quarantines = [...(manifest.quarantines || []), record];
      finalManifestTarget = await persistUninstallManifest(manifestPath, manifest, dest);
      await _beforeManagedMutation?.({
        operation: "receipt-durable",
        path,
        manifestPath,
        quarantine: record.directory
      });
      await unlinkManaged(dest, path, _beforeManagedMutation, expected, _platform, record, true);
      manifest.quarantines = manifest.quarantines.filter(candidate => candidate !== record);
      finalManifestTarget = await persistUninstallManifest(manifestPath, manifest, dest);
      await _beforeManagedMutation?.({
        operation: "receipt-cleared",
        path,
        manifestPath,
        quarantine: record.directory
      });
      removed.push(rel);
    }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  // The fence block: manifest-gated (a pre-fence manifest has no
  // `permissionRules` and must not touch config.toml at all), marker-scoped
  // (only muster's block is removed; a config the user deleted first is a
  // clean skip). Reuse the install path's lock, no-follow snapshot, ancestry
  // guard, staged-byte validation, and atomic publication discipline.
  let configRemoved = false;
  if (manifest.permissionRules) {
    const configGuard = () => assertSafeManagedFiles(dest, [configPath]);
    await configGuard();
    await configGuard();
    const original = await configSnapshot(dest, configPath);
    if (original) {
      const stripped = stripPermissionRules(original.bytes.toString("utf8"), manifest.permissionRules);
      if (stripped === null) {
        await removePublishedConfig(dest, configPath, original, _beforeManagedMutation);
        configRemoved = true;
      } else {
        const published = await publishConfigBytes(
          dest,
          configPath,
          Buffer.from(stripped.text),
          original,
          _beforeManagedMutation
        );
        await published.commit();
      }
    }
  }

  // Prune empty skill dirs (deepest first), then the agents/skills roots.
  const skillDirs = [...new Set([...manifest.skills, ...(manifest.verbs || [])].map(rel => rel.split("/").slice(0, 2).join("/")))];
  for (const rel of skillDirs) await rmdirIfEmpty(join(dest, rel));
  await rmdirIfEmpty(join(dest, "skills"));
  await rmdirIfEmpty(join(dest, "agents"));
  const finalManifestIdentity = {
    ...await captureManagedParentIdentity(dest, manifestPath),
    target: finalManifestTarget ?? await lstat(manifestPath)
  };
  await unlinkManaged(
    dest,
    manifestPath,
    _beforeManagedMutation,
    finalManifestIdentity,
    _platform,
    {
      rel: relative(dest, manifestPath).split(sep).join("/"),
      directory: KIMI_MANIFEST_QUARANTINE,
      dev: "0",
      ino: "0"
    }
  ).catch(error => { if (error.code !== "ENOENT") throw error; });
  await rmdirIfEmpty(join(dest, "muster"));

  return { dest, removed, fileCount: removed.length, ...(manifest.permissionRules ? { permissionRules: { stripped: true, configRemoved } } : {}) };
}

export async function runKimiUninstall(options = {}) {
  const dest = kimiHome(options.home ?? homedir());
  const configPath = join(dest, "config.toml");
  await assertWritableDir(dest);
  await mkdir(dest, { recursive: true });
  await assertWritableDir(dest);
  const lifecycleGuard = () => assertSafeManagedFiles(dest, [configPath]);
  await lifecycleGuard();
  await options._beforeManagedMutation?.({ operation: "lifecycle-lock-ready", path: configPath });
  return withFileMutationLock(
    configPath,
    () => runKimiUninstallUnlocked(options),
    { beforeOpen: lifecycleGuard, staleMs: 1_000 }
  );
}

// Manifest publish: temp-write-then-rename via fs-safe.js's shared atomicWrite
// (audit S4) with its DEFAULT temp name -- the pid+RANDOM suffix is the
// collision handling: this site's historical pid-only temp name
// (`.tmp-<pid>`, no random) could hit EEXIST under atomicWrite's O_EXCL open
// when a stale temp from a crashed install met a recycled pid, where the old
// the former plain write simply overwrote. Ordinary install publication keeps fsync
// off (a torn publish is self-healing on rerun); uninstall receipt publication
// opts into both file and parent-directory fsync before destructive rename.
async function atomicWriteJson(
  path,
  value,
  dest,
  beforeManagedMutation,
  { fsync = false, fsyncDir = false, beforeCommit = null, afterCommit = null } = {}
) {
  let publishedIdentity = null;
  await atomicWrite(path, JSON.stringify(value, null, 2) + "\n", {
    fsync,
    fsyncDir,
    beforeRename: async temporary => {
      await beforeManagedMutation?.({ operation: "publish", path, temporary });
      await assertSafeManagedFiles(dest, [path]);
      publishedIdentity = await lstat(temporary);
      if (!publishedIdentity.isFile() || publishedIdentity.isSymbolicLink()) {
        throw new Error(`Refusing to publish a non-ordinary Kimi file: ${temporary}`);
      }
      await beforeCommit?.(publishedIdentity);
    }
  });
  await afterCommit?.();
  return publishedIdentity;
}
