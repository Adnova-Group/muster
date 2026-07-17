import { readFile, lstat, open, rename, unlink } from "node:fs/promises";
import { constants } from "node:fs";
import { join, basename, dirname } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash, randomBytes } from "node:crypto";

async function readIfExists(p) {
  try { return await readFile(p, "utf8"); } catch { return null; }
}

const NOFOLLOW = constants.O_NOFOLLOW || 0;
// Exact digests of output-styles/muster.md revisions that the retired installer
// copied into user homes. Ownership is content-based because that installer did
// not write a registry or sidecar marker. Unknown same-name files are preserved.
const LEGACY_STYLE_DIGESTS = new Set([
  "02117ed091e2c1a11054631815bb0734b238652b65f664c939bdf526ed926732",
  "48fa150dcc1999db9de9439f2a2b7cb267ece1221fc435fd166b2f6746fce6cb",
  "49e17cb950049579c07bf2fcfcb414438f0b871ce9c66afaa92841a350bf45f8",
  "502075b0d10f2ed3ac79a48a08db702c1e2c83e12048e45fbfba062f15a706c5",
  "fc7eba324504fc84429156fc3527bfd09f4ce2994bfb73886633a87a6242b79b",
]);

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function statIfExists(path) {
  try { return await lstat(path); }
  catch (error) { if (error?.code === "ENOENT") return null; throw error; }
}

async function safeLegacyAncestry(home) {
  for (const path of [home, join(home, ".claude"), join(home, ".claude", "output-styles")]) {
    const stat = await statIfExists(path);
    if (stat === null) return "absent";
    if (stat.isSymbolicLink() || !stat.isDirectory()) return "unsafe";
  }
  return "safe";
}

async function readRegularNoFollow(path) {
  const before = await statIfExists(path);
  if (before === null) return { kind: "absent" };
  if (before.isSymbolicLink() || !before.isFile()) return { kind: "unsafe" };
  let handle;
  try {
    handle = await open(path, constants.O_RDONLY | NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile()) return { kind: "unsafe" };
    const bytes = await handle.readFile();
    return { kind: "regular", bytes, stat: opened };
  } catch (error) {
    if (["ELOOP", "EMLINK", "EINVAL"].includes(error?.code)) return { kind: "unsafe" };
    throw error;
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(left, right) {
  // ino/dev are zero or unavailable on some Windows filesystems. In that case
  // the repeated no-follow regular-file check remains the portable safeguard.
  return !left?.ino || !right?.ino || (left.ino === right.ino && left.dev === right.dev);
}

async function verifyUnchangedRegular(path, expected) {
  const current = await readRegularNoFollow(path);
  return current.kind === "regular"
    && sameFileIdentity(expected.stat, current.stat)
    && Buffer.compare(expected.bytes, current.bytes) === 0;
}

async function atomicReplaceRegular(path, bytes, expectedDest) {
  const parent = dirname(path);
  const temp = join(parent, `.${basename(path)}.${process.pid}.${randomBytes(12).toString("hex")}.muster-tmp-`);
  let handle;
  try {
    handle = await open(temp, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | NOFOLLOW, 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const staged = await readRegularNoFollow(temp);
    if (staged.kind !== "regular" || Buffer.compare(staged.bytes, bytes) !== 0)
      throw new Error("legacy restore staging verification failed");
    if (!(await verifyUnchangedRegular(path, expectedDest)))
      throw new Error("legacy output style changed during uninstall");
    await rename(temp, path);
    const published = await readRegularNoFollow(path);
    if (published.kind !== "regular" || Buffer.compare(published.bytes, bytes) !== 0)
      throw new Error("legacy restore publication verification failed");
  } finally {
    await handle?.close();
    try { await unlink(temp); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  }
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
    if (marketplace) {
      const { mpName, pName } = resolveNames(marketplace);
      nextSteps.push(`add the marketplace: /plugin marketplace add ${root}`);
      nextSteps.push(`install the plugin: /plugin install ${pName}@${mpName}`);
    } else {
      // No local marketplace.json (e.g. tarball install missing the manifest, or
      // an unrecognised root).  Fall back to the GitHub-hosted marketplace so the
      // user always gets actionable steps rather than an empty list.
      nextSteps.push(`add the marketplace: /plugin marketplace add ${GITHUB_SLUG}`);
      nextSteps.push(`install the plugin: /plugin install muster@muster`);
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

  const ancestry = await safeLegacyAncestry(home);
  const existing = ancestry === "safe" ? await readRegularNoFollow(dest) : { kind: ancestry };
  let legacyStyle;
  if (existing.kind === "absent") {
    legacyStyle = "absent";
  } else if (existing.kind === "unsafe") {
    legacyStyle = "unsafe";
  } else if (!LEGACY_STYLE_DIGESTS.has(digest(existing.bytes))) {
    legacyStyle = "unowned";
  } else {
    const backup = await readRegularNoFollow(bak);
    if (backup.kind === "unsafe") {
      legacyStyle = "unsafe";
    } else if (backup.kind === "regular") {
      // A prior install displaced your file; bring the original back.
      await atomicReplaceRegular(dest, backup.bytes, existing);
      if (!(await verifyUnchangedRegular(dest, { bytes: backup.bytes, stat: (await readRegularNoFollow(dest)).stat })))
        throw new Error("legacy output style restore verification failed");
      const backupNow = await readRegularNoFollow(bak);
      if (backupNow.kind !== "regular" || !sameFileIdentity(backup.stat, backupNow.stat)
          || Buffer.compare(backup.bytes, backupNow.bytes) !== 0)
        throw new Error("legacy output style backup changed during uninstall");
      await unlink(bak);
      legacyStyle = "restored";
    } else {
      if (!(await verifyUnchangedRegular(dest, existing)))
        throw new Error("legacy output style changed during uninstall");
      await unlink(dest);
      legacyStyle = "removed";
    }
  }

  const nextSteps = [
    `uninstall the plugin: /plugin uninstall muster@muster`,
    `remove the marketplace: /plugin marketplace remove muster`,
  ];

  return { outputStyle: { legacyStyle, dest }, nextSteps };
}
