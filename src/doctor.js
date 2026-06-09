import { loadCatalog } from "./catalog.js";
import { loadPipelines } from "./pipeline.js";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { homedir } from "node:os";
import { exists, readJson } from "./fs-util.js";

// All event names Claude Code recognises as valid hook event keys.
const KNOWN_HOOK_EVENTS = new Set([
  "PreToolUse",
  "PostToolUse",
  "SessionStart",
  "UserPromptSubmit",
  "Stop",
  "Notification",
]);

// Extract the bare filename (e.g. "session-start.js") referenced by a hook
// command string.  Commands shipped by muster follow the pattern:
//   node "${CLAUDE_PLUGIN_ROOT}/hooks/<file>.js"
// Return null if the command doesn't match the expected pattern.
function extractHookFilename(command) {
  const m = command.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/([^\s"]+\.js)/);
  return m ? m[1] : null;
}

// Semver comparison: returns negative if a < b, 0 if equal, positive if a > b.
// Only handles the numeric major.minor.patch form used by this project.
function semverCompare(a, b) {
  const parse = v => String(v).split(".").map(Number);
  const [aMaj, aMin, aPat = 0] = parse(a);
  const [bMaj, bMin, bPat = 0] = parse(b);
  return (aMaj - bMaj) || (aMin - bMin) || (aPat - bPat);
}

export async function runDoctor({ root, home } = {}) {
  const base = root instanceof URL ? fileURLToPath(root) : (root || process.cwd());
  const checks = [];

  try { const c = await loadCatalog(join(base, "catalog")); checks.push({ name: "catalog", ok: true, detail: `${c.length} entries` }); }
  catch (e) { checks.push({ name: "catalog", ok: false, detail: e.message }); }

  try { const p = await loadPipelines(join(base, "pipelines")); checks.push({ name: "pipelines", ok: true, detail: `${p.length} pipelines` }); }
  catch (e) { checks.push({ name: "pipelines", ok: false, detail: e.message }); }

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

  // --- plugin staleness ---
  // Compare the installed muster plugin version against the version in the
  // repo's plugin manifest.  Missing installed_plugins.json or no muster entry
  // is fine — this is a dev machine without the plugin installed.
  {
    const effectiveHome = home || homedir();
    const installedPath = join(effectiveHome, ".claude/plugins/installed_plugins.json");
    const manifestPath = join(base, "plugin/.claude-plugin/plugin.json");

    const installedJson = await readJson(installedPath);
    const manifestJson = await readJson(manifestPath);
    const repoVersion = manifestJson?.version;

    if (!installedJson || !installedJson.plugins) {
      // No install file — skip (ok for dev/CI)
      checks.push({ name: "plugin-staleness", ok: true, detail: "no installed_plugins.json — skip" });
    } else {
      // Find a key whose plugin name (before @) is "muster"
      const musterKey = Object.keys(installedJson.plugins).find(k => k.split("@")[0] === "muster");
      if (!musterKey) {
        checks.push({ name: "plugin-staleness", ok: true, detail: "muster not in installed_plugins.json — skip" });
      } else {
        // The value is an array of objects; version may live on the first entry.
        const entries = installedJson.plugins[musterKey];
        const installedVersion = Array.isArray(entries) && entries[0]?.version;
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
  }

  return { ok: checks.every(c => c.ok), checks };
}
