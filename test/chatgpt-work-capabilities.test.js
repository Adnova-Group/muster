import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import assert from "node:assert/strict";

import { resolveCapabilities } from "../src/capabilities.js";
import { readInstalledWork } from "../src/harness.js";

const pexecFile = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = join(root, "src", "cli.js");

const catalog = [
  {
    id: "serena",
    kind: "external",
    roles: ["code-navigation"],
    rank: 90,
    detect: { kind: "mcp_server", match: "serena" },
  },
  {
    id: "claude-agent",
    kind: "agent",
    roles: ["implement"],
    rank: 80,
    provenance: { license: "MIT", inspired_by: "fixture" },
  },
  {
    id: "claude-skill",
    kind: "builtin",
    roles: ["plan"],
    rank: 70,
    provenance: { license: "MIT", inspired_by: "fixture" },
  },
];

async function run(args) {
  return pexecFile(process.execPath, [cli, ...args], {
    cwd: root,
    env: { ...process.env },
  });
}

test("Work inventory is deterministic and never inherits host-installed providers", async () => {
  assert.deepEqual(await readInstalledWork(), {
    runtime: "work",
    plugins: [],
    skills: [],
    agents: [],
    mcpServers: [],
  });
});

test("Work capabilities expose only callable MCP or inline providers and no skills", () => {
  const capabilities = resolveCapabilities(catalog, {
    runtime: "work",
    plugins: ["claude-plugin"],
    skills: ["claude-skill"],
    agents: ["claude-agent"],
    mcpServers: ["serena"],
  });

  assert.deepEqual(capabilities.roles["code-navigation"].chosen, {
    id: "serena",
    source: "installed",
    kind: "mcp",
  });
  assert.deepEqual(capabilities.roles.implement.chosen, {
    id: "inline",
    source: "inline",
    kind: "inline",
  });
  assert.deepEqual(capabilities.roles.plan.chosen, {
    id: "inline",
    source: "inline",
    kind: "inline",
  });
  assert.deepEqual(capabilities.skills, []);
  assert.ok(
    Object.values(capabilities.roles).every(({ model }) =>
      ["scout", "core", "prime", "apex"].includes(model)),
    "Work keeps the generic conceptual model tiers",
  );
  assert.ok(
    Object.values(capabilities.roles).every((role) => !("claudeModel" in role)),
    "Work must not advertise Claude-specific model mappings",
  );
});

test("capabilities --work ignores Claude/Codex disk state and resolves safely inline", async () => {
  const { stdout } = await run(["capabilities", "--work"]);
  const capabilities = JSON.parse(stdout);

  assert.equal(capabilities.installedRaw.runtime, "work");
  assert.deepEqual(capabilities.skills, []);
  assert.ok(
    Object.values(capabilities.roles).every(({ chosen, chain }) =>
      [chosen, ...chain].every(({ kind }) => kind === "mcp" || kind === "inline")),
  );
});

test("match --work does not advertise unavailable builtins or external providers", async () => {
  const { stdout } = await run(["match", "--work", "debug a failing test"]);
  assert.deepEqual(JSON.parse(stdout), []);
});

test("manifest validate --work rejects unavailable skill and provider bindings", async () => {
  const manifest = join(root, "test", "fixtures", "manifest.valid.json");
  const source = JSON.parse(await readFile(manifest, "utf8"));
  source.crew[0] = {
    ...source.crew[0],
    provider: "muster-builder",
    source: "builtin",
    model: "core",
  };
  source.plan[0].skills = [{ id: "muster-humanizer", rationale: "fixture" }];

  const dir = await mkdtemp(join(tmpdir(), "muster-work-capabilities-"));
  const file = join(dir, "manifest.json");
  await writeFile(file, JSON.stringify(source));
  try {
    await assert.rejects(
      run(["manifest", "validate", file, "--work"]),
      (error) => {
        const result = JSON.parse(error.stdout);
        assert.equal(result.ok, false);
        assert.ok(result.errors.some((message) => message.includes("muster-builder")));
        assert.ok(result.errors.some((message) => message.includes("muster-humanizer")));
        return true;
      },
    );
  } finally {
    await rm(dir, { recursive: true });
  }
});

test("manifest validate --work accepts the expected all-inline crew without a bypass warning", async () => {
  const manifest = join(root, "test", "fixtures", "manifest.valid.json");
  const source = JSON.parse(await readFile(manifest, "utf8"));
  source.crew = source.crew.map((member) => ({
    ...member,
    provider: "inline",
    source: "inline",
  }));

  const dir = await mkdtemp(join(tmpdir(), "muster-work-capabilities-"));
  const file = join(dir, "manifest.json");
  await writeFile(file, JSON.stringify(source));
  try {
    const { stdout } = await run(["manifest", "validate", file, "--work"]);
    assert.deepEqual(JSON.parse(stdout), { ok: true, errors: [] });
  } finally {
    await rm(dir, { recursive: true });
  }
});
