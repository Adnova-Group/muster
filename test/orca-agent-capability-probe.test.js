import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  CAPABILITY_STATUSES,
  CAPABILITY_SURFACES,
  ORCA_AGENT_CAPABILITY_PROFILES,
  ORCA_AGENT_PROVIDERS,
  UNKNOWN,
  probeOrcaAgentCapabilities,
  validateOrcaAgentCapabilityProbe,
} from "../src/orca-agent-capability-probe.js";
import { ORCA_CONTEXT_COMMANDS } from "../src/orca-context-adapter.js";

const CONTEXT_FIXTURE_ROOT = join(process.cwd(), "test/fixtures/orca-context");
const CAPABILITY_FIXTURE_ROOT = join(process.cwd(), "test/fixtures/orca-agent-capabilities");

async function fixture(root, name) {
  return JSON.parse(await readFile(join(root, `${name}.json`), "utf8"));
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

test("covers six provider profiles with every required capability surface", async () => {
  assert.equal(ORCA_AGENT_PROVIDERS.length, 6);
  assert.deepEqual(ORCA_AGENT_PROVIDERS, ["claude-code", "codex", "kimi", "hermes", "cowork", "chatgpt-work"]);
  for (const name of ORCA_AGENT_PROVIDERS) {
    const data = await fixture(CAPABILITY_FIXTURE_ROOT, name);
    assert.deepEqual(Object.keys(data.expected).sort(), [...CAPABILITY_SURFACES].sort(), `${name} fixture coverage`);
    assert.ok(data.expected["working-directory"]);
    assert.ok(ORCA_AGENT_CAPABILITY_PROFILES[name]);
  }
});
test("uses the integrated Orca context adapter and only read-only public JSON CLI calls", async () => {
  const context = await fixture(CONTEXT_FIXTURE_ROOT, "local");
  const calls = [];
  const result = await probeOrcaAgentCapabilities({
    profile: "codex",
    env: context.env,
    contextOptions: { runCommand: runnerFor(context, calls) },
  });

  assert.equal(result.available, true);
  assert.equal(result.profile, "codex");
  assert.equal(result.observations.working_directory, "/workspace/app");
  assert.equal(result.observations.orca_worktree_id, "repo-local::/workspace/app");
  assert.equal(result.capabilities["working-directory"].status, "SUPPORTED");
  assert.equal(result.capabilities.workingDirectory.status, "SUPPORTED");
  assert.deepEqual(calls.map(({ args }) => args), [
    ORCA_CONTEXT_COMMANDS.schema,
    ORCA_CONTEXT_COMMANDS.status,
    ORCA_CONTEXT_COMMANDS.worktree,
    ["terminal", "list", "--worktree", "id:repo-local::/workspace/app", "--json"],
  ]);
  assert.ok(calls.every(({ args }) => args.includes("--json")));
  assert.deepEqual(validateOrcaAgentCapabilityProbe(result), { ok: true, errors: [] });
});

for (const name of ["claude-code", "codex", "kimi", "hermes", "cowork", "chatgpt-work"]) {
  test(`${name} fixture preserves bounded capability statuses`, async () => {
    const context = await fixture(CONTEXT_FIXTURE_ROOT, "local");
    const expected = await fixture(CAPABILITY_FIXTURE_ROOT, name);
    const result = await probeOrcaAgentCapabilities({
      profile: name,
      env: context.env,
      contextOptions: { runCommand: runnerFor(context) },
    });
    const statuses = Object.fromEntries(CAPABILITY_SURFACES.map((surface) => [surface, result.capabilities[surface].status]));
    assert.deepEqual(statuses, expected.expected);
    assert.ok(Object.values(statuses).every((value) => CAPABILITY_STATUSES.includes(value)));
  });
}

test("unknown or unverified profile values never become inferred support", async () => {
  const context = await fixture(CONTEXT_FIXTURE_ROOT, "local");
  const result = await probeOrcaAgentCapabilities({
    profile: "provider-not-in-catalog",
    env: context.env,
    contextOptions: { runCommand: runnerFor(context) },
  });
  assert.equal(result.profile, "provider-not-in-catalog");
  assert.ok(CAPABILITY_SURFACES.every((surface) => result.capabilities[surface].status === UNKNOWN));

  const malformed = await probeOrcaAgentCapabilities({
    profile: "fixture-profile",
    profileFixture: {
      provider: "fixture-profile",
      capabilities: {
        "working-directory": "SUPPORTED",
        skills: "maybe",
        mcp: { status: "UNSUPPORTED", evidence: "fixture" },
      },
    },
    env: context.env,
    contextOptions: { runCommand: runnerFor(context) },
  });
  assert.equal(malformed.capabilities.skills.status, UNKNOWN);
  assert.equal(malformed.capabilities.mcp.status, "UNSUPPORTED");
  assert.ok(CAPABILITY_SURFACES.every((surface) => CAPABILITY_STATUSES.includes(malformed.capabilities[surface].status)));
});

test("unavailable or reconnecting Orca context bounds every surface to UNKNOWN", async () => {
  const context = await fixture(CONTEXT_FIXTURE_ROOT, "reconnect");
  const result = await probeOrcaAgentCapabilities({
    profile: "claude-code",
    env: context.env,
    contextOptions: { runCommand: runnerFor(context) },
  });
  assert.equal(result.available, false);
  assert.equal(result.context, null);
  assert.ok(CAPABILITY_SURFACES.every((surface) => result.capabilities[surface].status === UNKNOWN));
  assert.deepEqual(validateOrcaAgentCapabilityProbe(result), { ok: true, errors: [] });
});

test("an explicit fixture can only lower confidence and cannot add new surfaces", async () => {
  const context = await fixture(CONTEXT_FIXTURE_ROOT, "local");
  const result = await probeOrcaAgentCapabilities({
    profile: "codex",
    profileFixture: {
      provider: "codex",
      capabilities: {
        "working-directory": { status: "UNSUPPORTED", evidence: "fixture override" },
        skills: { status: "UNKNOWN", evidence: "do not retain unverified text" },
      },
      privateToken: "must not be copied",
    },
    env: context.env,
    contextOptions: { runCommand: runnerFor(context) },
  });
  assert.equal(result.capabilities["working-directory"].status, "UNSUPPORTED");
  assert.equal(result.capabilities.skills.status, UNKNOWN);
  assert.ok(!JSON.stringify(result).includes("privateToken"));
  assert.deepEqual(validateOrcaAgentCapabilityProbe(result), { ok: true, errors: [] });
});
