// Ratchets the test-tmpdir-convention migration: every test file that needs a
// synchronous temp directory must go through test-support/helpers.js's
// trackedMkdtempSync (process-exit safety net), never a raw fs.mkdtempSync
// import. A raw import has no process-exit sweep -- a fixture dir survives
// forever in /tmp if the creating test throws before its own explicit
// cleanup runs. See test-support/helpers.js's header comment for the
// guarantee, and test/tmp-leak-guard.test.js for the mutant-kill proof that
// the sweep itself works.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const TEST_DIR = path.dirname(fileURLToPath(import.meta.url));

// Every *.test.js file under test/, excluding test/test-support/ (hook-test
// fixtures, not review-gated test files themselves -- and not where the raw
// wrapper lives; that's the OTHER test-support/, a sibling of test/).
function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "test-support") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.endsWith(".test.js")) {
      out.push(full);
    }
  }
  return out;
}

// An `import { ... } from "node:fs"` block, single- or multi-line, captured
// so its specifier list can be checked for the banned source identifier.
const NODE_FS_IMPORT = /import\s*\{([^}]*)\}\s*from\s*["']node:fs["']/g;

test("convention: no test file imports mkdtempSync straight from node:fs -- trackedMkdtempSync only", () => {
  const offenders = [];
  for (const file of collectTestFiles(TEST_DIR)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(NODE_FS_IMPORT)) {
      // `mkdtempSync` or `mkdtempSync as someLocalAlias` -- either way the
      // SOURCE identifier pulled straight off node:fs is what this guard
      // bans; a local alias name does not launder it.
      if (/\bmkdtempSync\b/.test(match[1])) {
        offenders.push(path.relative(TEST_DIR, file));
        break;
      }
    }
  }
  assert.deepEqual(
    offenders,
    [],
    `raw fs.mkdtempSync import found outside test-support/ -- use trackedMkdtempSync ` +
      `from ../test-support/helpers.js instead:\n${offenders.join("\n")}`,
  );
});
