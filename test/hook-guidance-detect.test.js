// Direct unit tests for guidance.js detect() function.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import os from "node:os";
import { cleanDir } from "./test-support/hook-helpers.js";

// Import guidance.js detect directly.
const { detect } = await import(
  path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "plugin", "hooks", "guidance.js")
);

function tmpDir() {
  return mkdtempSync(path.join(os.tmpdir(), "muster-gd-test-"));
}

// ── pyproject.toml ────────────────────────────────────────────────────────────
test("detect: pyproject.toml without .git → Python project (no git)", () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, "pyproject.toml"), "[tool.poetry]\nname = 'x'\n");
    const result = detect(dir);
    assert.match(result, /Python project/i, "should detect Python project");
    assert.doesNotMatch(result, /git repo/i, "should not mention git when no .git");
  } finally {
    cleanDir(dir);
  }
});

test("detect: pyproject.toml with .git → Python project in git repo", () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, "pyproject.toml"), "[project]\nname = 'x'\n");
    writeFileSync(path.join(dir, ".git"), "gitdir: /nowhere"); // file form is OK for existsSync
    const result = detect(dir);
    assert.match(result, /Python project/i, "should detect Python project");
    assert.match(result, /git repo/i, "should mention git when .git present");
  } finally {
    cleanDir(dir);
  }
});

// ── go.mod ───────────────────────────────────────────────────────────────────
test("detect: go.mod without .git → Go project (no git)", () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, "go.mod"), "module example.com/x\ngo 1.21\n");
    const result = detect(dir);
    assert.match(result, /Go project/i, "should detect Go project");
    assert.doesNotMatch(result, /git repo/i, "should not mention git when no .git");
  } finally {
    cleanDir(dir);
  }
});

test("detect: go.mod with .git → Go project in git repo", () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, "go.mod"), "module example.com/x\ngo 1.21\n");
    mkdirSync(path.join(dir, ".git"));
    const result = detect(dir);
    assert.match(result, /Go project/i, "should detect Go project");
    assert.match(result, /git repo/i, "should mention git when .git present");
  } finally {
    cleanDir(dir);
  }
});

// ── Cargo.toml ───────────────────────────────────────────────────────────────
test("detect: Cargo.toml without .git → Rust project (no git)", () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
    const result = detect(dir);
    assert.match(result, /Rust project/i, "should detect Rust project");
    assert.doesNotMatch(result, /git repo/i, "should not mention git when no .git");
  } finally {
    cleanDir(dir);
  }
});

test("detect: Cargo.toml with .git → Rust project in git repo", () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, "Cargo.toml"), '[package]\nname = "x"\n');
    mkdirSync(path.join(dir, ".git"));
    const result = detect(dir);
    assert.match(result, /Rust project/i, "should detect Rust project");
    assert.match(result, /git repo/i, "should mention git when .git present");
  } finally {
    cleanDir(dir);
  }
});

// ── git-only (no recognized project type) ───────────────────────────────────
test("detect: .git only (no recognized project file) → git repo with no recognized project", () => {
  const dir = tmpDir();
  try {
    mkdirSync(path.join(dir, ".git"));
    const result = detect(dir);
    assert.match(result, /git repo/i, "should mention git repo");
    assert.match(result, /no recognized/i, "should say no recognized project type");
  } finally {
    cleanDir(dir);
  }
});

// ── empty dir ────────────────────────────────────────────────────────────────
test("detect: empty dir → no recognized project", () => {
  const dir = tmpDir();
  try {
    const result = detect(dir);
    assert.match(result, /No recognized project/i, "empty dir: no recognized project");
    assert.doesNotMatch(result, /git repo/i, "should not mention git for empty dir");
  } finally {
    cleanDir(dir);
  }
});

// ── package.json takes priority over pyproject.toml (ordering) ──────────────
test("detect: package.json + pyproject.toml → Node project (package.json wins)", () => {
  const dir = tmpDir();
  try {
    writeFileSync(path.join(dir, "package.json"), '{"name":"x"}');
    writeFileSync(path.join(dir, "pyproject.toml"), "[tool.poetry]\nname = 'x'\n");
    const result = detect(dir);
    assert.match(result, /Node project/i, "package.json should take priority");
    assert.doesNotMatch(result, /Python/i, "should not detect Python when package.json present");
  } finally {
    cleanDir(dir);
  }
});
