import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Codex dispatch has its own module and CLI import boundary", async () => {
  const codex = await import("../src/codex-dispatch.js");
  const wave = await import("../src/wave-dispatch.js");
  const cli = await readFile(new URL("../src/cli.js", import.meta.url), "utf8");

  assert.equal(codex.resolveCodexWaveDispatch, undefined);
  assert.equal(codex.resolveCodexDispatchLane, undefined);
  assert.equal(typeof codex.codexSpawnAgentCall, "function");
  assert.equal(typeof codex.codexExecCall, "function");
  assert.equal(typeof codex.codexReviewCall, "function");
  assert.equal(wave.resolveCodexWaveDispatch, undefined);
  assert.match(cli, /from "\.\/codex-dispatch\.js"/);
});

// codex-hermetic-wave-reconcile: PR 151's own benchmark rejected native-review
// shadow adoption (0/10 schema-valid outputs) and wave-dispatch.js's
// resolveCodexReviewRouting records that rejection structurally
// (nativeReviewEnabled: false). codex-dispatch.js once duplicated the same
// codexReviewCall builder with a stale pre-benchmark comment claiming the
// native reviewer "replaces muster's hand-dispatched reviewer"; the
// finish-wave-dispatch-split integration deleted that duplicate outright
// (codex-dispatch.js now carries only a pure re-export), so the rejection
// prose lives solely in wave-dispatch.js -- the one canonical implementation.
// This test pins the wiring invariant AND that neither module ever
// reintroduces the pre-benchmark claim.
test("native-review shadow routing stays disabled: no doc drift, no production wiring", async () => {
  const cli = await readFile(new URL("../src/cli.js", import.meta.url), "utf8");
  const dispatchSource = await readFile(new URL("../src/codex-dispatch.js", import.meta.url), "utf8");
  const waveSource = await readFile(new URL("../src/wave-dispatch.js", import.meta.url), "utf8");

  // cli.js is the only production entry point; neither review builder may be
  // wired into it, however that import might be spelled.
  assert.doesNotMatch(cli, /codexReviewCall|resolveCodexReviewRouting/);

  // The canonical module must record the benchmark-rejected reality -- the
  // rejection reason string is the source of truth. Comment prose may wrap
  // across lines (each continuation re-prefixed with "// "), so collapse
  // line-comment wrapping to single spaces before matching; only the words
  // themselves are pinned.
  const collapseWrappedComments = (text) => text.replace(/\n\/\/ ?/g, " ");
  const rejectionReason = /shadow benchmark rejected adoption \(0\/10 schema-valid outputs\)/i;
  assert.match(collapseWrappedComments(waveSource), rejectionReason, "wave-dispatch.js must record the benchmark rejection");

  // The pre-benchmark claim that native review "replaces" muster's own
  // reviewer must never reappear undisclaimed in either module.
  assert.doesNotMatch(dispatchSource, /Replaces muster's hand-dispatched reviewer/);
  assert.doesNotMatch(waveSource, /Replaces muster's hand-dispatched reviewer/);
});

test("the explicit leaf-dispatch module contains no production-wave fallback selector", async () => {
  const source = await readFile(new URL("../src/codex-dispatch.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /sequential-inline/i);
  assert.doesNotMatch(source, /disjoint write sets[\s\S]{0,160}spawn_agent/i);
  assert.doesNotMatch(source, /resolveCodexWaveDispatch|resolveCodexDispatchLane/);
});

// finish-wave-dispatch-split item: PR #169 split Codex-specific logic out of
// src/wave-dispatch.js into src/codex-dispatch.js, but duplicate definitions of the
// spawn_agent packet builders (constants, resolver, packet builders, fail-closed
// guard) remained in wave-dispatch.js -- dead weight nothing imported from there
// (every real consumer -- src/cli.js, src/codex-audit-provider.js, and every
// directly-relevant test -- already pulled these from codex-dispatch.js). Structural
// assertion (a): those definitions are gone from wave-dispatch.js, not just
// shadowed. Anchored to `export const/function NAME` so this does not trip on the
// legitimate prose mention of codexSpawnAgentCall in resolveCodexDispatchLane's own
// comment (wave-dispatch.js still correctly points readers at the canonical name).
test("wave-dispatch.js carries no spawn_agent packet-builder duplicates (canonical only in codex-dispatch.js)", async () => {
  const source = await readFile(new URL("../src/wave-dispatch.js", import.meta.url), "utf8");
  for (const name of [
    "CODEX_MULTI_AGENT_VERSIONS",
    "resolveCodexMultiAgentVersion",
    "codexSpawnAgentCall",
    "CODEX_WAIT_TIMEOUT_MS",
    "codexWaitAgentCall",
    "assertCodexSpawnAgentAccepted",
  ]) {
    assert.doesNotMatch(
      source,
      new RegExp(`export (?:const|function) ${name}\\b`),
      `wave-dispatch.js must not (re)define ${name} -- codex-dispatch.js is its one canonical home`
    );
  }
  const wave = await import("../src/wave-dispatch.js");
  for (const name of [
    "CODEX_MULTI_AGENT_VERSIONS",
    "resolveCodexMultiAgentVersion",
    "codexSpawnAgentCall",
    "CODEX_WAIT_TIMEOUT_MS",
    "codexWaitAgentCall",
    "assertCodexSpawnAgentAccepted",
  ]) {
    assert.equal(wave[name], undefined, `wave-dispatch.js must not export ${name}`);
  }
});

// Structural assertion (b): behavior/import-path equivalence for the symbols that DO
// stay reachable from both modules. codex-dispatch.js's codexExecCall/
// interpretCodexExecExit/codexReviewCall used to be a second, independently
// reimplemented (and hardening-drifted -- missing the production feature fence
// wave-dispatch.js's copy grew) set of definitions with no consumer of their own;
// they are now pure re-exports of the one canonical, production-consumed
// (codex-wave-runner.js, test/codex-exec-lane.test.js) implementation in
// wave-dispatch.js. Reference identity (not just deepEqual output) proves there is
// exactly one function object behind both import paths -- a re-export, never a copy.
test("codex-dispatch.js re-exports the exec-lane/review builders by identity, never a second implementation", async () => {
  const codex = await import("../src/codex-dispatch.js");
  const wave = await import("../src/wave-dispatch.js");
  for (const name of ["codexExecCall", "interpretCodexExecExit", "codexReviewCall"]) {
    assert.equal(typeof wave[name], "function", `wave-dispatch.js must export ${name}`);
    assert.equal(codex[name], wave[name], `codex-dispatch.js's ${name} must be the exact same function object as wave-dispatch.js's (a pure re-export)`);
  }
  // The re-export must be a plain `export { ... } from "./wave-dispatch.js"` line --
  // no wrapper logic reintroducing a second decision point for these names.
  const source = await readFile(new URL("../src/codex-dispatch.js", import.meta.url), "utf8");
  assert.match(
    source,
    /export \{\s*codexExecCall,\s*interpretCodexExecExit,\s*codexReviewCall\s*\} from "\.\/wave-dispatch\.js";/,
    "codex-dispatch.js must re-export codexExecCall/interpretCodexExecExit/codexReviewCall as a single pure re-export statement, no local logic"
  );
});

// resolveCodexDispatchLane/CODEX_EXEC_MODES are the one pair that is NOT a re-export
// candidate: they are the production-wave LANE SELECTOR itself, and codex-dispatch.js
// (this module's own header: "this module cannot select or downgrade that lane") must
// never carry it under any name, re-exported or otherwise -- selection stays sole
// property of the canonical wave runtime path (wave-dispatch.js / codex-wave-runner.js).
test("codex-dispatch.js never re-exports the production-wave lane selector", async () => {
  const codex = await import("../src/codex-dispatch.js");
  assert.equal(codex.resolveCodexDispatchLane, undefined);
  assert.equal(codex.CODEX_EXEC_MODES, undefined);
});
