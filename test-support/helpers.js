import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

// Every fixture dir made through trackedMkdtemp is recorded here and swept
// when THIS process exits. `node --test` runs each test file in its own
// child process, so this sweep only ever removes paths ITS process
// created -- never a glob sweep of /tmp, which would race concurrent test
// processes (or other sessions) on a shared machine. It is a process-exit
// fallback layered under any explicit per-test cleanup (e.g. t.after), not
// a replacement for it: a fixture whose test throws before reaching its
// own cleanup still gets removed once the file's tests are done, instead
// of leaking into /tmp for the life of the machine.
const trackedDirs = new Set();
let exitSweepRegistered = false;

function registerExitSweep() {
  if (exitSweepRegistered) return;
  exitSweepRegistered = true;
  process.on("exit", () => {
    for (const dir of trackedDirs) {
      try {
        rmSync(dir, { recursive: true, force: true });
      } catch {
        // best-effort: a dir the test itself already removed is not a leak
      }
    }
  });
}

// Drop-in replacement for fs/promises.mkdtemp: identical signature and
// return value, plus the process-exit tracking above so a fixture never
// outlives the test process that made it.
export async function trackedMkdtemp(prefix) {
  registerExitSweep();
  const dir = await mkdtemp(prefix);
  trackedDirs.add(dir);
  return dir;
}

// Sync counterpart of trackedMkdtemp above: same drop-in signature and return
// value as fs.mkdtempSync, plus the same process-exit tracking so a fixture
// made through the sync form never outlives its creating test process either.
export function trackedMkdtempSync(prefix) {
  registerExitSweep();
  const dir = mkdtempSync(prefix);
  trackedDirs.add(dir);
  return dir;
}

export async function tmpProject(files = {}) {
  const dir = await trackedMkdtemp(join(tmpdir(), "muster-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
