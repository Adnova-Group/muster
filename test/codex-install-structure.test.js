import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Structural ratchet for split-codex-install, mirroring
// test/codex-doctor-structure.test.js's approach (named phases of at most
// 150 lines, an orchestration-only entry point, and an explicit facade line
// ceiling) but generalized across the file set codex-install.js was split
// into: the facade itself plus its four concern modules.

const facadeUrl = new URL("../src/codex-install.js", import.meta.url);
const splitFiles = [
  "../src/codex-install.js",
  "../src/codex-install-shared.js",
  "../src/codex-install-hooks.js",
  "../src/codex-install-scope-lock.js",
  "../src/codex-install-config-transactions.js",
  "../src/codex-install-marketplace.js"
].map(relative => new URL(relative, import.meta.url));

// runCodexInstall's decomposition, in call order. Before this split it was a
// single 504-line function with a load-bearing indentation lie: two `try {`
// at the same column (installConfig's own outer try and, on the very next
// line, its TRUE inner try), the inner catch dedented to look like it closed
// the outer try, and ~175 lines that were actually still inside the outer
// try/catch printed flush with the function body. A structural brace-depth
// trace (not text indentation) established the true nesting before any line
// moved -- see the split-codex-install commit messages.
const installPhases = [
  "beginCodexInstallContext",
  "verifyCodexInstallPreconditions",
  "writeCodexInstallArtifacts",
  "applyThreadLimitsAndHookState",
  "writeCodexDeclarationsAndVerifyHookActivation",
  "validateAndPublishStrictCodexConfig",
  "publishCodexConfigTransaction",
  "installCodexScopeTransactionBody",
  "resolveCodexInstallHookTrust",
  "runCodexInstall"
];

function declarationSpans(source) {
  const declRe = /^(?:export\s+)?(?:async\s+)?function\s+([A-Za-z0-9_]+)\s*\(|^(?:export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(?:async\s*)?\(?[A-Za-z0-9_{},.\s]*\)?\s*=>/gm;
  const starts = [...source.matchAll(declRe)]
    .map(match => ({ name: match[1] || match[2], line: source.slice(0, match.index).split("\n").length }));
  const totalLines = source.split("\n").length;
  return starts.map((entry, index) => ({
    name: entry.name,
    line: entry.line,
    end: (starts[index + 1]?.line ?? totalLines + 1) - 1
  }));
}

test("runCodexInstall stays decomposed into named phases of at most 150 lines", async () => {
  const source = await readFile(facadeUrl, "utf8");
  const spans = declarationSpans(source).filter(entry => installPhases.includes(entry.name));

  assert.deepEqual(spans.map(entry => entry.name), installPhases);
  for (const span of spans) {
    const length = span.end - span.line + 1;
    assert.ok(length <= 150, `${span.name} spans ${length} lines; maximum is 150`);
  }
});

test("the runCodexInstall decomposition's three orchestration layers each call their own immediate sub-phases", async () => {
  // Unlike codex-doctor's flat runCodexDoctor(calls every phase directly),
  // this decomposition is layered: runCodexInstall delegates the whole
  // scope-registry transaction to installCodexScopeTransactionBody, which in
  // turn delegates the config-publish sub-transaction to
  // publishCodexConfigTransaction. Each orchestrator is checked against only
  // the sub-phases it calls directly.
  const source = await readFile(facadeUrl, "utf8");
  const spans = declarationSpans(source);
  const bodyOf = name => {
    const span = spans.find(entry => entry.name === name);
    const lines = source.split("\n");
    return lines.slice(span.line - 1, span.end).join("\n");
  };
  const layers = {
    runCodexInstall: ["beginCodexInstallContext", "installCodexScopeTransactionBody", "resolveCodexInstallHookTrust"],
    installCodexScopeTransactionBody: ["verifyCodexInstallPreconditions", "writeCodexInstallArtifacts", "publishCodexConfigTransaction"],
    publishCodexConfigTransaction: ["applyThreadLimitsAndHookState", "writeCodexDeclarationsAndVerifyHookActivation", "validateAndPublishStrictCodexConfig"]
  };
  for (const [caller, callees] of Object.entries(layers)) {
    const body = bodyOf(caller);
    for (const callee of callees) {
      assert.match(body, new RegExp(`\\b${callee}\\(`), `${caller} must call ${callee}`);
    }
  }
});

// Mutant-kill receipt (2026-08-04): add 61 padding lines to
// applyThreadLimitsAndHookState in src/codex-install.js, then run this file.
// The guard failed with `codex-install.js:applyThreadLimitsAndHookState
// spans 151 lines` (4 pass, 1 fail). Restoring the file to its prior content
// produced 5 pass / 0 fail. `sha256sum src/codex-install.js` was
// byte-identical before and after:
// 3a7cd6df9f52c8af31a851187c8bec36f3286ca92a8bc2fda10453d3a8c27dff.
test("every function in the split codex-install family stays at most 150 lines", async () => {
  const offenders = [];
  for (const url of splitFiles) {
    const source = await readFile(url, "utf8");
    for (const span of declarationSpans(source)) {
      const length = span.end - span.line + 1;
      if (length > 150) offenders.push(`${url.pathname.split("/").pop()}:${span.name} spans ${length} lines`);
    }
  }
  assert.deepEqual(offenders, []);
});

test("codex-install.js stays a facade under a 1400-line ceiling", async () => {
  const source = await readFile(facadeUrl, "utf8");
  const lines = source.split("\n").length;
  assert.ok(lines <= 1400, `codex-install.js is ${lines} lines; ceiling is 1400`);
});

// Hardened both directions (tighten-install-family-export-surface,
// 2026-08-04): the prior version only asserted expected ⊆ names, so it
// stayed green through the split's 24 -> 168-export blowup as long as
// the original 24 were still present somewhere in the pile ("52 exports
// pass a test named 'exact'" per the audit). This now also asserts
// names ⊆ expected, i.e. exact set equality -- codex-install.js's public
// surface must be precisely the pre-split 24 names, no more, no less.
//
// Mutant-kill receipt (2026-08-04): re-add `export` to agentsDir's
// declaration in src/codex-install.js, then run this file. The guard
// failed with `codex-install.js exports names outside the pre-split
// public API: agentsDir` (4 pass, 1 fail). Restoring the file to its
// prior content produced 5 pass / 0 fail. `sha256sum src/codex-install.js`
// was byte-identical before and after:
// 5732169342ec4f26d24726414e0c2444dc0961ba6066e6f79cbfa26dec191ba7.
test("codex-install.js re-exports exactly the pre-split public API, no more and no less", async () => {
  const source = await readFile(facadeUrl, "utf8");
  const exportRe = /^export\s+(?:const|function|async function)\s+([A-Za-z0-9_]+)|^export\s*\{([^}]+)\}/gm;
  const names = new Set();
  for (const match of source.matchAll(exportRe)) {
    if (match[1]) names.add(match[1]);
    else for (const part of match[2].split(",")) names.add(part.trim().split(/\s+as\s+/)[0].trim());
  }
  const expected = [
    "CODEX_PLUGIN", "codexProjectRoot", "codexInvocationRoot", "codexActivationConfigDirs",
    "hookActivationSnapshot", "sameHookActivationSnapshot", "reconcileScopeRegistryEntries",
    "reconcileConfigTomlHookState", "readCodexHookInventory", "effectiveHookTrust", "musterHookTrustGaps",
    "assertContainedProfiles", "isMusterHookCommand", "hasMusterHookCommandAlias",
    "hasManagedRuntimeInventoryAlias", "inventoryAliasCandidateSnapshot", "sameAliasCandidateSnapshot",
    "codexHookStateKeys", "formatCodexWindowsPath", "parseHookCommand", "expectedCodexHookInstall",
    "verifyCodexConfigRetirementReceipt", "runCodexInstall", "runCodexUninstall"
  ];
  // Presence: every pre-split name must still be exported.
  for (const name of expected) assert.ok(names.has(name), `codex-install.js must still export ${name}`);
  // Absence: nothing else may be exported from the facade.
  const extra = [...names].filter(name => !expected.includes(name)).sort();
  assert.deepEqual(extra, [], `codex-install.js exports names outside the pre-split public API: ${extra.join(", ")}`);
});
