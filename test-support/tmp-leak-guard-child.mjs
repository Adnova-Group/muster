// Fixture process for test/tmp-leak-guard.test.js. Not a test file itself
// (test-support/ is never scanned by `node --test`, matching the existing
// helpers.js/codex-helpers.js convention): it just creates one tracked
// fixture dir via the shared helper, proves it exists, and exits. The
// parent test spawns this as a child process and asserts the dir is gone
// once this process ends -- that end-to-end round trip is the only way to
// observe a process-exit sweep without racing the guard test's own exit.
import { trackedMkdtemp } from "./helpers.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const dir = await trackedMkdtemp(join(tmpdir(), "muster-leak-guard-test-"));
process.stdout.write(JSON.stringify({ dir, existedRightAfterCreate: existsSync(dir) }));
