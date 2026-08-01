// Repo-wide prompt scanner: walks a directory tree for candidate prompt files,
// discovers structured prompts, and lints each one deterministically (no LLM).
// Extracted from cli.js so it is independently importable and unit-testable.
// Bounded (skip vendored/build dirs, text extensions only, per-file + total caps)
// so it stays fast and safe to run on any tree. Deterministic — the lint is no-LLM.
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname } from "node:path";
import { lintPrompt } from "./prompt-lint.js";
import { discoverPrompts } from "./prompt-discover.js";

export const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage",
  ".next", ".nuxt", ".worktrees", ".muster", ".claude", ".agents", "vendor", "__pycache__"]);
export const SCAN_TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb",
  ".go", ".java", ".md", ".txt", ".prompt", ".tmpl", ".json", ".yaml", ".yml"]);
export const SCAN_MAX_FILE = 256 * 1024;
export const SCAN_MAX_FILES = 5000;

async function collectScanEvidence(root, io = {}) {
  const readdirFn = io.readdir ?? readdir;
  const readFileFn = io.readFile ?? readFile;
  const statFn = io.stat ?? stat;
  const files = [];
  const incompleteEvidence = [];
  let fileLimitWitnessFound = false;
  async function walk(dir) {
    if (fileLimitWitnessFound) return;
    let ents;
    try { ents = await readdirFn(dir, { withFileTypes: true }); } catch {
      incompleteEvidence.push({ file: relative(root, dir) || ".", reason: "directory-read-failure" });
      return;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SCAN_SKIP_DIRS.has(e.name)) await walk(full);
        if (fileLimitWitnessFound) return;
        continue;
      }
      if (!e.isFile()) continue;
      const isPromptName = /\.(prompt|tmpl)$/i.test(e.name);
      if (!SCAN_TEXT_EXT.has(extname(e.name).toLowerCase()) && !isPromptName) continue;
      const path = relative(root, full);
      if (files.length >= SCAN_MAX_FILES) {
        incompleteEvidence.push({ file: path, reason: "file-limit" });
        fileLimitWitnessFound = true;
        return;
      }
      let fileStat;
      try { fileStat = await statFn(full); } catch {
        incompleteEvidence.push({ file: path, reason: "read-failure" });
        continue;
      }
      if (fileStat.size > SCAN_MAX_FILE) {
        incompleteEvidence.push({ file: path, reason: "size-limit" });
        continue;
      }
      let raw;
      try { raw = await readFileFn(full); } catch {
        incompleteEvidence.push({ file: path, reason: "read-failure" });
        continue;
      }
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      if (bytes.byteLength > SCAN_MAX_FILE) {
        incompleteEvidence.push({ file: path, reason: "size-limit" });
        continue;
      }
      files.push({ path, content: bytes.toString("utf8") });
    }
  }
  await walk(root);
  return { files, incompleteEvidence };
}

export async function collectScanFiles(root, io) {
  const { files } = await collectScanEvidence(root, io);
  return files;
}

export async function scanRepoPrompts(root, io) {
  const { files, incompleteEvidence } = await collectScanEvidence(root, io);
  const reviewed = discoverPrompts(files).map((p) => {
    // Discovered prompt docs and system/instruction code-prompts are the system genre;
    // dedicated prompt files (.prompt/.tmpl/templates) are task prompts.
    const genre = p.kind === "prompt-file" ? "task" : "system";
    // ctx.file lets path-scoped rules (CTX-EXAMPLE-001) distinguish muster-authored
    // instruction prompts from vendored pattern-library content.
    const { findings, total, passing, weakest } = lintPrompt(p.text, { genre, file: p.file });
    return {
      file: p.file, kind: p.kind, identifier: p.identifier, genre, passing, total,
      weakest: weakest?.criterion ?? null,
      findings: findings.map(f => ({ id: f.id, severity: f.severity, fix: f.fix })),
    };
  });
  const failing = reviewed.filter(r => !r.passing);
  const complete = incompleteEvidence.length === 0;
  return {
    scannedFiles: files.length,
    promptCount: reviewed.length,
    passing: reviewed.length - failing.length,
    failing: failing.length,
    complete,
    clean: complete && failing.length === 0,
    truncated: incompleteEvidence.some(({ reason }) => reason === "file-limit"),
    incompleteEvidence,
    prompts: reviewed,
  };
}
