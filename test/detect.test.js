import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";
import { detectProject } from "../src/detect.js";

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
