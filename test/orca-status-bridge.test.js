import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  ORCA_BRIDGE_UNKNOWN,
  buildOrcaStatusBridge,
  readOrcaStatusBridge,
  validateOrcaStatusBridge,
} from "../src/orca-status-bridge.js";
import { ORCA_CONTEXT_COMMANDS } from "../src/orca-context-adapter.js";

// These fixtures are SYNTHETIC: their terminal `state`/`resumable`/
// `restored_from` fields and lifecycle names (hibernation, restoration) come
// from Orca's docs, not from a live capture -- no observed terminal record
// carries them. They exercise inert-by-design branches; the verified signals
// are `connected` and `orphaned` only.
const FIXTURE_ROOT = join(process.cwd(), "test/fixtures/orca-status-bridge");

async function fixture(name) {
  return JSON.parse(await readFile(join(FIXTURE_ROOT, `${name}.json`), "utf8"));
}

function runnerFor(data, calls) {
  return async ({ command, args }) => {
    calls.push({ command, args: [...args] });
    if (args[0] === "agent-context") return data.agentContext;
    if (args[0] === "status") return data.status;
    if (args[0] === "worktree") return data.worktree;
    if (args[0] === "terminal") return data.terminals;
    throw new Error(`unexpected command ${command} ${args.join(" ")}`);
  };
}

test("four lifecycle fixtures produce bounded read-only projections", async () => {
  const expected = {
    hibernation: ["hibernated", "hibernated", "hibernated"],
    restoration: ["ready", "connected", "attached"],
    reconnect: ["reconnecting", "reconnecting", "reconnecting"],
    "missing-provider-hook": ["ready", "connected", "attached"],
  };
  for (const name of Object.keys(expected)) {
    const data = await fixture(name);
    const before = JSON.stringify(data);
    const calls = [];
    const result = await readOrcaStatusBridge({
      profile: data.profile,
      profileFixture: data.profileFixture,
      env: data.env,
      contextOptions: { runCommand: runnerFor(data, calls) },
      muster: data.muster,
    });
    assert.deepEqual([
      result.orca.lifecycle.state,
      result.orca.terminal.status,
      result.orca.session.status,
    ], expected[name], name);
    assert.equal(result.readOnly, true);
    assert.deepEqual(validateOrcaStatusBridge(result), { ok: true, errors: [] });
    assert.equal(JSON.stringify(data), before, `${name} input must not be mutated`);
    assert.ok(calls.every(({ args }) => args.includes("--json")), `${name} must use JSON CLI reads`);
    assert.ok(calls.every(({ args }) => args[0] === "agent-context" || args[0] === "status" || args[0] === "worktree" || args[0] === "terminal"));
  }
});

test("a disconnected terminal without a positive hibernation signal is unknown, not hibernated", async () => {
  const data = await fixture("hibernation");
  // Strip the self-authored fields: no live Orca terminal record carries
  // `state`/`resumable`, and Orca's hibernation preconditions (agent done,
  // idle window elapsed, no unsettled dispatch) are not visible in any record.
  // A crashed or daemon-killed terminal looks identical to a hibernated one,
  // so the honest classification for a bare `connected: false` is unknown.
  const stripped = JSON.parse(JSON.stringify(data));
  for (const terminal of stripped.terminals.terminals) {
    delete terminal.state;
    delete terminal.resumable;
  }
  const result = await readOrcaStatusBridge({
    profile: stripped.profile,
    profileFixture: stripped.profileFixture,
    env: stripped.env,
    contextOptions: { runCommand: runnerFor(stripped, []) },
    muster: stripped.muster,
  });
  assert.equal(result.orca.lifecycle.state, "unknown");
  assert.equal(result.orca.terminal.status, "UNKNOWN");
  assert.equal(result.orca.session.status, "UNKNOWN");
});

test("hibernation retains Muster state but never upgrades it from an Orca terminal observation", async () => {
  const data = await fixture("hibernation");
  const result = await readOrcaStatusBridge({
    profile: data.profile,
    env: data.env,
    contextOptions: { runCommand: runnerFor(data, []) },
    muster: data.muster,
  });
  assert.equal(result.muster.item.state, "implementation_in_flight");
  assert.equal(result.muster.receipt.status, "UNKNOWN");
  assert.equal(result.orca.terminal.handle, "term-hibernate");
  assert.equal(result.orca.session.id, null);
});

test("reconnect maps every live Orca claim to unavailable or UNKNOWN and does not use stale worktree data", async () => {
  const data = await fixture("reconnect");
  const result = await readOrcaStatusBridge({
    profile: data.profile,
    env: data.env,
    contextOptions: { runCommand: runnerFor(data, []) },
    muster: data.muster,
  });
  assert.equal(result.availability, "unavailable");
  assert.equal(result.reason, "reconnect");
  assert.equal(result.orca.lifecycle.state, "reconnecting");
  assert.equal(result.orca.worktree.status, ORCA_BRIDGE_UNKNOWN);
  assert.equal(result.orca.remote.status, "reconnecting");
  assert.ok(Object.values(result.orca.capabilities).every((entry) => entry.status === ORCA_BRIDGE_UNKNOWN));
});

test("missing provider hook remains UNKNOWN and cannot close a completed Muster gate", async () => {
  const data = await fixture("missing-provider-hook");
  const result = await readOrcaStatusBridge({
    profile: data.profile,
    profileFixture: data.profileFixture,
    env: data.env,
    contextOptions: { runCommand: runnerFor(data, []) },
    muster: data.muster,
  });
  assert.equal(result.muster.gate.verdict, "PASS");
  assert.equal(result.orca.capabilities.hooks.status, ORCA_BRIDGE_UNKNOWN);
  assert.equal(result.orca.provider_hook.status, ORCA_BRIDGE_UNKNOWN);
  assert.equal(result.orca.lifecycle.state, "ready");
});

test("pure bridge accepts a frozen unavailable observation and performs no filesystem or task writes", () => {
  const context = Object.freeze({
    schemaVersion: 1,
    available: false,
    availability: "unavailable",
    reason: "reconnect",
    detail: "runtime unavailable",
    diagnostics: [],
    context: null,
  });
  const muster = Object.freeze({
    item: Object.freeze({ id: "item", state: "in_flight" }),
    attempt: Object.freeze({ id: "attempt", number: 1, state: "in_flight" }),
  });
  const result = buildOrcaStatusBridge({ context, muster });
  assert.equal(result.readOnly, true);
  assert.equal(result.orca.lifecycle.state, "reconnecting");
  assert.deepEqual(validateOrcaStatusBridge(result), { ok: true, errors: [] });
});
