// The ui-skills.com skill registry (docs/strategy/2026-11-revival-review.md, "Skill discovery
// follow-up"): a discovery source, never vendored. The network is touched only by an explicit
// `muster skills search` (registry catalog) or `muster skills add` (catalog, GitHub license API,
// raw skill files). Everything else, preflight included, reads the cached catalog only.
//
// Registry entries and fetched files are untrusted data: entries are shape-checked, files are
// fetched only from raw.githubusercontent.com for the repository the entry names, relative
// paths are checked, and sizes are capped.
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { matchSkills } from "./match.js";
import { isRestrictedLicense, isShareAlikeLicense } from "./provenance.js";

export const REGISTRY_URL = "https://www.ui-skills.com/skills/registry.json";
export const REGISTRY_TTL_MS = 24 * 60 * 60 * 1000;
export const FETCH_TIMEOUT_MS = 5000;
const MAX_REGISTRY_BYTES = 8 * 1024 * 1024;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;
const USER_AGENT = "muster-cli";

// The per-user cache directory: MUSTER_CACHE_DIR, else the platform convention.
export function userCacheDir(env = process.env, home = homedir(), platform = process.platform) {
  if (env.MUSTER_CACHE_DIR) return env.MUSTER_CACHE_DIR;
  if (platform === "win32") return join(env.LOCALAPPDATA || join(home, "AppData", "Local"), "muster", "Cache");
  if (platform === "darwin") return join(home, "Library", "Caches", "muster");
  return join(env.XDG_CACHE_HOME || join(home, ".cache"), "muster");
}

export const registryCachePath = (cacheDir) => join(cacheDir, "ui-skills-registry.json");

const str = (v) => (typeof v === "string" ? v : "");
const SAFE_SEGMENT = /^[A-Za-z0-9._-]{1,100}$/;

// Registry JSON ({registry:[...]} or a bare array) -> the well-formed entries only.
export function normalizeRegistry(json) {
  const list = Array.isArray(json) ? json : Array.isArray(json?.registry) ? json.registry : null;
  if (!list) return [];
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== "object") continue;
    const slug = str(e.slug), user = str(e.user), pathSlug = str(e.pathSlug) || `${user}/${slug}`.toLowerCase();
    if (!SAFE_SEGMENT.test(slug) || !SAFE_SEGMENT.test(user)) continue;
    out.push({
      slug, user, repo: str(e.repo), name: str(e.name) || slug, pathSlug,
      rawUrl: str(e.rawUrl), githubUrl: str(e.githubUrl),
      description: str(e.description).replace(/\s+/g, " ").trim(),
      topics: Array.isArray(e.topics) ? e.topics.filter((t) => typeof t === "string") : [],
      files: Array.isArray(e.files) ? e.files.filter((f) => typeof f === "string") : [],
    });
  }
  return out;
}

export async function readCachedRegistry(cacheDir) {
  try {
    const cached = JSON.parse(await readFile(registryCachePath(cacheDir), "utf8"));
    const skills = normalizeRegistry(cached.registry);
    return skills.length ? { skills, fetchedAt: str(cached.fetchedAt) } : null;
  } catch {
    return null;
  }
}

async function writeCache(cacheDir, registry, fetchedAt) {
  await mkdir(cacheDir, { recursive: true });
  const path = registryCachePath(cacheDir);
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ url: REGISTRY_URL, fetchedAt, registry }));
  await rename(tmp, path);
}

async function fetchText(fetchImpl, url, { timeoutMs = FETCH_TIMEOUT_MS, maxBytes, headers = {} } = {}) {
  const res = await fetchImpl(url, { headers: { "User-Agent": USER_AGENT, ...headers }, signal: AbortSignal.timeout(timeoutMs) });
  const text = res.ok ? await res.text() : "";
  if (res.ok && maxBytes && Buffer.byteLength(text, "utf8") > maxBytes) throw new Error(`${url}: response over ${maxBytes} bytes`);
  return { status: res.status, ok: res.ok, text };
}

// The registry for an explicit search or add: a fresh cache, else the network (short timeout),
// else a stale cache, else nothing. `network: false` reads the cache only.
// Returns { skills, source: "cache"|"network"|"stale-cache"|"none", fetchedAt, note }.
export async function loadRegistry({ fetchImpl = globalThis.fetch, cacheDir, now = new Date(), ttlMs = REGISTRY_TTL_MS, network = true, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const cached = await readCachedRegistry(cacheDir);
  const age = cached ? now.getTime() - Date.parse(cached.fetchedAt) : Infinity;
  if (cached && age >= 0 && age < ttlMs) return { ...cached, source: "cache", note: null };
  if (network && fetchImpl) {
    try {
      const r = await fetchText(fetchImpl, REGISTRY_URL, { timeoutMs, maxBytes: MAX_REGISTRY_BYTES });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const json = JSON.parse(r.text);
      const skills = normalizeRegistry(json);
      if (!skills.length) throw new Error("no skills in the registry response");
      const fetchedAt = now.toISOString();
      await writeCache(cacheDir, Array.isArray(json) ? json : json.registry, fetchedAt).catch(() => {});
      return { skills, fetchedAt, source: "network", note: null };
    } catch (e) {
      const why = e?.name === "TimeoutError" ? `timed out after ${timeoutMs} ms` : e?.message || String(e);
      if (cached) return { ...cached, source: "stale-cache", note: `registry unreachable (${why}); using the cached copy from ${cached.fetchedAt}` };
      return { skills: [], fetchedAt: null, source: "none", note: `registry unreachable (${why}); builtin results only` };
    }
  }
  if (cached) return { ...cached, source: "stale-cache", note: `offline; using the cached registry from ${cached.fetchedAt}` };
  return { skills: [], fetchedAt: null, source: "none", note: "offline and no cached registry; builtin results only" };
}

// Rank registry entries against a query with the same weighted bag as `match --skills`
// (slug tokens and topics high, description low).
export function matchRegistry(query, skills, { limit = 8, minScore = 1 } = {}) {
  // matchSkills splits ids on - _ :, so `publisher:slug` scores both and stays unique.
  const byId = new Map(skills.map((e) => [e.pathSlug.replace("/", ":"), e]));
  const inventory = [...byId].map(([id, e]) => ({ id, source: "registry", description: `${e.name} ${e.description}`, keywords: e.topics }));
  return matchSkills(query, inventory, { limit: inventory.length || 1 })
    .filter((m) => m.score >= minScore)
    .slice(0, limit)
    .map((m) => {
      const e = byId.get(m.id);
      return { ref: e.pathSlug, score: m.score, description: e.description, topics: e.topics };
    });
}

// Preflight's offline suggestion: up to 3 cached-registry skills for an outcome no builtin
// matched strongly. Never fetches; no cache means no suggestions.
export async function suggestFromCachedRegistry(outcome, { cacheDir, limit = 3, minScore = 3 } = {}) {
  const cached = await readCachedRegistry(cacheDir);
  if (!cached) return [];
  // Refs only: registry descriptions are third-party free text and reach the model through
  // preflight's summary, so they stay out (prompt-injection surface). `muster skills show`
  // and `search` let the user read them on request. Refs are validated to the owner/name shape.
  return matchRegistry(outcome, cached.skills, { limit, minScore })
    .filter((m) => /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(String(m.ref)))
    .map((m) => ({ ref: m.ref, note: `not installed; offer \`/muster:skills add ${m.ref}\` only if the user asks` }));
}

export function findRegistryEntry(skills, ref) {
  const want = String(ref || "").toLowerCase();
  return skills.find((e) => e.pathSlug.toLowerCase() === want || `${e.user}/${e.slug}`.toLowerCase() === want || `${e.user}/${e.name}`.toLowerCase() === want) || null;
}

// Where an entry's files live on GitHub: {owner, repo, ref, dir} from its githubUrl
// (github.com/<o>/<r>/blob/<ref>/<path>/SKILL.md) or rawUrl (raw.githubusercontent.com/<o>/<r>/<ref>/<path>).
// null when neither URL is on GitHub: the license cannot be checked, so add refuses it.
export function githubSource(entry) {
  const parse = (url, re) => {
    let u;
    try { u = new URL(url); } catch { return null; }
    const m = u.protocol === "https:" ? u.pathname.match(re) : null;
    return m ? { owner: decodeURIComponent(m[1]), repo: decodeURIComponent(m[2]), ref: decodeURIComponent(m[3]), file: decodeURIComponent(m[4]), host: u.host } : null;
  };
  const gh = parse(entry.githubUrl, /^\/([^/]+)\/([^/]+)\/blob\/([^/]+)\/(.+)$/);
  const raw = parse(entry.rawUrl, /^\/([^/]+)\/([^/]+)\/([^/]+)\/(.+)$/);
  const pick = gh && gh.host === "github.com" ? gh : raw && raw.host === "raw.githubusercontent.com" ? raw : null;
  if (!pick || !SAFE_SEGMENT.test(pick.owner) || !SAFE_SEGMENT.test(pick.repo) || !SAFE_SEGMENT.test(pick.ref)) return null;
  if (!/(^|\/)SKILL\.md$/.test(pick.file) || pick.file.split("/").some((s) => !s || s === "." || s === "..")) return null;
  const dir = pick.file.replace(/\/?SKILL\.md$/, "");
  return { owner: pick.owner, repo: pick.repo, ref: pick.ref, dir };
}

// SPDX id -> { ok, license, reason, note }. Refuses no license, NonCommercial, NoDerivatives,
// proprietary (LicenseRef) and licenses GitHub cannot identify.
export function licenseVerdict(spdx) {
  const license = spdx || "NONE";
  if (license === "NONE") return { ok: false, license, reason: "the repository has no license, so all rights are reserved and its files cannot be copied" };
  if (license === "NOASSERTION" || license === "OTHER") return { ok: false, license, reason: "GitHub cannot identify the repository's license (NOASSERTION); read its terms and copy the skill by hand only if they allow it" };
  if (/^LicenseRef-/i.test(license) || /proprietary/i.test(license)) return { ok: false, license, reason: `${license} is a proprietary license` };
  if (isRestrictedLicense(license)) return { ok: false, license, reason: `${license} forbids commercial use or derivatives (NC/ND)` };
  const copyleft = isShareAlikeLicense(license) || /^(A|L)?GPL-/i.test(license) || /^MPL-/i.test(license);
  return { ok: true, license, reason: null, note: copyleft ? `${license} is copyleft/share-alike: the copied files stay under ${license}` : null };
}

const githubHeaders = (env, accept = "application/vnd.github+json") => {
  const token = env.GITHUB_TOKEN || env.GH_TOKEN;
  return { Accept: accept, "X-GitHub-Api-Version": "2022-11-28", ...(token ? { Authorization: `Bearer ${token}` } : {}) };
};

// The repository license from the GitHub API: { spdx } or throws on a network/HTTP error.
// A 404 means GitHub found no license file (or no such public repo): spdx NONE.
export async function fetchRepoLicense(fetchImpl, owner, repo, { env = process.env, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/license`;
  const r = await fetchText(fetchImpl, url, { timeoutMs, maxBytes: MAX_SKILL_FILE_BYTES, headers: githubHeaders(env) });
  if (r.status === 404) return { spdx: "NONE" };
  if (!r.ok) throw new Error(`GitHub license API answered HTTP ${r.status} for ${owner}/${repo}`);
  const body = JSON.parse(r.text);
  return { spdx: str(body?.license?.spdx_id) || "NOASSERTION" };
}

// The commit a branch points at (provenance pin), or null when the API does not say.
export async function fetchCommitSha(fetchImpl, owner, repo, ref, { env = process.env, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  try {
    const url = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/commits/${encodeURIComponent(ref)}`;
    const r = await fetchText(fetchImpl, url, { timeoutMs, maxBytes: 4096, headers: githubHeaders(env, "application/vnd.github.sha") });
    const sha = r.ok ? r.text.trim() : "";
    return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
  } catch {
    return null;
  }
}

// A relative file path inside a skill directory: no absolute path, no `..`, a file extension.
export function safeSkillFile(rel) {
  const p = String(rel || "").replace(/^\.\//, "");
  if (!p || p.length > 200 || p.startsWith("/") || p.includes("\\") || p.includes("//")) return null;
  if (!/^[A-Za-z0-9._/-]+$/.test(p) || p.split("/").some((s) => s === "." || s === ".." || s === "")) return null;
  if (!/\.[A-Za-z0-9]{1,8}$/.test(p) || p === "SKILL.md") return null;
  return p;
}

// Relative files a SKILL.md links to (markdown links), for the best-effort fetch.
export function referencedFiles(markdown) {
  const out = new Set();
  for (const m of String(markdown).matchAll(/\]\(([^)\s#]+)(?:#[^)\s]*)?\)/g)) {
    if (/^[a-z][a-z0-9+.-]*:/i.test(m[1])) continue;
    const p = safeSkillFile(m[1]);
    if (p) out.add(p);
  }
  return [...out].sort();
}

export async function fetchRawFile(fetchImpl, { owner, repo, ref, dir }, rel, { timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const path = [dir, rel].filter(Boolean).map((s) => s.split("/").map(encodeURIComponent).join("/")).join("/");
  const url = `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${encodeURIComponent(ref)}/${path}`;
  const r = await fetchText(fetchImpl, url, { timeoutMs, maxBytes: MAX_SKILL_FILE_BYTES });
  return { url, ...r };
}
