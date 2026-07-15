import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const SELECTION = /^(\d{12})-([a-f0-9]{64})\.json$/;
const sha256 = value => createHash("sha256").update(value).digest("hex");

// Models the immutable release-format check in Codex bootstrap resolvers that
// shipped before format 2. It deliberately understands only format 1.
export async function resolveFrozenV1Generation(repoRoot) {
  const selectionsRoot = join(repoRoot, ".agents", "plugins", "selections");
  for (const name of (await readdir(selectionsRoot)).filter(name => SELECTION.test(name)).sort().reverse()) {
    try {
      const record = JSON.parse(await readFile(join(selectionsRoot, name), "utf8"));
      const generation = name.match(SELECTION)[2];
      if (record.format !== 1 || record.generation !== generation) continue;
      const metadata = JSON.parse(await readFile(join(repoRoot, ".agents", "plugins", "releases", generation, "release.json"), "utf8"));
      if (metadata.format !== 1 || metadata.generation !== generation || !Array.isArray(metadata.files)) continue;
      const actual = sha256(JSON.stringify({ format: 1, packageVersion: metadata.packageVersion, files: metadata.files }));
      if (actual === generation) return generation;
    } catch { /* frozen resolvers skip incoherent or unsupported generations */ }
  }
  throw new Error("frozen Codex v1 resolver found no compatible generation");
}
