import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { tmpProject } from "../test-support/helpers.js";
import { detectProject, hasPromptingSignal } from "../src/detect.js";

const pexec = promisify(execFile);

test("empty dir is greenfield", async () => {
  const dir = await tmpProject({});
  const p = await detectProject(dir);
  assert.equal(p.greenfield, true);
  assert.equal(p.shape, "unknown");
});

test("detects node + framework + package manager from manifest/lockfile", async () => {
  const dir = await tmpProject({
    "package.json": { dependencies: { next: "14.0.0", react: "18.0.0" }, devDependencies: { vitest: "1.0.0" } },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'"
  });
  const p = await detectProject(dir);
  assert.equal(p.greenfield, false);
  assert.ok(p.languages.includes("javascript"));
  assert.ok(p.frameworks.includes("next"));
  assert.equal(p.packageManager, "pnpm");
  assert.equal(p.testRunner, "vitest");
  assert.ok(p.signals.includes("next"));
});

test("react-native marks mobile shape", async () => {
  const dir = await tmpProject({ "package.json": { dependencies: { "react-native": "0.74.0" } } });
  const p = await detectProject(dir);
  assert.equal(p.shape, "mobile");
});

test("frontend-only deps yield frontend shape", async () => {
  const dir = await tmpProject({ "package.json": { dependencies: { react: "18.0.0", vite: "5.0.0" } } });
  const p = await detectProject(dir);
  assert.equal(p.shape, "frontend");
});

test("an LLM SDK dependency adds the 'prompting' signal", async () => {
  const dir = await tmpProject({ "package.json": { dependencies: { "@anthropic-ai/sdk": "0.30.0" } } });
  const p = await detectProject(dir);
  assert.ok(p.signals.includes("prompting"), "expected 'prompting' signal from an AI SDK dep");
});

test("a plain project has no 'prompting' signal", async () => {
  const dir = await tmpProject({ "package.json": { dependencies: { express: "4.0.0" } } });
  const p = await detectProject(dir);
  assert.ok(!p.signals.includes("prompting"));
});

test("unknown values never throw, reported as unknown", async () => {
  const dir = await tmpProject({ "README.md": "# hi" });
  const p = await detectProject(dir);
  assert.equal(p.packageManager, "unknown");
  assert.equal(p.testRunner, "unknown");
});

test("malformed package.json degrades AND warns to stderr", async () => {
  const dir = await tmpProject({ "package.json": "{ not valid json," });
  const calls = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { calls.push(String(chunk)); return true; };
  let p;
  try {
    p = await detectProject(dir);
  } finally {
    process.stderr.write = orig;
  }
  // graceful degradation: still returns a result, treated as no-pkg
  assert.equal(p.greenfield, false);
  assert.deepEqual(p.languages, []);
  // fail loud: a warning was emitted mentioning the path
  const warned = calls.join("");
  assert.match(warned, /warning/);
  assert.match(warned, /package\.json/);
});

test("absent package.json emits no warning", async () => {
  const dir = await tmpProject({ "README.md": "# hi" });
  const calls = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { calls.push(String(chunk)); return true; };
  try {
    await detectProject(dir);
  } finally {
    process.stderr.write = orig;
  }
  assert.equal(calls.join(""), "");
});

test("populates vcs from a real git repo", async () => {
  const dir = await tmpProject({ "package.json": { name: "x" }, "a.txt": "hi" });
  await pexec("git", ["init", "-q"], { cwd: dir });
  await pexec("git", ["config", "user.email", "t@t.t"], { cwd: dir });
  await pexec("git", ["config", "user.name", "t"], { cwd: dir });
  const p = await detectProject(dir);
  assert.equal(p.vcs.isRepo, true);
  assert.equal(typeof p.vcs.branch, "string");      // some branch name
  assert.equal(p.vcs.dirty, true);                   // untracked files present
  assert.equal(p.vcs.hasRemote, false);              // no remote added
});

// --- security: hostile repo config must not execute (audit S3) ---

test("hostile .git/config core.fsmonitor is never executed during detect", async () => {
  const dir = await tmpProject({ "package.json": { name: "x" }, "a.txt": "hi" });
  await pexec("git", ["init", "-q"], { cwd: dir });
  const marker = join(dir, "pwned-marker");
  const script = join(dir, "fsmonitor-evil.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  await pexec("git", ["config", "core.fsmonitor", script], { cwd: dir });
  const p = await detectProject(dir);
  assert.equal(p.vcs.isRepo, true);
  assert.equal(existsSync(marker), false, "hostile core.fsmonitor command must not execute");
});

test("ambient GIT_CONFIG_COUNT env cannot inject config into detect's git calls", async () => {
  const dir = await tmpProject({ "package.json": { name: "x" }, "a.txt": "hi" });
  await pexec("git", ["init", "-q"], { cwd: dir });
  const marker = join(dir, "pwned-env-marker");
  const script = join(dir, "fsmonitor-env-evil.sh");
  await writeFile(script, `#!/bin/sh\ntouch "${marker}"\n`, { mode: 0o755 });
  const orig = {
    count: process.env.GIT_CONFIG_COUNT,
    key: process.env.GIT_CONFIG_KEY_0,
    value: process.env.GIT_CONFIG_VALUE_0,
  };
  process.env.GIT_CONFIG_COUNT = "1";
  process.env.GIT_CONFIG_KEY_0 = "core.fsmonitor";
  process.env.GIT_CONFIG_VALUE_0 = script;
  try {
    await detectProject(dir);
  } finally {
    for (const [k, name] of [["count", "GIT_CONFIG_COUNT"], ["key", "GIT_CONFIG_KEY_0"], ["value", "GIT_CONFIG_VALUE_0"]]) {
      if (orig[k] === undefined) delete process.env[name]; else process.env[name] = orig[k];
    }
  }
  assert.equal(existsSync(marker), false, "env-injected core.fsmonitor must not execute");
});

// --- hasPromptingSignal (item 8) ---

test("hasPromptingSignal: true when @anthropic-ai/sdk is in dependencies", async () => {
  const dir = await tmpProject({
    "package.json": { dependencies: { "@anthropic-ai/sdk": "0.30.0" } }
  });
  assert.equal(await hasPromptingSignal(dir), true);
});

test("hasPromptingSignal: true when AI SDK is in devDependencies", async () => {
  const dir = await tmpProject({
    "package.json": { devDependencies: { "openai": "4.0.0" } }
  });
  assert.equal(await hasPromptingSignal(dir), true);
});

test("hasPromptingSignal: false for a plain express project", async () => {
  const dir = await tmpProject({
    "package.json": { dependencies: { "express": "4.0.0" } }
  });
  assert.equal(await hasPromptingSignal(dir), false);
});

test("hasPromptingSignal: false and does not throw when package.json is absent", async () => {
  const dir = await tmpProject({});
  assert.equal(await hasPromptingSignal(dir), false);
});

// --- detectProject shapes (item 10) ---

test("detectProject: backend shape from express dep", async () => {
  const dir = await tmpProject({
    "package.json": { dependencies: { "express": "4.0.0" } }
  });
  const p = await detectProject(dir);
  assert.equal(p.shape, "backend");
});

test("detectProject: fullstack shape when both frontend and backend deps present", async () => {
  const dir = await tmpProject({
    "package.json": { dependencies: { "react": "18.0.0", "express": "4.0.0" } }
  });
  const p = await detectProject(dir);
  assert.equal(p.shape, "fullstack");
});

test("detectProject: library shape from package.json main/exports without FE or BE", async () => {
  const dir = await tmpProject({
    "package.json": { main: "index.js", dependencies: { "lodash": "4.0.0" } }
  });
  const p = await detectProject(dir);
  assert.equal(p.shape, "library");
});

test("detectProject: monorepo shape when pnpm-workspace.yaml present", async () => {
  const dir = await tmpProject({
    "package.json": { name: "root" },
    "pnpm-workspace.yaml": "packages:\n  - packages/*"
  });
  const p = await detectProject(dir);
  assert.equal(p.shape, "monorepo");
});

test("detectProject: monorepo shape when package.json has workspaces field", async () => {
  const dir = await tmpProject({
    "package.json": { workspaces: ["packages/*"] }
  });
  const p = await detectProject(dir);
  assert.equal(p.shape, "monorepo");
});
