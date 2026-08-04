import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";
import { promisify } from "node:util";

import { trackedMkdtemp } from "./helpers.js";

const execFileAsync = promisify(execFile);
const cli = new URL("../src/cli.js", import.meta.url).pathname;
const SURFACES = new Set(["chatgpt-desktop", "codex-desktop", "gpt-work"]);

export async function createNativeInitSurfaceFixture(surface) {
  if (!SURFACES.has(surface)) throw new Error(`unsupported native-init fixture surface: ${surface}`);
  const sandbox = await trackedMkdtemp(join(tmpdir(), `muster-${surface}-init-`));
  const dir = join(sandbox, "project");
  const home = join(sandbox, "home");
  const temp = join(sandbox, "tmp");
  await Promise.all([mkdir(dir), mkdir(home), mkdir(temp)]);
  await writeFile(join(dir, "fixture.txt"), `native init fixture: ${surface}\n`);
  return { dir, home, sandbox, surface, temp };
}

export async function runMusterInit(fixture, ...args) {
  const { stdout } = await execFileAsync(process.execPath, [cli, "init", ...args], {
    cwd: fixture.sandbox,
    env: {
      ...process.env,
      HOME: fixture.home,
      USERPROFILE: fixture.home,
      TMPDIR: fixture.temp,
      TMP: fixture.temp,
      TEMP: fixture.temp,
    },
  });
  return JSON.parse(stdout);
}

export async function fixtureState(root) {
  const state = {};
  async function visit(dir) {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => Buffer.compare(Buffer.from(a.name), Buffer.from(b.name)));
    for (const entry of entries) {
      const absolute = join(dir, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        state[`${path}/`] = { kind: "directory" };
        await visit(absolute);
      } else {
        const bytes = await readFile(absolute);
        state[path] = path.endsWith(".json")
          ? { kind: "json", value: JSON.parse(bytes.toString("utf8")) }
          : {
              kind: "file",
              bytes: bytes.length,
              sha256: createHash("sha256").update(bytes).digest("hex"),
            };
      }
    }
  }
  await visit(root);
  return state;
}
