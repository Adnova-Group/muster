import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveDesktopHarness } from "../src/desktop-harness.js";

const execFileAsync = promisify(execFile);
const root = new URL("../", import.meta.url);
const cli = new URL("../src/cli.js", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

async function run(surface) {
  const { stdout } = await execFileAsync(process.execPath, [cli.pathname, "desktop-harness", surface]);
  return JSON.parse(stdout);
}

test("ChatGPT Desktop is detected as a host shell, never as a native init adapter", async () => {
  const contract = resolveDesktopHarness("chatgpt-desktop");
  assert.deepEqual(contract, await run("chatgpt-desktop"));
  assert.equal(contract.runtime, null);
  assert.equal(contract.capabilities.mode, "select-experience");
  assert.deepEqual(contract.init, {
    state: "handoff",
    reason: "unavailable",
    expectedArtifacts: [],
    instruction: null,
  });
});

test("Codex Desktop selects the Codex capability lane and its real native init handoff", async () => {
  const contract = resolveDesktopHarness("codex-desktop");
  assert.deepEqual(contract, await run("codex-desktop"));
  assert.equal(contract.runtime, "codex");
  assert.equal(contract.capabilities.cliFlag, "--codex");
  assert.deepEqual(contract.init, {
    state: "handoff",
    reason: "not-callable",
    expectedArtifacts: ["AGENTS.md"],
    instruction: "/init",
  });
});

test("GPT Work aliases ChatGPT Work and stays on the MCP-only capability lane", async () => {
  const contract = resolveDesktopHarness("gpt-work");
  assert.deepEqual(contract, await run("gpt-work"));
  assert.equal(contract.surface, "chatgpt-work");
  assert.equal(contract.runtime, "work");
  assert.equal(contract.capabilities.cliFlag, "--work");
  assert.equal(contract.capabilities.dispatch, "mcp-or-inline");
  assert.deepEqual(contract.init, {
    state: "handoff",
    reason: "unavailable",
    expectedArtifacts: [],
    instruction: null,
  });
});

test("desktop init documentation keeps shell, Codex, and Work behavior distinct", async () => {
  const [init, harnesses] = await Promise.all([
    read("plugin/commands/init.md"),
    read("website/guides/harnesses.md"),
  ]);
  assert.match(init, /ChatGPT Desktop shell[\s\S]*?select the active experience/i);
  assert.match(init, /Codex Desktop[\s\S]*?AGENTS\.md[\s\S]*?\/init/);
  assert.match(init, /ChatGPT Work \(GPT Work\)[\s\S]*?--reason unavailable --expect ""/);
  assert.match(harnesses, /`muster desktop-harness chatgpt-desktop`/);
  assert.match(harnesses, /`muster desktop-harness codex-desktop`/);
  assert.match(harnesses, /`muster desktop-harness gpt-work`/);
});
