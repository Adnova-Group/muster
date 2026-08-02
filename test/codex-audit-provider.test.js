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
      { id: "unavailable-v1", apiVersion: "v1", available: false, profile: null },
      { id: "v2-only", apiVersion: "v2", available: true, profile: null },
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
  assert.deepEqual(candidates, [
    { ...provider("preferred", "v1"), profile: { status: "manifest", scope: "manifest", path: null, model: "preferred-model" } },
    { ...provider("alternate", "v2"), profile: { status: "manifest", scope: "manifest", path: null, model: "alternate-model" } },
  ]);
  assert.equal(select(["v2"], candidates).provider.id, "alternate");
});

test("candidate derivation uses the effective project profile instead of a shadowed manifest model", async () => {
  const roleEntry = { chain: [provider("reviewer", "v2")] };
  const candidates = await deriveCodexAuditCandidates(roleEntry, {
    agents: ["reviewer"],
    agentProfiles: [
      { name: "reviewer", model: "project-v1", status: "resolved", scope: "project", path: "/repo/.codex/agents/reviewer.toml" },
      { name: "reviewer", model: "user-v2", status: "resolved", scope: "user", path: "/home/.codex/agents/reviewer.toml" },
    ],
  }, {
    profileForAgent: () => ({ model: "manifest-v2" }),
    versionForModel: async model => model.endsWith("v1") ? "v1" : "v2",
  });
  assert.equal(candidates[0].apiVersion, "v1");
  assert.equal(candidates[0].profile.scope, "project");
  assert.equal(candidates[0].profile.path, "/repo/.codex/agents/reviewer.toml");
  assert.equal(select(["v1"], candidates).provider.profile.scope, "project");
});

test("ambiguous or model-inheriting effective profiles are ineligible", async () => {
  const roleEntry = { chain: [provider("reviewer", "v2")] };
  for (const agentProfiles of [
    [
      { name: "reviewer", model: "one", status: "resolved", scope: "project", path: "/repo/a.toml" },
      { name: "reviewer", model: "two", status: "resolved", scope: "project", path: "/repo/b.toml" },
    ],
    [{ name: "reviewer", model: null, status: "unresolved", scope: "project", path: "/repo/reviewer.toml" }],
  ]) {
    const [candidate] = await deriveCodexAuditCandidates(roleEntry, { agents: ["reviewer"], agentProfiles }, {
      profileForAgent: () => ({ model: "manifest-v2" }),
      versionForModel: async () => "v2",
    });
    assert.equal(candidate.available, false);
    assert.equal(candidate.apiVersion, null);
    assert.match(candidate.profile.status, /shadowed|unresolved/);
    assert.equal(select(["v2"], [candidate]).mode, "inline");
  }
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
  await writeFile(join(codexHome, "config.toml"), `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
  await writeFile(join(dir, ".codex", "config.toml"), "[agents.muster-reviewer]\nconfig_file = 'agents/muster-reviewer.toml'\n");
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
    models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v2" }],
  }));
  await writeFile(join(agents, "muster-reviewer.toml"), "name = 'muster-reviewer'\nmodel = 'gpt-5.6-sol'\n");
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

test("codex-audit-provider CLI refuses a project profile whose effective model uses an uncallable API", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-audit-shadow-"));
  const home = join(dir, "home");
  const codexHome = join(home, ".codex");
  const projectAgents = join(dir, ".codex", "agents");
  const userAgents = join(codexHome, "agents");
  const bin = join(dir, "bin");
  await mkdir(projectAgents, { recursive: true });
  await mkdir(userAgents, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), [
    `[projects.${JSON.stringify(dir)}]`,
    'trust_level = "trusted"',
    '[agents.muster-reviewer]',
    "config_file = 'agents/muster-reviewer.toml'",
    "",
  ].join("\n"));
  await writeFile(join(dir, ".codex", "config.toml"), "[agents.muster-reviewer]\nconfig_file = 'agents/muster-reviewer.toml'\n");
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({ models: [
    { slug: "gpt-5.6-sol", multi_agent_version: "v2" },
    { slug: "gpt-5.6-luna", multi_agent_version: "v1" },
  ] }));
  await writeFile(join(userAgents, "muster-reviewer.toml"), "name = 'muster-reviewer'\nmodel = 'gpt-5.6-sol'\n");
  await writeFile(join(projectAgents, "muster-reviewer.toml"), "name = 'muster-reviewer'\nmodel = 'gpt-5.6-luna'\n");
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
  assert.equal(result.mode, "inline");
  const reviewer = result.degradation.considered.find(candidate => candidate.id === "muster-reviewer");
  assert.equal(reviewer.apiVersion, "v1");
  assert.equal(reviewer.profile.scope, "project");
  assert.equal(reviewer.profile.model, "gpt-5.6-luna");

  await writeFile(join(codexHome, "config.toml"), [
    `[projects.${JSON.stringify(dir)}]`,
    'trust_level = "untrusted"',
    '[agents.muster-reviewer]',
    "config_file = 'agents/muster-reviewer.toml'",
    "",
  ].join("\n"));
  const untrusted = JSON.parse((await execFile(process.execPath, [
    new URL("../src/cli.js", import.meta.url).pathname,
    "codex-audit-provider", "--role", "code-review", "--task-id", "audit-readability",
    "--callable-apis", "v2", "--message", "Review readability",
  ], {
    cwd: dir,
    env: { ...process.env, HOME: home, CODEX_HOME: codexHome, PATH: `${bin}:${process.env.PATH || ""}` },
  })).stdout);
  assert.equal(untrusted.mode, "independent");
  assert.equal(untrusted.provider.profile.scope, "user");
  assert.equal(untrusted.provider.profile.model, "gpt-5.6-sol");
});

test("a valid complex profile with name different from filename remains an unresolved shadow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-codex-audit-complex-shadow-"));
  const home = join(dir, "home");
  const codexHome = join(home, ".codex");
  const agents = join(dir, ".codex", "agents");
  const bin = join(dir, "bin");
  await mkdir(codexHome, { recursive: true });
  await mkdir(agents, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(join(codexHome, "config.toml"), `[projects.${JSON.stringify(dir)}]\ntrust_level = "trusted"\n`);
  await writeFile(join(dir, ".codex", "config.toml"), "[agents.muster-reviewer]\nconfig_file = 'agents/different-filename.toml'\n");
  await writeFile(join(codexHome, "models_cache.json"), JSON.stringify({
    models: [{ slug: "gpt-5.6-sol", multi_agent_version: "v2" }],
  }));
  await writeFile(join(agents, "different-filename.toml"), [
    "name = 'muster-reviewer'",
    "model = 'gpt-5.6-sol'",
    "skills.config = ['review']",
    "",
  ].join("\n"));
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
  assert.equal(result.mode, "inline");
  const reviewer = result.degradation.considered.find(candidate => candidate.id === "muster-reviewer");
  assert.equal(reviewer.available, false);
  assert.equal(reviewer.profile.status, "unresolved");
  assert.equal(reviewer.profile.scope, "project");
  assert.match(reviewer.profile.path, /different-filename\.toml$/);
});
