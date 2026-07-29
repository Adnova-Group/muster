import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const pexecFile = promisify(execFile);
const childScript = fileURLToPath(new URL("../test-support/tmp-leak-guard-child.mjs", import.meta.url));

// Mutant-kill proof (manual, not committed): comment out the
// `process.on("exit", ...)` registration (or the rmSync call inside it) in
// test-support/helpers.js's registerExitSweep, rerun this test alone --
// it fails because the child's fixture dir is still present. Restore the
// code and this test passes again. See PR body for the transcript.
test("trackedMkdtemp: a fixture created via the shared helper is removed once its own process exits, never left behind in /tmp", async () => {
  const { stdout } = await pexecFile(process.execPath, [childScript]);
  const { dir, existedRightAfterCreate } = JSON.parse(stdout);

  assert.ok(
    existedRightAfterCreate,
    "fixture must actually have existed right after trackedMkdtemp resolved, proving creation succeeded (not just absent)",
  );
  assert.ok(
    !existsSync(dir),
    `fixture ${dir} must be gone now that the creating process has exited (process-exit sweep)`,
  );
});
