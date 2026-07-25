// The v1/v2 Codex subagent API split (Codex 0.145.0).
// Codex picks the API version PER MODEL from the catalog's multi_agent_version;
// the live 0.145.0 catalog puts sol/terra on v2 but luna (muster's SONNET tier)
// on v1, so a single hardcoded packet shape is wrong for a tier at all times.
// Evidence: docs/research/codex-cli.md sec 10.1.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codexSpawnAgentCall, codexWaitAgentCall, resolveCodexMultiAgentVersion, CODEX_MULTI_AGENT_VERSIONS, CODEX_WAIT_TIMEOUT_MS } from "../src/wave-dispatch.js";
import { readCodexMultiAgentVersion } from "../src/codex-inventory.js";

test("resolveCodexMultiAgentVersion: override wins, then catalog, then a v1 floor", () => {
  assert.equal(resolveCodexMultiAgentVersion({ override: "v1", catalogVersion: "v2" }), "v1");
  assert.equal(resolveCodexMultiAgentVersion({ catalogVersion: "v2" }), "v2");
  assert.equal(resolveCodexMultiAgentVersion({ catalogVersion: "v1" }), "v1");
  // Nothing known -> v1, which is what the shipped `features.multi_agent = true`
  // default selects. NEVER v2: guessing v2 at a v1 model is the defect itself.
  assert.equal(resolveCodexMultiAgentVersion({}), CODEX_MULTI_AGENT_VERSIONS.V1);
  assert.equal(resolveCodexMultiAgentVersion({ catalogVersion: null }), "v1");
});

test("resolveCodexMultiAgentVersion: an unrecognized version fails loud, never guesses", () => {
  assert.throws(() => resolveCodexMultiAgentVersion({ catalogVersion: "v3" }), /unknown multi_agent_version/);
  assert.throws(() => resolveCodexMultiAgentVersion({ override: 2 }), /unknown multi_agent_version/);
});

test("codexSpawnAgentCall: v2 emits the collaboration packet", () => {
  const call = codexSpawnAgentCall({ taskId: "wave1-build", message: "do it", agentType: "muster-builder", version: "v2" });
  assert.equal(call.tool, "collaboration.spawn_agent");
  assert.equal(call.task_name, "wave1-build");
  assert.equal(call.fork_turns, "none");
  assert.equal(call.agent_type, "muster-builder");
  assert.equal(call.fork_context, undefined); // v2 rejects fork_context outright
});

test("codexSpawnAgentCall: v1 emits the multi_agent_v1 packet — no task_name, no fork_turns", () => {
  const call = codexSpawnAgentCall({ taskId: "wave1-fix", message: "do it", agentType: "muster-surgeon", version: "v1" });
  assert.equal(call.tool, "multi_agent_v1.spawn_agent");
  assert.equal(call.fork_context, false);
  assert.equal(call.agent_type, "muster-surgeon");
  assert.equal(call.task_name, undefined);  // v1 has no task_name
  assert.equal(call.fork_turns, undefined); // "fork_context is not supported in MultiAgentV2; use fork_turns instead"
});

test("codexSpawnAgentCall: defaults to the v1 shape when the version is unknown", () => {
  assert.equal(codexSpawnAgentCall({ taskId: "t", agentType: "a" }).tool, "multi_agent_v1.spawn_agent");
});

test("codexSpawnAgentCall: fork_turns must be a STRING — Codex rejects the integer", () => {
  const ok = f => codexSpawnAgentCall({ taskId: "t", agentType: "a", version: "v2", forkTurns: f });
  assert.equal(ok("3").fork_turns, "3");   // keeps 3 turns AND still accepts agent_type
  assert.equal(ok("none").fork_turns, "none");
  assert.throws(() => ok(3), /must be the STRING/);
  assert.throws(() => ok("0"), /must be the STRING/);
  assert.throws(() => ok("-1"), /must be the STRING/);
});

test("codexSpawnAgentCall: fork_turns 'all' with a named agent_type is refused before dispatch", () => {
  // Codex: "Full-history forked agents inherit the parent agent type" — catching
  // it here beats learning it from a rejected spawn mid-wave.
  assert.throws(
    () => codexSpawnAgentCall({ taskId: "t", agentType: "muster-builder", version: "v2", forkTurns: "all" }),
    /full-history fork, which Codex refuses to combine with a named agent_type/
  );
});

test("codexSpawnAgentCall: still requires taskId and agentType", () => {
  assert.throws(() => codexSpawnAgentCall({ agentType: "a" }), /taskId is required/);
  assert.throws(() => codexSpawnAgentCall({ taskId: "t" }), /agentType is required/);
});

// --- catalog reader ---------------------------------------------------------

test("readCodexMultiAgentVersion: reads the per-model version from the catalog", async () => {
  const home = mkdtempSync(join(tmpdir(), "muster-codex-cat-"));
  try {
    mkdirSync(join(home, ".codex"), { recursive: true });
    writeFileSync(join(home, ".codex", "models_cache.json"), JSON.stringify({
      client_version: "0.145.0",
      models: [
        { slug: "gpt-5.6-sol", multi_agent_version: "v2" },
        { slug: "gpt-5.6-terra", multi_agent_version: "v2" },
        { slug: "gpt-5.6-luna", multi_agent_version: "v1" },
        { slug: "gpt-5.5" } // no field -> null -> caller's floor
      ]
    }));
    assert.equal(await readCodexMultiAgentVersion("gpt-5.6-sol", { home }), "v2");
    assert.equal(await readCodexMultiAgentVersion("gpt-5.6-luna", { home }), "v1"); // muster's SONNET tier
    assert.equal(await readCodexMultiAgentVersion("gpt-5.5", { home }), null);
    assert.equal(await readCodexMultiAgentVersion("no-such-model", { home }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("readCodexMultiAgentVersion: a missing catalog degrades to null, never throws", async () => {
  const home = mkdtempSync(join(tmpdir(), "muster-codex-cat-"));
  try {
    assert.equal(await readCodexMultiAgentVersion("gpt-5.6-sol", { home }), null);
    assert.equal(await readCodexMultiAgentVersion("", { home }), null);
  } finally { rmSync(home, { recursive: true, force: true }); }
});

test("a tier moving across the v1/v2 line changes the emitted shape (the real hazard)", async () => {
  // A catalog refresh can flip a tier's version with no muster-visible change.
  const sonnet = "gpt-5.6-luna";
  for (const [catalogVersion, expectedTool] of [["v1", "multi_agent_v1.spawn_agent"], ["v2", "collaboration.spawn_agent"]]) {
    const version = resolveCodexMultiAgentVersion({ catalogVersion });
    assert.equal(codexSpawnAgentCall({ taskId: "t", agentType: "muster-surgeon", version }).tool, expectedTool,
      `${sonnet} on ${catalogVersion}`);
  }
});

// --- the wave BARRIER -------------------------------------------------------
// v1 and v2 wait_agent differ in kind: v1 waits on named targets and returns on
// the first to finish; v2 takes only a timeout and wakes on a mailbox update
// from ANY live agent. muster's prior instruction described only the v1 shape.

test("codexWaitAgentCall: v2 takes only a timeout — no targets", () => {
  const call = codexWaitAgentCall({ version: "v2" });
  assert.equal(call.tool, "collaboration.wait_agent");
  assert.equal(call.timeout_ms, CODEX_WAIT_TIMEOUT_MS.default);
  assert.equal(call.targets, undefined);
});

test("codexWaitAgentCall: v2 rejects targets rather than silently dropping them", () => {
  assert.throws(() => codexWaitAgentCall({ version: "v2", targets: ["agent-0"] }), /v2 wait_agent takes no targets/);
});

test("codexWaitAgentCall: v1 requires a non-empty targets array", () => {
  const call = codexWaitAgentCall({ version: "v1", targets: ["agent-0", "agent-1"] });
  assert.equal(call.tool, "multi_agent_v1.wait_agent");
  assert.deepEqual(call.targets, ["agent-0", "agent-1"]);
  assert.throws(() => codexWaitAgentCall({ version: "v1" }), /requires a non-empty targets array/);
  assert.throws(() => codexWaitAgentCall({ version: "v1", targets: [] }), /requires a non-empty targets array/);
  assert.throws(() => codexWaitAgentCall({ version: "v1", targets: [""] }), /requires a non-empty targets array/);
});

test("codexWaitAgentCall: enforces Codex's own wait-timeout bounds", () => {
  assert.equal(codexWaitAgentCall({ version: "v2", timeoutMs: 10_000 }).timeout_ms, 10_000);
  assert.equal(codexWaitAgentCall({ version: "v2", timeoutMs: 3_600_000 }).timeout_ms, 3_600_000);
  assert.throws(() => codexWaitAgentCall({ version: "v2", timeoutMs: 9_999 }), /must be an integer within/);
  assert.throws(() => codexWaitAgentCall({ version: "v2", timeoutMs: 3_600_001 }), /must be an integer within/);
  assert.throws(() => codexWaitAgentCall({ version: "v2", timeoutMs: 30.5 }), /must be an integer within/);
});

test("codexWaitAgentCall: an unknown version falls to the v1 shape, matching dispatch", () => {
  assert.equal(codexWaitAgentCall({ targets: ["a"] }).tool, "multi_agent_v1.wait_agent");
});
