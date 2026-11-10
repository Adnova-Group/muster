import { BASE_COPIES_ABSENT, baseCopiesPresent, checkVendorSync } from "./vendor-sync.js";
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
import { isRunId } from "./run-dir.js";
import { coworkConfigDirs, readAccountPluginList } from "./harness.js";

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
  "TaskCompleted",
]);

// Extract the bare filename (e.g. "pre-tool-use.js") a hook runs. Muster ships exec-form hooks
// ({"command": "node", "args": ["${CLAUDE_PLUGIN_ROOT}/hooks/<file>.js"]}); the shell form
// (node "${CLAUDE_PLUGIN_ROOT}/hooks/<file>.js" in `command`) is still recognized.
// Return null if neither the command nor any argument matches the expected pattern.
function extractHookFilename(hook) {
  for (const value of [hook.command, ...(Array.isArray(hook.args) ? hook.args : [])]) {
    const m = typeof value === "string" && value.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"]+\.js)/);
    if (m) return m[1];
  }
  return null;
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
// clause-ending punctuation — ".", "!", "?", OR A COMMA — between the "if" and the reference. A
// comma before the reference closes the conditional clause early (e.g. "If the run is attended,
// read `docs/x.md`" makes the read hard-required, not conditional on the file's existence);
// muster-humanizer's own VOICE.md wording has no comma before its reference, so it still passes.
const CREATE_ON_FIRST_USE_RE = /\bif\s+(present|it exists|[a-z0-9`/_.-]*\s*(exists|missing))\b|\bor the project'?s equivalent\b/i;

function isCreateOnFirstUseRef(content, index) {
  const before = content.slice(Math.max(0, index - 150), index);
  const window = before + content.slice(index, Math.min(content.length, index + 150));
  if (CREATE_ON_FIRST_USE_RE.test(window)) return true;

  const lastIf = before.toLowerCase().lastIndexOf("if ");
  if (lastIf === -1) return false;
  return !/[.!?,]/.test(before.slice(lastIf + 3));
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
  // Attribution-only (`fetch: false`) items are muster-authored files that merely
  // credit an upstream; their doc references are muster's own and stay checked.
  for (const s of (manifest?.sources || [])) {
    if (s?.fetch === false) continue;
    // Fetched builtins carry no kind; merge-tracked builtins (items with a mode, e.g. the
    // uupm/intent UX family) name kind: builtin. Both are upstream text, not muster's.
    for (const it of (s.items || [])) if (it?.id && (!it.kind || (it.mode !== undefined && it.kind === "builtin"))) ids.add(it.id);
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

// Pre-revival run-state files the stage-2 core no longer writes (docs/strategy/stage-2-contracts.md:
// a run's record is the committed .muster/runs/<id>/). Doctor only reports them; nothing reads them.
export const LEGACY_RUN_STATE = Object.freeze(["manifest.json", "capabilities.json", "gate-cadence.json", "verdicts.json", "wave-active", "task-board.json"]);

// Project run state in `cwd`: a leftover action-fence marker (the fence stays armed until it is
// deleted) and legacy files from the pre-revival flow. Informational: always ok.
export async function runStateCheck(cwd) {
  const dir = join(cwd, ".muster");
  const notes = [];
  const marker = await readFile(join(dir, "run-active"), "utf8").then(t => t.trim(), () => null);
  if (marker !== null) {
    const known = marker && await exists(join(dir, "runs", marker));
    notes.push(`.muster/run-active is present (${known ? `run ${marker}` : "no matching run"}); the action fence stays armed until a run's merge decision removes it or you delete it`);
  }
  const entries = await readdirSafe(dir);
  const legacy = entries.filter(f => LEGACY_RUN_STATE.includes(f) || /^STATE-archive-.*\.md$/.test(f));
  if (legacy.length) notes.push(`legacy pre-revival run state, safe to delete: ${legacy.map(f => `.muster/${f}`).join(", ")}`);
  const runs = (await readdirSafe(join(dir, "runs"))).filter(isRunId).length;
  return { name: "run-state", ok: true, detail: notes.length ? notes.join("; ") : `${runs} run director${runs === 1 ? "y" : "ies"}, no stale markers` };
}

export async function runDoctor({ root, home, exec, cwd } = {}) {
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

  // --- pipeline reachability and sources (src/pipeline-reach.js) ---
  // Some command or workflow can run every pipeline, every phase binds, and every pipeline's
  // sources are in vendor/manifest.yaml. Skipped where the plugin tree is not beside the CLI.
  {
    const commandsDir = join(base, "plugin/commands");
    if (pipelines === null || !(await exists(commandsDir))) {
      checks.push({ name: "pipeline-reach", ok: true, detail: pipelines === null ? "pipelines failed to load — skip" : "no plugin/commands beside this CLI — skip" });
    } else {
      try {
        const { checkPipelineReach } = await import("./pipeline-reach.js");
        const { specialistCatalog } = await import("./specialists.js");
        const commands = {};
        for (const f of (await readdirSafe(commandsDir)).filter(n => n.endsWith(".md"))) commands[f.replace(/\.md$/, "")] = await readFile(join(commandsDir, f), "utf8");
        let manifest = null;
        try { manifest = parseYaml(await readFile(join(base, "vendor/manifest.yaml"), "utf8")); } catch { /* reported by vendor-note-staleness */ }
        const res = checkPipelineReach({
          pipelines, manifest, commands,
          workflowPresent: await exists(join(base, "plugin/workflows/pipeline.js")),
          catalog: specialistCatalog({ catalogDir: join(base, "catalog"), pluginRoot: join(base, "plugin") }),
          pluginRoot: join(base, "plugin"),
        });
        checks.push({ name: "pipeline-reach", ok: res.ok, detail: res.ok ? res.detail : res.problems.join("; ") });
      } catch (e) {
        checks.push({ name: "pipeline-reach", ok: false, detail: e.message });
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
                const fname = extractHookFilename(hook);
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

  // --- vendor sync (offline) ---
  // Merge-tracked sources (src/vendor-sync.js): every base copy under vendor/upstream/
  // matches its recorded baseBlob, every adapted/verbatim file exists, and verbatim regions
  // still equal their base lines. A cached report for a newer upstream tag is surfaced as
  // "behind" without failing. No network.
  {
    let manifest = null;
    try { manifest = parseYaml(await readFile(join(base, "vendor/manifest.yaml"), "utf8")); } catch { /* reported by vendor-note-staleness below */ }
    if (!manifest || !Array.isArray(manifest.sources)) {
      checks.push({ name: "vendor-sync", ok: true, detail: "no readable vendor/manifest.yaml — skip" });
    } else if (!(await baseCopiesPresent(base))) {
      // A packaged install (npm, or the bundled plugin runtime): maintainer data, not a fault.
      checks.push({ name: "vendor-sync", ok: true, detail: `${BASE_COPIES_ABSENT} (vendor/upstream/ is absent) — skip; run from a source checkout` });
    } else {
      const res = await checkVendorSync({ root: base, manifest });
      const behind = res.behind.length ? `; ${res.behind.join("; ")}` : "";
      checks.push(res.ok
        ? { name: "vendor-sync", ok: true, detail: `${res.checked} merge-tracked item(s) match their base copies${behind}` }
        : { name: "vendor-sync", ok: false, detail: res.problems.join("; ") });
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
    let raw;
    let readError;
    try { raw = await readFile(manifestPath, "utf8"); } catch (error) { readError = error; }
    if (readError) {
      const reason = readError.code === "ENOENT" ? "missing" : "unreadable";
      checks.push({ name: "vendor-note-staleness", ok: false, detail: `vendor/manifest.yaml ${reason}: ${readError.message}` });
    } else {
      let manifest;
      let parseError;
      try { manifest = parseYaml(raw); } catch (error) { parseError = error; }
      if (parseError) {
        checks.push({ name: "vendor-note-staleness", ok: false, detail: `vendor/manifest.yaml unparsable: ${parseError.message}` });
      } else {
        if (!manifest || !Array.isArray(manifest.sources)) {
          checks.push({ name: "vendor-note-staleness", ok: false, detail: "vendor/manifest.yaml invalid: manifest.sources must be an array" });
          return { ok: checks.every(c => c.ok), checks };
        }
        const sources = manifest.sources;
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

  if (cwd) checks.push(await runStateCheck(cwd));
  return { ok: checks.every(c => c.ok), checks };
}

// --- doctor --desktop ---------------------------------------------------------
// Read-only report on Claude Desktop's view of muster. It never edits Desktop
// config. Covers: which config dirs exist (Windows %APPDATA% and the MSIX
// LocalCache copy, reached through /mnt/c from WSL); each `mcpServers` entry that
// launches muster, with its checkout's version and git state (stale or dirty is
// flagged); whether muster is in the account plugin list the app caches under
// plugin-list/ (the documented Desktop route is the plugin marketplace); and the
// log directory (%LOCALAPPDATA%\Claude\Logs on Windows).
// Facts and quotes behind each check: docs/research/claude-cowork.md §5.

const WINDOWS_PROFILE_SKIP = new Set(["All Users", "Default", "Default User", "Public", "desktop.ini"]);

// Other Windows profiles (service and sandbox accounts) deny access from WSL; a
// path we may not stat is simply not this user's Desktop, so it reads as absent.
async function reachable(p) {
  try { return await exists(p); }
  catch (err) { if (err.code === "EACCES" || err.code === "EPERM") return false; throw err; }
}

export function isWsl(env = process.env, platform = process.platform, procVersion = "") {
  if (platform !== "linux") return false;
  return !!(env.WSL_DISTRO_NAME || env.WSL_INTEROP || /microsoft/i.test(procVersion));
}

// C:\Users\me\x -> /mnt/c/Users/me/x (drive-letter paths only; anything else -> null).
export function windowsToWslPath(p, mountRoot = "/mnt") {
  const m = /^([A-Za-z]):[\\/](.*)$/.exec(String(p));
  if (!m) return null;
  return `${mountRoot}/${m[1].toLowerCase()}/${m[2].replace(/\\/g, "/")}`;
}

// Candidate Desktop config dirs, in the app's read order per profile:
// [{ dir, kind: "msix" | "appdata" | "native", profile, logsDir }].
export async function desktopConfigCandidates({ platform = process.platform, home = homedir(), wsl = false, usersRoot = "/mnt/c/Users" } = {}) {
  const out = [];
  if (wsl) {
    for (const user of await readdirSafe(usersRoot)) {
      if (WINDOWS_PROFILE_SKIP.has(user)) continue;
      const profile = join(usersRoot, user);
      const logsDir = join(profile, "AppData/Local/Claude/Logs");
      const packages = join(profile, "AppData/Local/Packages");
      for (const e of await readdirSafe(packages)) {
        if (e.startsWith("Claude_")) out.push({ dir: join(packages, e, "LocalCache/Roaming/Claude"), kind: "msix", profile, logsDir });
      }
      out.push({ dir: join(profile, "AppData/Roaming/Claude"), kind: "appdata", profile, logsDir });
    }
    return out;
  }
  const logsDir = platform === "win32"
    ? join(home, "AppData/Local/Claude/Logs")
    : platform === "darwin" ? join(home, "Library/Logs/Claude") : null;
  for (const dir of await coworkConfigDirs(home, platform)) {
    const kind = /[\\/]Packages[\\/]Claude_/.test(dir) ? "msix" : platform === "win32" ? "appdata" : "native";
    out.push({ dir, kind, profile: home, logsDir });
  }
  return out;
}

// A muster MCP entry: named muster, or launching one of muster's server entrypoints.
const MUSTER_SERVER_SCRIPT = /(?:^|[\\/])(?:cowork[\\/](?:mcp-server|chatgpt-work-server)|mcp[\\/](?:server|codex-server|chatgpt-work-server))\.mjs$/;
function musterServerScript(name, entry) {
  const args = Array.isArray(entry?.args) ? entry.args.map(String) : [];
  const script = args.find(a => MUSTER_SERVER_SCRIPT.test(a)) || null;
  const npxSpec = args.find(a => /^@adnova-group\/muster(?:@|$)/.test(a)) || null;
  if (!script && !npxSpec && !/muster/i.test(name)) return null;
  return { script, npxSpec };
}

async function inspectCheckout(scriptPath, { wsl, exec, mountRoot }) {
  const local = wsl ? (windowsToWslPath(scriptPath, mountRoot) || scriptPath) : scriptPath;
  const root = join(local, "..", "..");
  const info = { scriptPath, localPath: local, root, exists: await reachable(local) };
  if (!info.exists) return info;
  const pkg = await readJson(join(root, "package.json"));
  info.version = pkg && pkg.name === "@adnova-group/muster" ? pkg.version : null;
  const git = async args => {
    try { return (await exec("git", ["-C", root, ...args], { timeout: 20000 })).stdout.trim(); } catch { return null; }
  };
  info.headFull = await git(["rev-parse", "HEAD"]);
  info.head = info.headFull ? info.headFull.slice(0, 7) : null;
  if (info.head) {
    info.subject = await git(["log", "-1", "--format=%s"]);
    const porcelain = await git(["status", "--porcelain"]);
    info.dirtyFiles = porcelain === null ? null : porcelain.split("\n").filter(Boolean).length;
  }
  return info;
}

function checkoutChecks(where, server, cliVersion) {
  if (server.npxSpec && !server.script) {
    const pinned = server.npxSpec.split("@")[2] || null;
    const stale = !!(pinned && cliVersion && semverCompare(pinned, cliVersion) < 0);
    return [{ name: "desktop-mcp-checkout", ok: !stale, detail: `${where}: npx ${server.npxSpec}${stale ? ` -- stale: older than this CLI (${cliVersion})` : ""}` }];
  }
  const co = server.checkout;
  if (!co) return [{ name: "desktop-mcp-checkout", ok: false, detail: `${where}: no muster entrypoint in args` }];
  if (!co.exists) return [{ name: "desktop-mcp-checkout", ok: false, detail: `${where}: ${co.scriptPath} does not exist` }];
  const stale = !!(co.version && cliVersion && semverCompare(co.version, cliVersion) < 0);
  const head = co.head ? `${co.head}${co.subject ? ` "${co.subject}"` : ""}` : "not a git checkout";
  const out = [{
    name: "desktop-mcp-checkout",
    ok: !stale && !!co.version,
    detail: `${where}: ${co.scriptPath} -> v${co.version ?? "unknown"} at ${head}`
      + (stale ? ` -- stale: older than this CLI (${cliVersion})` : "")
      + (co.version ? "" : " -- not a muster package"),
  }];
  if (co.behind) {
    out.push({ name: "desktop-mcp-checkout-behind", ok: true, warn: true, detail: `${where}: ${co.behind} commit(s) behind this CLI's checkout (same history); pull it or point the entry here` });
  }
  if (co.dirtyFiles) {
    out.push({ name: "desktop-mcp-checkout-dirty", ok: true, warn: true, detail: `${where}: ${co.dirtyFiles} uncommitted change(s); the Desktop server runs that working tree` });
  }
  return out;
}

// Code-tab sessions and saved environments that run inside WSL, from Desktop's own
// files (observed 2026-11-10, undocumented): ccd-session-presets.json targets with a
// `wslDistro`, and claude-code-sessions/<org>/<account>/local_*.json with a
// `wslConfig`. Desktop WSL sessions load no plugins (code.claude.com/docs/en/
// desktop-wsl.md: "Plugins: not available in WSL sessions"), so muster is absent there.
async function readWslCodeSessions(dir) {
  const distros = new Set();
  let presets = 0;
  let sessions = 0;
  const presetFile = await readJson(join(dir, "ccd-session-presets.json"));
  for (const account of Object.values(presetFile?.byAccount || {})) {
    for (const p of account?.presets || []) {
      if (p?.target?.wslDistro) { presets += 1; distros.add(p.target.wslDistro); }
    }
  }
  const root = join(dir, "claude-code-sessions");
  for (const org of await readdirSafe(root)) {
    for (const account of await readdirSafe(join(root, org))) {
      for (const f of await readdirSafe(join(root, org, account))) {
        if (!/^local_.*\.json$/.test(f)) continue;
        const s = await readJson(join(root, org, account, f));
        if (s?.wslConfig && !s.isArchived) { sessions += 1; if (s.wslConfig.distro) distros.add(s.wslConfig.distro); }
      }
    }
  }
  return { presets, sessions, distros: [...distros] };
}

// Commits the Desktop checkout's HEAD trails this CLI's own checkout by, when both
// share history (null when this CLI is not a git checkout or the sha is unknown).
async function commitsBehind(base, sha, exec) {
  if (!sha) return null;
  try {
    const { stdout } = await exec("git", ["-C", base, "rev-list", "--count", `${sha}..HEAD`], { timeout: 20000 });
    const n = Number(stdout.trim());
    return Number.isInteger(n) ? n : null;
  } catch { return null; }
}

export async function runDesktopDoctor({
  root, env = process.env, platform = process.platform, home = homedir(),
  wsl, usersRoot = "/mnt/c/Users", mountRoot = "/mnt", exec,
} = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : (root || process.cwd());
  const execImpl = exec || promisify(execFile);
  let procVersion = "";
  if (wsl === undefined && platform === "linux") {
    try { procVersion = await readFile("/proc/version", "utf8"); } catch { /* not readable */ }
  }
  const onWsl = wsl === undefined ? isWsl(env, platform, procVersion) : !!wsl;
  const cliVersion = (await readJson(join(base, "package.json")))?.version || null;
  const checks = [];
  const desktop = { platform, wsl: onWsl, cliVersion, configs: [], logs: [] };
  const seenLogs = new Set();

  for (const c of await desktopConfigCandidates({ platform, home, wsl: onWsl, usersRoot })) {
    if (c.logsDir && !seenLogs.has(c.logsDir)) {
      seenLogs.add(c.logsDir);
      if (await reachable(c.logsDir)) {
        const files = await readdirSafe(c.logsDir);
        desktop.logs.push({ dir: c.logsDir, musterLog: files.includes("mcp-server-muster.log") });
      }
    }
    if (!(await reachable(c.dir))) {
      // An MSIX install without a LocalCache copy reads %APPDATA% (observed).
      if (c.kind === "msix") desktop.msixWithoutLocalCache = [...(desktop.msixWithoutLocalCache || []), c.dir];
      continue;
    }
    const cfg = await readJson(join(c.dir, "claude_desktop_config.json"));
    const plugins = await readAccountPluginList(c.dir);
    const record = {
      dir: c.dir, kind: c.kind, configFile: !!cfg,
      mcpServers: cfg?.mcpServers ? Object.keys(cfg.mcpServers) : [],
      musterServers: [], accountPlugins: plugins ? plugins.length : null,
    };
    desktop.configs.push(record);

    for (const [name, entry] of Object.entries(cfg?.mcpServers || {})) {
      const hit = musterServerScript(name, entry);
      if (!hit) continue;
      const server = { name, command: entry.command || null, ...hit };
      if (hit.script) {
        server.checkout = await inspectCheckout(hit.script, { wsl: onWsl, exec: execImpl, mountRoot });
        server.checkout.behind = await commitsBehind(base, server.checkout.headFull, execImpl);
      }
      record.musterServers.push(server);
      checks.push(...checkoutChecks(`${c.kind} mcpServers.${name}`, server, cliVersion));
    }

    const wslUse = await readWslCodeSessions(c.dir);
    record.wslCodeSessions = wslUse;
    if (wslUse.presets || wslUse.sessions) {
      checks.push({
        name: "desktop-wsl-sessions", ok: true, warn: true,
        detail: `${c.kind}: ${wslUse.sessions} open Code-tab session(s) and ${wslUse.presets} saved environment(s) run in WSL (${wslUse.distros.join(", ") || "unknown distro"}). Desktop WSL sessions load no plugins, so muster is absent there; use a local or SSH session, or the CLI inside WSL`,
      });
    }

    if (plugins) {
      const m = plugins.find(p => p.name === "muster" || p.id.startsWith("muster@"));
      record.musterPlugin = m || null;
      checks.push(m
        ? { name: "desktop-account-plugin", ok: true, warn: !m.enabled, detail: `${c.kind}: ${m.id} is ${m.enabled ? "enabled" : "installed but disabled"} in the account plugin list` }
        : { name: "desktop-account-plugin", ok: true, warn: true, detail: `${c.kind}: muster is not in the account plugin list (${plugins.length} plugin(s)), so Chat and Cowork get only the MCP fallback; add the marketplace in Customize > Plugins` });
    }
  }

  if (desktop.configs.length === 0) {
    checks.push({ name: "desktop-config", ok: true, detail: `no Claude Desktop config dir found (${onWsl ? `searched ${usersRoot}/*/AppData` : platform})` });
  } else {
    const active = desktop.configs.find(r => r.configFile) || desktop.configs[0];
    const msixNote = desktop.msixWithoutLocalCache ? "; MSIX package present without a LocalCache copy, so the app reads %APPDATA%" : "";
    checks.push({ name: "desktop-config", ok: true, detail: `${desktop.configs.length} config dir(s); active: ${active.dir} (${active.kind})${active.configFile ? "" : ", no claude_desktop_config.json"}${msixNote}` });
    if (!desktop.configs.some(r => r.musterServers.length)) {
      checks.push({ name: "desktop-mcp-checkout", ok: true, detail: "no muster entry in mcpServers (expected when muster rides in as a plugin)" });
    }
    if (!desktop.configs.some(r => r.accountPlugins !== null)) {
      checks.push({ name: "desktop-account-plugin", ok: true, warn: true, detail: "account plugin list not readable here; check Customize > Plugins in the app" });
    }
  }
  checks.push(desktop.logs.length
    ? { name: "desktop-logs", ok: true, detail: desktop.logs.map(l => `${l.dir}${l.musterLog ? " (mcp-server-muster.log present)" : ""}`).join("; ") }
    : { name: "desktop-logs", ok: true, detail: platform === "win32" || onWsl ? "%LOCALAPPDATA%\\Claude\\Logs not found" : "no Desktop log dir found" });

  return { ok: checks.every(c => c.ok), checks, desktop };
}
