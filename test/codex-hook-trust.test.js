// Codex runs an unmanaged hook only when its persisted state is enabled and
// trusted_hash exactly matches the hook's current normalized content hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { effectiveHookTrust, musterHookTrustGaps, runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const absentCodex = async () => { throw new Error("codex absent"); };
const HOOKS_JSON = "/home/u/.codex/hooks.json";
const group = (command, matcher) => ({ ...(matcher === undefined ? {} : { matcher }), hooks: [{ type: "command", command }] });
const state = (key, { trustedHash, enabled } = {}) => [
  `[hooks.state."${HOOKS_JSON}:${key}"]`,
  ...(trustedHash === undefined ? [] : [`trusted_hash = "${trustedHash}"`]),
  ...(enabled === undefined ? [] : [`enabled = ${enabled}`]),
  ""
].join("\n");

const fixtures = [
  {
    name: "trusted",
    event: "PreToolUse",
    command: "echo trusted",
    key: "pre_tool_use:0:0",
    currentHash: "sha256:620fb822b32c78c73a2c5817199b662d4e82c221d93dd1b85bf843cf8fec7785",
    configTomlText: state("pre_tool_use:0:0", {
      trustedHash: "sha256:620fb822b32c78c73a2c5817199b662d4e82c221d93dd1b85bf843cf8fec7785"
    }),
    expectedStatus: "trusted",
    expectedTrustedHash: "sha256:620fb822b32c78c73a2c5817199b662d4e82c221d93dd1b85bf843cf8fec7785",
    expectedStale: []
  },
  {
    name: "changed-hash",
    event: "PreToolUse",
    command: "echo changed",
    key: "pre_tool_use:0:0",
    currentHash: "sha256:a88d2495432877773f0f9dea0941d2e84b2eb8749b4cededf655d9894721b655",
    configTomlText: state("pre_tool_use:0:0", {
      trustedHash: "sha256:620fb822b32c78c73a2c5817199b662d4e82c221d93dd1b85bf843cf8fec7785"
    }),
    expectedStatus: "modified",
    expectedTrustedHash: "sha256:620fb822b32c78c73a2c5817199b662d4e82c221d93dd1b85bf843cf8fec7785",
    expectedStale: []
  },
  {
    name: "disabled",
    event: "SessionStart",
    command: "echo disabled",
    key: "session_start:0:0",
    currentHash: "sha256:b840eff221964b05297f06965435cdbe7509d7f8188b357c89367ae1e078eed8",
    configTomlText: state("session_start:0:0", {
      trustedHash: "sha256:b840eff221964b05297f06965435cdbe7509d7f8188b357c89367ae1e078eed8",
      enabled: false
    }),
    expectedStatus: "disabled",
    expectedTrustedHash: "sha256:b840eff221964b05297f06965435cdbe7509d7f8188b357c89367ae1e078eed8",
    expectedStale: []
  },
  {
    name: "absent-state",
    event: "Stop",
    command: "echo absent",
    matcher: "ignored-by-codex",
    key: "stop:0:0",
    currentHash: "sha256:98a3fa002153cd1969a6a6384e406079ce1dd302be5fc0ff0fc42500389b93ce",
    configTomlText: "",
    expectedStatus: "untrusted",
    expectedTrustedHash: null,
    expectedStale: []
  },
  {
    name: "stale-position",
    event: "PostToolUse",
    command: "echo stale",
    key: "post_tool_use:0:0",
    currentHash: "sha256:f53f5dfc35e8db38250e7106ae0e719d9d64bfc77da7f9b79332374c37713278",
    configTomlText: state("post_tool_use:0:0", {
      trustedHash: "sha256:f53f5dfc35e8db38250e7106ae0e719d9d64bfc77da7f9b79332374c37713278"
    }) + state("post_tool_use:1:0", {
      trustedHash: "sha256:f53f5dfc35e8db38250e7106ae0e719d9d64bfc77da7f9b79332374c37713278"
    }),
    expectedStatus: "trusted",
    expectedTrustedHash: "sha256:f53f5dfc35e8db38250e7106ae0e719d9d64bfc77da7f9b79332374c37713278",
    expectedStale: ["post_tool_use:1:0"]
  }
];

test("musterHookTrustGaps returns exact per-hook trust results for all five Codex states", async t => {
  for (const fixture of fixtures) await t.test(fixture.name, () => {
    const hookGroup = group(fixture.command, fixture.matcher);
    const result = musterHookTrustGaps({
      configTomlText: fixture.configTomlText,
      hooksJsonPath: HOOKS_JSON,
      config: { hooks: { [fixture.event]: [hookGroup] } },
      hookGroups: { [fixture.event]: [hookGroup] }
    });

    assert.deepEqual(result.results, [{
      key: fixture.key,
      currentHash: fixture.currentHash,
      trustedHash: fixture.expectedTrustedHash,
      enabled: fixture.expectedStatus !== "disabled",
      status: fixture.expectedStatus
    }]);
    assert.deepEqual(result.trusted, fixture.expectedStatus === "trusted" ? [fixture.key] : []);
    assert.deepEqual(result.untrusted, fixture.expectedStatus === "trusted" ? [] : [fixture.key]);
    assert.deepEqual(result.stale, fixture.expectedStale);
  });
});

test("musterHookTrustGaps matches Codex 0.145 matcher omission and rejects malformed or duplicate state", () => {
  const promptGroup = group("echo prompt", "ignored-by-codex");
  const prompt = musterHookTrustGaps({
    configTomlText: "", hooksJsonPath: HOOKS_JSON,
    config: { hooks: { UserPromptSubmit: [promptGroup] } }, hookGroups: { UserPromptSubmit: [promptGroup] }
  });
  assert.equal(prompt.results[0].currentHash, "sha256:dc1c713727e2f3066673ac61ad3ccfe653c4f0e9c9ae2cad0ce6233ba7f8b50d");

  const trustedGroup = group("echo trusted");
  const exactHash = fixtures[0].currentHash;
  for (const configTomlText of [
    `[hooks.state."${HOOKS_JSON}:pre_tool_use:0:0"]\ntrusted_hash = "${exactHash}"\nenabled = "false"\n`,
    state("pre_tool_use:0:0", { trustedHash: exactHash }) + state("pre_tool_use:0:0", { trustedHash: exactHash })
  ]) {
    const result = musterHookTrustGaps({ configTomlText, hooksJsonPath: HOOKS_JSON,
      config: { hooks: { PreToolUse: [trustedGroup] } }, hookGroups: { PreToolUse: [trustedGroup] } });
    assert.equal(result.results[0].status, "invalid");
    assert.deepEqual(result.untrusted, ["pre_tool_use:0:0"]);
  }
  for (const enabledKey of [`"enabled"`, `'enabled'`, `"en\\u0061bled"`]) {
    const quotedDisabled = musterHookTrustGaps({
      configTomlText: `[hooks.state."${HOOKS_JSON}:pre_tool_use:0:0"]\ntrusted_hash = "${exactHash}"\n${enabledKey} = false\n`,
      hooksJsonPath: HOOKS_JSON,
      config: { hooks: { PreToolUse: [trustedGroup] } },
      hookGroups: { PreToolUse: [trustedGroup] }
    });
    assert.equal(quotedDisabled.results[0].status, "disabled", enabledKey);
  }
});

test("musterHookTrustGaps does not label a current non-Muster hook state stale", () => {
  const musterGroup = group("echo trusted");
  const foreignGroup = group("echo foreign");
  const config = { hooks: { PreToolUse: [musterGroup, foreignGroup] } };
  const exactHash = fixtures[0].currentHash;
  const result = musterHookTrustGaps({
    configTomlText: state("pre_tool_use:0:0", { trustedHash: exactHash })
      + state("pre_tool_use:1:0", { trustedHash: "sha256:foreign-owned-state" }),
    hooksJsonPath: HOOKS_JSON,
    config,
    hookGroups: { PreToolUse: [musterGroup] }
  });
  assert.deepEqual(result.trusted, ["pre_tool_use:0:0"]);
  assert.deepEqual(result.stale, []);
});

test("musterHookTrustGaps never certifies header-shaped text inside TOML multiline strings", () => {
  const musterGroup = group("echo trusted");
  const exactHash = fixtures[0].currentHash;
  const fakeSection = `[hooks.state."${HOOKS_JSON}:pre_tool_use:0:0"]\ntrusted_hash = "${exactHash}"`;
  const documents = [
    `note = """\n${fakeSection} # """\n`,
    `note = '''\n${fakeSection} # '''\n`,
    `note = """\nescaped delimiter: \\"""\n${fakeSection}\n"""\n`
  ];
  for (const configTomlText of documents) {
    const result = musterHookTrustGaps({
      configTomlText,
      hooksJsonPath: HOOKS_JSON,
      config: { hooks: { PreToolUse: [musterGroup] } },
      hookGroups: { PreToolUse: [musterGroup] }
    });
    assert.equal(result.results[0].status, "untrusted");
  }
});

const inventoryFor = (cwd, hooksJsonPath, results) => ({ ok: true, data: [{ cwd, warnings: [], errors: [], hooks: results.map(result => ({
  key: `${hooksJsonPath}:${result.key}`, enabled: true, trustStatus: "trusted", currentHash: result.currentHash
})) }] });

test("effectiveHookTrust rejects duplicate scope and managed hook inventory records", () => {
  const cwd = "/repo", hooksJsonPath = "/repo/.codex/hooks.json";
  const results = [{ key: "stop:0:0", currentHash: "sha256:exact" }];
  const record = { cwd, warnings: [], errors: [], hooks: [{
    key: `${hooksJsonPath}:stop:0:0`, enabled: true, trustStatus: "trusted", currentHash: "sha256:exact"
  }] };
  assert.equal(effectiveHookTrust({ ok: true, data: [record, structuredClone(record)] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  const duplicateHook = structuredClone(record);
  duplicateHook.hooks.push(structuredClone(duplicateHook.hooks[0]));
  assert.equal(effectiveHookTrust({ ok: true, data: [duplicateHook] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  for (const mutate of [
    item => { item.errors = "fatal load error"; },
    item => { item.warnings = null; },
    item => { item.cwd = `${cwd}/\0/..`; },
    item => { item.hooks[0].enabled = "true"; },
    item => { item.hooks[0].currentHash = null; }
  ]) {
    const malformed = structuredClone(record);
    mutate(malformed);
    assert.equal(effectiveHookTrust({ ok: true, data: [malformed] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  }
});

test("Codex reinstall rejects an exact duplicate Muster group left outside manifest ownership", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-duplicate-owned-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const hooksPath = join(cwd, ".codex", "hooks.json");
  const config = JSON.parse(await readFile(hooksPath, "utf8"));
  config.hooks.SessionStart.push(structuredClone(config.hooks.SessionStart[0]));
  await writeFile(hooksPath, JSON.stringify(config, null, 2) + "\n");
  await assert.rejects(
    () => runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex }),
    /duplicate|unmanaged Muster hook|hook conflict/i
  );
});

test("ordinary project/user install and doctor reject unexpected active positions", async t => {
  for (const scope of ["project", "user"]) await t.test(scope, async () => {
    const tmp = await mkdtemp(join(tmpdir(), `muster-codex-hook-extra-effective-${scope}-`));
    const cwd = join(tmp, "project"), home = join(tmp, "home");
    const hooksJsonPath = scope === "user" ? join(home, ".codex", "hooks.json") : join(cwd, ".codex", "hooks.json");
    const first = await runCodexInstall({ scope, cwd, home, repoRoot, execFile: absentCodex });
    const configPath = join(home, ".codex", "config.toml");
    const trustText = first.hookTrust.results.map(result =>
      `[hooks.state."${hooksJsonPath}:${result.key}"]\ntrusted_hash = "${result.currentHash}"\nenabled = true\n`
    ).join("\n");
    await writeFile(configPath, `${await readFile(configPath, "utf8")}\n${trustText}`);
    const inventory = inventoryFor(cwd, hooksJsonPath, first.hookTrust.results);
    inventory.data[0].hooks.push({
      key: `${hooksJsonPath}:session_end:99:0`, enabled: true, trustStatus: "trusted", currentHash: `sha256:${"a".repeat(64)}`
    });
    const hookInventory = async () => structuredClone(inventory);
    const installed = await runCodexInstall({ scope, cwd, home, repoRoot, execFile: absentCodex, hookInventory });
    assert.equal(installed.ok, false, `${scope} install must reject the unexpected active position`);
    assert.match(installed.hookTrust.effective.error || "", /unexpected active hook position/i);
    const doctor = await runCodexDoctor({ root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absentCodex, hookInventory });
    const trust = doctor.checks.find(check => check.name === "codex-hook-trust");
    assert.equal(trust?.ok, false, `${scope} doctor must reject the unexpected active position`);
    assert.match(trust?.detail || "", /unexpected active hook position/i);
  });
});

test("Codex install blocks on untrusted writes and clears only after exact persisted and effective trust", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-install-hook-trust-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home");
  const absentCodex = async () => { throw new Error("not found"); };

  const first = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(first.ok, false);
  assert.equal(first.hookTrust.ok, false);
  assert.equal(first.hookTrust.blocking, true);
  assert.equal(first.hookTrust.results.length, 7);
  assert.ok(first.hookTrust.results.every(result => result.status === "untrusted"));
  assert.match(first.hookTrust.remediation, /open Codex.*\/hooks.*trust.*exact current.*definitions/i);
  assert.doesNotMatch(first.hookTrust.remediation, /bypass-hook-trust/i);
  const firstDoctor = await runCodexDoctor({
    root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absentCodex
  });
  const firstDoctorTrust = firstDoctor.checks.find(check => check.name === "codex-hook-trust");
  assert.equal(firstDoctorTrust?.ok, false);
  assert.match(firstDoctorTrust?.detail || "", /untrusted/);
  assert.match(firstDoctorTrust?.detail || "", /\/hooks/);
  assert.doesNotMatch(firstDoctorTrust?.detail || "", /bypass-hook-trust/i);

  const configPath = join(home, ".codex", "config.toml");
  const trustText = first.hookTrust.results.map(result =>
    `[hooks.state."${join(cwd, ".codex", "hooks.json")}:${result.key}"]\ntrusted_hash = "${result.currentHash}"\nenabled = true\n`
  ).join("\n");
  await mkdir(dirname(configPath), { recursive: true });
  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n${trustText}`);

  const trusted = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  assert.equal(trusted.ok, false, "persisted trust alone cannot prove effective activation");
  assert.equal(trusted.hookTrust.effective.verified, false);
  const suppressedInventory = async () => ({ ok: true, data: [{ cwd, warnings: [], errors: [], hooks: [] }] });
  const suppressed = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, hookInventory: suppressedInventory });
  assert.equal(suppressed.ok, false, "policy-suppressed hooks cannot be reported active");
  assert.equal(suppressed.hookTrust.effective.verified, true);
  assert.equal(suppressed.hookTrust.effective.ok, false);
  assert.equal(suppressed.hookTrust.effective.results.length, 7);
  const hookInventory = async () => inventoryFor(cwd, join(cwd, ".codex", "hooks.json"), first.hookTrust.results);
  const active = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, hookInventory });
  assert.equal(active.ok, true);
  assert.equal(active.hookTrust.ok, true);
  assert.equal(active.hookTrust.blocking, false);
  assert.equal(active.hookTrust.effective.ok, true);
  assert.ok(active.hookTrust.results.every(result => result.status === "trusted"));
  const trustedDoctor = await runCodexDoctor({
    root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absentCodex, hookInventory
  });
  const trustedDoctorTrust = trustedDoctor.checks.find(check => check.name === "codex-hook-trust");
  assert.equal(trustedDoctorTrust?.ok, true, trustedDoctorTrust?.detail);
  assert.match(trustedDoctorTrust?.detail || "", /exact current hash and enabled state/i);

  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n${state("pre_tool_use:9:0", { trustedHash: first.hookTrust.results[0].currentHash }).replaceAll(HOOKS_JSON, join(cwd, ".codex", "hooks.json"))}`);
  const stale = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, hookInventory });
  assert.equal(stale.ok, false);
  assert.deepEqual(stale.hookTrust.stale, ["pre_tool_use:9:0"]);

  const dry = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, dryRun: true });
  assert.equal(dry.ok, true, "the dry-run plan itself completed");
  assert.equal(dry.hookTrust.ok, false);
  assert.equal(dry.hookTrust.verified, false);
});

test("Codex install CLI exits 2 for absent, modified, and disabled hook trust", async t => {
  const cli = fileURLToPath(new URL("../src/cli.js", import.meta.url));
  for (const variant of ["absent", "modified", "disabled"]) await t.test(variant, async () => {
    const tmp = await mkdtemp(join(tmpdir(), `muster-codex-hook-cli-${variant}-`));
    const cwd = join(tmp, "project"), home = join(tmp, "home");
    const installed = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
    if (variant !== "absent") {
      const configPath = join(home, ".codex", "config.toml");
      const trustText = installed.hookTrust.results.map((result, index) =>
        `[hooks.state."${join(cwd, ".codex", "hooks.json")}:${result.key}"]\ntrusted_hash = "${variant === "modified" && index === 0 ? "sha256:deadbeef" : result.currentHash}"\n${variant === "disabled" && index === 0 ? "enabled = false\n" : ""}`
      ).join("\n");
      await writeFile(configPath, `${await readFile(configPath, "utf8")}\n${trustText}`);
    }
    const run = spawnSync(process.execPath, [cli, "install", "codex", "--scope", "project"], {
      cwd, encoding: "utf8", env: { ...process.env, HOME: home, CODEX_HOME: join(home, ".codex"), PATH: "" }
    });
    assert.equal(run.status, 2, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.ok, false);
    assert.ok(output.hookTrust.results.some(result => result.status === ({ absent: "untrusted", modified: "modified", disabled: "disabled" })[variant]));
  });
});
