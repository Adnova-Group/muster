import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpProject } from "./helpers.js";
import { detectProject } from "../src/detect.js";

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
