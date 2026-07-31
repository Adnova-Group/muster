import { access, cp, mkdtemp, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { fileURLToPath, pathToFileURL } from "node:url";

const defaultExecFile = promisify(execFileCb);
const root = fileURLToPath(new URL("../", import.meta.url));
const defaultSelections = [
  { vendorId: "superpowers", familyId: "superpowers" },
  { vendorId: "wshobson", familyId: "wshobson-agents" }
];
const REFERENCE_DIRECTIVE = "<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001, ANTH-POS-001, GUARD-IDK-001, GUARD-CITE-002, ANTH-XML-001, GUARD-SEP-003: Pinned upstream supporting asset loaded inside its parent skill; the parent supplies role, output, evidence, and input boundaries. -->\n\n";

async function annotateMarkdownReferences(path) {
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const target = join(path, entry.name);
    if (entry.isDirectory()) await annotateMarkdownReferences(target);
    else if (entry.isFile() && entry.name.endsWith(".md")) {
      const content = await readFile(target, "utf8");
      await writeFile(target, REFERENCE_DIRECTIVE + content, "utf8");
    }
  }
}

async function listFiles(path, prefix = "") {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await listFiles(join(path, entry.name), relativePath));
    else files.push(relativePath);
  }
  return files;
}

async function localSupportingEntries(path) {
  try {
    return (await readdir(path, { withFileTypes: true })).filter(entry => entry.name !== "SKILL.md");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function applyLocalOverlays(staging, builtinsDir, manifest, sourceBySkillId, copy) {
  for (const [id, source] of sourceBySkillId) {
    const localSkill = join(builtinsDir, id);
    const entries = await localSupportingEntries(localSkill);
    if (!entries.length) continue;

    const destination = join(staging, id);
    await mkdir(destination, { recursive: true });
    for (const entry of entries) await copy(join(localSkill, entry.name), join(destination, entry.name), { recursive: true });
    const overlayFiles = (await listFiles(localSkill)).filter(file => file !== "SKILL.md").sort();
    let skill = manifest.skills.find(item => item.id === id);
    if (!skill) {
      skill = { id, source, adaptation: "upstream supporting assets with prompt-lint annotations on Markdown", files: [] };
      manifest.skills.push(skill);
    }
    skill.files = [...new Set([...skill.files, ...entries.map(entry => entry.name)])].sort();
    skill.adaptation = "upstream supporting assets with prompt-lint annotations on Markdown; intentional local supporting-asset overlay";
    skill.overlay = { source: `plugin/builtins/${id}`, files: overlayFiles };
  }
}

async function validateStagedOutput(staging, builtinsDir, manifest, expectedSourceCount) {
  const persisted = JSON.parse(await readFile(join(staging, "manifest.json"), "utf8"));
  if (persisted.schemaVersion !== 1 || persisted.sources.length !== expectedSourceCount) {
    throw new Error("Staged Codex asset manifest is incomplete");
  }
  if (JSON.stringify(persisted) !== JSON.stringify(manifest)) {
    throw new Error("Staged Codex asset manifest does not match generated content");
  }
  for (const skill of persisted.skills) {
    for (const file of skill.files) await access(join(staging, skill.id, file));
    for (const file of skill.overlay?.files ?? []) {
      const [stagedContent, localContent] = await Promise.all([
        readFile(join(staging, skill.id, file)),
        readFile(join(builtinsDir, skill.id, file))
      ]);
      if (!stagedContent.equals(localContent)) throw new Error(`Staged local overlay does not match plugin/builtins/${skill.id}/${file}`);
    }
  }
}

async function publishStagedOutput(staging, output, renamePath) {
  const parent = dirname(output);
  const backup = await mkdtemp(join(parent, ".skill-assets-backup-"));
  await rm(backup, { recursive: true, force: true });
  let hasBackup = false;

  try {
    try {
      await renamePath(output, backup);
      hasBackup = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }

    try {
      await renamePath(staging, output);
    } catch (publishError) {
      if (hasBackup) {
        try {
          await renamePath(backup, output);
          hasBackup = false;
        } catch (rollbackError) {
          throw new AggregateError([publishError, rollbackError], `Failed to publish Codex assets and restore backup at ${backup}`);
        }
      }
      throw publishError;
    }

    if (hasBackup) {
      await rm(backup, { recursive: true, force: true });
      hasBackup = false;
    }
  } finally {
    // If rollback itself fails, retain the backup rather than deleting tracked assets.
    if (!hasBackup) await rm(backup, { recursive: true, force: true });
  }
}

export async function syncCodexSkillAssets({
  outputDir,
  builtinsDir = join(root, "plugin", "builtins"),
  upstreams,
  vendor,
  selections = defaultSelections,
  execFile = defaultExecFile,
  copy = cp,
  renamePath = rename,
  stdout = process.stdout
}) {
  const output = outputDir ?? join(root, "codex", "skill-assets");
  const parent = dirname(output);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, ".skill-assets-stage-"));
  const checkoutTemp = await mkdtemp(join(tmpdir(), "muster-codex-assets-"));
  const manifest = { schemaVersion: 1, sources: [], skills: [] };
  const familyById = new Map(upstreams.families.map(family => [family.id, family]));
  const sourceBySkillId = new Map();
  let published = false;

  try {
    for (const selection of selections) {
      const family = familyById.get(selection.familyId);
      const source = vendor.sources.find(item => item.id === selection.vendorId);
      if (!family?.repository || !family.ref || !source) throw new Error(`Missing pinned Codex upstream for ${selection.familyId}`);
      const clone = join(checkoutTemp, selection.familyId);
      await execFile("git", ["init", clone]);
      await execFile("git", ["-C", clone, "remote", "add", "origin", `${family.repository}.git`]);
      await execFile("git", ["-C", clone, "fetch", "--depth", "1", "origin", family.ref], { maxBuffer: 16 * 1024 * 1024 });
      await execFile("git", ["-C", clone, "checkout", "--detach", "FETCH_HEAD"]);
      const actual = (await execFile("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
      if (actual !== family.ref) throw new Error(`${selection.familyId} resolved ${actual}, expected ${family.ref}`);
      manifest.sources.push({ id: selection.familyId, repository: family.repository, ref: actual });

      for (const item of source.items.filter(item => item.as !== "agent")) {
        const sourceDir = join(clone, dirname(item.from));
        sourceBySkillId.set(item.id, `${selection.familyId}:${dirname(item.from)}`);
        const destination = join(staging, item.id);
        const entries = (await readdir(sourceDir, { withFileTypes: true })).filter(entry => entry.name !== "SKILL.md");
        if (!entries.length) continue;
        await mkdir(destination, { recursive: true });
        for (const entry of entries) await copy(join(sourceDir, entry.name), join(destination, entry.name), { recursive: true });
        await annotateMarkdownReferences(destination);
        manifest.skills.push({ id: item.id, source: sourceBySkillId.get(item.id), adaptation: "packaging-only prompt-lint annotations on Markdown supporting assets", files: entries.map(entry => entry.name).sort() });
      }
    }
    await applyLocalOverlays(staging, builtinsDir, manifest, sourceBySkillId, copy);
    manifest.skills.sort((a, b) => a.id.localeCompare(b.id));
    await writeFile(join(staging, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    await validateStagedOutput(staging, builtinsDir, manifest, selections.length);
    await publishStagedOutput(staging, output, renamePath);
    published = true;
    stdout.write(`${JSON.stringify({ ok: true, sources: manifest.sources.length, skills: manifest.skills.length }, null, 2)}\n`);
    return manifest;
  } finally {
    await rm(checkoutTemp, { recursive: true, force: true });
    if (!published) await rm(staging, { recursive: true, force: true });
  }
}

async function main() {
  const upstreams = JSON.parse(await readFile(join(root, "codex", "upstreams.json"), "utf8"));
  const vendor = parseYaml(await readFile(join(root, "vendor", "manifest.yaml"), "utf8"));
  await syncCodexSkillAssets({ upstreams, vendor });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
