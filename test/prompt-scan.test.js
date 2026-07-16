// test/prompt-scan.test.js — coverage for src/prompt-scan.js
//
// Wave B audit additions: prompt-scan.js had no test file.
// Covers: SCAN_SKIP_DIRS exclusion (C2), SCAN_MAX_FILES cap (C3),
//         per-file SCAN_MAX_FILE size cap (C5), readdir/readFile fault
//         tolerance on permission-denied subdirectory (C7).
//
// Pure test file — no production-code changes.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, rmSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  collectScanFiles,
  scanRepoPrompts,
  SCAN_SKIP_DIRS,
  SCAN_MAX_FILE,
  SCAN_MAX_FILES,
} from "../src/prompt-scan.js";

// ── C2: SCAN_SKIP_DIRS exclusion ─────────────────────────────────────────────
// node_modules, .git, and dist are in SCAN_SKIP_DIRS — files inside them must
// never appear in the results, even if they carry a text extension.
test("C2: collectScanFiles excludes files inside SCAN_SKIP_DIRS (node_modules, .git, dist)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muster-ps-c2-"));
  try {
    // Verify our constants are the ones we expect (guards against constant rename).
    assert.ok(SCAN_SKIP_DIRS.has("node_modules"), "SCAN_SKIP_DIRS must contain node_modules");
    assert.ok(SCAN_SKIP_DIRS.has(".git"),          "SCAN_SKIP_DIRS must contain .git");
    assert.ok(SCAN_SKIP_DIRS.has("dist"),          "SCAN_SKIP_DIRS must contain dist");

    // Create files that SHOULD be excluded.
    mkdirSync(path.join(dir, "node_modules"), { recursive: true });
    writeFileSync(path.join(dir, "node_modules", "skip-me.md"), "# should be excluded");
    mkdirSync(path.join(dir, ".git"), { recursive: true });
    writeFileSync(path.join(dir, ".git", "skip-me.md"), "# should be excluded");
    mkdirSync(path.join(dir, "dist"), { recursive: true });
    writeFileSync(path.join(dir, "dist", "skip-me.md"), "# should be excluded");

    // Create a file that SHOULD be included.
    writeFileSync(path.join(dir, "visible.md"), "# visible file");

    const files = await collectScanFiles(dir);
    const paths = files.map((f) => f.path);

    assert.ok(paths.includes("visible.md"), "visible.md must be included");
    assert.ok(
      !paths.some((p) => p.startsWith("node_modules")),
      "node_modules must be excluded",
    );
    assert.ok(
      !paths.some((p) => p.startsWith(".git")),
      ".git must be excluded",
    );
    assert.ok(
      !paths.some((p) => p.startsWith("dist")),
      "dist must be excluded",
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C3: SCAN_MAX_FILES cap + truncated flag ───────────────────────────────────
// Create SCAN_MAX_FILES + 1 eligible files. collectScanFiles must stop at cap,
// and scanRepoPrompts must report truncated:true + scannedFiles === cap.
test("C3: SCAN_MAX_FILES cap — collectScanFiles stops at cap; scanRepoPrompts sets truncated:true", { timeout: 120_000 }, async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muster-ps-c3-"));
  try {
    // Create SCAN_MAX_FILES + 1 small .md files in parallel batches to avoid
    // EMFILE and keep the test reasonably fast.
    const total = SCAN_MAX_FILES + 1;
    const batchSize = 200;
    for (let i = 0; i < total; i += batchSize) {
      const end = Math.min(i + batchSize, total);
      await Promise.all(
        Array.from({ length: end - i }, (_, j) =>
          writeFile(path.join(dir, `f${i + j}.md`), "# x"),
        ),
      );
    }

    const files = await collectScanFiles(dir);
    assert.equal(
      files.length,
      SCAN_MAX_FILES,
      `collectScanFiles must stop at ${SCAN_MAX_FILES}, got ${files.length}`,
    );

    const result = await scanRepoPrompts(dir);
    assert.equal(result.scannedFiles, SCAN_MAX_FILES, "scannedFiles must equal cap");
    assert.equal(result.truncated, true, "truncated must be true when files reach the cap");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C5: per-file SCAN_MAX_FILE size cap ──────────────────────────────────────
// A file whose content length exceeds SCAN_MAX_FILE must be silently skipped;
// a small sibling file in the same directory must still be included.
test("C5: collectScanFiles skips files larger than SCAN_MAX_FILE bytes", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muster-ps-c5-"));
  try {
    // Create an oversized file (one byte over the cap, all ASCII so byte == char length).
    const oversizeContent = Buffer.alloc(SCAN_MAX_FILE + 1, 0x61); // 'a' * (cap + 1)
    writeFileSync(path.join(dir, "big.md"), oversizeContent);

    // Create a small file that must be included.
    writeFileSync(path.join(dir, "small.md"), "# small file");

    const files = await collectScanFiles(dir);
    const paths = files.map((f) => f.path);

    assert.ok(!paths.includes("big.md"),   "file exceeding SCAN_MAX_FILE must be excluded");
    assert.ok(paths.includes("small.md"),  "small file must still be included");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C7: readdir fault tolerance (chmod 000 subdir) ───────────────────────────
// On Linux, a chmod 000 directory is unreadable. collectScanFiles must not
// throw; readable siblings at the same level must still be returned.
// Note: this test is only meaningful when NOT running as root (root ignores
// DAC permissions). The assertion targets "doesn't throw + sibling returned",
// which holds either way.
test("C7: chmod 000 subdir — collectScanFiles does not throw; readable siblings are returned", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muster-ps-c7-"));
  const restrictedDir = path.join(dir, "restricted");
  try {
    // Create a readable sibling file.
    writeFileSync(path.join(dir, "readable.md"), "# readable sibling");

    // Create a subdir, put a file in it, then lock it.
    mkdirSync(restrictedDir);
    writeFileSync(path.join(restrictedDir, "secret.md"), "# hidden");
    chmodSync(restrictedDir, 0o000);

    let files;
    await assert.doesNotReject(async () => {
      files = await collectScanFiles(dir);
    }, "collectScanFiles must not throw on a permission-denied subdir");

    const paths = files.map((f) => f.path);
    assert.ok(paths.includes("readable.md"), "readable sibling must be present in results");
  } finally {
    // Restore permissions before cleanup so rmSync can delete the directory.
    try { chmodSync(restrictedDir, 0o755); } catch { /* ignore if dir was never created */ }
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── C2b: SCAN_SKIP_DIRS excludes .claude (harness-created agent worktrees) ──
// Claude Code auto-creates agent worktrees under <root>/.claude/worktrees/agent-*/,
// each a full checkout of the repo (SKILL.md copies included). Without .claude in
// SCAN_SKIP_DIRS, a repo-wide prompt scan descends into every agent worktree and
// re-lints hundreds of duplicate prompt files, producing false failures whenever
// worktrees are present locally (see D1 test below).
test("C2b: collectScanFiles excludes files inside .claude (harness agent-worktree state)", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "muster-ps-c2b-"));
  try {
    assert.ok(SCAN_SKIP_DIRS.has(".claude"), "SCAN_SKIP_DIRS must contain .claude");

    // Simulate a harness-created agent worktree with a prompt-lint violation
    // (no persona, no output format -- guaranteed to fail lintPrompt).
    const worktreeDir = path.join(dir, ".claude", "worktrees", "agent-x");
    mkdirSync(worktreeDir, { recursive: true });
    writeFileSync(
      path.join(worktreeDir, "SKILL.md"),
      "---\nname: fixture-skill\n---\n\nDo the thing.\n",
    );

    // Create a file that SHOULD be included.
    writeFileSync(path.join(dir, "visible.md"), "# visible file");

    const files = await collectScanFiles(dir);
    const paths = files.map((f) => f.path);

    assert.ok(paths.includes("visible.md"), "visible.md must be included");
    assert.ok(
      !paths.some((p) => p.startsWith(".claude")),
      ".claude must be excluded, but found: " + paths.filter((p) => p.startsWith(".claude")),
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ── D1: repo-wide prompt-lint backlog is clean (backlog item prompt-lint-backlog) ──────
// Pins the deliverable itself: `node src/cli.js prompt scan .` must report zero failing
// files across the real repo. Before this item's fix, plugin/commands/run.md, autopilot.md,
// and sprint.md failed ANTH-ROLE-001 (no persona) and ANTH-FMT-001 (no output format) --
// they are intentional thin legacy-alias stubs (frontmatter + one heads-up guidance line
// + a Read-and-execute directive; 9 lines after this fix's added disable-comment line) with
// no persona/output-format prose BY DESIGN, and
// test/mode-evals.test.js's "alias-shape equivalence" test hard-pins each stub's body to
// EXACTLY those 2 paragraphs -- adding persona/format prose to satisfy the linter would
// fatten the stub and break that guard. The fix instead adds an inline
// `<!-- prompt-lint-disable ANTH-ROLE-001, ANTH-FMT-001: ... -->` directive appended (via a
// single newline, no blank line) onto the END of each stub's existing heads-up paragraph,
// not as a new third paragraph -- so both invariants (this test's 0-failing gate AND the
// alias-shape guard's exact-2-paragraph pin) hold simultaneously. Scans the real repo root
// (not a synthetic fixture) since the deliverable is specifically "the live tree scans
// clean", not "the scanner mechanism works on fixtures" (already covered by C2/C3/C5/C7
// above).
test("repo-wide prompt-lint backlog is clean: scanRepoPrompts(repoRoot) reports zero failing files", async () => {
  const repoRoot = fileURLToPath(new URL("../", import.meta.url));
  const result = await scanRepoPrompts(repoRoot);
  const failing = result.prompts.filter((p) => !p.passing);
  assert.deepEqual(
    failing.map((f) => f.file),
    [],
    `expected 0 failing files from a repo-wide prompt scan, got: ${JSON.stringify(
      failing.map((f) => ({ file: f.file, findings: f.findings })),
      null,
      2,
    )}`,
  );
});
