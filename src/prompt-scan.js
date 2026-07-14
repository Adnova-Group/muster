// Repo-wide prompt scanner: walks a directory tree for candidate prompt files,
// discovers structured prompts, and lints each one deterministically (no LLM).
// Extracted from cli.js so it is independently importable and unit-testable.
// Bounded (skip vendored/build dirs, text extensions only, per-file + total caps)
// so it stays fast and safe to run on any tree. Deterministic — the lint is no-LLM.
import { readdir, readFile } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { lintPrompt } from "./prompt-lint.js";
import { discoverPrompts } from "./prompt-discover.js";

export const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage",
  ".next", ".nuxt", ".worktrees", ".muster", ".agents", "vendor", "__pycache__"]);
export const SCAN_TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb",
  ".go", ".java", ".md", ".txt", ".prompt", ".tmpl", ".json", ".yaml", ".yml"]);
export const SCAN_MAX_FILE = 256 * 1024;
export const SCAN_MAX_FILES = 5000;

export async function collectScanFiles(root) {
  const files = [];
  async function walk(dir) {
    if (files.length >= SCAN_MAX_FILES) return;
    let ents;
    try { ents = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (files.length >= SCAN_MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) { if (!SCAN_SKIP_DIRS.has(e.name)) await walk(full); continue; }
      if (!e.isFile()) continue;
      const isPromptName = /\.(prompt|tmpl)$/i.test(e.name);
      if (!SCAN_TEXT_EXT.has(extname(e.name).toLowerCase()) && !isPromptName) continue;
      let content;
      try { content = await readFile(full, "utf8"); } catch { continue; }
      if (content.length > SCAN_MAX_FILE) continue;
      files.push({ path: relative(root, full), content });
    }
  }
  await walk(root);
  return files;
}

export async function scanRepoPrompts(root) {
  const files = await collectScanFiles(root);
  const reviewed = discoverPrompts(files).map((p) => {
    // Discovered prompt docs and system/instruction code-prompts are the system genre;
    // dedicated prompt files (.prompt/.tmpl/templates) are task prompts.
    const genre = p.kind === "prompt-file" ? "task" : "system";
    const { findings, total, passing, weakest } = lintPrompt(p.text, { genre });
    return {
      file: p.file, kind: p.kind, identifier: p.identifier, genre, passing, total,
      weakest: weakest?.criterion ?? null,
      findings: findings.map(f => ({ id: f.id, severity: f.severity, fix: f.fix })),
    };
  });
  const failing = reviewed.filter(r => !r.passing);
  return {
    scannedFiles: files.length,
    promptCount: reviewed.length,
    passing: reviewed.length - failing.length,
    failing: failing.length,
    truncated: files.length >= SCAN_MAX_FILES,
    prompts: reviewed,
  };
}
