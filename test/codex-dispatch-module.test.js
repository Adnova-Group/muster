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

test("the explicit leaf-dispatch module contains no production-wave fallback selector", async () => {
  const source = await readFile(new URL("../src/codex-dispatch.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /sequential-inline/i);
  assert.doesNotMatch(source, /disjoint write sets[\s\S]{0,160}spawn_agent/i);
  assert.doesNotMatch(source, /resolveCodexWaveDispatch|resolveCodexDispatchLane/);
});
