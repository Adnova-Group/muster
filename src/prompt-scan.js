// Repo-wide prompt scanner: walks a directory tree for candidate prompt files,
// discovers structured prompts, and lints each one deterministically (no LLM).
// Extracted from cli.js so it is independently importable and unit-testable.
// Bounded (skip vendored/build dirs, text extensions only, per-file + total caps)
// so it stays fast and safe to run on any tree. Deterministic — the lint is no-LLM.
import { constants as fsConstants } from "node:fs";
import { lstat, readdir } from "node:fs/promises";
import { extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { readNoFollowRegular } from "./fs-safe.js";
import { lintPrompt } from "./prompt-lint.js";
import { discoverPrompts } from "./prompt-discover.js";

export const SCAN_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage",
  ".next", ".nuxt", ".worktrees", ".muster", ".claude", ".agents", "vendor", "__pycache__"]);
export const SCAN_TEXT_EXT = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx", ".py", ".rb",
  ".go", ".java", ".md", ".txt", ".prompt", ".tmpl", ".json", ".yaml", ".yml"]);
export const SCAN_MAX_FILE = 256 * 1024;
export const SCAN_MAX_FILES = 5000;
export const SCAN_MAX_INCOMPLETE_EVIDENCE = 100;

function sameIdentity(current, prior) {
  return current.ino === prior.ino && current.dev === prior.dev &&
    current.mode === prior.mode && current.nlink === prior.nlink &&
    current.size === prior.size && current.mtimeMs === prior.mtimeMs &&
    current.ctimeMs === prior.ctimeMs;
}

function sameDirectoryIdentity(current, prior) {
  return current.isDirectory() && prior.isDirectory() && sameIdentity(current, prior);
}

async function snapshotDirectoryChain(root, dir, lstatFn) {
  const rel = relative(root, dir);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error("scan directory escaped the root");
  }
  const paths = [root];
  let current = root;
  for (const part of rel ? rel.split(sep) : []) {
    current = join(current, part);
    paths.push(current);
  }
  const infos = await Promise.all(paths.map((path) => lstatFn(path)));
  if (infos.some((info) => info.isSymbolicLink() || !info.isDirectory())) {
    throw new Error("scan directory contains a symlink or non-directory ancestor");
  }
  return { paths, infos };
}

async function validateDirectoryChain(snapshot, lstatFn) {
  const current = await Promise.all(snapshot.paths.map((path) => lstatFn(path)));
  if (current.some((info, index) => !sameDirectoryIdentity(info, snapshot.infos[index]))) {
    throw new Error("scan directory changed while reading");
  }
}

async function collectScanEvidence(root, io = {}) {
  const readdirFn = io.readdir ?? readdir;
  const lstatFn = io.lstat ?? lstat;
  // `stat` is retained as a test seam for the candidate's pre-open metadata;
  // the default is deliberately lstat so the name is never followed.
  const metadataFn = io.stat ?? lstatFn;
  const readNoFollowFn = io.readNoFollowRegular ?? readNoFollowRegular;
  const scanRoot = resolve(root);
  const files = [];
  const incompleteEvidence = [];
  let fileLimitWitnessFound = false;
  let incompleteEvidenceTruncated = false;
  const shouldStop = () => fileLimitWitnessFound || incompleteEvidenceTruncated;
  const recordIncomplete = (file, reason) => {
    incompleteEvidence.push({ file, reason });
    if (incompleteEvidence.length >= SCAN_MAX_INCOMPLETE_EVIDENCE) {
      incompleteEvidenceTruncated = true;
    }
  };
  async function walk(dir) {
    if (shouldStop()) return;
    let directorySnapshot;
    let ents;
    try {
      directorySnapshot = await snapshotDirectoryChain(scanRoot, dir, lstatFn);
      ents = await readdirFn(dir, { withFileTypes: true });
      await validateDirectoryChain(directorySnapshot, lstatFn);
    } catch {
      recordIncomplete(relative(scanRoot, dir) || ".", "directory-read-failure");
      return;
    }
    ents.sort((a, b) => a.name.localeCompare(b.name));
    for (const e of ents) {
      const full = join(dir, e.name);
      if (SCAN_SKIP_DIRS.has(e.name) && (e.isDirectory() || e.isSymbolicLink())) continue;
      const path = relative(scanRoot, full);
      if (e.isSymbolicLink()) {
        recordIncomplete(path, "symlink");
        if (shouldStop()) return;
        continue;
      }
      if (e.isDirectory()) {
        await walk(full);
        if (shouldStop()) return;
        continue;
      }
      const isPromptName = /\.(prompt|tmpl)$/i.test(e.name);
      if (!SCAN_TEXT_EXT.has(extname(e.name).toLowerCase()) && !isPromptName) continue;
      if (!e.isFile()) {
        recordIncomplete(path, "read-failure");
        if (shouldStop()) return;
        continue;
      }
      if (files.length >= SCAN_MAX_FILES) {
        recordIncomplete(path, "file-limit");
        fileLimitWitnessFound = true;
        return;
      }
      let fileStat;
      try {
        // Bind every candidate to the directory identities that produced its
        // Dirent. Establishing a fresh baseline here would bless a directory
        // replacement that landed after enumeration.
        await validateDirectoryChain(directorySnapshot, lstatFn);
        fileStat = await metadataFn(full);
      } catch {
        recordIncomplete(path, "read-failure");
        if (shouldStop()) return;
        continue;
      }
      if (fileStat.size > SCAN_MAX_FILE) {
        recordIncomplete(path, "size-limit");
        if (shouldStop()) return;
        continue;
      }
      let raw;
      try {
        if (!fsConstants.O_NOFOLLOW || !fsConstants.O_NONBLOCK) {
          throw new Error("safe prompt reads require O_NOFOLLOW and O_NONBLOCK");
        }
        const opened = await readNoFollowFn(full, {
          maxBytes: SCAN_MAX_FILE,
          label: path,
          expectedInfo: fileStat,
        });
        raw = opened.bytes;
        const namedAfter = await lstatFn(full);
        if (namedAfter.isSymbolicLink() || !namedAfter.isFile() ||
            !sameIdentity(namedAfter, opened.info)) {
          throw new Error(`file changed while reading: ${path}`);
        }
        await validateDirectoryChain(directorySnapshot, lstatFn);
      } catch (error) {
        recordIncomplete(path, error.fsSafe?.reason === "too-large" ? "size-limit" : "read-failure");
        if (shouldStop()) return;
        continue;
      }
      const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(String(raw));
      if (bytes.byteLength > SCAN_MAX_FILE) {
        recordIncomplete(path, "size-limit");
        if (shouldStop()) return;
        continue;
      }
      files.push({ path, content: bytes.toString("utf8") });
    }
  }
  await walk(scanRoot);
  return { files, incompleteEvidence, incompleteEvidenceTruncated };
}

export async function collectScanFiles(root, io) {
  const { files } = await collectScanEvidence(root, io);
  return files;
}

export async function scanRepoPrompts(root, io) {
  const { files, incompleteEvidence, incompleteEvidenceTruncated } = await collectScanEvidence(root, io);
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
    incompleteEvidenceTruncated,
    prompts: reviewed,
  };
}
