// Ratchets the dedupe-crypto-helpers consolidation: src/fs-safe.js is now the
// one shared home for the sha256(value) hex-digest helper and the
// SHA256_HEX_RE hex-64 predicate (see fs-safe.js's "Content hashing" section
// header for the full list of sites that used to redefine each independently).
// This guard fails if either shape gets a NEW standalone definition anywhere
// else in src/ -- the regression this consolidation exists to prevent.
//
// Two separate, precise rules (mirroring test/tmpdir-convention.test.js's
// lesson: be exact about what counts as an offending shape, not just about
// where the banned substring appears):
//
//  (a) HEX64_LITERAL -- the exact regex literal text `/^[0-9a-f]{64}$/`
//      appearing anywhere in a src/ file other than fs-safe.js, whether as a
//      named const declaration or an inline `.test(...)` literal. Every prior
//      site was collapsed to import SHA256_HEX_RE (directly, or via a local
//      alias such as `const HEX64 = SHA256_HEX_RE;`), so this exact literal
//      text has no legitimate reason to reappear. A textual variant --
//      different char-class order ([a-f0-9]), an extra alternation (the
//      40-char git SHA union), an algorithm prefix, or different flags/length
//      -- is NOT this shape and correctly does not match; those variants stay
//      at their own sites (see fs-safe.js's export comment and the per-file
//      comments next to each one).
//
//  (b) SHA256_ONE_LINER_DEFINITION -- a NEW standalone helper whose entire
//      value/body is exactly createHash("sha256").update(<single arg>)
//      .digest("hex"): a concise arrow (`const NAME = (...) => <call>`), a
//      BLOCK-bodied arrow whose sole statement is that return
//      (`const NAME = (...) => { return <call>; }`), or a function
//      declaration whose sole statement is that return
//      (`function NAME(...) { return <call>; }`) -- any of the three
//      optionally `export`ed. This only flags a *definition* -- a reusable
//      named form, covering aliased const forms and both arrow-body styles --
//      not every inline occurrence of the call chain. Plenty of legitimate
//      inline call sites remain outside fs-safe.js (each hashing one
//      specific, already-touched value inline for its own domain purpose,
//      e.g. codex-wave-runner.js's per-field digests); those were never
//      "duplicated helpers" the item's survey enumerated, and requiring the
//      OWNING file to name a definition it never had would not catch
//      anything a real regression would introduce. An explicit non-default
//      .update(x, "utf8") encoding or a non-"hex" digest is a different shape
//      entirely and never matches either rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SELF = fileURLToPath(import.meta.url);
const REPO_ROOT = path.resolve(path.dirname(SELF), "..");
const SRC_DIR = path.join(REPO_ROOT, "src");
const SHARED_HOME = path.join(SRC_DIR, "fs-safe.js");

function collectSourceFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...collectSourceFiles(full));
    } else if (entry.endsWith(".js") && full !== SHARED_HOME) {
      out.push(full);
    }
  }
  return out;
}

const HEX64_LITERAL_TEXT = "/^[0-9a-f]{64}$/";

// The canonical call chain: createHash("sha256").update(<single arg, no comma
// -- a comma there is an explicit second .update() argument, i.e. a non-default
// encoding, which is a different shape>).digest("hex"). Quote-style agnostic.
const SHA256_ONE_LINER_CALL =
  /createHash\(\s*(['"])sha256\1\s*\)\.update\(\s*[^,()]*\s*\)\.digest\(\s*(['"])hex\2\s*\)/;

// A NEW DEFINITION of that shape: the call is the entire arrow-function body
// (optionally parenthesized params, concise OR block-bodied-with-a-single-
// return) assigned to a const, or the sole `return` statement of a function
// declaration -- i.e. reachable by name as a reusable helper, `export`ed or
// not. Embedding the same call chain inline inside a larger expression/
// object/template at its own one-off call site does not match this -- see
// the header comment above for why that is deliberate.
//
// The arrow branch's `(?:\{\s*return\s+)?` covers BOTH arrow-body styles with
// one alternative: absent for the concise form (`=> <call>`), present for the
// block-bodied form (`=> { return <call>; }`) -- a block-bodied arrow with
// no `return` at all can never equal this shape's value in the first place,
// so there is no third case to add.
const SHA256_ONE_LINER_DEFINITION = new RegExp(
  String.raw`(?:export\s+)?(?:` +
    String.raw`const\s+[A-Za-z_$][\w$]*\s*=\s*(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>\s*(?:\{\s*return\s+)?|` +
    String.raw`function\s+[A-Za-z_$][\w$]*\s*\([^)]*\)\s*\{\s*return\s+` +
    String.raw`)` +
    SHA256_ONE_LINER_CALL.source +
    String.raw`\s*;?\s*\}?`,
);

function findOffenders(predicate) {
  const offenders = [];
  for (const file of collectSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, "utf8");
    if (predicate(source)) offenders.push(path.relative(SRC_DIR, file));
  }
  return offenders;
}

test("convention: the exact hex-64 regex literal /^[0-9a-f]{64}$/ appears nowhere in src/ outside fs-safe.js", () => {
  const offenders = findOffenders((source) => source.includes(HEX64_LITERAL_TEXT));
  assert.deepEqual(
    offenders,
    [],
    `exact /^[0-9a-f]{64}$/ literal reachable outside fs-safe.js -- import SHA256_HEX_RE ` +
      `from ./fs-safe.js instead:\n${offenders.join("\n")}`,
  );
});

// Direct regex-level proof for all three definition shapes (independent of
// which files currently exist in src/): a reviewer-caught gap had the concise
// arrow and function-declaration forms covered but missed the block-bodied
// arrow (`=> { return <call>; }`) -- this pins all three permanently against
// synthetic source, not just today's real files.
test("SHA256_ONE_LINER_DEFINITION matches all three definition shapes", () => {
  const concise = 'const sha256 = value => createHash("sha256").update(value).digest("hex");';
  const blockBodied = 'const h = (v) => { return createHash("sha256").update(v).digest("hex"); };';
  const functionDecl = 'function sha256(value) {\n  return createHash("sha256").update(value).digest("hex");\n}';
  assert.ok(SHA256_ONE_LINER_DEFINITION.test(concise), "concise arrow body must match");
  assert.ok(SHA256_ONE_LINER_DEFINITION.test(blockBodied), "block-bodied arrow with a single return must match");
  assert.ok(SHA256_ONE_LINER_DEFINITION.test(functionDecl), "function declaration with a single return must match");
});

test("convention: no src/ file outside fs-safe.js defines a new createHash-sha256-hex one-liner helper", () => {
  const offenders = findOffenders((source) => SHA256_ONE_LINER_DEFINITION.test(source));
  assert.deepEqual(
    offenders,
    [],
    `new createHash("sha256").update(x).digest("hex") helper definition found -- import sha256 ` +
      `from ./fs-safe.js instead (alias it locally if the call site benefits from a domain name, ` +
      `e.g. \`const sprintStateHash = sha256;\`):\n${offenders.join("\n")}`,
  );
});

// codex-wave-runner.js hashes several distinct domain values (wave
// instructions, staged-tree entries, action fences, thread ids) inline with
// the exact createHash("sha256").update(x).digest("hex") chain, each at its
// own one-off call site -- never factored into a reusable named helper, and
// never one of the item's enumerated duplicated helpers. This canary pins
// that the two rules above stay precise: the call shape is present and must
// NOT trip the definition rule, and the file must never have carried the
// hex64 regex literal in the first place.
test("known non-offender: codex-wave-runner.js's inline per-field sha256 calls are not helper definitions", () => {
  const source = readFileSync(path.join(SRC_DIR, "codex-wave-runner.js"), "utf8");
  assert.ok(SHA256_ONE_LINER_CALL.test(source), "sanity: the file does contain the raw call-chain shape inline");
  assert.ok(!SHA256_ONE_LINER_DEFINITION.test(source), "and none of those inline calls forms a standalone definition");
  assert.ok(!source.includes(HEX64_LITERAL_TEXT), "and it never carried the exact hex64 regex literal");
});
