import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  discoverOrcaContext,
  ORCA_CONTEXT_COMMANDS,
  ORCA_CONTEXT_SCHEMA_VERSION,
  parseOrcaJsonResponse,
} from "../src/orca-context-adapter.js";

const FIXTURE_ROOT = join(process.cwd(), "test/fixtures/orca-context");

async function fixture(name) {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, `${name}.json`), "utf8"));
}

function runnerFor(data, calls = []) {
  return async ({ command, args }) => {
    calls.push({ command, args });
    if (args[0] === "agent-context") return data.agentContext;
    if (args[0] === "status") return data.status;
    if (args[0] === "worktree") return data.worktree;
    if (args[0] === "terminal") return data.terminals;
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}

test("discovers local context through JSON-only public CLI surfaces", async () => {
  const data = await fixture("local");
  const calls = [];
  const result = await discoverOrcaContext({ env: data.env, runCommand: runnerFor(data, calls) });

  assert.equal(result.schemaVersion, ORCA_CONTEXT_SCHEMA_VERSION);
  assert.equal(result.available, true);
  assert.equal(result.context.orca_runtime_id, "runtime-local");
  assert.equal(result.context.orca_repo_id, "repo-local");
  assert.equal(result.context.orca_worktree_id, "repo-local::/workspace/app");
  assert.equal(result.context.branch, "feature/local");
  assert.equal(result.context.host, "local");
  assert.equal(result.context.environment_kind, "local");
  assert.equal(result.context.terminal_handle, "term-local");
  assert.equal(result.context.pane_key, "pane-local");
  assert.equal(result.context.session_id, "session-local");
  assert.equal(result.context.remote_selector, "id:repo-local::/workspace/app");
  assert.deepEqual(calls.map(({ args }) => args), [
    ORCA_CONTEXT_COMMANDS.schema,
    ORCA_CONTEXT_COMMANDS.status,
    ORCA_CONTEXT_COMMANDS.worktree,
    ["terminal", "list", "--worktree", "id:repo-local::/workspace/app", "--json"],
  ]);
  assert.ok(calls.every(({ args }) => args.includes("--json")));
});

for (const [name, kind, host] of [
  ["ssh", "ssh", "ssh:build-host"],
  ["server", "server", "runtime:server-1"],
  ["vm", "vm-cloud", "vm:ephemeral-1"],
]) {
  test(`normalizes ${name} host identity and preserves an explicit remote selector`, async () => {
    const data = await fixture(name);
    const result = await discoverOrcaContext({ env: data.env, runCommand: runnerFor(data) });
    assert.equal(result.available, true);
    assert.equal(result.context.environment_kind, kind);
    assert.equal(result.context.host, host);
    assert.match(result.context.remote_selector, /^id:[^ ]+::\//);
    assert.equal(result.context.selector.worktree, result.context.remote_selector);
    assert.notEqual(result.context.selector.worktree, "active");
    assert.notEqual(result.context.selector.worktree, "current");
  });
}

test("fails closed while Orca is reconnecting", async () => {
  const data = await fixture("reconnect");
  const calls = [];
  const result = await discoverOrcaContext({ env: data.env, runCommand: runnerFor(data, calls) });
  assert.deepEqual(result, {
    schemaVersion: 1,
    available: false,
    availability: "unavailable",
    reason: "reconnect",
    detail: "Orca runtime/graph is stale_bootstrap/unavailable",
    diagnostics: [],
    context: null,
  });
  assert.deepEqual(calls.map(({ args }) => args), [ORCA_CONTEXT_COMMANDS.schema, ORCA_CONTEXT_COMMANDS.status]);
});

test("fails closed for malformed public JSON responses", async () => {
  const data = await fixture("malformed");
  const result = await discoverOrcaContext({ env: data.env, runCommand: runnerFor(data) });
  assert.equal(result.available, false);
  assert.equal(result.reason, "malformed-response");
  assert.equal(result.context, null);
});

test("fails closed for an unknown agent-context schema version", async () => {
  const data = await fixture("schema-version");
  const result = await discoverOrcaContext({ env: data.env, runCommand: runnerFor(data) });
  assert.equal(result.available, false);
  assert.equal(result.reason, "schema-version");
  assert.match(result.detail, /version: 2/);
  assert.equal(result.context, null);
});

test("fails closed when CLI and ORCA_WORKTREE_ID disagree", async () => {
  const data = await fixture("local");
  const result = await discoverOrcaContext({
    env: { ...data.env, ORCA_WORKTREE_ID: "repo-other::/workspace/other" },
    runCommand: runnerFor(data),
  });
  assert.equal(result.available, false);
  assert.equal(result.reason, "identity-mismatch");
});

test("parses wrapped and direct public JSON results without retaining raw output", () => {
  assert.deepEqual(parseOrcaJsonResponse('{"ok":true,"result":{"value":1}}'), { value: 1 });
  assert.deepEqual(parseOrcaJsonResponse({ value: 2 }), { value: 2 });
  assert.throws(() => parseOrcaJsonResponse("not json"), /invalid JSON/);
});
