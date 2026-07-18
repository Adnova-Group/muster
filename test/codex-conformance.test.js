// Fixture-driven coverage for the Codex subagent model-conformance audit
// (src/codex-conformance.js): the join of rollout session_meta agent_role x
// turn_context.model x profile-TOML pin, and the MATCH/MISMATCH/GENERIC
// verdicts -- the glass-box answer to "did the subagent run the model its
// profile pins, or inherit the orchestrator's?" (2026-07-18 dogfood follow-up).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditCodexModelConformance, CONFORMANCE_VERDICTS } from "../src/codex-conformance.js";

const DAY = "2026/07/18";

function rolloutLines({ threadSource, agentRole, nickname, depth, cwd, turnModels }) {
  const source = threadSource === "subagent"
    ? { subagent: { thread_spawn: { parent_thread_id: "p-1", depth: depth ?? 1, agent_nickname: nickname || "Fixture", ...(agentRole ? { agent_role: agentRole } : {}) } } }
    : "cli";
  const lines = [
    { timestamp: "t0", type: "session_meta", payload: { session_id: "s", thread_source: threadSource, cwd: cwd || "/work/muster", source } }
  ];
  // turnModels entries: "model" (effort medium via collaboration_mode, the real
  // rollout shape), "model@<effort>" (explicit), "model@absent" (NO effort
  // telemetry anywhere on the turn), "model@flat:<effort>" (legacy top-level
  // payload.effort fallback, no collaboration_mode).
  for (const entry of turnModels) {
    const [model, effort] = entry.split("@");
    const payload = { type: "turn_context", model };
    if (effort === "absent") { /* no effort telemetry at all */ }
    else if (effort?.startsWith("flat:")) payload.effort = effort.slice(5);
    else payload.collaboration_mode = { mode: "default", settings: { model, reasoning_effort: effort || "medium" } };
    lines.push({ timestamp: "t1", type: "response_item", payload });
  }
  return lines.map(line => JSON.stringify(line)).join("\n") + "\n";
}

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "muster-codex-conformance-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const agentsDir = join(root, "agents");
  await mkdir(agentsDir, { recursive: true });
  await writeFile(join(agentsDir, "role-sol.toml"), 'name = "role-sol"\nmodel = "gpt-5.6-sol"\nmodel_reasoning_effort = "medium"\n');
  await writeFile(join(agentsDir, "role-luna.toml"), 'name = "role-luna"\nmodel = "gpt-5.6-luna"\nmodel_reasoning_effort = "xhigh"\n');
  const sessionsDir = join(root, "sessions");
  const dayDir = join(sessionsDir, DAY);
  await mkdir(dayDir, { recursive: true });
  return { agentsDir, sessionsDir, dayDir };
}

test("conformance audit classifies MATCH, MISMATCH, GENERIC, NO-PIN, and IDLE threads", async t => {
  const { agentsDir, sessionsDir, dayDir } = await fixture(t);
  await writeFile(join(dayDir, "rollout-a-user.jsonl"), rolloutLines({ threadSource: "user", turnModels: ["gpt-5.6-sol"] }));
  await writeFile(join(dayDir, "rollout-b-match.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "role-sol", nickname: "Curie", turnModels: ["gpt-5.6-sol", "gpt-5.6-sol"] }));
  await writeFile(join(dayDir, "rollout-c-mismatch.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "role-luna", nickname: "Volta", turnModels: ["gpt-5.6-sol"] }));
  await writeFile(join(dayDir, "rollout-d-generic.jsonl"), rolloutLines({ threadSource: "subagent", nickname: "Erdos", depth: 2, turnModels: ["gpt-5.6-sol"] }));
  await writeFile(join(dayDir, "rollout-e-nopin.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "ghost-role", turnModels: ["gpt-5.6-terra"] }));
  await writeFile(join(dayDir, "rollout-f-idle.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "role-sol", turnModels: [] }));
  // Effort-only drift: right model, wrong reasoning effort -- the
  // openai/codex#32587 inheritance class (a sol/medium pin billed at the
  // parent's high effort) must read as MISMATCH, not MATCH.
  await writeFile(join(dayDir, "rollout-g-effort.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "role-sol", nickname: "Noether", turnModels: ["gpt-5.6-sol@high"] }));
  // Deliberate fail-open: a turn with NO effort telemetry proves nothing about
  // effort, so it must NOT fail the audit (right model + absent effort = MATCH).
  await writeFile(join(dayDir, "rollout-h-absent.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "role-sol", turnModels: ["gpt-5.6-sol@absent"] }));
  // ...but the fail-open never masks a PRESENT wrong effort: mixed
  // absent-telemetry and wrong-effort turns still read MISMATCH, including
  // when the wrong effort arrives via the legacy top-level payload.effort.
  await writeFile(join(dayDir, "rollout-i-mixed.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "role-sol", turnModels: ["gpt-5.6-sol@absent", "gpt-5.6-sol@flat:xhigh"] }));
  const report = await auditCodexModelConformance({ sessionsDir, agentsDir, day: DAY });
  const byFile = Object.fromEntries(report.rows.map(row => [row.file, row]));
  assert.equal(byFile["rollout-g-effort.jsonl"].verdict, CONFORMANCE_VERDICTS.MISMATCH);
  assert.deepEqual(byFile["rollout-g-effort.jsonl"].observed, [{ model: "gpt-5.6-sol", effort: "high", turns: 1 }]);
  assert.equal(byFile["rollout-h-absent.jsonl"].verdict, CONFORMANCE_VERDICTS.MATCH, "absent effort telemetry is fail-open, not a mismatch");
  assert.deepEqual(byFile["rollout-h-absent.jsonl"].observed, [{ model: "gpt-5.6-sol", effort: null, turns: 1 }]);
  assert.equal(byFile["rollout-i-mixed.jsonl"].verdict, CONFORMANCE_VERDICTS.MISMATCH, "a present wrong effort fails even alongside absent-telemetry turns");
  assert.equal(byFile["rollout-a-user.jsonl"].kind, "user");
  assert.equal(byFile["rollout-a-user.jsonl"].verdict, null);
  assert.equal(byFile["rollout-b-match.jsonl"].verdict, CONFORMANCE_VERDICTS.MATCH);
  assert.deepEqual(byFile["rollout-b-match.jsonl"].observed, [{ model: "gpt-5.6-sol", effort: "medium", turns: 2 }]);
  assert.equal(byFile["rollout-c-mismatch.jsonl"].verdict, CONFORMANCE_VERDICTS.MISMATCH);
  assert.deepEqual(byFile["rollout-c-mismatch.jsonl"].expected, { model: "gpt-5.6-luna", effort: "xhigh" });
  assert.equal(byFile["rollout-d-generic.jsonl"].verdict, CONFORMANCE_VERDICTS.GENERIC);
  assert.equal(byFile["rollout-d-generic.jsonl"].depth, 2);
  assert.equal(byFile["rollout-e-nopin.jsonl"].verdict, CONFORMANCE_VERDICTS.NO_PIN);
  assert.equal(byFile["rollout-f-idle.jsonl"].verdict, CONFORMANCE_VERDICTS.IDLE);
  assert.deepEqual(report.tally, { subagents: 8, match: 2, mismatch: 3, generic: 1, noPin: 1, idle: 1 });
  assert.equal(report.pins, 2);
});

test("conformance audit honors the cwd filter and an absent day yields an empty report", async t => {
  const { agentsDir, sessionsDir, dayDir } = await fixture(t);
  await writeFile(join(dayDir, "rollout-in.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "role-sol", cwd: "/work/muster", turnModels: ["gpt-5.6-sol"] }));
  await writeFile(join(dayDir, "rollout-out.jsonl"), rolloutLines({ threadSource: "subagent", agentRole: "role-luna", cwd: "/elsewhere/app", turnModels: ["gpt-5.6-sol"] }));
  const filtered = await auditCodexModelConformance({ sessionsDir, agentsDir, day: DAY, cwdFilter: "muster" });
  assert.deepEqual(filtered.rows.map(row => row.file), ["rollout-in.jsonl"]);
  assert.equal(filtered.tally.mismatch, 0);
  const missing = await auditCodexModelConformance({ sessionsDir, agentsDir, day: "1999/01/01" });
  assert.deepEqual(missing.rows, []);
  assert.equal(missing.tally.subagents, 0);
});

test("conformance audit fails loud on missing required inputs and tolerates junk lines", async t => {
  const { agentsDir, sessionsDir, dayDir } = await fixture(t);
  await assert.rejects(auditCodexModelConformance({}), /sessionsDir, agentsDir, and day/);
  await writeFile(join(dayDir, "rollout-junk.jsonl"), "not-json\n\n" + rolloutLines({ threadSource: "subagent", agentRole: "role-sol", turnModels: ["gpt-5.6-sol"] }));
  const report = await auditCodexModelConformance({ sessionsDir, agentsDir, day: DAY });
  assert.equal(report.rows.length, 1);
  assert.equal(report.rows[0].verdict, CONFORMANCE_VERDICTS.MATCH);
});
