import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  CODEX_SECURITY_UPSTREAM,
  buildSecurityInvocation,
  normalizeSecurityReceipt,
  securityAuditWarranted,
} from "../src/security.js";

const officialResult = (findings = []) => ({
  findings: {
    documentType: "codex-security.findings",
    schemaVersion: "1.0",
    scanId: "scan_test_001",
    findings,
  },
  coverage: {
    documentType: "codex-security.coverage",
    schemaVersion: "1.0",
    scanId: "scan_test_001",
    completeness: "complete",
  },
  reportPath: "/private/results/report.md",
});

test("Codex Security integration is pinned to the current immutable official release", () => {
  assert.deepEqual(CODEX_SECURITY_UPSTREAM, {
    package: "@openai/codex-security",
    version: "0.1.5",
    tag: "npm-v0.1.5",
    commit: "66778d0d85f478d7832854b81d0a6ddb93a3ce4c",
    integrity: "sha512-P6RZCrtZjQ23TG55VVYdrz5+/o5SGt4A3xDy18C/1ZqhfbRQYFzZIVP+HzfR2j0HaJv0l1KsKzuKtR8UOeK/UQ==",
    license: "Apache-2.0",
  });
});

test("security routing is conditional on security-sensitive scope or diff risk", () => {
  assert.equal(securityAuditWarranted({ outcome: "rename a heading", diffFiles: ["docs/readme.md"] }).warranted, false);
  assert.equal(securityAuditWarranted({ outcome: "add OAuth token rotation", diffFiles: ["src/auth.js"] }).warranted, true);
  assert.equal(securityAuditWarranted({ outcome: "refactor helper", diffFiles: ["src/auth/session.ts"] }).warranted, true);
  assert.equal(securityAuditWarranted({ outcome: "update deps", diffFiles: ["package-lock.json"] }).warranted, true);
});

test("review and audit map to useful upstream scan targets with policy and JSON output", () => {
  assert.deepEqual(buildSecurityInvocation("review", "/repo", { base: "origin/main", failOnSeverity: "high" }).args,
    ["scan", "/repo", "--diff", "origin/main", "--json", "--fail-on-severity", "high"]);
  assert.deepEqual(buildSecurityInvocation("review", "/repo", {}).args,
    ["scan", "/repo", "--working-tree", "--json"]);
  assert.deepEqual(buildSecurityInvocation("audit", "/repo", { paths: ["src", "api"] }).args,
    ["scan", "/repo", "--path", "src", "--path", "api", "--json"]);
});

test("finding receipts require severity and concrete evidence", () => {
  const receipt = normalizeSecurityReceipt(officialResult([{ severity: "high", title: "SQL injection", location: "src/db.js:9", evidence: "user input reaches query()" }]));
  assert.equal(receipt.findings[0].severity, "high");
  assert.equal(receipt.findings[0].evidence, "src/db.js:9 — user input reaches query()");
  assert.throws(() => normalizeSecurityReceipt(officialResult([{ severity: "high", title: "vague" }])), /evidence/i);
  assert.throws(() => normalizeSecurityReceipt(officialResult([{ title: "missing severity", evidence: "x" }])), /severity/i);
});

test("finding receipts normalize the official 0.1.5 findings document shape", () => {
  const receipt = normalizeSecurityReceipt({
    ...officialResult(),
    findings: {
      documentType: "codex-security.findings",
      schemaVersion: "1.0",
      scanId: "scan_example_001",
      findings: [{
        findingId: "csf_example",
        title: "Unsafe archive extraction",
        summary: "An attacker-controlled path reaches a filesystem write.",
        severity: { level: "high", score: 8.1 },
        locations: [{ path: "src/extract.py", startLine: 41, endLine: 44 }],
      }],
    },
    coverage: { documentType: "codex-security.coverage", schemaVersion: "1.0", scanId: "scan_example_001", completeness: "complete" },
  });
  assert.deepEqual(receipt.findings[0], {
    id: "csf_example",
    severity: "high",
    title: "Unsafe archive extraction",
    evidence: "src/extract.py:41 — An attacker-controlled path reaches a filesystem write.",
  });
  assert.equal(receipt.reportPath, "/private/results/report.md");
});

test("unknown, partial, or mismatched official envelopes fail closed", () => {
  assert.throws(() => normalizeSecurityReceipt({}), /findings document envelope/i);
  assert.throws(() => normalizeSecurityReceipt({ ...officialResult(), coverage: { ...officialResult().coverage, completeness: "partial" } }), /coverage/i);
  assert.throws(() => normalizeSecurityReceipt({ ...officialResult(), reportPath: "relative/report.md" }), /report path/i);
});

test("structured validation objects never become object-string evidence", () => {
  const receipt = normalizeSecurityReceipt(officialResult([{
    findingId: "csf_validation",
    title: "Validated issue",
    severity: { level: "medium" },
    locations: [{ path: "src/a.js", startLine: 7 }],
    validation: { status: "confirmed" },
    summary: "Concrete source-to-sink trace.",
  }]));
  assert.equal(receipt.findings[0].evidence, "src/a.js:7 — Concrete source-to-sink trace.");
  assert.doesNotMatch(receipt.findings[0].evidence, /\[object Object\]/);
});

test("security route stays dependency-free for irrelevant work", () => {
  const run = spawnSync(process.execPath, ["src/cli.js", "security", "route", "--outcome", "rename a heading"], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, MUSTER_CODEX_SECURITY_BIN: "/definitely/not/invoked" },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).warranted, false);
});

test("CLI classifies version drift as runtime exit 2 and preserves severity-policy exit 1", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-security-"));
  const fake = join(dir, "codex-security");
  await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 9.9.9; exit 0; fi\nexit 0\n`);
  await chmod(fake, 0o755);
  let run = spawnSync(process.execPath, ["src/cli.js", "security", "review", "."], { cwd: new URL("..", import.meta.url), env: { ...process.env, MUSTER_CODEX_SECURITY_BIN: fake }, encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /expected 0\.1\.5.*got 9\.9\.9/i);

  const policyFake = join(dir, "codex-security-policy");
  await writeFile(policyFake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.5; exit 0; fi\nprintf '%s' '${JSON.stringify(officialResult([{ severity: "high", title: "x", location: "a:1", evidence: "proof" }]))}'\nexit 1\n`);
  await chmod(policyFake, 0o755);
  run = spawnSync(process.execPath, ["src/cli.js", "security", "review", "."], { cwd: new URL("..", import.meta.url), env: { ...process.env, MUSTER_CODEX_SECURITY_BIN: policyFake }, encoding: "utf8" });
  assert.equal(run.status, 1);
  assert.match(run.stdout, /"classification": "finding-policy"/);
});

test("CLI rejects cross-workflow flags, excess positionals, and unknown info/route arguments", () => {
  const cases = [
    ["security", "review", ".", "--path", "src"],
    ["security", "audit", ".", "--base", "main"],
    ["security", "review", ".", "extra"],
    ["security", "info", "extra"],
    ["security", "route", "extra"],
    ["security", "route", "--outcome", "--diff-files"],
    ["security", "review", ".", "--auth", "--model"],
    ["security", "audit", ".", "--path", "--deep"],
  ];
  for (const args of cases) {
    const run = spawnSync(process.execPath, ["src/cli.js", ...args], { cwd: new URL("..", import.meta.url), encoding: "utf8" });
    assert.equal(run.status, 1, `${args.join(" ")} must be a usage failure`);
  }
});

test("generated Codex runtime resolves an exact PATH CLI and completes end to end", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-security-path-"));
  const fake = join(dir, process.platform === "win32" ? "codex-security.cmd" : "codex-security");
  await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.5; exit 0; fi\nprintf '%s' '${JSON.stringify(officialResult())}'\n`);
  await chmod(fake, 0o755);
  const runtime = fileURLToPath(new URL("../.agents/plugins/plugin/runtime/muster.mjs", import.meta.url));
  const run = spawnSync(process.execPath, [runtime, "security", "audit", "."], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, PATH: `${dir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH || ""}` },
    encoding: "utf8",
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout).classification, "complete");
});

test("CLI treats upstream incomplete coverage/runtime exit 2 as a dependency failure", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-security-"));
  const fake = join(dir, "codex-security");
  await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.5; exit 0; fi\necho 'coverage unavailable' >&2\nexit 2\n`);
  await chmod(fake, 0o755);
  const run = spawnSync(process.execPath, ["src/cli.js", "security", "audit", "."], { cwd: new URL("..", import.meta.url), env: { ...process.env, MUSTER_CODEX_SECURITY_BIN: fake }, encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /incomplete coverage or runtime failure/i);
});

test("missing binaries, invalid JSON, and unexpected exits are runtime exit 2", async () => {
  let run = spawnSync(process.execPath, ["src/cli.js", "security", "audit", "."], {
    cwd: new URL("..", import.meta.url),
    env: { ...process.env, MUSTER_CODEX_SECURITY_BIN: "/definitely/missing/codex-security" },
    encoding: "utf8",
  });
  assert.equal(run.status, 2);

  const dir = await mkdtemp(join(tmpdir(), "muster-security-errors-"));
  for (const [name, body, expected] of [
    ["invalid-json", "printf 'not-json'", /invalid JSON/i],
    ["unexpected-exit", "echo failed >&2; exit 3", /unexpected exit 3/i],
  ]) {
    const fake = join(dir, name);
    await writeFile(fake, `#!/bin/sh\nif [ "$1" = "--version" ]; then echo 0.1.5; exit 0; fi\n${body}\n`);
    await chmod(fake, 0o755);
    run = spawnSync(process.execPath, ["src/cli.js", "security", "audit", "."], {
      cwd: new URL("..", import.meta.url),
      env: { ...process.env, MUSTER_CODEX_SECURITY_BIN: fake },
      encoding: "utf8",
    });
    assert.equal(run.status, 2);
    assert.match(run.stderr, expected);
  }
});
