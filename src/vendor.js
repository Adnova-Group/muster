import { parse, stringify } from "yaml";
import { mkdir, mkdtemp, readdir, lstat, realpath, open, rename, rm, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, dirname, sep, resolve, relative, basename } from "node:path";
import { homedir, tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists } from "./fs-util.js";
import { isContainedLexical } from "./fs-safe.js";
import { modelForRole, maxTier, floorAtCore, normalizeTier } from "./model.js";
import { claudeModelForTier, claudeProfileForAgentId } from "./claude.js";
import { matchFrontmatter } from "./frontmatter.js";
import { isSyncItem, isSyncSource, validateSyncItem, validateSyncSource } from "./vendor-sync.js";
import {
  RELATIONS, ITEM_PATHS, WAIVER_STATUSES, WORK_KINDS, LICENSE_REVIEW_FINDINGS, isWorkSource,
  isValidLicense, isVendoredItem, isFetchedSource,
  upstreamEntry, renderUpstreamBlock, generateNotice as generateManifestNotice, NOTICE_PATHS
} from "./provenance.js";

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

// Lexical containment, shared in fs-safe.js (audit S4): true when `candidate`
// resolves to `root` itself or strictly inside it. The canonical-escape check
// in readSourceRegular applies the same predicate to realpath()ed paths.
const contained = isContainedLexical;

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
    // A work (article, book, paper, standard, talk, person, unknown) is credited, never
    // fetched, and only ever inspired-by: it names a title/author instead of a repo.
    const work = isWorkSource(s);
    if (!work && !s.license) errors.push(`sources[${i}].license: required`);
    if (!["local", "github", ...WORK_KINDS].includes(s.kind)) errors.push(`sources[${i}].kind: must be local|github|${WORK_KINDS.join("|")}`);
    if (work) {
      if (s.repo !== undefined || s.ref !== undefined) errors.push(`sources[${i}]: a ${s.kind} source has no repo or ref`);
      if (s.fetch !== false) errors.push(`sources[${i}].fetch: a ${s.kind} source must be fetch: false`);
      const named = [s.title, s.author].some(v => typeof v === "string" && v.trim());
      if (s.kind === "unknown" ? !(typeof s.title === "string" && s.title.trim() && /\b\d{4}-\d{2}-\d{2}\b/.test(String(s.note ?? ""))) : !named)
        errors.push(`sources[${i}]: ${s.kind === "unknown" ? "an unknown origin needs a title and a dated note (YYYY-MM-DD)" : "a work needs a title or an author"}`);
      if (s.url !== undefined && !(typeof s.url === "string" && /^https:\/\//.test(s.url))) errors.push(`sources[${i}].url: a work's url must be https://`);
      const relations = [s.relation, ...(s.items || []).map(it => it?.relation)].filter(r => r !== undefined);
      if (s.relation === undefined || relations.some(r => r !== "inspired-by")) errors.push(`sources[${i}].relation: a ${s.kind} source can only be inspired-by`);
    }
    if (s.licenseReview !== undefined) {
      const r = s.licenseReview;
      if (!r || !/^\d{4}-\d{2}-\d{2}$/.test(String(r.date ?? "")) || !LICENSE_REVIEW_FINDINGS.includes(r.finding) || typeof r.evidence !== "string" || !r.evidence.trim())
        errors.push(`sources[${i}].licenseReview: needs date (YYYY-MM-DD), finding (${LICENSE_REVIEW_FINDINGS.join("|")}) and evidence`);
    }
    if (s.repo !== undefined && !REPO_RE.test(s.repo))
      errors.push(`sources[${i}].repo: invalid — must be owner/name (alphanumeric, dash, dot, underscore only)`);
    if (s.ref !== undefined) {
      if (!REF_RE.test(s.ref) || s.ref.startsWith("-"))
        errors.push(`sources[${i}].ref: invalid — must not start with "-" and may only contain alphanumeric, _./${String.fromCharCode(126)}^- chars`);
    }
    // source.url is interpolated verbatim into the git clone/fetch argv
    // (cloneCommandsFor). A `-`-leading value is parsed by git as an OPTION
    // (e.g. `--upload-pack=<cmd>` -> command execution), so it gets the same
    // leading-dash guard as ref, plus a scheme allowlist: https, file, or an
    // absolute local path (the test/local-fixture seam — git clones those
    // exactly like file://). Anything else (ssh://, scp-style, ...) is rejected.
    if (s.url !== undefined) {
      if (typeof s.url !== "string" || s.url.startsWith("-")) {
        errors.push(`sources[${i}].url: invalid — must not start with "-" (git would parse it as an option, not a remote)`);
      } else if (!/^(https|file):\/\//.test(s.url) && !s.url.startsWith("/")) {
        errors.push(`sources[${i}].url: invalid — scheme must be https:// or file:// (or an absolute local path)`);
      }
    }
    // Provenance fields (src/provenance.js). `attributionOnly` was generalized to `fetch: false`.
    if (s.attributionOnly !== undefined) errors.push(`sources[${i}].attributionOnly: retired — use fetch: false`);
    if (s.fetch !== undefined && typeof s.fetch !== "boolean") errors.push(`sources[${i}].fetch: must be a boolean`);
    if (s.relation !== undefined && !RELATIONS.includes(s.relation))
      errors.push(`sources[${i}].relation: must be one of ${RELATIONS.join("|")}`);
    if (s.license && !isValidLicense(s.license))
      errors.push(`sources[${i}].license: must be an allowed SPDX id, NONE or LicenseRef-*`);
    if (s.copyright !== undefined && (typeof s.copyright !== "string" || !s.copyright.trim()))
      errors.push(`sources[${i}].copyright: must be a non-empty string`);
    if (s.formerly !== undefined && (!Array.isArray(s.formerly) || !s.formerly.every(r => REPO_RE.test(r))))
      errors.push(`sources[${i}].formerly: must be a list of owner/name`);
    if (s.tag !== undefined && !isSyncSource(s)) errors.push(`sources[${i}].tag: only a merge-tracked source (items with mode) records a tag`);
    if (Array.isArray(s.items) && isSyncSource(s)) {
      errors.push(...validateSyncSource(s, `sources[${i}]`));
      if (!isFetchedSource(s)) errors.push(`sources[${i}].fetch: a merge-tracked source is fetched by muster vendor update`);
    }
    if (!Array.isArray(s.items)) errors.push(`sources[${i}].items: must be an array`);
    else s.items.forEach((it, j) => {
      const at = `sources[${i}].items[${j}]`;
      if (it.to !== undefined && !isSyncItem(it)) { errors.push(`${at}.mode: a file item (with to) needs mode ${["adapted", "verbatim", "watch"].join("|")}`); return; }
      if (isSyncItem(it)) {
        errors.push(...validateSyncItem(it, at, (kind, id) => ITEM_PATHS[kind]?.(id), s.ref));
        if (it.kind !== undefined && !Object.hasOwn(ITEM_PATHS, it.kind)) errors.push(`${at}.kind: must be one of ${Object.keys(ITEM_PATHS).join("|")}`);
        if (it.id !== undefined && !ID_RE.test(it.id)) errors.push(`${at}.id: invalid — must match /^[a-zA-Z0-9_-]+$/`);
        if (it.relation !== undefined && !RELATIONS.includes(it.relation)) errors.push(`${at}.relation: must be one of ${RELATIONS.join("|")}`);
        return;
      }
      const vendored = isVendoredItem(s, it);
      if (vendored ? !it.from : (it.from !== null && typeof it.from !== "string")) errors.push(`${at}.from: required${vendored ? "" : " (null = repository-wide)"}`);
      if (!it.id) {
        errors.push(`${at}.id: required`);
      } else if (!ID_RE.test(it.id)) {
        errors.push(`${at}.id: invalid — must match /^[a-zA-Z0-9_-]+$/`);
      }
      if (vendored && (!Array.isArray(it.roles) || it.roles.length === 0))
        errors.push(`${at}.roles: required non-empty array`);
      if (it.as !== undefined && it.as !== "agent" && it.as !== "skill")
        errors.push(`${at}.as: must be "agent" or "skill" when set`);
      if (it.kind !== undefined && !Object.hasOwn(ITEM_PATHS, it.kind))
        errors.push(`${at}.kind: must be one of ${Object.keys(ITEM_PATHS).join("|")}`);
      if (!isFetchedSource(s) && it.kind === undefined) errors.push(`${at}.kind: required for a fetch: false source`);
      if (it.relation !== undefined && !RELATIONS.includes(it.relation))
        errors.push(`${at}.relation: must be one of ${RELATIONS.join("|")}`);
      if (it.ref !== undefined && !/^[0-9a-f]{40}$/.test(String(it.ref))) errors.push(`${at}.ref: must be a 40-hex commit SHA`);
    });
  });
  const ids = (doc.sources || []).map(s => s.id).filter(Boolean);
  for (const id of new Set(ids.filter((id, k) => ids.indexOf(id) !== k))) errors.push(`sources: duplicate id ${id}`);
  if (doc.licenseWaivers !== undefined) {
    if (!Array.isArray(doc.licenseWaivers)) errors.push("licenseWaivers: must be an array");
    else doc.licenseWaivers.forEach((w, i) => {
      if (!ids.includes(w?.source)) errors.push(`licenseWaivers[${i}].source: must name a source id`);
      if (!WAIVER_STATUSES.includes(w?.status)) errors.push(`licenseWaivers[${i}].status: must be one of ${WAIVER_STATUSES.join("|")}`);
      if (typeof w?.reason !== "string" || !w.reason.trim()) errors.push(`licenseWaivers[${i}].reason: required`);
    });
  }
  return { ok: errors.length === 0, errors };
}

export function splitFrontmatter(text) {
  const m = matchFrontmatter(text);
  if (!m) return { data: {}, body: text };
  return { data: parse(m.body) || {}, body: m.rest };
}

// The `upstream:` frontmatter block for a vendored item. Rendered by the same
// serializer `muster provenance --write` uses, so vendoring and stamping agree
// byte for byte (provenance.js projects the identical entry from the manifest).
function frontmatterWithUpstream(fm, source, item) {
  return `---\n${stringify(fm, { lineWidth: 0 }).trim()}\n${renderUpstreamBlock([upstreamEntry(source, item)])}\n---\n`;
}

export function toBuiltin(sourceText, item, source) {
  const { data, body } = splitFrontmatter(sourceText);
  const fm = {
    name: data.name || item.id,
    description: item.description || data.description || `Built-in for ${item.roles.join(", ")} (adapted from ${source.repo})`,
    muster_builtin: true,
    license: source.license
  };
  const content = `${frontmatterWithUpstream(fm, source, item)}\n${body.trim()}\n`;
  const catalogEntry = {
    id: item.id, kind: "builtin", roles: item.roles, rank: item.rank !== undefined ? item.rank : 50,
    provenance: { license: source.license, upstream: [source.repo] }
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
// model tier: maxTier over the item's role-mapped models, floored at core.
// An agent never pins below core — scout-tier (mechanical) roles ride the
// orchestrator's override instead. The floor is enforced by floorAtCore from
// src/model.js (which owns MODEL_TIER_ORDER and tier arithmetic).

// Pure helper: given a roles array, return the model tier toAgent would emit
// (absent an explicit item.model override). Exported so tests and the generator
// share one code path for drift detection.
export function modelForRoles(roles) {
  return floorAtCore(maxTier(roles.map(modelForRole)));
}

// The concrete Claude `model:` toAgent writes for a vendored agent item. Agent-backed
// entries take it from the same manifest-driven, emission-layer profile that
// capabilities dispatches (catalog/agents.manifest.json via claudeProfileForAgentId).
// Unknown/non-manifest agents preserve the vendor-manifest fallback: an explicit
// item.model pin, otherwise the role-derived tier floored at core. Exported so the
// generator and test/agents.generated.test.js's drift check share one code path.
export function vendoredAgentModel(item) {
  const tier = item.model ? normalizeTier(item.model) : modelForRoles(item.roles);
  return claudeProfileForAgentId(item.id)?.model ?? claudeModelForTier(tier).model;
}

export function toAgent(sourceText, item, source) {
  const { data, body } = splitFrontmatter(sourceText);
  const model = vendoredAgentModel(item);
  const filteredTools = (() => {
    if (!data.tools) return DEFAULT_TOOLS;
    const allowed = data.tools.split(",").map(s => s.trim()).filter(t => ALLOWED_TOOLS.has(t));
    return allowed.length > 0 ? allowed.join(", ") : DEFAULT_TOOLS;
  })();
  const fm = {
    name: data.name || item.id,
    description: item.description || data.description || `Agent for ${item.roles.join(", ")} (adapted from ${source.repo})`,
    model,
    tools: filteredTools,
    muster_builtin: true,
    license: source.license
  };
  const content = `${frontmatterWithUpstream(fm, source, item)}\n${body.trim()}\n`;
  return {
    path: `plugin/agents/${item.id}.md`,
    content,
    catalogEntry: {
      id: item.id, kind: "agent", roles: item.roles, rank: 50,
      description: fm.description,
      provenance: { license: source.license, upstream: [source.repo] }
    }
  };
}

// Do-not-edit banner prepended to every artifact runVendor generates. YAML form is
// a leading comment line (harmless to loadCatalog); NOTICE uses the same text as a
// plain leading line. The marker steers humans back to vendor/manifest.yaml.
const BANNER_TEXT = "GENERATED by `muster vendor` from vendor/manifest.yaml — do not edit";
const YAML_BANNER = `# ${BANNER_TEXT}\n`;

// NOTICE is generated from the whole manifest (every source, fetched or not, with
// its copyright line) — see src/provenance.js.
export const generateNotice = generateManifestNotice;

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
  let tempRoot;
  try {
    // mkdtemp atomically creates a mode-0700 directory on supported platforms.
    // The checkout lives below that unguessable root, so concurrent runs and a
    // hostile pre-created /tmp/muster-vendor-<id> tree cannot collide with it.
    tempRoot = await mkdtemp(join(tmpdir(), "muster-vendor-"));
    const dir = join(tempRoot, "checkout");
    for (const [cmd, args] of cloneCommandsFor(source, dir)) {
      await pexec(cmd, args);
    }
    const inside = (await pexec("git", ["-C", dir, "rev-parse", "--is-inside-work-tree"])).stdout.trim();
    if (inside !== "true") throw new Error("fetched source is not a git work tree");
    const commit = (await pexec("git", ["-C", dir, "rev-parse", "--verify", "HEAD^{commit}"])).stdout.trim();
    if (!SHA_RE.test(commit)) throw new Error("fetched source HEAD is not a commit");
    if (SHA_RE.test(source.ref || "") && commit.toLowerCase() !== source.ref.toLowerCase())
      throw new Error(`fetched source resolved ${commit}, expected ${source.ref}`);
    await pexec("git", ["-C", dir, "fsck", "--no-dangling"]);
    await pexec("git", ["-C", dir, "diff-index", "--quiet", "HEAD", "--"]);
    return { root: dir, cleanup: () => rm(tempRoot, { recursive: true, force: true }) };
  } catch (e) {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {});
    return { root: null, error: e };
  }
}

export async function runVendor({ home = homedir(), repoRoot = process.cwd(), manifest } = {}) {
  const outputRoot = await canonicalDirectory(repoRoot, "output");
  const warnings = [];
  const builtinEntries = [];
  const agentEntries = [];
  for (const source of manifest.sources) {
    // Attribution-only sources are recorded (NOTICE, `upstream:`) but never fetched;
    // merge-tracked sources are only touched by `muster vendor update`.
    if (!isFetchedSource(source) || !source.items.some(it => isVendoredItem(source, it))) continue;
    const { root, error, cleanup } = await fetchSourceRoot(source, home);
    if (!root) {
      const detail = error ? `: ${error.message}` : "";
      warnings.push(`source ${source.id}: could not fetch (${source.kind})${detail}`);
      continue;
    }
    try {
      for (const item of source.items.filter(it => isVendoredItem(source, it))) {
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
    } finally {
      await cleanup?.();
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
  // cowork/NOTICE ships in the Cowork bundle and must stay byte-identical to NOTICE.
  const notice = generateNotice(manifest);
  for (const path of NOTICE_PATHS) await atomicPublish(outputRoot, path, notice);
  return { count: allEntries.length, builtins: builtinEntries.length, agents: agentEntries.length, warnings };
}
