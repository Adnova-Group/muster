// Fixture process for test/tmp-leak-guard.test.js's trackedMkdtempSync case.
// Not a test file itself (test-support/ is never scanned by `node --test`,
// matching the existing helpers.js/codex-helpers.js convention): it just
// creates one tracked fixture dir via the shared sync helper, proves it
// exists, and exits. The parent test spawns this as a child process and
// asserts the dir is gone once this process ends -- the same round trip
// tmp-leak-guard-child.mjs proves for the async trackedMkdtemp.
import { trackedMkdtempSync } from "./helpers.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { existsSync } from "node:fs";

const dir = trackedMkdtempSync(join(tmpdir(), "muster-leak-guard-sync-test-"));
process.stdout.write(JSON.stringify({ dir, existedRightAfterCreate: existsSync(dir) }));
