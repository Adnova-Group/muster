// Codex runs an unmanaged hook only when its persisted state is enabled and
// trusted_hash exactly matches the hook's current normalized content hash.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { musterHookTrustGaps, runCodexInstall } from "../src/codex-install.js";
import { runCodexDoctor } from "../src/codex-doctor.js";
import { repoRoot } from "../test-support/codex-helpers.js";

const HOOKS_JSON = "/home/u/.codex/hooks.json";
const group = command => ({ hooks: [{ type: "command", command }] });
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
    currentHash: "sha256:d4199fac84734f3033669015bf980b297547865b91ed664687715118b3e7a960",
    configTomlText: state("pre_tool_use:0:0", {
      trustedHash: "sha256:d4199fac84734f3033669015bf980b297547865b91ed664687715118b3e7a960"
    }),
    expectedStatus: "trusted",
    expectedTrustedHash: "sha256:d4199fac84734f3033669015bf980b297547865b91ed664687715118b3e7a960",
    expectedStale: []
  },
  {
    name: "changed-hash",
    event: "PreToolUse",
    command: "echo changed",
    key: "pre_tool_use:0:0",
    currentHash: "sha256:e10af5663aa5fd8860e0cfe3d6bc7d581e41137b762edc0c8bac4ed4cfde447a",
    configTomlText: state("pre_tool_use:0:0", {
      trustedHash: "sha256:d4199fac84734f3033669015bf980b297547865b91ed664687715118b3e7a960"
    }),
    expectedStatus: "modified",
    expectedTrustedHash: "sha256:d4199fac84734f3033669015bf980b297547865b91ed664687715118b3e7a960",
    expectedStale: []
  },
  {
    name: "disabled",
    event: "SessionStart",
    command: "echo disabled",
    key: "session_start:0:0",
    currentHash: "sha256:983b18cf424022dec742ddd1a2d31abfa73b13c5b51ce5f67d6301a180048bd9",
    configTomlText: state("session_start:0:0", {
      trustedHash: "sha256:983b18cf424022dec742ddd1a2d31abfa73b13c5b51ce5f67d6301a180048bd9",
      enabled: false
    }),
    expectedStatus: "disabled",
    expectedTrustedHash: "sha256:983b18cf424022dec742ddd1a2d31abfa73b13c5b51ce5f67d6301a180048bd9",
    expectedStale: []
  },
  {
    name: "absent-state",
    event: "Stop",
    command: "echo absent",
    key: "stop:0:0",
    currentHash: "sha256:fa846b180c6757b88e131b3ff412b8ee70fd8542a33fa34d6732be952fbbc956",
    configTomlText: "",
    expectedStatus: "untrusted",
    expectedTrustedHash: null,
    expectedStale: []
  },
  {
    name: "stale-hash",
    event: "PostToolUse",
    command: "echo stale",
    key: "post_tool_use:0:0",
    currentHash: "sha256:02e3d436710ce3d6e69154c7747eec108a483f619cff6c149a0bc5336384f52d",
    configTomlText: state("post_tool_use:1:0", {
      trustedHash: "sha256:02e3d436710ce3d6e69154c7747eec108a483f619cff6c149a0bc5336384f52d"
    }),
    expectedStatus: "untrusted",
    expectedTrustedHash: null,
    expectedStale: ["post_tool_use:1:0"]
  }
];

test("musterHookTrustGaps returns exact per-hook trust results for all five Codex states", async t => {
  for (const fixture of fixtures) await t.test(fixture.name, () => {
    const hookGroup = group(fixture.command);
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

test("Codex install blocks on untrusted writes and clears only after exact external trust", async () => {
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
  assert.equal(trusted.ok, true);
  assert.equal(trusted.hookTrust.ok, true);
  assert.equal(trusted.hookTrust.blocking, false);
  assert.ok(trusted.hookTrust.results.every(result => result.status === "trusted"));
  const trustedDoctor = await runCodexDoctor({
    root: repoRoot, cwd, codexHome: join(home, ".codex"), execFile: absentCodex
  });
  const trustedDoctorTrust = trustedDoctor.checks.find(check => check.name === "codex-hook-trust");
  assert.equal(trustedDoctorTrust?.ok, true, trustedDoctorTrust?.detail);
  assert.match(trustedDoctorTrust?.detail || "", /exact current hash and enabled state/i);
});
