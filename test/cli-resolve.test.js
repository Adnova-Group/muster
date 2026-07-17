import { test } from "node:test";
import assert from "node:assert/strict";
import { delimiter } from "node:path";
import { resolveMusterCli, formatInvocation, RESOLUTION_SHELL_SNIPPET } from "../src/cli-resolve.js";

// Fake filesystem: a Set of paths that "exist", injected so this test never touches the
// real disk or PATH — resolution order is asserted purely from the fake shape.
function fakeExists(paths) {
  const set = new Set(paths);
  return async (p) => set.has(p);
}

test("vendored plugin runtime wins when CLAUDE_PLUGIN_ROOT is set and the file exists", async () => {
  const r = await resolveMusterCli({
    env: { CLAUDE_PLUGIN_ROOT: "/plugins/muster" },
    cwd: "/work",
    exists: fakeExists(["/plugins/muster/runtime/muster.mjs"]),
  });
  assert.deepEqual(r, { command: "node", args: ["/plugins/muster/runtime/muster.mjs"], source: "vendored-plugin", degraded: false });
});

test("CLAUDE_PLUGIN_ROOT set but no vendored runtime present falls through", async () => {
  const r = await resolveMusterCli({
    env: { CLAUDE_PLUGIN_ROOT: "/plugins/muster" },
    cwd: "/work",
    exists: fakeExists([]), // nothing exists anywhere
  });
  assert.equal(r.source, "npx-fallback");
});

test("local checkout (src/cli.js + its own marker) wins over local/global bin", async () => {
  const r = await resolveMusterCli({
    env: {},
    cwd: "/repo",
    exists: fakeExists(["/repo/src/cli.js", "/repo/src/cli-resolve.js", "/repo/node_modules/.bin/muster"]),
  });
  assert.deepEqual(r, { command: "node", args: ["/repo/src/cli.js"], source: "local-checkout", degraded: false });
});

test("src/cli.js alone (no cli-resolve.js marker) is NOT treated as a muster checkout", async () => {
  // guards against an unrelated project that happens to have its own src/cli.js
  const r = await resolveMusterCli({
    env: {},
    cwd: "/some-other-project",
    exists: fakeExists(["/some-other-project/src/cli.js", "/some-other-project/node_modules/.bin/muster"]),
  });
  assert.equal(r.source, "local-bin");
});

test("local node_modules/.bin/muster wins over a global bin", async () => {
  const r = await resolveMusterCli({
    env: {},
    cwd: "/work",
    exists: fakeExists(["/work/node_modules/.bin/muster"]),
    hasBin: async () => true,
  });
  assert.deepEqual(r, { command: "/work/node_modules/.bin/muster", args: [], source: "local-bin", degraded: false });
});

test("global bin on PATH is chosen when nothing local resolves", async () => {
  const r = await resolveMusterCli({
    env: {},
    cwd: "/work",
    exists: fakeExists([]),
    hasBin: async (name) => name === "muster",
  });
  assert.deepEqual(r, { command: "muster", args: [], source: "global-bin", degraded: false });
});

test("npx fallback is the last resort and is marked degraded", async () => {
  const r = await resolveMusterCli({
    env: {},
    cwd: "/work",
    exists: fakeExists([]),
    hasBin: async () => false,
  });
  assert.deepEqual(r, { command: "npx", args: ["-y", "@adnova-group/muster"], source: "npx-fallback", degraded: true });
});

test("default hasBin scans PATH directories via the injected exists check", async () => {
  const r = await resolveMusterCli({
    env: { PATH: ["/usr/bin", "/opt/muster/bin"].join(delimiter) },
    cwd: "/work",
    exists: fakeExists(["/opt/muster/bin/muster"]),
  });
  assert.equal(r.source, "global-bin");
  assert.equal(r.command, "muster");
});

test("formatInvocation joins command + args into one shell-ready string", () => {
  assert.equal(formatInvocation({ command: "node", args: ["/x/cli.js"] }), "node /x/cli.js");
  assert.equal(formatInvocation({ command: "npx", args: ["-y", "@adnova-group/muster"] }), "npx -y @adnova-group/muster");
  assert.equal(formatInvocation({ command: "muster", args: [] }), "muster");
});

test("the canonical shell snippet embeds all four resolution tiers and assigns MUSTER_CLI", () => {
  assert.match(RESOLUTION_SHELL_SNIPPET, /CLAUDE_PLUGIN_ROOT/);
  assert.match(RESOLUTION_SHELL_SNIPPET, /runtime\/muster\.mjs/);
  assert.match(RESOLUTION_SHELL_SNIPPET, /src\/cli\.js/);
  assert.match(RESOLUTION_SHELL_SNIPPET, /node_modules\/\.bin\/muster/);
  assert.match(RESOLUTION_SHELL_SNIPPET, /command -v muster/);
  assert.match(RESOLUTION_SHELL_SNIPPET, /npx -y @adnova-group\/muster/);
  assert.match(RESOLUTION_SHELL_SNIPPET, /MUSTER_CLI=/);
});
