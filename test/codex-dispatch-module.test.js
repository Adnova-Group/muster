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
