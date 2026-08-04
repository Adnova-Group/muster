// Ratchets the test-tmpdir-convention migration: every test file that needs a
// synchronous temp directory must go through test-support/helpers.js's
// trackedMkdtempSync (process-exit safety net), never a raw fs.mkdtempSync
// reached by ANY fs-import shape. A raw import has no process-exit sweep --
// a fixture dir survives forever in /tmp if the creating test throws before
// its own explicit cleanup runs. See test-support/helpers.js's header
// comment for the guarantee, and test/tmp-leak-guard.test.js for the
// mutant-kill proof that the sweep itself works.
//
// A file is an offender when BOTH hold:
//   (a) it obtains a handle on the fs module by ANY form -- ESM named/
//       namespace/default import from "node:fs" or "fs", CJS
//       require("node:fs"|"fs"), or a dynamic import("node:fs"|"fs"); AND
//   (b) it textually calls mkdtempSync( somewhere a tracked alias import
//       (`trackedMkdtempSync as mkdtempSync` from test-support/helpers.js)
//       does not satisfy -- either a `<handle>.mkdtempSync(` member call
//       (ALWAYS raw: the tracked helper only ever binds the BARE name
//       `mkdtempSync`, never a `.mkdtempSync` property on some other
//       object) or a bare `mkdtempSync(` call with no tracked alias import
//       anywhere in the file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const TEST_DIR = path.dirname(SELF);

// Every *.test.js file under test/, excluding test/test-support/ (hook-test
// fixtures, not review-gated test files themselves -- and not where the raw
// wrapper lives; that's the OTHER test-support/, a sibling of test/) and
// this guard's own file: its prose (this comment block, the assertion
// messages, the test titles) legitimately spells out `mkdtempSync(` to
// describe the banned pattern, which would otherwise self-trip condition (b)
// below the same way a lint rule's own definition file mentions the pattern
// it forbids. Nothing about excluding it weakens the guard: mutants are
// injected into OTHER files (see the mutant-kill proof in the PR body), and
// this file's own imports (readdirSync/readFileSync/statSync, no
// mkdtempSync) never touch the banned call for real.
function collectTestFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    if (entry === "test-support") continue;
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectTestFiles(full));
    } else if (entry.endsWith(".test.js") && full !== SELF) {
      out.push(full);
    }
  }
  return out;
}

// Any way to obtain a handle on the fs module: an ESM `import ... from
// "<spec>"` (that single shape covers named `{ x }`, namespace `* as x`, and
// default `x` imports alike), a CJS require(), or a dynamic import(). Both
// "fs" and "node:fs" specifiers count; the trailing `["']` anchors the
// specifier to end exactly there, so "node:fs/promises", "fs-extra", etc.
// don't false-match.
const FS_IMPORT_ANY =
  /import\s+[^;]*?from\s*["'](?:node:)?fs["']|require\(\s*["'](?:node:)?fs["']\s*\)|import\(\s*["'](?:node:)?fs["']\s*\)/;

// A call to mkdtempSync(, with an optional `<identifier>.` receiver captured
// separately: group 1 set means a member call (`fs.mkdtempSync(`); unset
// means a bare `mkdtempSync(`.
const MKDTEMPSYNC_CALL = /(?:([A-Za-z_$][\w$]*)\.)?mkdtempSync\s*\(/g;

// The ONE shape that can satisfy a bare mkdtempSync( call: the tracked
// helper imported and aliased to the local name `mkdtempSync`. A member call
// on a namespace/default/require/dynamic-import handle can never be
// satisfied this way -- test-support/helpers.js exports `trackedMkdtempSync`,
// never a `.mkdtempSync` property on anything.
const TRACKED_ALIAS_IMPORT =
  /import\s*\{[^}]*\btrackedMkdtempSync\s+as\s+mkdtempSync\b[^}]*\}\s*from\s*["'][^"']*test-support\/helpers\.js["']/;

function findOffendingFiles() {
  const offenders = [];
  for (const file of collectTestFiles(TEST_DIR)) {
    const source = readFileSync(file, "utf8");
    if (!FS_IMPORT_ANY.test(source)) continue; // condition (a) fails: no fs handle reachable at all
    const hasTrackedAlias = TRACKED_ALIAS_IMPORT.test(source);
    for (const match of source.matchAll(MKDTEMPSYNC_CALL)) {
      const isMemberCall = Boolean(match[1]);
      if (isMemberCall || !hasTrackedAlias) {
        offenders.push(path.relative(TEST_DIR, file));
        break;
      }
    }
  }
  return offenders;
}

test("convention: no test file reaches mkdtempSync through a raw fs handle -- trackedMkdtempSync only", () => {
  const offenders = findOffendingFiles();
  assert.deepEqual(
    offenders,
    [],
    `raw fs.mkdtempSync reachable outside test-support/ -- use trackedMkdtempSync ` +
      `from ../test-support/helpers.js instead:\n${offenders.join("\n")}`,
  );
});

// codex-live-wave.test.js embeds `require("node:fs")` inside a template
// literal it writes out as a fake `codex` CLI script for a spawned child
// process -- not an import this test file's own execution context makes.
// Verified: the file has zero mkdtempSync( occurrences anywhere (template
// literal or otherwise), so condition (b) above never holds for it and the
// AND rule above does not trip on it -- no special-case skip needed. This
// test pins that fact down: if the file ever grows a REAL mkdtempSync( call,
// this canary goes red (and so does the main guard above), and the fix is
// the same tracked-alias import used everywhere else.
test("known non-offender: codex-live-wave.test.js's template-embedded require(\"node:fs\") has no mkdtempSync( to pair it with", () => {
  const source = readFileSync(path.join(TEST_DIR, "codex-live-wave.test.js"), "utf8");
  assert.ok(FS_IMPORT_ANY.test(source), "sanity: the file does contain an fs-import-shaped match (the template-embedded require)");
  assert.ok(!/mkdtempSync\s*\(/.test(source), "and it must have zero mkdtempSync( calls, or the AND rule would need a real exclusion");
});
