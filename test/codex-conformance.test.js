// Fixture-driven coverage for the Codex subagent model-conformance audit
// (src/codex-conformance.js): the join of rollout session_meta agent_role x
// turn_context.model x profile-TOML pin, and the MATCH/MISMATCH/GENERIC
// verdicts -- the glass-box answer to "did the subagent run the model its
// profile pins, or inherit the orchestrator's?" (2026-07-18 dogfood follow-up).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { auditCodexModelConformance, CONFORMANCE_VERDICTS } from "../src/codex-conformance.js";

const DAY = "2026/07/18";
const pexecFile = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

function utcDay(offset = 0, reference = new Date()) {
  const date = new Date(Date.UTC(
    reference.getUTCFullYear(),
    reference.getUTCMonth(),
    reference.getUTCDate() + offset
  ));
  return date.toISOString().slice(0, 10).replaceAll("-", "/");
}

async function writeDayRollout(sessionsDir, day, name, options) {
  const dayDir = join(sessionsDir, day);
  await mkdir(dayDir, { recursive: true });
  await writeFile(join(dayDir, name), rolloutLines(options));
}

function runCli(args, codexHome) {
  return pexecFile(process.execPath, [CLI, ...args], {
    cwd: REPO_ROOT,
    env: { ...process.env, CODEX_HOME: codexHome }
  });
}

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
  return { root, agentsDir, sessionsDir, dayDir };
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
  assert.equal(byFile["rollout-b-match.jsonl"].pinsNewerThanRollout, undefined, "pinsNewerThanRollout is only stamped on MISMATCH rows");
  assert.equal(byFile["rollout-c-mismatch.jsonl"].pinsNewerThanRollout, false, "these fixture pins predate every rollout write, so no mismatch here is pre-retier");
  assert.deepEqual(byFile["rollout-b-match.jsonl"].observed, [{ model: "gpt-5.6-sol", effort: "medium", turns: 2 }]);
  assert.equal(byFile["rollout-c-mismatch.jsonl"].verdict, CONFORMANCE_VERDICTS.MISMATCH);
  assert.deepEqual(byFile["rollout-c-mismatch.jsonl"].expected, { model: "gpt-5.6-luna", effort: "xhigh" });
  assert.equal(byFile["rollout-d-generic.jsonl"].verdict, CONFORMANCE_VERDICTS.GENERIC);
  assert.equal(byFile["rollout-d-generic.jsonl"].depth, 2);
  assert.equal(byFile["rollout-e-nopin.jsonl"].verdict, CONFORMANCE_VERDICTS.NO_PIN);
  assert.equal(byFile["rollout-f-idle.jsonl"].verdict, CONFORMANCE_VERDICTS.IDLE);
  assert.deepEqual(report.tally, { subagents: 8, match: 2, mismatch: 3, generic: 1, noPin: 1, idle: 1, prePinMismatch: 0 });
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

test("conformance audit scans a UTC-inclusive multi-day range, aggregates tally, and skips missing days", async t => {
  const { agentsDir, sessionsDir } = await fixture(t);
  const anchor = new Date();
  const today = utcDay(0, anchor);
  const yesterday = utcDay(-1, anchor);
  const missing = utcDay(-2, anchor);
  await writeDayRollout(sessionsDir, today, "rollout-today-match.jsonl", {
    threadSource: "subagent", agentRole: "role-sol", turnModels: ["gpt-5.6-sol"]
  });
  await writeDayRollout(sessionsDir, yesterday, "rollout-yesterday-mismatch.jsonl", {
    threadSource: "subagent", agentRole: "role-luna", turnModels: ["gpt-5.6-sol"]
  });

  const report = await auditCodexModelConformance({ sessionsDir, agentsDir, days: 3 });
  assert.equal(report.tally.subagents, 2, "an absent day is skipped without an empty row");
  assert.equal(report.tally.match, 1);
  assert.equal(report.tally.mismatch, 1);
  assert.deepEqual(report.rows.map(row => row.day).sort(), [today, yesterday].sort());
  assert.ok(!report.rows.some(row => row.day === missing), "missing day must not abort or fabricate rows");
  const mismatch = report.rows.find(row => row.verdict === CONFORMANCE_VERDICTS.MISMATCH);
  assert.equal(mismatch.day, yesterday, "the mismatch keeps its source day");
});

test("codex-conformance CLI rejects an explicit day combined with --days", async t => {
  const { root } = await fixture(t);
  const explicitDay = utcDay();
  await assert.rejects(
    () => runCli(["codex-conformance", explicitDay, "--days", "2"], root),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /day.*days|days.*day|conflict/i);
      return true;
    }
  );
});

test("codex-conformance CLI validates --days as a positive base-10 integer", async t => {
  const { root } = await fixture(t);
  for (const value of ["0", "-1", "1.5", "abc"]) {
    await assert.rejects(
      () => runCli(["codex-conformance", "--days", value], root),
      error => {
        assert.notEqual(error.code, 0, `--days ${value} must fail`);
        assert.match(error.stderr, /days.*positive|positive.*integer|base-10|invalid/i);
        return true;
      }
    );
  }
  await assert.rejects(
    () => runCli(["codex-conformance", "--days"], root),
    error => {
      assert.notEqual(error.code, 0);
      assert.match(error.stderr, /days.*positive|positive.*integer|missing|invalid/i);
      return true;
    }
  );
});

test("codex-conformance CLI rejects --days=N loudly with exit 1 and no stdout", async t => {
  const { root } = await fixture(t);
  await assert.rejects(
    () => runCli(["codex-conformance", "--days=2"], root),
    error => {
      assert.equal(error.code, 1);
      assert.equal(error.stdout, "", "usage errors must not emit a JSON report");
      assert.match(error.stderr, /--days requires a separate positive base-10 integer argument/);
      return true;
    }
  );
});

test("codex-conformance API and CLI enforce the inclusive 1..3660 day range", async t => {
  const { root, sessionsDir, agentsDir } = await fixture(t);
  for (const value of [3661, 5_000_000_000]) {
    await assert.rejects(
      () => auditCodexModelConformance({ sessionsDir, agentsDir, days: value }),
      error => {
        assert.match(error.message, /days.*3660|3660.*days/i, `API error names the 3660-day upper bound for ${value}`);
        return true;
      }
    );
    await assert.rejects(
      () => runCli(["codex-conformance", "--days", String(value)], root),
      error => {
        assert.equal(error.code, 1, `--days ${value} is a usage error, not an audit mismatch`);
        assert.equal(error.stdout, "", "range validation must not emit a JSON report");
        assert.match(error.stderr, /days.*3660|3660.*days/i, `CLI error names the 3660-day upper bound for ${value}`);
        return true;
      }
    );
  }

  // Boundary acceptance uses an empty, non-existent sessions tree: the API must
  // validate and accept the bound without requiring thousands of fixture files.
  const boundary = await auditCodexModelConformance({
    sessionsDir: join(root, "empty-sessions"),
    agentsDir: join(root, "empty-agents"),
    days: 3660
  });
  assert.equal(boundary.days, 3660);
  assert.deepEqual(boundary.rows, []);
  assert.deepEqual(boundary.tally, { subagents: 0, match: 0, mismatch: 0, generic: 0, noPin: 0, idle: 0, prePinMismatch: 0 });
  const { stdout } = await runCli(["codex-conformance", "--days", "3660"], root);
  assert.equal(JSON.parse(stdout).days, 3660);
  assert.equal(stdout, JSON.stringify(JSON.parse(stdout), null, 2) + "\n", "valid reports keep canonical JSON stdout");
});

test("codex-conformance CLI applies --cwd filtering to every day in a two-day range", async t => {
  const { root, sessionsDir } = await fixture(t);
  const anchor = new Date();
  const today = utcDay(0, anchor);
  const yesterday = utcDay(-1, anchor);
  for (const [day, label] of [[today, "today"], [yesterday, "yesterday"]]) {
    await writeDayRollout(sessionsDir, day, `rollout-${label}-match.jsonl`, {
      threadSource: "subagent", agentRole: "role-sol", cwd: "/work/muster", turnModels: ["gpt-5.6-sol"]
    });
    await writeDayRollout(sessionsDir, day, `rollout-${label}-outside.jsonl`, {
      threadSource: "subagent", agentRole: "role-luna", cwd: "/elsewhere/app", turnModels: ["gpt-5.6-sol"]
    });
  }

  const { stdout } = await runCli(["codex-conformance", "--days", "2", "--cwd", "muster"], root);
  const report = JSON.parse(stdout);
  assert.equal(report.days, 2);
  assert.deepEqual(report.rows.map(row => row.file), ["rollout-today-match.jsonl", "rollout-yesterday-match.jsonl"]);
  assert.deepEqual(report.rows.map(row => row.day).sort(), [today, yesterday].sort());
  assert.deepEqual(report.tally, { subagents: 2, match: 2, mismatch: 0, generic: 0, noPin: 0, idle: 0, prePinMismatch: 0 });
  assert.equal(stdout, JSON.stringify(report, null, 2) + "\n", "valid reports keep canonical JSON stdout");
});

test("codex-conformance CLI without a day or --days audits only today's UTC directory", async t => {
  const { root, sessionsDir } = await fixture(t);
  const anchor = new Date();
  const today = utcDay(0, anchor);
  const yesterday = utcDay(-1, anchor);
  await writeDayRollout(sessionsDir, today, "rollout-today-match.jsonl", {
    threadSource: "subagent", agentRole: "role-sol", turnModels: ["gpt-5.6-sol"]
  });
  await writeDayRollout(sessionsDir, yesterday, "rollout-yesterday-mismatch.jsonl", {
    threadSource: "subagent", agentRole: "role-luna", turnModels: ["gpt-5.6-sol"]
  });
  // Resolve the UTC day immediately before spawning so the assertion follows the
  // CLI's own default anchor rather than a stale test constant.
  const dayBeforeSpawn = utcDay();
  const { stdout } = await runCli(["codex-conformance"], root);
  const report = JSON.parse(stdout);
  assert.equal(report.day, dayBeforeSpawn);
  assert.equal(report.tally.mismatch, 0, "a mismatch on yesterday must not enter today's default audit");
  assert.equal(report.rows.length, 1);
});

test("codex-conformance CLI exits nonzero when any mismatch appears in the requested range", async t => {
  const { root, sessionsDir } = await fixture(t);
  const anchor = new Date();
  const today = utcDay(0, anchor);
  const yesterday = utcDay(-1, anchor);
  await writeDayRollout(sessionsDir, today, "rollout-today-match.jsonl", {
    threadSource: "subagent", agentRole: "role-sol", turnModels: ["gpt-5.6-sol"]
  });
  await writeDayRollout(sessionsDir, yesterday, "rollout-yesterday-mismatch.jsonl", {
    threadSource: "subagent", agentRole: "role-luna", turnModels: ["gpt-5.6-sol"]
  });
  // Resolve immediately before spawn; the range is today plus its prior day.
  const dayBeforeSpawn = utcDay();
  await assert.rejects(
    () => runCli(["codex-conformance", "--days", "2"], root),
    error => {
      assert.equal(error.code, 2, "an audit mismatch is a distinct nonzero status from usage errors");
      assert.equal(error.stderr, "", "a valid audit report does not write diagnostics to stderr");
      const report = JSON.parse(error.stdout);
      assert.equal(report.tally.mismatch, 1);
      assert.ok(report.rows.some(row => row.day !== dayBeforeSpawn && row.verdict === CONFORMANCE_VERDICTS.MISMATCH));
      assert.equal(error.stdout, JSON.stringify(report, null, 2) + "\n", "valid reports keep canonical JSON stdout");
      return true;
    }
  );
});

// Pre-retier mismatch annotation (backlog item run4-polish-pair, part b): a
// range crossing a profile retier legitimately contains historical MISMATCH
// rows -- comparing a rollout that ran before the retier against the CURRENT
// pins always disagrees. Fixtures control real mtimes via utimes rather than
// relying on write-order timing.
test("conformance audit stamps a pre-retier MISMATCH (old rollout, newer pins) and --current-pins-only excludes it from the exit-code decision without hiding it", async t => {
  const { agentsDir, sessionsDir, dayDir, root } = await fixture(t);
  const rolloutPath = join(dayDir, "rollout-old-mismatch.jsonl");
  await writeFile(rolloutPath, rolloutLines({ threadSource: "subagent", agentRole: "role-luna", turnModels: ["gpt-5.6-sol"] }));
  const old = new Date("2020-01-01T00:00:00Z");
  await utimes(rolloutPath, old, old);
  // Simulate a retier landing AFTER this historical rollout ran.
  const retier = new Date();
  await utimes(join(agentsDir, "role-sol.toml"), retier, retier);
  await utimes(join(agentsDir, "role-luna.toml"), retier, retier);

  const report = await auditCodexModelConformance({ sessionsDir, agentsDir, day: DAY });
  const row = report.rows.find(r => r.file === "rollout-old-mismatch.jsonl");
  assert.equal(row.verdict, CONFORMANCE_VERDICTS.MISMATCH);
  assert.equal(row.pinsNewerThanRollout, true, "current pins postdate this historical rollout");
  assert.equal(report.tally.mismatch, 1);
  assert.equal(report.tally.prePinMismatch, 1);

  await assert.rejects(
    () => runCli(["codex-conformance", DAY], root),
    error => {
      assert.equal(error.code, 2, "a pre-pin mismatch still exits 2 by default -- never silently hidden");
      const defaultReport = JSON.parse(error.stdout);
      assert.equal(defaultReport.tally.mismatch, 1);
      assert.equal(defaultReport.tally.prePinMismatch, 1);
      assert.equal(defaultReport.rows.find(r => r.file === "rollout-old-mismatch.jsonl").pinsNewerThanRollout, true, "the row stays listed and annotated, not hidden");
      return true;
    }
  );

  const { stdout } = await runCli(["codex-conformance", DAY, "--current-pins-only"], root);
  const flagged = JSON.parse(stdout);
  assert.equal(flagged.tally.mismatch, 1, "the row is still listed under the flag");
  assert.equal(flagged.tally.prePinMismatch, 1);
  assert.equal(flagged.rows.find(r => r.file === "rollout-old-mismatch.jsonl").pinsNewerThanRollout, true);
});

test("conformance: a genuinely-current MISMATCH (pins no newer than the rollout) exits 2 under --current-pins-only too", async t => {
  const { agentsDir, sessionsDir, dayDir, root } = await fixture(t);
  const rolloutPath = join(dayDir, "rollout-current-mismatch.jsonl");
  await writeFile(rolloutPath, rolloutLines({ threadSource: "subagent", agentRole: "role-luna", turnModels: ["gpt-5.6-sol"] }));
  // No retier since: the pins are explicitly OLDER than this rollout.
  const past = new Date("2020-01-01T00:00:00Z");
  await utimes(join(agentsDir, "role-sol.toml"), past, past);
  await utimes(join(agentsDir, "role-luna.toml"), past, past);

  const report = await auditCodexModelConformance({ sessionsDir, agentsDir, day: DAY });
  const row = report.rows.find(r => r.file === "rollout-current-mismatch.jsonl");
  assert.equal(row.verdict, CONFORMANCE_VERDICTS.MISMATCH);
  assert.equal(row.pinsNewerThanRollout, false);
  assert.equal(report.tally.prePinMismatch, 0);

  for (const args of [["codex-conformance", DAY], ["codex-conformance", DAY, "--current-pins-only"]]) {
    await assert.rejects(
      () => runCli(args, root),
      error => {
        assert.equal(error.code, 2, `${args.join(" ")} must still exit 2 -- a genuinely current mismatch is never excluded`);
        return true;
      }
    );
  }
});
