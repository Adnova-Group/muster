// Codex runs an unmanaged hook only when its persisted state is enabled and
// trusted_hash exactly matches the hook's current normalized content hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { effectiveHookTrust, hasManagedRuntimeInventoryAlias, hookActivationSnapshot, musterHookTrustGaps, runCodexInstall } from "../src/codex-install.js";
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

const currentCodexInventoryHook = ({ key, currentHash, overrides = {} }) => ({
  key,
  eventName: "stop",
  handlerType: "command",
  matcher: null,
  command: "'/usr/bin/node' '/repo/.codex/muster/hooks/muster-hook.mjs'",
  timeoutSec: 600,
  statusMessage: null,
  additionalContextLimit: null,
  sourcePath: key.slice(0, key.lastIndexOf(":stop:")),
  source: "project",
  pluginId: null,
  displayOrder: 0,
  enabled: true,
  isManaged: false,
  currentHash,
  trustStatus: "trusted",
  ...overrides
});

test("effectiveHookTrust accepts Codex 0.146 full hook records without relaxing their schema", () => {
  const cwd = "/repo", hooksJsonPath = "/repo/.codex/hooks.json";
  const currentHash = `sha256:${"a".repeat(64)}`;
  const results = [{ key: "stop:0:0", currentHash, trustedHash: currentHash, enabled: true, status: "trusted" }];
  const hook = currentCodexInventoryHook({ key: `${hooksJsonPath}:stop:0:0`, currentHash });
  const inventory = { ok: true, data: [{ cwd, warnings: [], errors: [], hooks: [hook] }] };
  assert.equal(effectiveHookTrust(inventory, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, true);

  const inlineDuplicate = currentCodexInventoryHook({
    key: "/repo/.codex/config.toml:stop:0:0",
    currentHash,
    overrides: { sourcePath: "/repo/.codex/config.toml", command: hook.command, source: "project" }
  });
  assert.equal(effectiveHookTrust({ ...inventory, data: [{ ...inventory.data[0], hooks: [hook, inlineDuplicate] }] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  const delayedExpansionDuplicate = currentCodexInventoryHook({
    key: "/repo/.codex/config.toml:stop:0:0",
    currentHash,
    overrides: {
      sourcePath: "/repo/.codex/config.toml",
      command: "set DIR=C:\\runtime && set NAME=muster && set PART=-hook && set EXT=.mjs && cmd /V:ON /C node !DIR!\\!NAME!!PART!!EXT!",
      source: "project"
    }
  });
  assert.equal(effectiveHookTrust({ ...inventory, data: [{ ...inventory.data[0], hooks: [hook, delayedExpansionDuplicate] }] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  for (const command of ["node ~/runtime-alias.mjs", "node ./runtime-*.mjs", "node ./runtime-?.mjs", "node ./runtime-[a-z].mjs"]) {
    const expandedPathDuplicate = currentCodexInventoryHook({
      key: "/repo/.codex/config.toml:stop:0:0",
      currentHash,
      overrides: { sourcePath: "/repo/.codex/config.toml", command, source: "project" }
    });
    assert.equal(
      effectiveHookTrust({ ...inventory, data: [{ ...inventory.data[0], hooks: [hook, expandedPathDuplicate] }] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok,
      false,
      `unresolved shell path expansion must fail closed: ${command}`
    );
  }

  for (const malformed of [
    { ...hook, sourcePath: "/foreign/hooks.json" },
    { ...hook, displayOrder: -1 },
    { ...hook, timeoutSec: "600" },
    { ...hook, pluginId: 42 },
    { ...hook, extra: true }
  ]) {
    assert.equal(effectiveHookTrust({ ...inventory, data: [{ ...inventory.data[0], hooks: [malformed] }] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  }
});

test("install and doctor reject hooks/list proofs when activation files change during inventory", async t => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-inventory-snapshot-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), hooksJsonPath = join(cwd, ".codex", "hooks.json");
  await mkdir(cwd, { recursive: true });
  const first = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const configPath = join(cwd, ".codex", "config.toml");
  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n${first.hookTrust.results
    .map(result => state(result.key, { trustedHash: result.currentHash })).join("")}`);
  const active = () => inventoryFor(cwd, hooksJsonPath, first.hookTrust.results);

  const replacingInventory = async () => {
    const replacement = `${hooksJsonPath}.replacement`;
    await writeFile(replacement, await readFile(hooksJsonPath));
    await rename(replacement, hooksJsonPath);
    return active();
  };
  const installed = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, hookInventory: replacingInventory });
  assert.equal(installed.ok, false);
  assert.match(installed.hookTrust.effective.error, /activation state changed/);

  const changingInventory = async () => {
    await writeFile(configPath, `${await readFile(configPath, "utf8")}\n# concurrent edit\n`);
    return active();
  };
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absentCodex, hookInventory: changingInventory });
  assert.equal(report.checks.find(check => check.name === "codex-hook-trust")?.ok, false);
  assert.match(report.checks.find(check => check.name === "codex-hook-trust")?.detail || "", /activation state changed/);
});

test("install rejects a runtime changed during plugin registration after the transaction proof", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-registration-runtime-race-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), hooksJsonPath = join(cwd, ".codex", "hooks.json");
  await mkdir(cwd, { recursive: true });
  const first = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const configPath = join(cwd, ".codex", "config.toml");
  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n${first.hookTrust.results
    .map(result => state(result.key, { trustedHash: result.currentHash })).join("")}`);
  const runtimePath = join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs");
  const mutatingExecFile = async (_bin, args) => {
    if (args[0] === "--version") return { stdout: "codex-cli test" };
    if (args.slice(0, 3).join(" ") === "plugin marketplace list") return { stdout: JSON.stringify({ marketplaces: [] }) };
    if (args.slice(0, 3).join(" ") === "plugin marketplace add") return { stdout: "" };
    if (args.slice(0, 3).join(" ") === "plugin list --available") return { stdout: JSON.stringify({ installed: [], available: [] }) };
    if (args.slice(0, 2).join(" ") === "plugin add") {
      await writeFile(runtimePath, `${await readFile(runtimePath, "utf8")}\n// concurrent replacement\n`);
      return { stdout: "" };
    }
    throw new Error(`unexpected command: ${args.join(" ")}`);
  };
  const result = await runCodexInstall({
    cwd, home, repoRoot, execFile: mutatingExecFile,
    hookInventory: async () => inventoryFor(cwd, hooksJsonPath, first.hookTrust.results)
  });
  assert.equal(result.ok, false);
  assert.match(result.hookTrust.effective.error, /activation state changed/);
});

test("install and doctor reject another inventory source physically aliasing the managed runtime", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-codex-hook-inventory-hardlink-"));
  const cwd = join(tmp, "project"), home = join(tmp, "home"), hooksJsonPath = join(cwd, ".codex", "hooks.json");
  await mkdir(cwd, { recursive: true });
  const first = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex });
  const configPath = join(cwd, ".codex", "config.toml");
  await writeFile(configPath, `${await readFile(configPath, "utf8")}\n${first.hookTrust.results
    .map(result => state(result.key, { trustedHash: result.currentHash })).join("")}`);
  const aliasPath = join(tmp, "foreign-inventory-hook.mjs");
  const inventory = async () => {
    await unlink(aliasPath).catch(error => { if (error.code !== "ENOENT") throw error; });
    await link(join(cwd, ".codex", "muster", "hooks", "muster-hook.mjs"), aliasPath);
    const value = inventoryFor(cwd, hooksJsonPath, first.hookTrust.results);
    value.data[0].hooks.push(currentCodexInventoryHook({
      key: `${configPath}:stop:0:0`, currentHash: `sha256:${"b".repeat(64)}`,
      overrides: { sourcePath: configPath, command: `DIR=${dirname(aliasPath)} NAME=${aliasPath.slice(aliasPath.lastIndexOf("/") + 1, -4)} EXT=.mjs sh -c 'node "$DIR/$NAME$EXT"'`, source: "project" }
    }));
    return value;
  };

  const directInventory = await inventory();
  assert.equal(await hasManagedRuntimeInventoryAlias(directInventory, {
    cwd, hooksJsonPath, activationSnapshot: await hookActivationSnapshot({ home, cwd })
  }), true);

  const optionInventory = inventoryFor(cwd, hooksJsonPath, first.hookTrust.results);
  optionInventory.data[0].hooks.push(currentCodexInventoryHook({
    key: `${configPath}:stop:0:0`, currentHash: `sha256:${"c".repeat(64)}`,
    overrides: { sourcePath: configPath, command: `node --import=${aliasPath} -e ''`, source: "project" }
  }));
  assert.equal(await hasManagedRuntimeInventoryAlias(optionInventory, {
    cwd, hooksJsonPath, activationSnapshot: await hookActivationSnapshot({ home, cwd })
  }), true, "option-attached paths must participate in physical alias detection");

  const installed = await runCodexInstall({ cwd, home, repoRoot, execFile: absentCodex, hookInventory: inventory });
  assert.equal(installed.ok, false);
  assert.match(installed.hookTrust.effective.error, /another source invoking/);
  const report = await runCodexDoctor({ root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absentCodex, hookInventory: inventory });
  assert.equal(report.checks.find(check => check.name === "codex-hook-trust")?.ok, false);
  assert.match(report.checks.find(check => check.name === "codex-hook-trust")?.detail || "", /another source invoking/);
});

test("effectiveHookTrust rejects duplicate scope and managed hook inventory records", () => {
  const cwd = "/repo", hooksJsonPath = "/repo/.codex/hooks.json";
  const exactHash = `sha256:${"a".repeat(64)}`;
  const results = [{ key: "stop:0:0", currentHash: exactHash, trustedHash: exactHash, enabled: true, status: "trusted" }];
  const record = { cwd, warnings: [], errors: [], hooks: [{
    key: `${hooksJsonPath}:stop:0:0`, enabled: true, trustStatus: "trusted", currentHash: exactHash
  }] };
  assert.equal(effectiveHookTrust({ ok: true, data: [record, structuredClone(record)] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  const duplicateHook = structuredClone(record);
  duplicateHook.hooks.push(structuredClone(duplicateHook.hooks[0]));
  assert.equal(effectiveHookTrust({ ok: true, data: [duplicateHook] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  for (const mutate of [
    item => { item.errors = "fatal load error"; },
    item => { item.warnings = null; },
    item => { item.cwd = `${cwd}/\0/..`; },
    item => { item.cwd = `${cwd}/\t/..`; },
    item => { item.cwd = `${cwd}/\x01/..`; },
    item => { item.cwd = `${cwd}/\u007f/..`; },
    item => { item.cwd = `${cwd}/\u0085/..`; },
    item => { item.hooks[0].enabled = "true"; },
    item => { item.hooks[0].currentHash = null; },
    item => { item.hooks[0].trustStatus = "TRUSTED"; },
    item => { item.hooks[0].key += "\t"; }
  ]) {
    const malformed = structuredClone(record);
    mutate(malformed);
    assert.equal(effectiveHookTrust({ ok: true, data: [malformed] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  }
  const other = { ...structuredClone(record), cwd: "/other" };
  assert.equal(effectiveHookTrust({ ok: true, data: [record, other, structuredClone(other)] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  const duplicateForeign = structuredClone(record);
  const foreign = { key: "/foreign/hooks.json:stop:0:0", enabled: false, trustStatus: "untrusted", currentHash: exactHash };
  duplicateForeign.hooks.push(foreign, structuredClone(foreign));
  assert.equal(effectiveHookTrust({ ok: true, data: [duplicateForeign] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  const malformedForeign = structuredClone(record);
  malformedForeign.hooks.push({ ...foreign, currentHash: "not-a-sha256" });
  assert.equal(effectiveHookTrust({ ok: true, data: [malformedForeign] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  for (const control of ["\t", "\x01", "\u007f", "\u0085"]) {
    const controlledCwd = `/repo/${control}name`;
    const controlled = { ...structuredClone(record), cwd: controlledCwd };
    assert.equal(effectiveHookTrust({ ok: true, data: [controlled] }, controlledCwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  }
  for (const [requested, recordCwd] of [
    ["relative-hook-scope", resolve("relative-hook-scope")],
    [`${cwd}/child/..`, cwd],
    [`${cwd}/\x01/..`, cwd],
    [`${cwd}/\u0085/..`, cwd]
  ]) {
    const cleanRecord = { ...structuredClone(record), cwd: recordCwd };
    assert.equal(effectiveHookTrust({ ok: true, data: [cleanRecord] }, requested, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  }
  for (const alias of [`${cwd}/.codex/./hooks.json`, `${cwd}/.codex/sub/../hooks.json`]) {
    const aliased = structuredClone(record);
    aliased.hooks.push({ ...structuredClone(aliased.hooks[0]), key: `${alias}:stop:1:0` });
    assert.equal(effectiveHookTrust({ ok: true, data: [aliased] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  }
  for (const noncanonicalPosition of ["stop:00:0", "stop:0:00", `stop:${Number.MAX_SAFE_INTEGER + 1}:0`]) {
    const malformedPosition = structuredClone(record);
    malformedPosition.hooks[0].key = `${hooksJsonPath}:${noncanonicalPosition}`;
    assert.equal(effectiveHookTrust({ ok: true, data: [malformedPosition] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
    assert.equal(effectiveHookTrust({ ok: true, data: [record] }, cwd, hooksJsonPath, [{ ...results[0], key: noncanonicalPosition }], { knownKeys: [noncanonicalPosition] }).ok, false);
    assert.equal(effectiveHookTrust({ ok: true, data: [malformedPosition] }, cwd, hooksJsonPath, [{ ...results[0], key: noncanonicalPosition }], { knownKeys: [noncanonicalPosition] }).ok, false);
  }
  for (const malformedResult of [
    { key: results[0].key, currentHash: exactHash },
    { ...results[0], trustedHash: 1 },
    { ...results[0], enabled: "true" },
    { ...results[0], status: 1 },
    { ...results[0], surplus: true }
  ]) assert.equal(effectiveHookTrust({ ok: true, data: [record] }, cwd, hooksJsonPath, [malformedResult], { knownKeys: ["stop:0:0"] }).ok, false);
  const sparseResults = [results[0], ,];
  const sparseKnownKeys = ["stop:0:0", ,];
  const sparseData = [record, ,];
  const sparseHooks = structuredClone(record);
  sparseHooks.hooks = [sparseHooks.hooks[0], ,];
  assert.equal(effectiveHookTrust({ ok: true, data: [record] }, cwd, hooksJsonPath, sparseResults, { knownKeys: ["stop:0:0"] }).ok, false);
  assert.equal(effectiveHookTrust({ ok: true, data: [record] }, cwd, hooksJsonPath, results, { knownKeys: sparseKnownKeys }).ok, false);
  assert.equal(effectiveHookTrust({ ok: true, data: sparseData }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  assert.equal(effectiveHookTrust({ ok: true, data: [sparseHooks] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  assert.equal(effectiveHookTrust({ ok: true, data: [record], surplus: true }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  assert.equal(effectiveHookTrust({ ok: true, data: [{ ...record, surplus: true }] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
  assert.equal(effectiveHookTrust({ ok: true, data: [{ ...record, hooks: [{ ...record.hooks[0], surplus: true }] }] }, cwd, hooksJsonPath, results, { knownKeys: ["stop:0:0"] }).ok, false);
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
