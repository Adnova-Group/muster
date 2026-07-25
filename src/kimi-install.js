import { copyFile, lstat, mkdir, readFile, readdir, rename, rmdir, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { exists, readdirSafe, readJson } from "./fs-util.js";

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
// firing source to converge -- only files to write and a manifest to remove
// them by. The safety posture that remains: a manifest scopes uninstall to
// muster's OWN files (never a wholesale rmdir over a dir the user also uses),
// every written path is containment-checked inside the dest, and a symlinked
// agents/ or skills/ dest is refused rather than written through.
//
// The agent `model:` frontmatter is copied VERBATIM and is inert on Kimi: gen2
// has no per-subagent model (the second data point behind the model-policy
// refactor). The concrete Kimi model a manifest agent resolves to is surfaced
// through `capabilities --kimi` / kimiProfileForAgentId (src/kimi.js), not baked
// into the on-disk file -- so rewriting the field would only mislead.

export const KIMI_MANIFEST = ".muster-managed.json";

// Live-probed 2026-07-24 (GET https://api.kimi.com/coding/v1/models, HTTP 200):
// the managed coding plan serves EXACTLY these four, all supports_thinking_type
// "only" (always-thinking). No k2.6/k2.5, no non-thinking/general model -- so the
// haiku lane stays kimi-for-coding-highspeed (there is nothing cheaper to remap
// to). See src/kimi.js's KIMI_TIERS and docs/research/kimi-code-cli.md 11.6.
export const KIMI_MODELS_BASE_URL = "https://api.kimi.com/coding/v1";
export const KIMI_EXPECTED_MODEL_IDS = Object.freeze([
  "kimi-for-coding", "kimi-for-coding-highspeed", "k3", "k3-256k"
]);

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
function assertContained(relPaths, dest) {
  const base = resolve(dest);
  for (const rel of relPaths) {
    const target = resolve(base, rel);
    if (typeof rel !== "string" || rel === "" || rel.startsWith(sep) || rel.split("/").includes("..")
      || (target !== base && !target.startsWith(base + sep))) {
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

async function readManifest(manifestPath, dest) {
  const raw = await readJson(manifestPath);
  if (!raw) return null;
  if (raw.owner !== "muster" || raw.format !== 1 || !Array.isArray(raw.agents) || !Array.isArray(raw.skills)) {
    throw new Error(`Kimi installation manifest conflict: ${manifestPath}. Move or remove it, then rerun.`);
  }
  assertContained([...raw.agents, ...raw.skills], dest);
  return raw;
}

// Prune a directory only if it is now empty (best-effort). Used to tidy the
// agents/ and skills/<name>/ dirs muster created, never a wholesale removal.
async function rmdirIfEmpty(path) {
  try { await rmdir(path); return true; }
  catch (error) { if (["ENOTEMPTY", "ENOENT", "EEXIST"].includes(error.code)) return false; throw error; }
}

// Classify a served model id: a "cheaper" haiku-lane candidate is a served
// model that is NEITHER a coding model (kimi-for-coding*) NOR a k3* frontier
// model -- i.e. the general k2.6/k2.5 family the plan's probe went looking for.
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
  const agents = agentFiles.map(f => ({ rel: `agents/${f}`, src: join(agentsSrc, f) }));
  const skills = [];
  for (const name of (await readdirSafe(skillsSrc)).sort()) {
    const skillDir = join(skillsSrc, name);
    if (!(await exists(join(skillDir, "SKILL.md")))) continue;
    for (const rel of (await walkFiles(skillDir)).sort()) {
      skills.push({ rel: `skills/${name}/${rel}`, src: join(skillDir, rel), skill: name });
    }
  }
  return { agents, skills };
}

// Install muster's agents + builtin skills into the Kimi Code data root.
// Idempotent: a reinstall overwrites owned files and prunes any file the PRIOR
// manifest owned that this install no longer ships. Returns a glass-box summary
// (agent/skill counts, the dest, and the probe verdict when --probe is set).
export async function runKimiInstall({ home = homedir(), repoRoot, dryRun = false, probe = false, fetchImpl } = {}) {
  const root = repoRoot || fileURLToPath(new URL("../", import.meta.url));
  const pluginRoot = await resolvePluginRoot(root);
  const dest = kimiHome(home);
  const packageVersion = await readPackageVersion(root);

  const { agents, skills } = await collectSource(pluginRoot);
  const skillNames = [...new Set(skills.map(s => s.skill))];
  const ownedRel = [...agents.map(a => a.rel), ...skills.map(s => s.rel)];
  assertContained(ownedRel, dest);

  const probeResult = probe ? await probeKimiModels({ home, fetchImpl }) : null;

  if (dryRun) {
    return {
      dryRun: true, dest, packageVersion,
      agents: agents.map(a => basename(a.rel)), skills: skillNames,
      fileCount: ownedRel.length, ...(probeResult ? { probe: probeResult } : {})
    };
  }

  await assertWritableDir(join(dest, "agents"));
  await assertWritableDir(join(dest, "skills"));

  // Prune stale files a prior install owned but this one no longer ships.
  const manifestPath = join(dest, "muster", KIMI_MANIFEST);
  const previous = await readManifest(manifestPath, dest);
  const ownedSet = new Set(ownedRel);
  const removedStale = [];
  for (const rel of previous ? [...previous.agents, ...previous.skills] : []) {
    if (ownedSet.has(rel)) continue;
    try { await unlink(join(dest, rel)); removedStale.push(rel); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }

  for (const { rel, src } of [...agents, ...skills]) await copyInto(src, join(dest, rel));

  await mkdir(dirname(manifestPath), { recursive: true });
  await atomicWriteJson(manifestPath, {
    format: 1, owner: "muster", packageVersion,
    agents: agents.map(a => a.rel), skills: skills.map(s => s.rel)
  });

  return {
    dest, packageVersion, agents: agents.map(a => basename(a.rel)), skills: skillNames,
    fileCount: ownedRel.length, removedStale,
    ...(probeResult ? { probe: probeResult } : {})
  };
}

// Reverse runKimiInstall: remove exactly the manifest-owned files (never a
// wholesale directory removal -- a user's own agents/skills sharing those dirs
// are untouched), prune the now-empty muster-created dirs, and drop the manifest.
export async function runKimiUninstall({ home = homedir(), dryRun = false } = {}) {
  const dest = kimiHome(home);
  const manifestPath = join(dest, "muster", KIMI_MANIFEST);
  const manifest = await readManifest(manifestPath, dest);
  if (!manifest) return { dest, removed: [], note: "no muster install found" };

  const owned = [...manifest.agents, ...manifest.skills];
  if (dryRun) return { dryRun: true, dest, wouldRemove: owned, fileCount: owned.length };

  const removed = [];
  for (const rel of owned) {
    try { await unlink(join(dest, rel)); removed.push(rel); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
  }
  // Prune empty skill dirs (deepest first), then the agents/skills roots.
  const skillDirs = [...new Set(manifest.skills.map(rel => rel.split("/").slice(0, 2).join("/")))];
  for (const rel of skillDirs) await rmdirIfEmpty(join(dest, rel));
  await rmdirIfEmpty(join(dest, "skills"));
  await rmdirIfEmpty(join(dest, "agents"));
  await unlink(manifestPath).catch(error => { if (error.code !== "ENOENT") throw error; });
  await rmdirIfEmpty(join(dest, "muster"));

  return { dest, removed, fileCount: removed.length };
}

async function atomicWriteJson(path, value) {
  const temp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}`);
  await writeFile(temp, JSON.stringify(value, null, 2) + "\n", { mode: 0o600 });
  await rename(temp, path);
}
