import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export async function tmpProject(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), "muster-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
