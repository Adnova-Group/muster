// `muster skills <verb>`: see and opt into muster's bundled skills (docs/strategy/
// 2026-11-revival-review.md, "Skill discovery follow-up"). The ~140 builtins in plugin/builtins/
// are not in Claude Code's skill listing (zero idle cost); builders get them by path through the
// planner's per-task `skills` binding. These verbs make them visible and let a project opt in:
//
//   list [domain]           builtins by catalog role, with upstream and license
//   show <id>               description, source, license, roles, path, project status
//   search <query>          builtins first (match --skills ranking), then the ui-skills.com registry
//   enable <id> / disable   copy a builtin into .claude/skills/<id>/ (per project) / remove that copy
//   add <publisher>/<skill> install a registry skill after a license check (network)
//   pin <id> [--role r]     .muster/config pins the planner always binds / unpin
//   usage                   bound, applied, missed and never-used skills across .muster/runs/
//
// Network only on `search` (registry catalog, cached with a TTL) and `add`. `enable`/`add` record
// every file they write, with its hash, in .claude/skills/.muster-enabled.json; `disable` removes
// only those files, and only while unmodified.
import { existsSync, readdirSync, readFileSync, lstatSync } from "node:fs";
import { lstat, readFile, readdir, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, relative, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { matchFrontmatter } from "./frontmatter.js";
import { matchSkills } from "./match.js";
import { ROLES } from "./roles.js";
import { PLUGIN_ROOT, specialistCatalog } from "./specialists.js";
import { createContainedFile, ensureContainedDirectory, sha256, writeContainedFile, assertContainedNoSymlinkPath } from "./fs-safe.js";
import { parsePlan } from "./plan-lint.js";
import {
  CONFIG_REL, ENABLED_MANIFEST_REL, SKILL_ID_RE, readEnabledManifest, readPins, readProjectConfig,
} from "./skill-pins.js";
import {
  MAX_SKILL_FILE_BYTES, fetchCommitSha, fetchRawFile, fetchRepoLicense, findRegistryEntry, githubSource,
  licenseVerdict, loadRegistry, matchRegistry, referencedFiles, safeSkillFile, userCacheDir,
} from "./skill-registry.js";

const PACKAGE_VERSION = (() => {
  try { return JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version || "unknown"; } catch { return "unknown"; }
})();
const UNROUTED = "unrouted";
const oneLine = (s) => String(s || "").replace(/\s+/g, " ").trim();

function readFrontmatter(path) {
  try {
    const fm = matchFrontmatter(readFileSync(path, "utf8"));
    return fm ? parseYaml(fm.body) || {} : {};
  } catch {
    return {};
  }
}

function listFilesSync(dir, base = dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFilesSync(abs, base));
    else if (entry.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

// Upstream entries from a builtin's stamped `upstream:` frontmatter (vendor/manifest.yaml is the
// source of truth; `muster provenance` keeps the stamp in sync).
function upstreamOf(fm) {
  return (Array.isArray(fm.upstream) ? fm.upstream : []).filter((u) => u && typeof u === "object");
}

export function sourceLabel(upstream) {
  const labels = [...new Set(upstream.map((u) => u.repo || u.title || u.author).filter(Boolean))];
  return labels.length ? labels.join(", ") : "muster";
}

// Every builtin under plugin/builtins/, catalogued or not, sorted by id:
// [{id, name, description, roles, rank, cataloged, license, upstream, path, files}]
export function builtinInventory({ catalogDir, pluginRoot } = {}) {
  const catalog = specialistCatalog({ ...(catalogDir ? { catalogDir } : {}), ...(pluginRoot ? { pluginRoot } : {}) });
  const dir = join(pluginRoot || PLUGIN_ROOT, "builtins");
  const out = [];
  for (const id of (existsSync(dir) ? readdirSync(dir) : []).sort()) {
    const path = join(dir, id, "SKILL.md");
    if (!existsSync(path)) continue;
    const fm = readFrontmatter(path);
    const entry = catalog.skills.get(id);
    out.push({
      id,
      name: String(fm.name || id),
      description: oneLine(fm.description || entry?.description),
      roles: entry?.roles || [],
      keywords: entry?.keywords || [],
      rank: entry?.rank ?? 0,
      cataloged: !!entry,
      license: String(fm.license || entry?.license || "unknown"),
      upstream: upstreamOf(fm),
      path,
      files: listFilesSync(join(dir, id)),
    });
  }
  return out;
}

const primaryRole = (b) => b.roles[0] || UNROUTED;
const roleOrder = (r) => (r === UNROUTED ? ROLES.length : ROLES.indexOf(r));

// Builtins grouped by primary catalog role (ROLES order, unrouted last). `filter` keeps the
// builtins carrying that role, or, when no role has that name, an id family prefix ("emil").
export function groupBuiltins(inventory, filter = null) {
  let items = inventory;
  if (filter) {
    const f = String(filter).toLowerCase();
    items = ROLES.includes(f) || f === UNROUTED
      ? inventory.filter((b) => (f === UNROUTED ? !b.roles.length : b.roles.includes(f)))
      : inventory.filter((b) => b.id === f || b.id.startsWith(`${f}-`));
  }
  const groups = new Map();
  for (const b of items) {
    const role = filter && ROLES.includes(String(filter).toLowerCase()) ? String(filter).toLowerCase() : primaryRole(b);
    if (!groups.has(role)) groups.set(role, []);
    groups.get(role).push(b);
  }
  return [...groups].sort(([a], [b]) => roleOrder(a) - roleOrder(b)).map(([role, skills]) => ({ role, skills }));
}

// How the reader runs a skills verb. `muster` is not on a plugin user's PATH: the plugin's
// commands call the CLI through plugin/runtime/muster.sh, which sets MUSTER_VIA=claude-plugin,
// and the user types /muster:skills. An npm-global install (no MUSTER_VIA) types `muster skills`.
export const skillsCommand = (env = process.env) => (env.MUSTER_VIA === "claude-plugin" ? "/muster:skills" : "muster skills");

function renderList(groups, total, filter, cmd = "muster skills") {
  const shown = groups.reduce((n, g) => n + g.skills.length, 0);
  const lines = [`muster builtins: ${shown}${filter ? ` matching "${filter}"` : ""} of ${total}, as role: source · license: ids (details: ${cmd} show <id>)`];
  if (!filter) {
    // Unfiltered: one line per role naming its sources, so the list stays small however many
    // builtins are vendored (its output is model context). `list <role>` gives the ids.
    lines[0] = `muster builtins: ${total}, by role: sources (ids: ${cmd} list <role>; details: ${cmd} show <id>)`;
    for (const g of groups) {
      const sources = [...new Set(g.skills.map((b) => sourceLabel(b.upstream)))];
      const note = g.role === UNROUTED ? "; not in the catalog, so the planner never binds these" : "";
      lines.push(`${g.role} (${g.skills.length}): ${sources.join(", ")}${note}`);
    }
    return lines.join("\n") + "\n";
  }
  for (const g of groups) {
    lines.push(`${g.role} (${g.skills.length})${g.role === UNROUTED ? ": not in the catalog, so the planner never binds these" : ""}`);
    // One line per source and license keeps a role's list short.
    const bySource = new Map();
    for (const b of g.skills) {
      const key = `${sourceLabel(b.upstream)} · ${b.license}`;
      if (!bySource.has(key)) bySource.set(key, []);
      bySource.get(key).push(b.id);
    }
    for (const [key, ids] of bySource) lines.push(`  ${key}: ${ids.join(", ")}`);
  }
  if (!shown) lines.push(`no builtin matches "${filter}"; roles: ${ROLES.join(", ")}`);
  return lines.join("\n") + "\n";
}

function projectStatus(cwd, id) {
  const status = [];
  try { if (readEnabledManifest(cwd).skills[id]) status.push(`enabled in .claude/skills/${id}/`); } catch { /* unreadable manifest */ }
  try {
    const pin = readPins(cwd).find((p) => p.id === id);
    if (pin) status.push(`pinned${pin.role ? ` for role ${pin.role}` : " for every task"}`);
  } catch { /* unreadable config */ }
  return status;
}

function upstreamLine(u) {
  if (u.repo) return `${u.repo}${u.ref ? ` @ ${String(u.ref).slice(0, 12)}` : ""}${u.path ? ` ${u.path}` : ""} (${u.license || "?"}, ${u.relation || "?"})`;
  return `${[u.title, u.author].filter(Boolean).join(", ")}${u.url ? ` <${u.url}>` : ""} (${u.kind || "work"}, ${u.relation || "inspired-by"})`;
}

function showBuiltin(b, cwd) {
  const status = projectStatus(cwd, b.id);
  return {
    id: b.id, name: b.name, description: b.description, license: b.license,
    roles: b.roles, routed: b.cataloged, source: sourceLabel(b.upstream), upstream: b.upstream,
    path: b.path, files: b.files, project: status,
  };
}

function renderShow(s) {
  return [
    `${s.id}${s.name !== s.id ? ` (${s.name})` : ""}`,
    `  ${s.description || "(no description)"}`,
    `  bound to: ${s.roles.length ? `${s.roles.join(", ")} (preflight proposes it for tasks of these roles)` : "no catalog role, so the planner never binds it; workflows read it by path, or enable it per project"}`,
    `  license: ${s.license}`,
    ...(s.upstream.length ? s.upstream.map((u) => `  source: ${upstreamLine(u)}`) : ["  source: muster-authored"]),
    `  path: ${s.path}${s.files.length > 1 ? ` (+${s.files.length - 1} file${s.files.length > 2 ? "s" : ""})` : ""}`,
    `  project: ${s.project.length ? s.project.join("; ") : "not enabled, not pinned"}`,
  ].join("\n") + "\n";
}

// ── search ───────────────────────────────────────────────────────────────────

export async function searchSkills({ query, inventory, cacheDir, fetchImpl, now = new Date(), network = true, limit = 8 }) {
  const builtinRows = inventory.map((b) => ({ id: b.id, source: "builtin", description: b.description, keywords: b.keywords }));
  const byId = new Map(inventory.map((b) => [b.id, b]));
  const builtins = matchSkills(query, builtinRows, { limit }).map((m) => {
    const b = byId.get(m.id);
    return { id: m.id, score: m.score, roles: b.roles, source: sourceLabel(b.upstream), license: b.license, description: b.description };
  });
  const reg = await loadRegistry({ fetchImpl, cacheDir, now, network });
  const registry = matchRegistry(query, reg.skills, { limit, minScore: 2 }).map((m) => ({ ...m, install: `muster skills add ${m.ref}` }));
  return { query, builtins, registry, registrySource: reg.source, registryFetchedAt: reg.fetchedAt, ...(reg.note ? { note: reg.note } : {}) };
}

const clip = (s, n = 110) => (s.length > n ? `${s.slice(0, n - 3)}...` : s);

function renderSearch(r, cmd = "muster skills") {
  const lines = [`builtins for "${r.query}":`];
  if (!r.builtins.length) lines.push("  (none)");
  for (const b of r.builtins) lines.push(`  ${b.id} [${b.roles.join(",") || UNROUTED}] ${b.source} · ${b.license} - ${clip(b.description)}`);
  lines.push(`ui-skills.com registry${r.registrySource === "none" ? "" : ` (${r.registrySource}${r.registryFetchedAt ? `, ${r.registryFetchedAt}` : ""})`}:`);
  if (!r.registry.length) lines.push("  (none)");
  for (const m of r.registry) lines.push(`  ${m.ref} - ${clip(m.description)} (not installed: ${cmd} add ${m.ref})`);
  if (r.note) lines.push(`note: ${r.note}`);
  return lines.join("\n") + "\n";
}

// ── enable / add / disable ───────────────────────────────────────────────────

const skillsRoot = (cwd) => join(cwd, ".claude", "skills");

function insertAfterFrontmatter(text, comment) {
  const fm = matchFrontmatter(text);
  if (!fm) return null;
  const head = fm.raw.endsWith("\n") ? fm.raw : `${fm.raw}\n`;
  return `${head}\n${comment}\n${/^\r?\n/.test(fm.rest) ? "" : "\n"}${fm.rest}`;
}

// A manifest path that stays inside .claude/skills/<id>/.
function insideSkill(rel, id) {
  if (!rel.startsWith(`${id}/`) || rel.includes("\\")) return false;
  return rel.slice(id.length + 1).split("/").every((s) => s && s !== "." && s !== "..");
}

// An HTML comment whose body never contains "--" (which would end or invalidate it).
const htmlComment = (s) => `<!-- ${String(s).replace(/-{2,}/g, "-")} -->`;

async function writeManifest(cwd, manifest) {
  const path = join(cwd, ENABLED_MANIFEST_REL);
  if (!Object.keys(manifest.skills).length) {
    await unlink(path).catch((e) => { if (e.code !== "ENOENT") throw e; });
    return;
  }
  const sorted = { version: 1, skills: Object.fromEntries(Object.entries(manifest.skills).sort(([a], [b]) => a.localeCompare(b))) };
  await writeContainedFile(cwd, path, JSON.stringify(sorted, null, 2) + "\n");
}

async function pathExists(path) {
  try { await lstat(path); return true; } catch (e) { if (e.code === "ENOENT") return false; throw e; }
}

// Writes `files` ([{rel, bytes}], rel relative to .claude/skills/<id>/) with O_EXCL, rolling
// back what it created on any failure, and returns the manifest file records.
async function installFiles(cwd, id, files) {
  const root = skillsRoot(cwd);
  const created = [];
  try {
    for (const f of files) {
      const abs = join(root, id, ...f.rel.split("/"));
      if (!(await createContainedFile(cwd, abs, f.bytes))) throw new Error(`refusing to overwrite ${relative(cwd, abs)}`);
      created.push(abs);
    }
  } catch (e) {
    for (const abs of created.reverse()) await unlink(abs).catch(() => {});
    await removeEmptyDirs(join(root, id), root);
    throw e;
  }
  return files.map((f) => ({ path: `${id}/${f.rel}`, sha256: sha256(f.bytes) }));
}

async function preflightTarget(cwd, id) {
  if (!SKILL_ID_RE.test(id)) return `invalid skill id ${JSON.stringify(id)}`;
  const manifest = readEnabledManifest(cwd);
  if (manifest.skills[id]) return `${id} is already installed by muster (.claude/skills/${id}/); disable it first`;
  if (await pathExists(join(skillsRoot(cwd), id))) return `.claude/skills/${id}/ already exists and muster did not create it; refusing to overwrite`;
  return null;
}

export async function enableSkill({ cwd, id, inventory, now = new Date(), version = PACKAGE_VERSION, cmd = "muster skills" }) {
  const b = inventory.find((x) => x.id === id);
  if (!b) return { ok: false, id, problems: [`unknown builtin ${JSON.stringify(id)}; see ${cmd} list`] };
  const refusal = await preflightTarget(cwd, id);
  if (refusal) return { ok: false, id, problems: [refusal] };
  const srcDir = join(b.path, "..");
  const notes = [];
  const files = [];
  for (const rel of b.files) {
    if (lstatSync(join(srcDir, ...rel.split("/"))).isSymbolicLink()) continue;
    let bytes = await readFile(join(srcDir, ...rel.split("/")));
    if (rel === "SKILL.md") {
      const up = b.upstream.length ? b.upstream.map((u) => (u.repo ? `${u.repo}@${String(u.ref || "").slice(0, 12)}${u.path ? ` ${u.path}` : ""} (${u.relation})` : `${u.title || u.author} (${u.relation})`)).join("; ") : "muster-authored";
      const comment = htmlComment(`muster skills: copied from muster ${version} builtin "${id}" by \`muster skills enable\` on ${now.toISOString().slice(0, 10)}. License: ${b.license}. Upstream: ${up}. \`muster skills disable ${id}\` removes the unmodified copies.`);
      const next = insertAfterFrontmatter(bytes.toString("utf8"), comment);
      if (next === null) return { ok: false, id, problems: [`${id}/SKILL.md has no frontmatter`] };
      bytes = Buffer.from(next);
    }
    if (/\$\{?CLAUDE_PLUGIN_ROOT/.test(bytes.toString("utf8")) && !notes.length) notes.push("it references ${CLAUDE_PLUGIN_ROOT} paths, which resolve only while the muster plugin is installed");
    files.push({ rel, bytes });
  }
  const records = await installFiles(cwd, id, files);
  const manifest = readEnabledManifest(cwd);
  manifest.skills[id] = {
    kind: "builtin", source: `muster ${version} builtin ${id}`, license: b.license,
    upstream: b.upstream.map((u) => u.repo || u.title).filter(Boolean), installedAt: now.toISOString(), files: records,
  };
  await writeManifest(cwd, manifest);
  return { ok: true, id, dir: `.claude/skills/${id}/`, files: records.length, license: b.license, ...(notes.length ? { notes } : {}) };
}

export async function addSkill({ cwd, ref, fetchImpl = globalThis.fetch, cacheDir, now = new Date(), env = process.env, cmd = "muster skills" }) {
  if (!/^[^/\s]+\/[^/\s]+$/.test(String(ref || ""))) return { ok: false, ref, problems: ["add <publisher>/<skill>: expected a registry ref such as ibelick/ui-skills-root"] };
  const reg = await loadRegistry({ fetchImpl, cacheDir, now });
  const entry = findRegistryEntry(reg.skills, ref);
  if (!entry) return { ok: false, ref, problems: [reg.skills.length ? `${ref} is not in the ui-skills.com registry; try ${cmd} search` : reg.note || "registry unavailable"] };
  const id = entry.slug.toLowerCase();
  const refusal = await preflightTarget(cwd, id);
  if (refusal) return { ok: false, ref, problems: [refusal] };
  const src = githubSource(entry);
  if (!src) return { ok: false, ref, problems: [`${ref} is not hosted on GitHub (${entry.rawUrl || entry.githubUrl || "no URL"}), so its license cannot be checked; refusing to install it`] };

  let license;
  try { license = licenseVerdict((await fetchRepoLicense(fetchImpl, src.owner, src.repo, { env })).spdx); } catch (e) {
    return { ok: false, ref, problems: [`could not check the license of ${src.owner}/${src.repo}: ${e.message}`] };
  }
  if (!license.ok) return { ok: false, ref, license: license.license, problems: [`refusing ${ref}: ${license.reason} (${src.owner}/${src.repo})`] };

  const sha = await fetchCommitSha(fetchImpl, src.owner, src.repo, src.ref, { env });
  const at = { ...src, ref: sha || src.ref };
  const files = [];
  const skipped = [];
  let total = 0;
  const fetchOne = async (rel, required) => {
    let r;
    try { r = await fetchRawFile(fetchImpl, at, rel); } catch (e) { r = { ok: false, status: e.message }; }
    if (!r.ok) {
      if (required) throw new Error(`could not fetch ${rel} from ${src.owner}/${src.repo} (${r.status})`);
      skipped.push(`${rel} (${r.status})`);
      return null;
    }
    total += Buffer.byteLength(r.text, "utf8");
    if (total > 4 * MAX_SKILL_FILE_BYTES) throw new Error(`${ref} is larger than ${4 * MAX_SKILL_FILE_BYTES} bytes`);
    return r.text;
  };
  let skill;
  try {
    skill = await fetchOne("SKILL.md", true);
    const listed = entry.files.map(safeSkillFile).filter(Boolean);
    const linked = referencedFiles(skill).filter((p) => !listed.includes(p));
    for (const rel of listed.slice(0, 20)) files.push({ rel, bytes: Buffer.from(await fetchOne(rel, true)) });
    for (const rel of linked.slice(0, 20)) {
      const text = await fetchOne(rel, false);
      if (text !== null) files.push({ rel, bytes: Buffer.from(text) });
    }
  } catch (e) {
    return { ok: false, ref, problems: [e.message] };
  }
  const where = `${src.owner}/${src.repo}@${sha ? sha.slice(0, 12) : src.ref}${src.dir ? ` ${src.dir}/SKILL.md` : " SKILL.md"}`;
  const comment = htmlComment(`muster skills: added from the ui-skills.com registry entry ${entry.pathSlug} by \`muster skills add\` on ${now.toISOString().slice(0, 10)}. Upstream: ${where}. License: ${license.license} (GitHub license API). Third-party instructions: review before relying on them. \`muster skills disable ${id}\` removes the unmodified copies.`);
  const stamped = insertAfterFrontmatter(skill, comment);
  if (stamped === null) return { ok: false, ref, problems: [`${ref}: SKILL.md has no frontmatter, so it is not a Claude Code skill`] };
  files.unshift({ rel: "SKILL.md", bytes: Buffer.from(stamped) });
  let records;
  try { records = await installFiles(cwd, id, files); } catch (e) { return { ok: false, ref, problems: [e.message] }; }
  const manifest = readEnabledManifest(cwd);
  manifest.skills[id] = {
    kind: "registry", source: `ui-skills.com ${entry.pathSlug}`, repo: `${src.owner}/${src.repo}`, ref: sha || src.ref,
    path: `${src.dir ? `${src.dir}/` : ""}SKILL.md`, license: license.license, installedAt: now.toISOString(), files: records,
  };
  await writeManifest(cwd, manifest);
  return {
    ok: true, id, ref: entry.pathSlug, dir: `.claude/skills/${id}/`, files: records.length, license: license.license,
    upstream: where, ...(license.note || skipped.length ? { notes: [license.note, ...skipped.map((s) => `skipped linked file ${s}`)].filter(Boolean) } : {}),
  };
}

async function removeEmptyDirs(dir, stopAt) {
  // Never descend into or remove through a symlink: lstat the directory itself first.
  try { if ((await lstat(dir)).isSymbolicLink()) return; } catch { return; }
  let entries;
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) if (e.isDirectory()) await removeEmptyDirs(join(dir, e.name), stopAt);
  if (dir !== stopAt) await rmdir(dir).catch(() => {});
}

// Removes exactly the files enable/add recorded, and only those still byte-identical to what
// was written; anything else in the directory, or any edited file, is left in place.
export async function disableSkill({ cwd, id }) {
  if (!SKILL_ID_RE.test(String(id))) return { ok: false, id, problems: [`invalid skill id ${JSON.stringify(id)}`] };
  const manifest = readEnabledManifest(cwd);
  const rec = manifest.skills[id];
  if (!rec) return { ok: false, id, problems: [`${id} was not installed by muster skills enable/add; nothing removed`] };
  const root = skillsRoot(cwd);
  await ensureContainedDirectory(cwd, root);
  // The skill directory and every path under it must be real (no symlinks) and contained in
  // the project, so a redirected directory can never make disable delete files elsewhere.
  try {
    if (await pathExists(join(root, id))) await assertContainedNoSymlinkPath(cwd, join(root, id));
  } catch (e) {
    return { ok: false, id, problems: [`refusing to disable ${id}: ${e.message}`] };
  }
  const removed = [];
  const kept = [];
  for (const f of rec.files || []) {
    const rel = String(f.path || "");
    if (!insideSkill(rel, id)) { kept.push({ path: rel, reason: "outside the skill directory" }); continue; }
    const abs = join(root, ...rel.split("/"));
    try { await assertContainedNoSymlinkPath(cwd, abs, { allowMissingFinal: true }); }
    catch { kept.push({ path: rel, reason: "path is not a contained regular file" }); continue; }
    let info;
    try { info = await lstat(abs); } catch (e) { if (e.code === "ENOENT") continue; throw e; }
    if (!info.isFile() || info.isSymbolicLink()) { kept.push({ path: rel, reason: "no longer a regular file" }); continue; }
    if (sha256(await readFile(abs)) !== f.sha256) { kept.push({ path: rel, reason: "modified since install" }); continue; }
    await unlink(abs);
    removed.push(rel);
  }
  await removeEmptyDirs(join(root, id), root);
  delete manifest.skills[id];
  await writeManifest(cwd, manifest);
  const left = await pathExists(join(root, id));
  return { ok: true, id, removed: removed.length, ...(kept.length ? { kept } : {}), ...(left ? { note: `.claude/skills/${id}/ still holds files muster did not write or that were edited; they are yours now` } : {}) };
}

// ── pin / unpin ──────────────────────────────────────────────────────────────

async function writeProjectConfig(cwd, config) {
  await writeContainedFile(cwd, join(cwd, CONFIG_REL), JSON.stringify(config, null, 2) + "\n");
}

export async function pinSkill({ cwd, id, role = null, inventory, cmd = "muster skills" }) {
  const b = inventory.find((x) => x.id === id);
  let installed = false;
  try { installed = !!readEnabledManifest(cwd).skills[id]; } catch { /* treated as not installed */ }
  if (!b && !installed) return { ok: false, id, problems: [`unknown skill ${JSON.stringify(id)}: pin a builtin or a skill installed with ${cmd} add`] };
  if (b && !b.cataloged && !installed) return { ok: false, id, problems: [`${id} is not in the catalog, so build-args cannot bind it; enable it per project instead`] };
  if (role !== null && !ROLES.includes(role)) return { ok: false, id, problems: [`unknown role ${JSON.stringify(role)}; roles: ${ROLES.join(", ")}`] };
  const config = readProjectConfig(cwd);
  const skills = config.skills && typeof config.skills === "object" && !Array.isArray(config.skills) ? config.skills : {};
  const pins = (Array.isArray(skills.pins) ? skills.pins : []).filter((p) => p?.id !== id);
  pins.push(role ? { id, role } : { id });
  await writeProjectConfig(cwd, { version: 1, ...config, skills: { ...skills, pins } });
  return { ok: true, id, ...(role ? { role } : {}), config: CONFIG_REL.split(sep).join("/"), pins: pins.length };
}

export async function unpinSkill({ cwd, id }) {
  const config = readProjectConfig(cwd);
  const pins = Array.isArray(config.skills?.pins) ? config.skills.pins : [];
  if (!pins.some((p) => p?.id === id)) return { ok: false, id, problems: [`${id} is not pinned in ${CONFIG_REL.split(sep).join("/")}`] };
  await writeProjectConfig(cwd, { ...config, skills: { ...config.skills, pins: pins.filter((p) => p?.id !== id) } });
  return { ok: true, id, pins: pins.length - 1 };
}

// ── usage ────────────────────────────────────────────────────────────────────

async function readJson(path) {
  try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; }
}

const ids = (list) => (Array.isArray(list) ? list : []).map((k) => (typeof k === "string" ? k : k?.id)).filter((k) => typeof k === "string" && k);

function resultTasks(result) {
  if (result && result.result && typeof result.result === "object" && !Array.isArray(result.tasks)) result = result.result;
  if (Array.isArray(result?.tasks)) return result.tasks;
  if (Array.isArray(result?.items)) return result.items.flatMap((i) => (Array.isArray(i?.tasks) ? i.tasks : []));
  return [];
}

// Aggregates `.muster/runs/*/`: bound from build-args.json (else PLAN.md) and pipeline-args.json;
// applied and missed from build-result.json, pipeline-result.json and SUMMARY-*.md. One record per
// (run, task, skill), so a skill both in the build result and its SUMMARY counts once.
export async function skillUsage({ cwd, inventory }) {
  const runsDir = join(cwd, ".muster", "runs");
  const runs = existsSync(runsDir) ? (await readdir(runsDir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name).sort() : [];
  const rec = new Map(); // `${run}\0${task}\0${skill}` -> {bound, applied, missed}
  const withResult = new Set(); // `${run}\0${task}`
  const touch = (run, task, skill) => {
    const key = `${run}\0${task}\0${skill}`;
    if (!rec.has(key)) rec.set(key, { run, task, skill, bound: false, applied: false, missed: false });
    return rec.get(key);
  };
  for (const run of runs) {
    const dir = join(runsDir, run);
    const args = await readJson(join(dir, "build-args.json"));
    if (args && Array.isArray(args.waves)) {
      for (const t of args.waves.flat()) for (const s of ids(t?.skills)) touch(run, t.taskId, s).bound = true;
    } else if (existsSync(join(dir, "PLAN.md"))) {
      try { for (const t of parsePlan(await readFile(join(dir, "PLAN.md"), "utf8")).tasks) for (const s of t.skills || []) touch(run, t.id, s).bound = true; } catch { /* unreadable plan */ }
    }
    for (const t of resultTasks(await readJson(join(dir, "build-result.json")))) {
      if (!t?.taskId) continue;
      withResult.add(`${run}\0${t.taskId}`);
      for (const s of ids((t.skillsApplied || []).filter((u) => u?.how))) touch(run, t.taskId, s).applied = true;
      for (const s of ids(t.skillsMissing)) touch(run, t.taskId, s).missed = true;
    }
    const pargs = await readJson(join(dir, "pipeline-args.json"));
    for (const ph of Array.isArray(pargs?.phases) ? pargs.phases : []) for (const s of ids(ph?.skills)) touch(run, `phase:${ph.id}`, s).bound = true;
    const presult = await readJson(join(dir, "pipeline-result.json"));
    const phases = presult?.result?.phases || presult?.phases;
    for (const ph of Array.isArray(phases) ? phases : []) {
      if (!ph?.id) continue;
      withResult.add(`${run}\0phase:${ph.id}`);
      for (const s of ids((ph.skillsApplied || []).filter((u) => u?.how))) touch(run, `phase:${ph.id}`, s).applied = true;
    }
    let names = [];
    try { names = (await readdir(dir)).filter((f) => /^SUMMARY-.+\.md$/.test(f)).sort(); } catch { /* no dir */ }
    for (const f of names) {
      const task = f.slice(8, -3);
      withResult.add(`${run}\0${task}`);
      const text = await readFile(join(dir, f), "utf8").catch(() => "");
      for (const m of text.matchAll(/^- skill ([a-z0-9][a-z0-9-]*): /gm)) touch(run, task, m[1]).applied = true;
      for (const m of text.matchAll(/^- skills without evidence: (.+)$/gm)) for (const s of m[1].split(/,\s*/).filter(Boolean)) touch(run, task, s.trim()).missed = true;
    }
  }
  const per = new Map();
  for (const r of rec.values()) {
    if (r.bound && withResult.has(`${r.run}\0${r.task}`) && !r.applied) r.missed = true;
    if (!per.has(r.skill)) per.set(r.skill, { id: r.skill, bound: 0, applied: 0, missed: 0, runs: new Set() });
    const p = per.get(r.skill);
    if (r.bound) p.bound++;
    if (r.applied) p.applied++;
    if (r.missed && !r.applied) p.missed++;
    p.runs.add(r.run);
  }
  const skills = [...per.values()].sort((a, b) => b.bound - a.bound || a.id.localeCompare(b.id)).map((p) => ({ ...p, runs: p.runs.size }));
  const used = new Set(skills.filter((s) => s.bound || s.applied).map((s) => s.id));
  const neverUsed = inventory.map((b) => b.id).filter((id) => !used.has(id));
  return { runs: runs.length, tasksWithResults: withResult.size, skills, neverUsed };
}

function renderUsage(u) {
  if (!u.runs) return "no runs under .muster/runs/ yet; usage appears after /muster:plan or /muster:go\n";
  const width = Math.max(10, ...u.skills.map((s) => s.id.length));
  const lines = [`skill usage across ${u.runs} run${u.runs === 1 ? "" : "s"} (${u.tasksWithResults} task${u.tasksWithResults === 1 ? "" : "s"} with results)`];
  if (u.skills.length) {
    lines.push(`  ${"skill".padEnd(width)}  bound  applied  missed  runs`);
    for (const s of u.skills) lines.push(`  ${s.id.padEnd(width)}  ${String(s.bound).padStart(5)}  ${String(s.applied).padStart(7)}  ${String(s.missed).padStart(6)}  ${String(s.runs).padStart(4)}`);
  } else lines.push("  no task bound a skill");
  const head = u.neverUsed.slice(0, 12).join(", ");
  lines.push(`never bound: ${u.neverUsed.length} builtin${u.neverUsed.length === 1 ? "" : "s"}${u.neverUsed.length ? ` (${head}${u.neverUsed.length > 12 ? ", ... --json for all" : ""})` : ""}`);
  return lines.join("\n") + "\n";
}

// ── generated docs page ──────────────────────────────────────────────────────

export const SKILLS_PAGE_PATH = "website/reference/skills.md";
export const SKILLS_BEGIN = "<!-- BEGIN GENERATED by `node scripts/gen-skills-page.mjs` from catalog/ and plugin/builtins/; do not edit -->";
export const SKILLS_END = "<!-- END GENERATED -->";
const cell = (s) => String(s).replace(/\|/g, "\\|").replace(/</g, "&lt;");

function sourceCell(upstream) {
  if (!upstream.length) return "Muster";
  const seen = new Set();
  const parts = [];
  for (const u of upstream) {
    const label = u.repo ? `[${u.repo}](https://github.com/${u.repo})` : u.url ? `[${cell(u.title || u.author)}](${u.url})` : cell(u.title || u.author || "unknown");
    if (seen.has(label)) continue;
    seen.add(label);
    parts.push(`${label} (${u.relation || "?"})`);
  }
  return parts.join(", ");
}

export function generateSkillsBlock(inventory) {
  const groups = groupBuiltins(inventory);
  const routed = inventory.filter((b) => b.cataloged).length;
  let out = `${inventory.length} builtins: ${routed} in the catalog (preflight proposes them by role), ${inventory.length - routed} unrouted (read by path only).\n`;
  for (const g of groups) {
    out += `\n### ${g.role} (${g.skills.length})\n\n| Skill | What it does | Source | License |\n| --- | --- | --- | --- |\n`;
    for (const b of g.skills) {
      const d = b.description.length > 160 ? `${b.description.slice(0, 157)}...` : b.description;
      out += `| \`${b.id}\` | ${cell(d)} | ${sourceCell(b.upstream)} | ${cell(b.license)} |\n`;
    }
  }
  return out;
}

// Replace the generated block; null when the markers are missing.
export function stampSkillsPage(text, inventory) {
  const begin = text.indexOf(SKILLS_BEGIN);
  const end = text.indexOf(SKILLS_END);
  if (begin === -1 || end === -1 || end < begin) return null;
  return `${text.slice(0, begin)}${SKILLS_BEGIN}\n\n${generateSkillsBlock(inventory)}\n${text.slice(end)}`;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

// Up to 3 ids sharing the longest prefix with a mistyped one (at least 3 characters).
function didYouMean(want, all) {
  const common = (a, b) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  return all.map((id) => [id, common(want, id)]).filter(([, n]) => n >= 3)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 3).map(([id]) => id);
}

export const SKILLS_USAGE = "skills <list [domain]|show <id>|search <query> [--offline]|enable <id>|disable <id>|add <publisher>/<skill>|pin <id> [--role <role>]|unpin <id>|usage> [--json]";

// Returns the exit code: 0 done, 1 refused or failed, 2 usage error.
export async function runSkillsCli(argv, { cwd = process.cwd(), env = process.env, home = homedir(), fetchImpl = globalThis.fetch, now = new Date(), stdout = process.stdout, stderr = process.stderr, inventory = null } = {}) {
  const json = argv.includes("--json");
  const offline = argv.includes("--offline");
  const role = (() => { const i = argv.indexOf("--role"); return i >= 0 ? argv[i + 1] ?? "" : null; })();
  const words = argv.filter((a, i) => !a.startsWith("--") && argv[i - 1] !== "--role");
  const [verb, ...args] = words;
  const inv = inventory || builtinInventory();
  const cacheDir = userCacheDir(env, home);
  const emit = (obj, text) => { stdout.write(json ? JSON.stringify(obj, null, 2) + "\n" : text); return obj.ok === false ? 1 : 0; };
  const cmd = skillsCommand(env);
  const refuse = (r) => emit(r, `muster skills ${verb}: ${(r.problems || []).join("; ")}\n`);
  const usage = (msg) => { stderr.write(`muster: ${msg}\nusage: muster ${SKILLS_USAGE}\n`); return 2; };

  switch (verb) {
    case "list": case undefined: {
      const groups = groupBuiltins(inv, args[0] || null);
      const obj = { total: inv.length, groups: groups.map((g) => ({ role: g.role, skills: g.skills.map((b) => ({ id: b.id, source: sourceLabel(b.upstream), license: b.license, routed: b.cataloged })) })) };
      return emit(obj, renderList(groups, inv.length, args[0] || null, cmd));
    }
    case "show": {
      if (!args[0]) return usage("skills show <id>: missing id");
      const b = inv.find((x) => x.id === args[0]);
      if (!b) {
        const near = didYouMean(args[0], inv.map((x) => x.id));
        return refuse({ ok: false, id: args[0], problems: [`unknown builtin ${JSON.stringify(args[0])}${near.length ? `; did you mean ${near.join(", ")}?` : ""}`] });
      }
      const s = showBuiltin(b, cwd);
      return emit(s, renderShow(s));
    }
    case "search": {
      const query = args.join(" ");
      if (!query.trim()) return usage("skills search <query>: missing query");
      const r = await searchSkills({ query, inventory: inv, cacheDir, fetchImpl, now, network: !offline });
      return emit(r, renderSearch(r, cmd));
    }
    case "enable": {
      if (!args[0]) return usage("skills enable <id>: missing id");
      const r = await enableSkill({ cwd, id: args[0], inventory: inv, now, cmd });
      return r.ok ? emit(r, `enabled ${r.id}: ${r.files} file${r.files === 1 ? "" : "s"} in ${r.dir} (${r.license}); Claude Code offers it in this project from the next session${r.notes ? `\nnote: ${r.notes.join("; ")}` : ""}\n`) : refuse(r);
    }
    case "disable": {
      if (!args[0]) return usage("skills disable <id>: missing id");
      const r = await disableSkill({ cwd, id: args[0] });
      return r.ok ? emit(r, `disabled ${r.id}: removed ${r.removed} file${r.removed === 1 ? "" : "s"}${r.kept ? `; kept ${r.kept.map((k) => `${k.path} (${k.reason})`).join(", ")}` : ""}${r.note ? `\nnote: ${r.note}` : ""}\n`) : refuse(r);
    }
    case "add": {
      if (!args[0]) return usage("skills add <publisher>/<skill>: missing ref");
      const r = await addSkill({ cwd, ref: args[0], fetchImpl, cacheDir, now, env, cmd });
      return r.ok ? emit(r, `added ${r.ref} as ${r.dir}: ${r.files} file${r.files === 1 ? "" : "s"}, ${r.license}, from ${r.upstream}; review it before relying on it${r.notes ? `\nnote: ${r.notes.join("; ")}` : ""}\n`) : refuse(r);
    }
    case "pin": {
      if (!args[0]) return usage("skills pin <id> [--role <role>]: missing id");
      if (role === "") return usage("skills pin: --role needs a role");
      const r = await pinSkill({ cwd, id: args[0], role, inventory: inv, cmd });
      return r.ok ? emit(r, `pinned ${r.id}${r.role ? ` for role ${r.role}` : " for every task"} in ${r.config}; build-args binds it from the next plan\n`) : refuse(r);
    }
    case "unpin": {
      if (!args[0]) return usage("skills unpin <id>: missing id");
      const r = await unpinSkill({ cwd, id: args[0] });
      return r.ok ? emit(r, `unpinned ${r.id}\n`) : refuse(r);
    }
    case "usage": {
      const u = await skillUsage({ cwd, inventory: inv });
      return emit(u, renderUsage(u));
    }
    default:
      return usage(`unknown skills verb ${JSON.stringify(verb)}`);
  }
}

// For the docs generator script and its drift test.
export async function readSkillsPage(root) {
  return readFile(join(root, SKILLS_PAGE_PATH), "utf8");
}
export async function writeSkillsPage(root, text) {
  await writeFile(join(root, SKILLS_PAGE_PATH), text);
}
