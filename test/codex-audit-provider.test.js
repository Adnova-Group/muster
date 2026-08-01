import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile as execFileCb } from "node:child_process";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { deriveCodexAuditCandidates, selectCodexAuditProvider } from "../src/codex-audit-provider.js";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

const execFile = promisify(execFileCb);

const provider = (id, apiVersion, available = true) => ({
  id, source: "builtin", kind: "agent", apiVersion, available,
});

function select(callableApis, candidates) {
  return selectCodexAuditProvider({
    role: "code-review", taskId: "audit-readability", message: "Review readability",
    callableApis, candidates,
  });
}

const fixtures = [
  ["v1-only keeps a compatible preferred provider", ["v1"], [provider("preferred-v1", "v1"), provider("alternate-v2", "v2")], "preferred-v1", "multi_agent_v1.spawn_agent"],
  ["v1-only skips an incompatible preference for an independent v1 provider", ["v1"], [provider("stale-v2", "v2"), provider("alternate-v1", "v1")], "alternate-v1", "multi_agent_v1.spawn_agent"],
  ["v2-only keeps a compatible preferred provider", ["v2"], [provider("preferred-v2", "v2"), provider("alternate-v1", "v1")], "preferred-v2", "collaboration.spawn_agent"],
  ["v2-only skips an incompatible preference for an independent v2 provider", ["v2"], [provider("stale-v1", "v1"), provider("alternate-v2", "v2")], "alternate-v2", "collaboration.spawn_agent"],
  ["mixed session preserves manifest order when both APIs are callable", ["v1", "v2"], [provider("preferred-v1", "v1"), provider("alternate-v2", "v2")], "preferred-v1", "multi_agent_v1.spawn_agent"],
  ["mixed session skips an unavailable preference before choosing compatible coverage", ["v1", "v2"], [provider("unavailable-v2", "v2", false), provider("alternate-v2", "v2")], "alternate-v2", "collaboration.spawn_agent"],
];

for (const [name, callableApis, candidates, expected, tool] of fixtures) {
  test(name, () => {
    const result = select(callableApis, candidates);
    assert.equal(result.mode, "independent");
    assert.equal(result.provider.id, expected);
    assert.equal(result.packet.tool, tool);
    assert.equal(result.packet.agent_type, expected);
    assert.equal(result.degradation, null);
    const packetApi = result.packet.tool.startsWith("multi_agent_v1.") ? "v1" : "v2";
    assert.ok(callableApis.includes(packetApi), "must never emit a packet for an API absent from the active session");
  });
}

test("v1-only degrades inline only when no available provider speaks v1", () => {
  const result = select(["v1"], [provider("unavailable-v1", "v1", false), provider("v2-only", "v2")]);
  assert.equal(result.mode, "inline");
  assert.equal(result.packet, null);
  assert.deepEqual(result.degradation, {
    code: "CODEX_AUDIT_NO_COMPATIBLE_PROVIDER", role: "code-review", callableApis: ["v1"],
    considered: [
      { id: "unavailable-v1", apiVersion: "v1", available: false },
      { id: "v2-only", apiVersion: "v2", available: true },
    ],
  });
});

test("v2-only degrades inline with no spawn packet when every provider is incompatible or unavailable", () => {
  const result = select(["v2"], [provider("v1-only", "v1"), provider("unavailable-v2", "v2", false)]);
  assert.equal(result.mode, "inline");
  assert.equal(result.packet, null);
  assert.equal(result.degradation.code, "CODEX_AUDIT_NO_COMPATIBLE_PROVIDER");
});

test("invalid or ambiguous API metadata fails closed before any packet can be emitted", () => {
  assert.throws(() => select(["v3"], [provider("candidate", "v1")]), /unknown callable API/);
  assert.throws(() => select(["v1"], [provider("candidate", undefined)]), /apiVersion/);
  assert.throws(() => select(["v1"], [{ ...provider("candidate", "v1"), available: undefined }]), /availability must be explicit/);
  assert.throws(() => select(["v1"], [{ ...provider("candidate", "v1"), kind: "skill" }]), /independent agent provider/);
});

test("candidate derivation enriches the full ordered chain from live inventory and current model APIs", async () => {
  const roleEntry = { chain: [provider("preferred", "v1"), provider("alternate", "v2"), { id: "inline", kind: "inline" }] };
  const candidates = await deriveCodexAuditCandidates(roleEntry, { agents: ["preferred", "alternate"] }, {
    profileForAgent: id => ({ model: `${id}-model` }),
    versionForModel: async model => model === "preferred-model" ? "v1" : "v2",
  });
  assert.deepEqual(candidates, [provider("preferred", "v1"), provider("alternate", "v2")]);
  assert.equal(select(["v2"], candidates).provider.id, "alternate");
});

test("codex-audit-provider CLI derives candidates instead of accepting a handcrafted matrix", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-audit-provider-"));
  const home = join(dir, "home");
  const codexHome = join(home, ".codex");
  const agents = join(dir, ".codex", "agents");
  const bin = join(dir, "bin");
  await mkdir(codexHome, { recursive: true });
  await mkdir(agents, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
    models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v2" }],
  }));
  await writeFile(join(agents, "muster-reviewer.toml"), "name = 'muster-reviewer'\n");
  const codex = join(bin, "codex");
  await writeFile(codex, `#!${process.execPath}\nconsole.log("[]");\n`);
  await chmod(codex, 0o755);
  const { stdout } = await execFile(process.execPath, [
    new URL("../src/cli.js", import.meta.url).pathname,
    "codex-audit-provider", "--role", "code-review", "--task-id", "audit-readability",
    "--callable-apis", "v2", "--message", "Review readability",
  ], {
    cwd: dir,
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH || ""}` },
  });
  const result = JSON.parse(stdout);
  assert.equal(result.provider.id, "muster-reviewer");
  assert.equal(result.packet.tool, "collaboration.spawn_agent");
  assert.equal(result.degradation, null);
});
