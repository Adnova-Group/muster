import { copyFile, lstat, mkdir, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readdirSafe, readJson } from "./fs-util.js";
import { atomicWrite, isContainedLexical } from "./fs-safe.js";
import { matchFrontmatter } from "./frontmatter.js";
import { KIMI_LANES, kimiLaneEnv, kimiPreferenceForAgentId } from "./kimi.js";

// --- Kimi Code CLI install adapter -------------------------------------------
// The write side of the Kimi harness leg (docs/research/kimi-code-cli.md). Kimi
// loads Claude-Code-format agent .md files and SKILL.md skills natively (the
// research's "closest structural clone" finding), so `muster install kimi`
// simply places muster's 27 agents and 11 builtin skills into the gen2 data
// root (`$KIMI_CODE_HOME`, or ~/.kimi-code) where a Kimi session discovers them.
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
// docs/research/kimi-code-cli.md 11.10) are the v0.29.1 binary defaults in
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
  return typeof pkg?.version === "string" ? pkg.version : "0.5.0";
}

async function copyInto(srcFile, destFile) {
  await mkdir(dirname(destFile), { recursive: true });
  await copyFile(srcFile, destFile);
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
// Pattern semantics verified against kimi 0.29.1's bundled matcher
// (packages/agent-core*/.../matches-rule.ts + rule-match.ts): the tool-name
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
  assertContained([...raw.agents, ...raw.skills, ...(raw.verbs || [])], dest);
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
// its --dry-run. Agent files are agents/*.md; a skill is any skills/<name>/ that
// carries a SKILL.md, copied whole (SKILL.md plus any sibling assets, e.g.
// review-gate/verdict.schema.json).
async function collectSource(pluginRoot) {
  const agentsSrc = join(pluginRoot, "agents"), skillsSrc = join(pluginRoot, "skills");
  const agentFiles = (await readdirSafe(agentsSrc)).filter(f => f.endsWith(".md")).sort();
  // Each agent carries the Kimi lane its manifest tier resolves to; a file with
  // no manifest entry gets lane null and is copied through unstamped (surfaced
  // in the install result, never silently defaulted).
  const agents = agentFiles.map(f => {
    const id = f.slice(0, -3);
    return { rel: `agents/${f}`, src: join(agentsSrc, f), id, lane: kimiPreferenceForAgentId(id) };
  });
  const skills = [];
  for (const name of (await readdirSafe(skillsSrc)).sort()) {
    const skillDir = join(skillsSrc, name);
    if (!(await exists(join(skillDir, "SKILL.md")))) continue;
    for (const rel of (await walkFiles(skillDir)).sort()) {
      skills.push({ rel: `skills/${name}/${rel}`, src: join(skillDir, rel), skill: name });
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
export async function runKimiInstall({ home = homedir(), repoRoot, dryRun = false, probe = false, fetchImpl } = {}) {
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
  const previous = await readManifest(manifestPath, dest);
  const ownedSet = new Set(ownedRel);
  const removedStale = [];
  for (const rel of previous ? [...previous.agents, ...previous.skills, ...(previous.verbs || [])] : []) {
    if (ownedSet.has(rel)) continue;
    try { await unlink(join(dest, rel)); removedStale.push(rel); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  // Skills copy byte-for-byte; agents are stamped with their model_preference
  // lane (see the header note -- an un-stamped agent would silently bind to the
  // secondary/cheap lane once a [secondary_model] is configured).
  for (const { rel, src } of skills) await copyInto(src, join(dest, rel));
  const lanes = { primary: [], secondary: [] }, unstamped = [];
  for (const { rel, src, id, lane } of agents) {
    const destFile = join(dest, rel);
    const stamped = lane ? stampModelPreference(await readFile(src, "utf8"), lane) : null;
    if (stamped === null) {
      await copyInto(src, destFile);
      unstamped.push({ id, reason: lane ? "no frontmatter" : "no manifest entry" });
      continue;
    }
    await mkdir(dirname(destFile), { recursive: true });
    await writeFile(destFile, stamped);
    lanes[lane].push(id);
  }

  // The verbs: muster's entry points. Each is written with its frontmatter
  // `name` rewritten to the muster- namespace, since Kimi registers a skill by
  // its frontmatter name (not its directory) and `/plan` is already Kimi's own.
  const installedVerbs = [];
  for (const { rel, src, name } of verbs) {
    const destFile = join(dest, rel);
    const stamped = stampSkillName(await readFile(src, "utf8"), name);
    await mkdir(dirname(destFile), { recursive: true });
    await writeFile(destFile, stamped ?? await readFile(src, "utf8"));
    installedVerbs.push(name);
  }

  // The action-class fence: merge muster's marker-delimited [[permission.rules]]
  // block into the user's config.toml (creating it when absent). Written BEFORE
  // the manifest so the manifest stays the commit point; `created` is the
  // receipt uninstall uses to remove a file muster made. Deliberately a plain
  // writeFile, not a temp+rename: config.toml is the user's own file and is
  // commonly a dotfiles SYMLINK -- a rename would silently replace the link
  // with a regular file. A torn write is self-healing (reinstall re-converges
  // the block; malformed markers fail loud rather than corrupting silently).
  const existingConfig = (await exists(configPath)) ? await readFile(configPath, "utf8") : null;
  const mergedConfig = mergePermissionRules(existingConfig);
  // `created` is sticky across reinstalls: once muster made the file, a later
  // merge (file now present) must not flip the receipt, or uninstall would
  // leave an empty config.toml husk behind.
  const configCreated = mergedConfig.created || previous?.permissionRules?.created === true;
  await writeFile(configPath, mergedConfig.text, "utf8");

  await mkdir(dirname(manifestPath), { recursive: true });
  await atomicWriteJson(manifestPath, {
    format: 1, owner: "muster", packageVersion,
    agents: agents.map(a => a.rel), skills: skills.map(s => s.rel), verbs: verbs.map(v => v.rel),
    permissionRules: { created: configCreated }
  });

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

// Reverse runKimiInstall: remove exactly the manifest-owned files (never a
// wholesale directory removal -- a user's own agents/skills sharing those dirs
// are untouched), strip muster's marker-delimited permission-rules block from
// config.toml (deleting the file only when muster created it), prune the
// now-empty muster-created dirs, and drop the manifest.
export async function runKimiUninstall({ home = homedir(), dryRun = false } = {}) {
  const dest = kimiHome(home);
  const manifestPath = join(dest, "muster", KIMI_MANIFEST);
  const manifest = await readManifest(manifestPath, dest);
  if (!manifest) return { dest, removed: [], note: "no muster install found" };

  const owned = [...manifest.agents, ...manifest.skills, ...(manifest.verbs || [])];
  const configPath = join(dest, "config.toml");
  if (dryRun) {
    return {
      dryRun: true, dest, wouldRemove: owned, fileCount: owned.length,
      ...(manifest.permissionRules ? { wouldStripPermissionRules: await exists(configPath) } : {})
    };
  }

  const removed = [];
  for (const rel of owned) {
    try { await unlink(join(dest, rel)); removed.push(rel); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  // The fence block: manifest-gated (a pre-fence manifest has no
  // `permissionRules` and must not touch config.toml at all), marker-scoped
  // (only muster's block is removed; a config the user deleted first is a
  // clean skip). Same plain-writeFile rationale as the install merge.
  let configRemoved = false;
  if (manifest.permissionRules && (await exists(configPath))) {
    const stripped = stripPermissionRules(await readFile(configPath, "utf8"), manifest.permissionRules);
    if (stripped === null) { await unlink(configPath); configRemoved = true; }
    else await writeFile(configPath, stripped.text, "utf8");
  }

  // Prune empty skill dirs (deepest first), then the agents/skills roots.
  const skillDirs = [...new Set([...manifest.skills, ...(manifest.verbs || [])].map(rel => rel.split("/").slice(0, 2).join("/")))];
  for (const rel of skillDirs) await rmdirIfEmpty(join(dest, rel));
  await rmdirIfEmpty(join(dest, "skills"));
  await rmdirIfEmpty(join(dest, "agents"));
  await unlink(manifestPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  await rmdirIfEmpty(join(dest, "muster"));

  return { dest, removed, fileCount: removed.length, ...(manifest.permissionRules ? { permissionRules: { stripped: true, configRemoved } } : {}) };
}

// Manifest publish: temp-write-then-rename via fs-safe.js's shared atomicWrite
// (audit S4) with its DEFAULT temp name -- the pid+RANDOM suffix is the
// collision handling: this site's historical pid-only temp name
// (`.tmp-<pid>`, no random) could hit EEXIST under atomicWrite's O_EXCL open
// when a stale temp from a crashed install met a recycled pid, where the old
// plain writeFile simply overwrote. fsync stays off (the manifest is small
// and a torn publish is self-healing on rerun; the fence block's config.toml
// write is deliberately NOT this helper -- see the "deliberately a plain
// writeFile" comment at the install merge).
async function atomicWriteJson(path, value) {
  await atomicWrite(path, JSON.stringify(value, null, 2) + "\n", { fsync: false });
}
