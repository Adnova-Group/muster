import { loadCatalog } from "./catalog.js";
import { loadPipelines } from "./pipeline.js";
import { knownDomains } from "./domain.js";
import { readdir, readFile } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists, readJson, readdirSafe } from "./fs-util.js";

// All event names Claude Code recognises as valid hook event keys.
const KNOWN_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Notification",
  "SubagentStop",
  "SessionEnd",
  "PreCompact",
]);

// Extract the bare filename (e.g. "session-start.js") referenced by a hook
// command string.  Commands shipped by muster follow the pattern:
//   node "${CLAUDE_PLUGIN_ROOT}/hooks/<file>.js"
// Return null if the command doesn't match the expected pattern.
function extractHookFilename(command) {
  const m = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"]+\.js)/);
  return m ? m[1] : null;
}

// Returns a human-readable skip-detail string for the two plugin checks (staleness +
// install-integrity) when installed_plugins.json is absent or has no muster entry.
// Avoids duplicating the same ternary in both check blocks.
function pluginNotFoundDetail(entry) {
  return entry.reason === "no-file"
    ? "no installed_plugins.json — skip"
    : "muster not in installed_plugins.json — skip";
}

// Reads installed_plugins.json for the given home dir and locates the muster plugin entry.
// Returns { found: false, reason } when the file is absent or has no muster entry, or
// { found: true, musterKey, entries } when muster is present.  Called once per runDoctor
// invocation so both plugin-staleness and install-integrity share a single file read.
async function readMusterPluginEntry(home) {
  const effectiveHome = home || homedir();
  const installedPath = join(effectiveHome, ".claude/plugins/installed_plugins.json");
  const installedJson = await readJson(installedPath);
  if (!installedJson || !installedJson.plugins) return { found: false, reason: "no-file" };
  const musterKey = Object.keys(installedJson.plugins).find(k => k.split("@")[0] === "muster");
  if (!musterKey) return { found: false, reason: "no-entry" };
  const entries = installedJson.plugins[musterKey];
  return { found: true, musterKey, entries };
}

// Semver comparison: returns negative if a < b, 0 if equal, positive if a > b.
// Only handles the numeric major.minor.patch form used by this project.
function semverCompare(a, b) {
  const parse = v => String(v).split(".").map(Number);
  const [aMaj, aMin, aPat = 0] = parse(a);
  const [bMaj, bMin, bPat = 0] = parse(b);
  return (aMaj - bMaj) || (aMin - bMin) || (aPat - bPat);
}

// Extract concrete (extensioned) docs/ paths a SKILL.md references, alongside the match index
// (needed by isCreateOnFirstUseRef below to inspect the surrounding wording). Only backtick-quoted,
// literal references count — e.g. `docs/qa/RUNBOOK.md` — never a bare directory mention (no
// extension, e.g. `docs/plan/`) and never one immediately preceded by "default " (e.g. "default
// `docs/roadmap.md`"), which documents a future OUTPUT destination in the target project, not a
// doc this repo is expected to already ship.
function extractDocsPaths(content) {
  const re = /`(docs\/[A-Za-z0-9/_.-]+\.[A-Za-z0-9]+)`/g;
  const refs = [];
  let m;
  while ((m = re.exec(content))) {
    const before = content.slice(Math.max(0, m.index - 20), m.index);
    if (/default\s+$/i.test(before)) continue;
    refs.push({ path: m[1], index: m.index });
  }
  return refs;
}

// A docs/ reference belongs to the create-on-first-use convention layer when the SKILL.md's OWN
// nearby wording treats the file as optional / not-yet-created rather than as a repo doc that must
// already exist. This is derived from the actual phrasing muster's SKILLs use around such
// references — never a hardcoded directory allowlist — so a hard-required reference under the same
// directory (e.g. a docs/qa/ path with no such wording) still hard-fails when missing:
//   - "if present" / "if `docs/x` exists" (review-gate, muster-video)
//   - "if the file is missing" (muster-image)
//   - "or the project's equivalent" (muster-image — this repo's own copy is just one instance)
// plus a second signal for phrasing that conditions on the reference without an exists/missing/
// present keyword (e.g. muster-humanizer's "If the artifact resolved a named voice profile from
// `docs/profiles/VOICE.md` ..."): the reference sits inside a clause opened by "if " with no
// sentence-ending punctuation between the "if" and the reference.
const CREATE_ON_FIRST_USE_RE = /\bif\s+(present|it exists|[a-z0-9`/_.-]*\s*(exists|missing))\b|\bor the project'?s equivalent\b/i;

function isCreateOnFirstUseRef(content, index) {
  const before = content.slice(Math.max(0, index - 150), index);
  const window = before + content.slice(index, Math.min(content.length, index + 150));
  if (CREATE_ON_FIRST_USE_RE.test(window)) return true;

  const lastIf = before.toLowerCase().lastIndexOf("if ");
  if (lastIf === -1) return false;
  return !/[.!?]/.test(before.slice(lastIf + 3));
}

// Reads vendor/manifest.yaml and returns the Set of vendored builtin ids (the `sp-`/`wsh-`/
// `gsd-`-prefixed entries copied in from third-party repos). Their SKILL.md `docs/` references
// point at the UPSTREAM project's own doc tree, not this repo's — so they must be excluded from
// the skill-doc-refs check below. Missing/unreadable manifest degrades to an empty set.
async function vendoredBuiltinIds(base) {
  const raw = await readFile(join(base, "vendor/manifest.yaml"), "utf8").catch(() => null);
  const ids = new Set();
  if (!raw) return ids;
  let manifest;
  try { manifest = parseYaml(raw); } catch { return ids; }
  for (const s of (manifest?.sources || [])) {
    for (const it of (s.items || [])) if (it?.id) ids.add(it.id);
  }
  return ids;
}

// A plausible git commit sha (short or full form) inside a YAML comment line — 7-40 hex
// chars. Case-normalised to lowercase by the caller before comparison.
const SHA_TOKEN_RE = /\b[0-9a-f]{7,40}\b/gi;

// Scans vendor/manifest.yaml's RAW text (not the parsed doc — YAML comments never survive
// parsing) for commit shas mentioned in each source's own comment block: rolled-mechanism or
// divergence notes, e.g. "(upstream gsd-core@d1f7ba8, #1592)" or "Re-pinned: 8e1262a -> 284be590".
// A source's block runs from its `- id: <id>` header line to the next source's header (or EOF).
// A note-sha that is itself a prefix of the source's OWN pinned `ref` is filtered out here —
// that's the trivial "equal to the pin" case, already satisfied without a network round-trip.
// Only `kind: github` sources with both `repo` and `ref` are checked; anything else has no
// upstream to compare a note-sha against.
function extractVendorNotes(raw, sources) {
  const notes = [];
  const headerRe = /^\s*-\s*id:\s*(\S+)/gm;
  const headers = [];
  let hm;
  while ((hm = headerRe.exec(raw))) headers.push({ id: hm[1], index: hm.index });
  for (let i = 0; i < headers.length; i++) {
    const source = sources.find(s => s.id === headers[i].id);
    if (!source || source.kind !== "github" || !source.ref || !source.repo) continue;
    const start = headers[i].index;
    const end = i + 1 < headers.length ? headers[i + 1].index : raw.length;
    const segment = raw.slice(start, end);
    const shas = new Set();
    for (const line of segment.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed.startsWith("#")) continue;
      for (const tok of trimmed.match(SHA_TOKEN_RE) || []) shas.add(tok.toLowerCase());
    }
    for (const sha of shas) {
      if (source.ref.toLowerCase().startsWith(sha)) continue;
      notes.push({ sourceId: source.id, repo: source.repo, ref: source.ref, sha });
    }
  }
  return notes;
}

// Verifies one note-sha is an ancestor of (or equal to) its source's pinned ref via
// `gh api repos/<repo>/compare/<sha>...<ref>`. GitHub's compare status is "ahead" or
// "identical" when the note-sha has genuinely landed by the pin; "behind"/"diverged" means the
// note is stale — it references a commit the pin hasn't actually reached (or has since drifted
// past). Any exec failure (no `gh`, no auth, no network) is reported back as offline:true rather
// than a failure — doctor runs offline, and this is the one check that needs a network round-trip.
async function checkNoteAncestor(note, execImpl) {
  try {
    const { stdout } = await execImpl(
      "gh",
      ["api", `repos/${note.repo}/compare/${note.sha}...${note.ref}`, "--jq", ".status"],
      { timeout: 8000 }
    );
    const status = String(stdout).trim();
    return { ok: status === "ahead" || status === "identical", status };
  } catch (e) {
    return { offline: true, error: e };
  }
}

export async function runDoctor({ root, home, exec } = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : (root || process.cwd());
  const checks = [];

  try { const c = await loadCatalog(join(base, "catalog")); checks.push({ name: "catalog", ok: true, detail: `${c.length} entries` }); }
  catch (e) { checks.push({ name: "catalog", ok: false, detail: e.message }); }

  // Hoisted so the domain-alignment check below can reuse the already-loaded/validated
  // pipelines instead of re-parsing the yaml a second time.
  let pipelines = null;
  try { pipelines = await loadPipelines(join(base, "pipelines")); checks.push({ name: "pipelines", ok: true, detail: `${pipelines.length} pipelines` }); }
  catch (e) { checks.push({ name: "pipelines", ok: false, detail: e.message }); }

  // --- pipeline/domain alignment ---
  // Every pipelines/*.yaml `domain:` must be a domain the classifier (classifyDomain) actually
  // knows about, or an outcome routed to that pipeline by domain default can never be reached.
  // The reverse is NOT required — a classifier domain like "software" legitimately has no
  // content pipeline (the code route handles it directly).
  {
    if (pipelines === null) {
      checks.push({ name: "domain-alignment", ok: true, detail: "pipelines failed to load — skip" });
    } else {
      const known = new Set(knownDomains());
      const bad = pipelines.filter(p => !known.has(p.domain)).map(p => `${p.id} (domain: "${p.domain}")`);
      if (bad.length > 0) {
        checks.push({ name: "domain-alignment", ok: false, detail: `pipeline domain(s) not in classifier vocabulary: ${bad.join(", ")}` });
      } else {
        checks.push({ name: "domain-alignment", ok: true, detail: `${pipelines.length} pipeline domain(s) aligned` });
      }
    }
  }

  // --- skill doc references ---
  // Every concrete (extensioned) docs/ path a muster-authored SKILL.md cites as an existing
  // reference must actually exist on disk. Scoped to plugin/skills/** plus the muster-native
  // plugin/builtins/** entries (excludes vendored sp-/wsh-/gsd- builtins, whose docs/ references
  // point at their own upstream repo, not this one).
  {
    try {
      const vendored = await vendoredBuiltinIds(base);
      const skillFiles = [];
      const skillsDir = join(base, "plugin/skills");
      for (const d of await readdirSafe(skillsDir)) {
        const p = join(skillsDir, d, "SKILL.md");
        if (await exists(p)) skillFiles.push(p);
      }
      const builtinsDir = join(base, "plugin/builtins");
      for (const d of await readdirSafe(builtinsDir)) {
        if (vendored.has(d)) continue;
        const p = join(builtinsDir, d, "SKILL.md");
        if (await exists(p)) skillFiles.push(p);
      }

      const missing = [];
      const conventionAbsent = [];
      for (const file of skillFiles) {
        const content = await readFile(file, "utf8");
        for (const { path: docPath, index } of extractDocsPaths(content)) {
          if (await exists(join(base, docPath))) continue;
          if (isCreateOnFirstUseRef(content, index)) {
            conventionAbsent.push(docPath);
          } else {
            missing.push(`${docPath} (referenced by ${file})`);
          }
        }
      }

      if (missing.length > 0) {
        checks.push({ name: "skill-doc-refs", ok: false, detail: `missing doc(s) referenced by SKILL.md: ${missing.join(", ")}` });
      } else if (conventionAbsent.length > 0) {
        checks.push({ name: "skill-doc-refs", ok: true, detail: `${skillFiles.length} skill file(s) checked — absent (created on first use): ${conventionAbsent.join(", ")}` });
      } else {
        checks.push({ name: "skill-doc-refs", ok: true, detail: `${skillFiles.length} skill file(s) checked` });
      }
    } catch (e) {
      checks.push({ name: "skill-doc-refs", ok: false, detail: e.message });
    }
  }

  const bdir = join(base, "plugin/builtins");
  const bn = (await exists(bdir)) ? (await readdir(bdir)).length : 0;
  checks.push({ name: "builtins", ok: bn > 0, detail: `${bn} built-ins` });

  const major = Number(process.versions.node.split(".")[0]);
  checks.push({ name: "node>=20", ok: major >= 20, detail: process.versions.node });

  // --- hooks integrity ---
  // Validate plugin/hooks/hooks.json: every event key must be a known Claude
  // Code hook event, and every referenced .js file must exist on disk.
  {
    const hooksJsonPath = join(base, "plugin/hooks/hooks.json");
    const hooksDir = join(base, "plugin/hooks");
    const parsed = await readJson(hooksJsonPath);
    if (!parsed || typeof parsed.hooks !== "object") {
      checks.push({ name: "hooks-integrity", ok: false, detail: "hooks.json missing or malformed" });
    } else {
      const events = Object.keys(parsed.hooks);
      const badEvent = events.find(e => !KNOWN_HOOK_EVENTS.has(e));
      if (badEvent) {
        checks.push({ name: "hooks-integrity", ok: false, detail: `unknown hook event: "${badEvent}" — expected one of ${[...KNOWN_HOOK_EVENTS].join(", ")}` });
      } else {
        // Collect all hook commands and check referenced .js files exist.
        const problems = [];
        for (const eventHandlers of Object.values(parsed.hooks)) {
          for (const group of eventHandlers) {
            for (const hook of (group.hooks || [])) {
              if (typeof hook.command === "string") {
                const fname = extractHookFilename(hook.command);
                if (fname) {
                  const fpath = join(hooksDir, fname);
                  if (!(await exists(fpath))) {
                    problems.push(fname);
                  }
                }
              }
            }
          }
        }
        if (problems.length > 0) {
          checks.push({ name: "hooks-integrity", ok: false, detail: `missing hook script(s): ${problems.join(", ")}` });
        } else {
          checks.push({ name: "hooks-integrity", ok: true, detail: `${events.length} event(s) verified` });
        }
      }
    }
  }

  // Read once; shared by plugin-staleness and install-integrity to avoid two file reads.
  const pluginEntry = await readMusterPluginEntry(home);

  // --- plugin staleness ---
  // Compare the installed muster plugin version against the version in the
  // repo's plugin manifest.  Missing installed_plugins.json or no muster entry
  // is fine — this is a dev machine without the plugin installed.
  {
    const manifestPath = join(base, "plugin/.claude-plugin/plugin.json");
    const manifestJson = await readJson(manifestPath);
    const repoVersion = manifestJson?.version;

    if (!pluginEntry.found) {
      checks.push({ name: "plugin-staleness", ok: true, detail: pluginNotFoundDetail(pluginEntry) });
    } else {
      // The value is an array of objects; version may live on the first entry.
      const installedVersion = Array.isArray(pluginEntry.entries) && pluginEntry.entries[0]?.version;
      if (!installedVersion || !repoVersion) {
        checks.push({ name: "plugin-staleness", ok: true, detail: "version info unavailable — skip" });
      } else if (semverCompare(installedVersion, repoVersion) < 0) {
        checks.push({
          name: "plugin-staleness",
          ok: false,
          detail: `installed muster ${installedVersion} < repo ${repoVersion} — run: /plugin marketplace update muster, /plugin update muster, then restart Claude Code`
        });
      } else {
        checks.push({ name: "plugin-staleness", ok: true, detail: `installed muster ${installedVersion} is current` });
      }
    }
  }

  // --- install integrity ---
  // For each muster entry in installed_plugins.json, verify that the registered
  // installPath directory exists and contains hooks/hooks.json.  A missing
  // cache directory means the plugin copy silently failed and hooks will never
  // load, even though the version string looks healthy.
  {
    if (!pluginEntry.found) {
      checks.push({ name: "install-integrity", ok: true, detail: pluginNotFoundDetail(pluginEntry) });
    } else {
      const entry = Array.isArray(pluginEntry.entries) ? pluginEntry.entries[0] : null;
      const installPath = entry?.installPath;
      const remediation = `plugin cache is missing/incomplete — run: claude plugin uninstall muster@<marketplace> && claude plugin install muster@<marketplace>, then restart`;

      if (!installPath) {
        checks.push({ name: "install-integrity", ok: true, detail: "no installPath recorded — skip" });
      } else if (!(await exists(installPath))) {
        checks.push({
          name: "install-integrity",
          ok: false,
          detail: `${remediation} (installPath not found: ${installPath})`
        });
      } else if (!(await exists(join(installPath, "hooks/hooks.json")))) {
        checks.push({
          name: "install-integrity",
          ok: false,
          detail: `${remediation} (hooks/hooks.json missing under: ${installPath})`
        });
      } else {
        checks.push({ name: "install-integrity", ok: true, detail: `installPath verified: ${installPath}` });
      }
    }
  }

  // --- version parity ---
  // Ensure package.json version matches plugin/.claude-plugin/plugin.json version.
  // A mismatch means the tarball carries different versions and will confuse users.
  {
    const pkgPath = join(base, "package.json");
    const pluginJsonPath = join(base, "plugin/.claude-plugin/plugin.json");
    const pkgJson = await readJson(pkgPath);
    const pluginJson = await readJson(pluginJsonPath);
    const pkgVersion = pkgJson?.version;
    const pluginVersion = pluginJson?.version;
    if (!pkgVersion || !pluginVersion) {
      checks.push({ name: "version-parity", ok: true, detail: "version info unavailable — skip" });
    } else if (pkgVersion !== pluginVersion) {
      checks.push({
        name: "version-parity",
        ok: false,
        detail: `package.json version (${pkgVersion}) !== plugin.json version (${pluginVersion}) — bump both together`,
      });
    } else {
      checks.push({ name: "version-parity", ok: true, detail: `both at ${pkgVersion}` });
    }
  }

  // --- vendor note staleness ---
  // vendor/manifest.yaml's comment blocks record which upstream commit rolled a mechanism into
  // a hand-adapted builtin, or which commit a pin superseded. Those commit shas must actually be
  // ancestors of (or equal to) the source's pinned `ref` — verified via `gh api .../compare`
  // (network required). When gh/network is unavailable the check reports "skipped (offline)"
  // instead of failing, matching how the plugin checks above treat unavailable environment
  // state (e.g. missing installed_plugins.json) as a skip rather than a failure.
  {
    const manifestPath = join(base, "vendor/manifest.yaml");
    const raw = await readFile(manifestPath, "utf8").catch(() => null);
    if (raw === null) {
      checks.push({ name: "vendor-note-staleness", ok: true, detail: "no vendor/manifest.yaml — skip" });
    } else {
      let manifest;
      try { manifest = parseYaml(raw); } catch { manifest = null; }
      const sources = manifest?.sources;
      if (!Array.isArray(sources)) {
        checks.push({ name: "vendor-note-staleness", ok: true, detail: "manifest unparsable — skip" });
      } else {
        const notes = extractVendorNotes(raw, sources);
        if (notes.length === 0) {
          checks.push({ name: "vendor-note-staleness", ok: true, detail: "no commit-sha notes found" });
        } else {
          const execImpl = exec || promisify(execFile);
          let offline = false;
          const stale = [];
          for (const note of notes) {
            const result = await checkNoteAncestor(note, execImpl);
            if (result.offline) { offline = true; break; }
            if (!result.ok) {
              stale.push(`${note.sourceId}: ${note.sha} is not an ancestor of pinned ref ${note.ref} (status: ${result.status})`);
            }
          }
          if (offline) {
            checks.push({ name: "vendor-note-staleness", ok: true, detail: `skipped (offline) — ${notes.length} vendor note-sha(s) unverified` });
          } else if (stale.length > 0) {
            checks.push({ name: "vendor-note-staleness", ok: false, detail: `stale vendor note(s): ${stale.join("; ")}` });
          } else {
            checks.push({ name: "vendor-note-staleness", ok: true, detail: `${notes.length} vendor note-sha(s) verified ancestors of their pin` });
          }
        }
      }
    }
  }

  return { ok: checks.every(c => c.ok), checks };
}
