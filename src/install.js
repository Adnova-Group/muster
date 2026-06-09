import { readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";

async function readIfExists(p) {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

// Resolve the plugin's marketplace + plugin names, falling back to "muster".
function resolveNames(marketplaceJson) {
  let mpName = "muster", pName = "muster";
  if (marketplaceJson) {
    try {
      const mp = JSON.parse(marketplaceJson);
      if (mp.name) mpName = mp.name;
      if (mp.plugins?.[0]?.name) pName = mp.plugins[0].name;
    } catch { /* fall back to defaults */ }
  }
  return { mpName, pName };
}

// Return true when the resolved root sits inside an ephemeral npx cache.
// npx unpacks packages into paths that contain /_npx/ (POSIX) or \_npx\
// (Windows). Running from there means the directory will be pruned by npm,
// so a local-path marketplace registration would silently break on the next
// cache clear. In that case we steer the user toward the GitHub-hosted
// marketplace instead.
function isEphemeralNpx(root) {
  // Normalise Windows back-slashes so a single check covers both platforms.
  const normalised = root.replace(/\\/g, "/");
  return normalised.includes("/_npx/");
}

// The GitHub org/repo slug for the hosted marketplace, derived from package.json.
const GITHUB_SLUG = "Adnova-Group/muster";

// Print the steps to register muster with Claude Code. Muster does not mutate
// the user's ~/.claude files: the output style ships inside the plugin with
// `force-for-plugin`, so it applies automatically once the plugin is enabled.
// (The old `/output-style <name>` command was removed in Claude Code v2.1.91;
// auto-apply replaces it.) Registering a plugin is a Claude Code action the
// running session only picks up on reinstall, so muster surfaces the steps
// rather than touching CC's plugin state.
export async function runInstall({ home = homedir(), repoRoot } = {}) {
  const root = repoRoot || fileURLToPath(new URL("../", import.meta.url));

  const nextSteps = [];
  if (isEphemeralNpx(root)) {
    // Running from an npx cache: the path will be pruned, breaking a
    // local-path marketplace registration. Point to the GitHub-hosted
    // marketplace instead so the registration survives cache clears.
    nextSteps.push(`add the marketplace: /plugin marketplace add ${GITHUB_SLUG}`);
    nextSteps.push(`install the plugin: /plugin install muster@muster`);
  } else {
    const marketplace = await readIfExists(join(root, ".claude-plugin", "marketplace.json"));
    const { mpName, pName } = resolveNames(marketplace);
    if (marketplace) {
      nextSteps.push(`add the marketplace: /plugin marketplace add ${root}`);
      nextSteps.push(`install the plugin: /plugin install ${pName}@${mpName}`);
    }
  }
  // No "enable the output style" step: the plugin force-applies it on enable.
  // A restart or /clear lets the new session pick up the plugin and its style.

  return {
    outputStyle: { source: "plugin", autoApplied: true, name: "Muster" },
    nextSteps,
  };
}

// Reverse runInstall. Muster's current install mutates nothing under ~/.claude,
// so uninstall is mostly the inverse registration steps. It also cleans up a
// legacy home-copy: older muster versions copied the style to
// ~/.claude/output-styles/muster.md (with a .bak if they displaced a file of
// yours). If one is found, restore the displaced original or remove the copy,
// so an upgrade-then-uninstall leaves nothing behind. The plugin's own style and
// SessionStart hook are plugin-native: disabling the plugin removes both, and
// the force-applied style auto-reverts to your previous output style.
export async function runUninstall({ home = homedir() } = {}) {
  const dest = join(home, ".claude", "output-styles", "muster.md");
  const bak = `${dest}.bak`;

  const existing = await readIfExists(dest);
  let legacyStyle;
  if (existing === null) {
    legacyStyle = "absent";
  } else {
    const backup = await readIfExists(bak);
    if (backup !== null) {
      // A prior install displaced your file; bring the original back.
      await writeFile(dest, backup, "utf8");
      await rm(bak);
      legacyStyle = "restored";
    } else {
      await rm(dest);
      legacyStyle = "removed";
    }
  }

  const nextSteps = [
    `uninstall the plugin: /plugin uninstall muster@muster`,
    `remove the marketplace: /plugin marketplace remove muster`,
  ];

  return { outputStyle: { legacyStyle, dest }, nextSteps };
}
