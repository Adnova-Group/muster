import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

test("Codex dispatch has its own module and CLI import boundary", async () => {
  const codex = await import("../src/codex-dispatch.js");
  const wave = await import("../src/wave-dispatch.js");
  const cli = await readFile(new URL("../src/cli.js", import.meta.url), "utf8");

  assert.equal(typeof codex.resolveCodexWaveDispatch, "function");
  assert.equal(typeof codex.codexSpawnAgentCall, "function");
  assert.equal(typeof codex.codexExecCall, "function");
  assert.equal(typeof codex.codexReviewCall, "function");
  assert.equal(wave.resolveCodexWaveDispatch, undefined);
  assert.match(cli, /from "\.\/codex-dispatch\.js"/);
});

// codex-hermetic-wave-reconcile: PR 151's own benchmark rejected native-review
// shadow adoption (0/10 schema-valid outputs) and wave-dispatch.js's
// resolveCodexReviewRouting records that rejection structurally
// (nativeReviewEnabled: false). codex-dispatch.js duplicates the same
// codexReviewCall builder but, until this reconcile, carried a stale
// pre-benchmark comment claiming the native reviewer "replaces muster's
// hand-dispatched reviewer" -- a landmine that could mislead a future wiring
// into believing native review is sanctioned production behavior. Neither
// module's codexReviewCall is ever imported by cli.js (the only real
// production entry point), so today's runtime is safe; this test pins that
// invariant AND requires both modules' review-gate comments to state the same
// benchmark-rejected reality, so doc drift can never reintroduce the landmine.
test("native-review shadow routing stays disabled: no doc drift, no production wiring", async () => {
  const cli = await readFile(new URL("../src/cli.js", import.meta.url), "utf8");
  const dispatchSource = await readFile(new URL("../src/codex-dispatch.js", import.meta.url), "utf8");
  const waveSource = await readFile(new URL("../src/wave-dispatch.js", import.meta.url), "utf8");

  // cli.js is the only production entry point; neither review builder may be
  // wired into it, however that import might be spelled.
  assert.doesNotMatch(cli, /codexReviewCall|resolveCodexReviewRouting/);

  // Both modules must record the SAME benchmark-rejected reality -- the
  // rejection reason string is the shared source of truth. Comment prose may
  // wrap across lines (each continuation re-prefixed with "// "), so collapse
  // line-comment wrapping to single spaces before matching; only the words
  // themselves are pinned.
  const collapseWrappedComments = (text) => text.replace(/\n\/\/ ?/g, " ");
  const rejectionReason = /shadow benchmark rejected adoption \(0\/10 schema-valid outputs\)/i;
  assert.match(collapseWrappedComments(waveSource), rejectionReason, "wave-dispatch.js must record the benchmark rejection");
  assert.match(collapseWrappedComments(dispatchSource), rejectionReason, "codex-dispatch.js must record the same benchmark rejection, not a stale pre-benchmark claim");

  // The pre-benchmark claim that native review "replaces" muster's own
  // reviewer must never reappear undisclaimed in either module.
  assert.doesNotMatch(dispatchSource, /Replaces muster's hand-dispatched reviewer/);
  assert.doesNotMatch(waveSource, /Replaces muster's hand-dispatched reviewer/);
});
