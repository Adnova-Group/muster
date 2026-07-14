import { cp, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { execFile as execFileCb } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import { fileURLToPath } from "node:url";

const execFile = promisify(execFileCb);
const root = fileURLToPath(new URL("../", import.meta.url));
const output = join(root, "codex", "skill-assets");
const upstreams = JSON.parse(await readFile(join(root, "codex", "upstreams.json"), "utf8"));
const vendor = parseYaml(await readFile(join(root, "vendor", "manifest.yaml"), "utf8"));
const familyById = new Map(upstreams.families.map(family => [family.id, family]));
const selected = [
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

await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
const temp = await mkdtemp(join(tmpdir(), "muster-codex-assets-"));
const manifest = { schemaVersion: 1, sources: [], skills: [] };

try {
  for (const selection of selected) {
    const family = familyById.get(selection.familyId);
    const source = vendor.sources.find(item => item.id === selection.vendorId);
    if (!family?.repository || !family.ref || !source) throw new Error(`Missing pinned Codex upstream for ${selection.familyId}`);
    const clone = join(temp, selection.familyId);
    await execFile("git", ["init", clone]);
    await execFile("git", ["-C", clone, "remote", "add", "origin", `${family.repository}.git`]);
    await execFile("git", ["-C", clone, "fetch", "--depth", "1", "origin", family.ref], { maxBuffer: 16 * 1024 * 1024 });
    await execFile("git", ["-C", clone, "checkout", "--detach", "FETCH_HEAD"]);
    const actual = (await execFile("git", ["-C", clone, "rev-parse", "HEAD"])).stdout.trim();
    if (actual !== family.ref) throw new Error(`${selection.familyId} resolved ${actual}, expected ${family.ref}`);
    manifest.sources.push({ id: selection.familyId, repository: family.repository, ref: actual });

    for (const item of source.items.filter(item => item.as !== "agent")) {
      const sourceDir = join(clone, dirname(item.from));
      const destination = join(output, item.id);
      const entries = (await readdir(sourceDir, { withFileTypes: true })).filter(entry => entry.name !== "SKILL.md");
      if (!entries.length) continue;
      await mkdir(destination, { recursive: true });
      for (const entry of entries) await cp(join(sourceDir, entry.name), join(destination, entry.name), { recursive: true });
      await annotateMarkdownReferences(destination);
      manifest.skills.push({ id: item.id, source: `${selection.familyId}:${dirname(item.from)}`, adaptation: "packaging-only prompt-lint annotations on Markdown supporting assets", files: entries.map(entry => entry.name).sort() });
    }
  }
  manifest.skills.sort((a, b) => a.id.localeCompare(b.id));
  await writeFile(join(output, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  process.stdout.write(`${JSON.stringify({ ok: true, sources: manifest.sources.length, skills: manifest.skills.length }, null, 2)}\n`);
} finally {
  await rm(temp, { recursive: true, force: true });
}
