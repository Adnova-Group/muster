import { parse, stringify } from "yaml";
import { mkdir, readdir, lstat, realpath, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, sep, resolve, relative, isAbsolute, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists } from "./fs-util.js";
import { modelForRole, maxTier, floorAtSonnet } from "./model.js";
import { matchFrontmatter } from "./frontmatter.js";

// Allowlist of tools vendored agent frontmatter may reference.
// Derived from the tools lines in plugin/agents/wsh-*.md (all use the same set)
// plus additional Claude built-ins that are safe to expose to sub-agents.
const ALLOWED_TOOLS = new Set([
  "Read", "Grep", "Glob", "Edit", "Write", "Bash",
  "WebFetch", "WebSearch", "TodoWrite", "NotebookRead",
  "KillShell", "BashOutput"
]);
const DEFAULT_TOOLS = "Read, Grep, Glob, Edit, Bash";

const ID_RE = /^[a-zA-Z0-9_-]+$/;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const REF_RE = /^[A-Za-z0-9_.\/~^-]+$/;
const NOFOLLOW = constants.O_NOFOLLOW || 0;

function contained(root, candidate) {
  const rel = relative(root, candidate);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function lstatIfExists(path) {
  try { return await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function canonicalDirectory(path, label) {
  const info = await lstatIfExists(path);
  if (!info?.isDirectory() || info.isSymbolicLink()) throw new Error(`unsafe ${label} path: root must be a real directory`);
  return realpath(path);
}

async function readSourceRegular(root, itemPath) {
  const canonicalRoot = await canonicalDirectory(root, "source");
  const target = resolve(canonicalRoot, itemPath);
  if (!contained(canonicalRoot, target)) throw new Error("unsafe source path: traversal outside source root");
  const rel = relative(canonicalRoot, target);
  let cursor = canonicalRoot;
  for (const [index, part] of rel.split(sep).filter(Boolean).entries()) {
    cursor = join(cursor, part);
    const info = await lstatIfExists(cursor);
    if (!info) return null;
    const final = index === rel.split(sep).filter(Boolean).length - 1;
    if (info.isSymbolicLink() || (final ? !info.isFile() : !info.isDirectory()))
      throw new Error("unsafe source path: symlink or special component");
  }
  const canonicalTarget = await realpath(target);
  if (!contained(canonicalRoot, canonicalTarget)) throw new Error("unsafe source path: canonical escape");
  let handle;
  try {
    handle = await open(target, constants.O_RDONLY | NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw new Error("unsafe source path: item is not a regular file");
    return await handle.readFile("utf8");
  } catch (error) {
    if (["ELOOP", "EMLINK", "EINVAL"].includes(error?.code)) throw new Error("unsafe source path: no-follow open rejected item");
    throw error;
  } finally {
    await handle?.close();
  }
}

async function ensureOutputDirectory(root, directory) {
  if (!contained(root, directory)) throw new Error("unsafe output path: traversal outside repoRoot");
  const parts = relative(root, directory).split(sep).filter(Boolean);
  let cursor = root;
  for (const part of parts) {
    cursor = join(cursor, part);
    let info = await lstatIfExists(cursor);
    if (!info) {
      await mkdir(cursor, { mode: 0o755 });
      info = await lstat(cursor);
    }
    if (info.isSymbolicLink() || !info.isDirectory())
      throw new Error(`unsafe output path: ${cursor} is a symlink or special component`);
    const canonical = await realpath(cursor);
    if (!contained(root, canonical)) throw new Error("unsafe output path: canonical ancestry escapes repoRoot");
  }
}

async function readOutputRegular(path) {
  const info = await lstatIfExists(path);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`unsafe output path: ${path} is not a regular file`);
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    if (!(await handle.stat()).isFile()) throw new Error(`unsafe output path: ${path} is not a regular file`);
    return await handle.readFile();
  } finally {
    await handle?.close();
  }
}

async function atomicPublish(root, relativePath, content) {
  const target = resolve(root, relativePath);
  if (!contained(root, target)) throw new Error("unsafe output path: traversal outside repoRoot");
  await ensureOutputDirectory(root, dirname(target));
  await readOutputRegular(target); // reject an existing symlink/special file
  const bytes = Buffer.isBuffer(content) ? content : Buffer.from(content);
  const temp = join(dirname(target), `.${basename(target)}.${process.pid}.${randomBytes(12).toString("hex")}.muster-tmp-`);
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const staged = await readOutputRegular(temp);
    if (!staged || Buffer.compare(staged, bytes) !== 0) throw new Error("unsafe output path: staged publication verification failed");
    await ensureOutputDirectory(root, dirname(target));
    await readOutputRegular(target); // reject ancestry/target swaps before publication
    await rename(temp, target);
    const published = await readOutputRegular(target);
    if (!published || Buffer.compare(published, bytes) !== 0) throw new Error("unsafe output path: publication verification failed");
  } finally {
    await handle?.close();
    try { await unlink(temp); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
}

export function validateVendorManifest(doc) {
  const errors = [];
  if (!doc || !Array.isArray(doc.sources)) return { ok: false, errors: ["manifest.sources must be an array"] };
  doc.sources.forEach((s, i) => {
    if (!s.id) {
      errors.push(`sources[${i}].id: required`);
    } else if (!ID_RE.test(s.id)) {
      errors.push(`sources[${i}].id: invalid — must match /^[a-zA-Z0-9_-]+$/`);
    }
    if (!s.license) errors.push(`sources[${i}].license: required`);
    if (!["local", "github"].includes(s.kind)) errors.push(`sources[${i}].kind: must be local|github`);
    if (s.repo !== undefined && !REPO_RE.test(s.repo))
      errors.push(`sources[${i}].repo: invalid — must be owner/name (alphanumeric, dash, dot, underscore only)`);
    if (s.ref !== undefined) {
      if (!REF_RE.test(s.ref) || s.ref.startsWith("-"))
        errors.push(`sources[${i}].ref: invalid — must not start with "-" and may only contain alphanumeric, _./${String.fromCharCode(126)}^- chars`);
    }
    if (!Array.isArray(s.items)) errors.push(`sources[${i}].items: must be an array`);
    else s.items.forEach((it, j) => {
      if (!it.from) errors.push(`sources[${i}].items[${j}].from: required`);
      if (!it.id) {
        errors.push(`sources[${i}].items[${j}].id: required`);
      } else if (!ID_RE.test(it.id)) {
        errors.push(`sources[${i}].items[${j}].id: invalid — must match /^[a-zA-Z0-9_-]+$/`);
      }
      if (!Array.isArray(it.roles) || it.roles.length === 0)
        errors.push(`sources[${i}].items[${j}].roles: required non-empty array`);
      if (it.as !== undefined && it.as !== "agent" && it.as !== "skill")
        errors.push(`sources[${i}].items[${j}].as: must be "agent" or "skill" when set`);
    });
  });
  return { ok: errors.length === 0, errors };
}

export function splitFrontmatter(text) {
  const m = matchFrontmatter(text);
  if (!m) return { data: {}, body: text };
  return { data: parse(m.body) || {}, body: m.rest };
}

export function toBuiltin(sourceText, item, source) {
  const { data, body } = splitFrontmatter(sourceText);
  const adapted_from = `${source.repo} ${item.from}`;
  const fm = {
    name: data.name || item.id,
    description: item.description || data.description || `Built-in for ${item.roles.join(", ")} (adapted from ${source.repo})`,
    muster_builtin: true,
    adapted_from,
    license: source.license
  };
  const content = `---\n${stringify(fm, { lineWidth: 0 }).trim()}\n---\n\n${body.trim()}\n`;
  const catalogEntry = {
    id: item.id, kind: "builtin", roles: item.roles, rank: item.rank !== undefined ? item.rank : 50,
    provenance: { adapted_from, license: source.license }
  };
  if (item.description) catalogEntry.description = item.description;
  return {
    path: `plugin/builtins/${item.id}/SKILL.md`,
    content,
    catalogEntry
  };
}

// Vendor an item marked `as: agent` into a muster `kind: agent` catalog entry.
// Body goes to plugin/agents/<id>.md; catalog entry to catalog/agents.generated.yaml.
// model tier: maxTier over the item's role-mapped models, floored at sonnet.
// An agent never pins below sonnet — haiku-tier (mechanical) roles ride the
// orchestrator's override instead. The floor is enforced by floorAtSonnet from
// src/model.js (which owns MODEL_TIER_ORDER and tier arithmetic).

// Pure helper: given a roles array, return the model tier toAgent would emit
// (absent an explicit item.model override). Exported so tests and the generator
// share one code path for drift detection.
export function modelForRoles(roles) {
  return floorAtSonnet(maxTier(roles.map(modelForRole)));
}

export function toAgent(sourceText, item, source) {
  const { data, body } = splitFrontmatter(sourceText);
  const adapted_from = `${source.repo} ${item.from}`;
  // item.model is an explicit manifest pin (trusted as-is); otherwise derive from
  // roles via the single policy source (src/model.js), floored at sonnet.
  const model = item.model || modelForRoles(item.roles);
  const filteredTools = (() => {
    if (!data.tools) return DEFAULT_TOOLS;
    const allowed = data.tools.split(",").map(s => s.trim()).filter(t => ALLOWED_TOOLS.has(t));
    return allowed.length > 0 ? allowed.join(", ") : DEFAULT_TOOLS;
  })();
  const fm = {
    name: data.name || item.id,
    description: data.description || `Agent for ${item.roles.join(", ")} (adapted from ${source.repo})`,
    model,
    tools: filteredTools,
    muster_builtin: true,
    adapted_from,
    license: source.license
  };
  const content = `---\n${stringify(fm, { lineWidth: 0 }).trim()}\n---\n\n${body.trim()}\n`;
  return {
    path: `plugin/agents/${item.id}.md`,
    content,
    catalogEntry: {
      id: item.id, kind: "agent", roles: item.roles, rank: 50,
      description: fm.description,
      provenance: { adapted_from, license: source.license }
    }
  };
}

// Do-not-edit banner prepended to every artifact runVendor generates. YAML form is
// a leading comment line (harmless to loadCatalog); NOTICE uses the same text as a
// plain leading line. The marker steers humans back to vendor/manifest.yaml.
const BANNER_TEXT = "GENERATED by `muster vendor` from vendor/manifest.yaml — do not edit";
const YAML_BANNER = `# ${BANNER_TEXT}\n`;

export function generateNotice(builtinEntries) {
  const bySrc = new Map();
  for (const e of builtinEntries) {
    const repo = e.provenance.adapted_from.split(" ")[0];
    if (!bySrc.has(repo)) bySrc.set(repo, e.provenance.license);
  }
  let out = `${BANNER_TEXT}\n\nMuster\nCopyright 2026 Adnova Group\n\nThis product bundles adapted content from:\n`;
  for (const [repo, lic] of bySrc) out += `\n- ${repo} (${lic})`;
  return out + "\n";
}

const pexec = promisify(execFile);

const SEMVER_RE = /^\d+\.\d+\.\d+$/;
const SHA_RE = /^[0-9a-f]{40}$/i;

// Pure function: given a github source and a target directory, return the
// sequence of git commands (each as [cmd, argv]) needed to clone/fetch it.
// When source.ref is a 40-hex SHA, git clone --branch cannot be used (it only
// accepts branch/tag names), so we fall back to init + fetch FETCH_HEAD.
// Branch/tag refs keep the cheaper single-command clone path.
//
// source.url: optional URL override for tests / local fixtures. When absent
// the default https://github.com/<repo>.git URL is used — behaviour is
// byte-identical to the previous implementation for all real sources.
export function cloneCommandsFor(source, dir) {
  const url = source.url || `https://github.com/${source.repo}.git`;
  const ref = source.ref || "main";
  if (SHA_RE.test(ref)) {
    return [
      ["git", ["init", dir]],
      ["git", ["-C", dir, "remote", "add", "origin", url]],
      ["git", ["-C", dir, "fetch", "--depth", "1", "origin", ref]],
      ["git", ["-C", dir, "checkout", "FETCH_HEAD"]],
    ];
  }
  return [
    ["git", ["clone", "--depth", "1", "--branch", ref, url, dir]],
  ];
}

export function pickLatestVersion(entries) {
  if (!entries || entries.length === 0) return undefined;
  const semvers = entries.filter(e => SEMVER_RE.test(e));
  if (semvers.length === 0) return entries[0];
  return semvers.reduce((best, cur) => {
    const [bMaj, bMin, bPat] = best.split(".").map(Number);
    const [cMaj, cMin, cPat] = cur.split(".").map(Number);
    if (cMaj !== bMaj) return cMaj > bMaj ? cur : best;
    if (cMin !== bMin) return cMin > bMin ? cur : best;
    return cPat > bPat ? cur : best;
  });
}

async function resolveSuperpowers(home) {
  const base = join(home, ".claude/plugins/cache/claude-plugins-official/superpowers");
  if (!(await exists(base))) return null;
  const entries = await readdir(base);
  const best = pickLatestVersion(entries);
  const versions = best ? [best, ...entries.filter(e => e !== best)] : entries;
  for (const v of versions) {
    const skills = join(base, v, "skills");
    if (await exists(skills)) return skills;
  }
  return null;
}

async function fetchSourceRoot(source, home) {
  if (source.kind === "local") {
    if (source.id === "superpowers") return { root: await resolveSuperpowers(home) };
    return { root: null };
  }
  const vendorBase = join(tmpdir(), "muster-vendor-");
  const dir = join(tmpdir(), `muster-vendor-${source.id}`);
  // Belt-and-suspenders: computed dir must start with the expected vendor base
  // (validateVendorManifest should have caught bad ids already, but guard anyway).
  if (!dir.startsWith(vendorBase)) {
    return { root: null, error: new Error(`source.id "${source.id}" would escape vendor tmp dir`) };
  }
  try {
    await pexec("rm", ["-rf", dir]);
    for (const [cmd, args] of cloneCommandsFor(source, dir)) {
      await pexec(cmd, args);
    }
    return { root: dir };
  } catch (e) { return { root: null, error: e }; }
}

export async function runVendor({ home = homedir(), repoRoot = process.cwd(), manifest } = {}) {
  const outputRoot = await canonicalDirectory(repoRoot, "output");
  const warnings = [];
  const builtinEntries = [];
  const agentEntries = [];
  for (const source of manifest.sources) {
    const { root, error } = await fetchSourceRoot(source, home);
    if (!root) {
      const detail = error ? `: ${error.message}` : "";
      warnings.push(`source ${source.id}: could not fetch (${source.kind})${detail}`);
      continue;
    }
    for (const item of source.items) {
      const srcPath = join(root, item.from);
      // Guard: srcPath must stay within the clone/source root (no traversal via item.from).
      if (srcPath !== root && !srcPath.startsWith(root + sep)) {
        warnings.push(`${source.id}: item ${item.from} is outside of source root — skipping (traversal attempt)`);
        continue;
      }
      let text;
      try { text = await readSourceRegular(root, item.from); }
      catch (error) { warnings.push(`${source.id}: unsafe source path for ${item.from}: ${error.message}`); continue; }
      if (text === null) { warnings.push(`${source.id}: missing item ${item.from}`); continue; }
      const isAgent = item.as === "agent";
      const { path, content, catalogEntry } = isAgent
        ? toAgent(text, item, source)
        : toBuiltin(text, item, source);
      const abs = join(outputRoot, path);
      // Guard: abs output path must stay within repoRoot (no traversal via item.id).
      if (!contained(outputRoot, abs)) {
        warnings.push(`${source.id}: item.id "${item.id}" would write outside repoRoot — skipping`);
        continue;
      }
      await atomicPublish(outputRoot, path, content);
      (isAgent ? agentEntries : builtinEntries).push(catalogEntry);
    }
  }
  const allEntries = [...builtinEntries, ...agentEntries];
  if (allEntries.length === 0) {
    return { count: 0, warnings: [...warnings, "no items vendored — refusing to overwrite NOTICE/builtins.generated.yaml"] };
  }
  // Only overwrite a generated catalog when we actually produced entries of that kind,
  // so a partial/agent-only re-vendor can't clobber the other file on fetch failure.
  if (builtinEntries.length > 0)
    await atomicPublish(outputRoot, "catalog/builtins.generated.yaml", YAML_BANNER + stringify(builtinEntries, { lineWidth: 0 }));
  if (agentEntries.length > 0)
    await atomicPublish(outputRoot, "catalog/agents.generated.yaml", YAML_BANNER + stringify(agentEntries, { lineWidth: 0 }));
  await atomicPublish(outputRoot, "NOTICE", generateNotice(allEntries));
  return { count: allEntries.length, builtins: builtinEntries.length, agents: agentEntries.length, warnings };
}
