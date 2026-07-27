import { createHash, randomBytes } from "node:crypto";
import { execFile } from "node:child_process";
import {
  constants, lstat, mkdir, mkdtemp, open, readdir, readlink, realpath,
  rename, rm, stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { promisify } from "node:util";

const pexecFile = promisify(execFile);
const PROFILE_FORMAT = "muster.project-profile";
const RECEIPT_FORMAT = "muster.init-receipt";
const FINGERPRINT_BASIS = "muster.repository-state.v1";
const HEX64 = /^[0-9a-f]{64}$/;
const GIT_HEAD = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const NATIVE_ARTIFACTS = new Set([
  "AGENTS.md", "CLAUDE.md", "GEMINI.md", ".github/copilot-instructions.md",
]);

export const INIT_PATHS = Object.freeze({
  directory: ".muster",
  profile: ".muster/project-profile.json",
  receipt: ".muster/init-receipt.json",
});

export const INIT_LIMITS = Object.freeze({
  learnFiles: 128,
  learnDepth: 4,
  learnFileBytes: 1_048_576,
  learnTotalBytes: 8_388_608,
  fingerprintDepth: 32,
  fingerprintEntries: 10_000,
  fingerprintFileBytes: 16_777_216,
  fingerprintTotalBytes: 134_217_728,
  symlinkBytes: 4_096,
  evidenceBytes: 65_536,
  nativeArtifacts: 8,
});

const utf8Sort = (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const envelope = (receipt, observedNativeEvidence = null) => ({ receipt, observedNativeEvidence });

function canonicalValue(value, seen = new Set()) {
  if (value === null || typeof value === "boolean" || typeof value === "string") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new TypeError("canonical init JSON accepts integers only");
    return value;
  }
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item, seen));
  if (typeof value !== "object" || Object.getPrototypeOf(value) !== Object.prototype) {
    throw new TypeError("canonical init JSON accepts plain JSON objects only");
  }
  if (seen.has(value)) throw new TypeError("canonical init JSON rejects cycles");
  seen.add(value);
  const result = {};
  for (const key of Object.keys(value).sort(utf8Sort)) {
    if (!key || typeof value[key] === "undefined") throw new TypeError("canonical init JSON rejects undefined");
    result[key] = canonicalValue(value[key], seen);
  }
  seen.delete(value);
  return result;
}

export function canonicalInitJson(value) {
  return JSON.stringify(canonicalValue(value));
}

function prettyInitJson(value) {
  return JSON.stringify(canonicalValue(value), null, 2) + "\n";
}

function parseStrictJson(bytes, label) {
  const text = Buffer.isBuffer(bytes) ? bytes.toString("utf8") : bytes;
  if (Buffer.isBuffer(bytes) && !Buffer.from(text, "utf8").equals(bytes)) {
    throw new Error(`${label} must be UTF-8 JSON`);
  }
  let index = 0;
  const ws = () => { while (/\s/.test(text[index] || "")) index++; };
  const string = () => {
    const start = index++;
    while (index < text.length) {
      if (text[index] === "\\") { index += 2; continue; }
      if (text[index++] === '"') {
        try { return JSON.parse(text.slice(start, index)); }
        catch { throw new Error(`${label} contains invalid JSON`); }
      }
    }
    throw new Error(`${label} contains invalid JSON`);
  };
  const value = () => {
    ws();
    if (text[index] === '"') return string();
    if (text[index] === "[") {
      const result = [];
      index++; ws();
      if (text[index] === "]") { index++; return result; }
      while (true) {
        result.push(value()); ws();
        if (text[index] === "]") { index++; return result; }
        if (text[index++] !== ",") throw new Error(`${label} contains invalid JSON`);
      }
    }
    if (text[index] === "{") {
      const result = {};
      const keys = new Set();
      index++; ws();
      if (text[index] === "}") { index++; return result; }
      while (true) {
        ws();
        if (text[index] !== '"') throw new Error(`${label} contains invalid JSON`);
        const key = string();
        if (keys.has(key)) throw new Error(`${label} contains duplicate keys`);
        keys.add(key); ws();
        if (text[index++] !== ":") throw new Error(`${label} contains invalid JSON`);
        result[key] = value(); ws();
        if (text[index] === "}") { index++; return result; }
        if (text[index++] !== ",") throw new Error(`${label} contains invalid JSON`);
      }
    }
    for (const [literal, parsed] of [["true", true], ["false", false], ["null", null]]) {
      if (text.startsWith(literal, index)) { index += literal.length; return parsed; }
    }
    const match = /^-?(?:0|[1-9]\d*)/.exec(text.slice(index));
    if (!match) throw new Error(`${label} contains invalid JSON`);
    index += match[0].length;
    const parsed = Number(match[0]);
    if (!Number.isSafeInteger(parsed)) throw new Error(`${label} accepts safe integers only`);
    return parsed;
  };
  const parsed = value();
  ws();
  if (index !== text.length) throw new Error(`${label} contains invalid JSON`);
  return parsed;
}

async function absent(path) {
  try { await lstat(path); return false; }
  catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return true;
    throw error;
  }
}

async function validateRoot(dir) {
  const root = await realpath(resolve(dir));
  const info = await stat(root);
  if (!info.isDirectory()) throw new Error("initialization root must resolve to a real directory");
  const stateDir = join(root, INIT_PATHS.directory);
  if (!(await absent(stateDir))) {
    const stateInfo = await lstat(stateDir);
    if (stateInfo.isSymbolicLink()) throw new Error(".muster must not be a symlink");
    if (!stateInfo.isDirectory()) throw new Error(".muster must be a directory");
  }
  return root;
}

function safeRelative(path) {
  if (typeof path !== "string" || Buffer.byteLength(path) < 1 || Buffer.byteLength(path) > 256 ||
      path.includes("\0") || path.includes("\\") || isAbsolute(path) || /^[A-Za-z]:/.test(path) ||
      path.startsWith("//")) throw new Error(`unsafe relative path: ${path}`);
  const parts = path.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) throw new Error(`unsafe relative path: ${path}`);
  return path;
}

async function ensureSafeAncestors(root, rel) {
  const parts = safeRelative(rel).split("/");
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    if (await absent(current)) continue;
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`unsafe ancestor for ${rel}`);
  }
}

async function readNoFollowRegular(path, maxBytes, label, expectedInfo = null, requireSingleLink = false) {
  let handle;
  try {
    handle = await open(
      path,
      constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0),
    );
    const info = await handle.stat();
    if (!info.isFile() || (requireSingleLink && info.nlink !== 1) || info.size > maxBytes) {
      throw new Error(`unsafe regular file: ${label}`);
    }
    if (expectedInfo && (info.ino !== expectedInfo.ino || info.dev !== expectedInfo.dev)) {
      throw new Error(`file changed while reading: ${label}`);
    }
    const bytes = await handle.readFile();
    const after = await handle.stat();
    if (after.ino !== info.ino || after.dev !== info.dev || after.size !== info.size ||
        after.nlink !== info.nlink || !after.isFile()) {
      throw new Error(`file changed while reading: ${label}`);
    }
    return { bytes, info };
  } finally {
    await handle?.close();
  }
}

async function readRegular(root, rel, maxBytes) {
  await ensureSafeAncestors(root, rel);
  const path = join(root, ...safeRelative(rel).split("/"));
  try {
    return await readNoFollowRegular(path, maxBytes, rel, null, true);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

async function atomicWrite(root, rel, bytes) {
  await ensureSafeAncestors(root, rel);
  const target = join(root, ...rel.split("/"));
  await mkdir(dirname(target), { recursive: true });
  const current = await readRegular(root, rel, Math.max(bytes.length, INIT_LIMITS.learnFileBytes));
  if (current && current.bytes.equals(bytes)) return false;
  if (current && (!current.info.isFile() || current.info.nlink !== 1)) throw new Error(`unsafe owned target: ${rel}`);
  const token = randomBytes(8).toString("hex");
  const temp = join(dirname(target), `.muster-init-tmp-${token}`);
  let handle;
  try {
    handle = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
    await handle.writeFile(bytes);
    await handle.sync();
    await handle.close();
    handle = null;
    const recheck = await readRegular(root, rel, Math.max(bytes.length, INIT_LIMITS.learnFileBytes));
    if (!!current !== !!recheck || (current && (current.info.ino !== recheck.info.ino || current.info.dev !== recheck.info.dev))) {
      throw new Error(`owned target changed while writing: ${rel}`);
    }
    await rename(temp, target);
    const parent = await open(dirname(target), constants.O_RDONLY);
    try { await parent.sync(); } finally { await parent.close(); }
    return true;
  } finally {
    await handle?.close();
    await rm(temp, { force: true });
  }
}

function gitEnvironment() {
  const env = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TMPDIR", "TMP", "TEMP"]) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  Object.assign(env, {
    LC_ALL: "C", LANG: "C", GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
    GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0", GIT_PAGER: "cat",
  });
  return env;
}

async function safeGit(cwd, suffix) {
  const sandbox = await mkdtemp(join(tmpdir(), "muster-git-"));
  const args = [
    "--no-optional-locks", "-c", `core.hooksPath=${sandbox}`, "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false", "-c", "diff.external=", "-c", "pager.branch=false",
    ...suffix,
  ];
  try {
    const { stdout } = await pexecFile("git", args, { cwd, env: gitEnvironment(), encoding: "utf8" });
    return stdout.trim();
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

async function rootVcs(root) {
  const gitPath = join(root, ".git");
  if (await absent(gitPath)) return { branch: null, head: null, kind: "none", layout: "none" };
  const info = await lstat(gitPath);
  if (!info.isDirectory() && !info.isFile()) throw new Error(".git must be a regular file or directory");
  let head = null;
  let branch = null;
  try {
    const value = await safeGit(root, ["rev-parse", "--verify", "HEAD^{commit}"]);
    if (GIT_HEAD.test(value)) head = value;
  } catch {}
  try { branch = await safeGit(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]) || null; } catch {}
  return { branch, head, kind: "git", layout: info.isDirectory() ? "directory" : "worktree-file" };
}

async function initGit(root) {
  const sandbox = await mkdtemp(join(tmpdir(), "muster-git-template-"));
  try { await safeGit(root, ["init", "--quiet", `--template=${sandbox}`]); }
  finally { await rm(sandbox, { recursive: true, force: true }); }
}

async function realGitMarker(dir) {
  const marker = join(dir, ".git");
  if (await absent(marker)) return false;
  const info = await lstat(marker);
  return info.isDirectory() || info.isFile();
}

async function repositoryFingerprint(root) {
  const rows = [];
  let entries = 0;
  let total = 0;
  async function walk(abs, prefix, depth) {
    if (depth > INIT_LIMITS.fingerprintDepth) throw new Error("repository fingerprint depth limit exceeded");
    const names = (await readdir(abs)).sort(utf8Sort);
    for (const name of names) {
      const rel = prefix ? `${prefix}/${name}` : name;
      if (!prefix && (name === ".git" || name === ".muster" || name.startsWith(".muster-init-tmp-"))) continue;
      if (++entries > INIT_LIMITS.fingerprintEntries) throw new Error("repository fingerprint entry limit exceeded");
      const path = join(abs, name);
      const info = await lstat(path);
      if (info.isDirectory()) {
        if (await realGitMarker(path)) {
          let head = null;
          try {
            const value = await safeGit(path, ["rev-parse", "--verify", "HEAD^{commit}"]);
            if (GIT_HEAD.test(value)) head = value;
          } catch {}
          rows.push({ path: rel, row: `V\0${rel}\0${head ?? "null"}\n` });
        } else {
          rows.push({ path: rel, row: `D\0${rel}\0\n` });
          await walk(path, rel, depth + 1);
        }
      } else if (info.isFile()) {
        const opened = await readNoFollowRegular(
          path, INIT_LIMITS.fingerprintFileBytes, rel, info,
        );
        total += opened.info.size;
        if (total > INIT_LIMITS.fingerprintTotalBytes) throw new Error("repository fingerprint total limit exceeded");
        rows.push({
          path: rel,
          row: `F\0${rel}\0${(opened.info.mode & 0o111) ? 1 : 0}\0${opened.info.size}\0${sha256(opened.bytes)}\n`,
        });
      } else if (info.isSymbolicLink()) {
        const target = await readlink(path, { encoding: "buffer" });
        if (target.length > INIT_LIMITS.symlinkBytes) throw new Error("repository symlink target limit exceeded");
        rows.push({ path: rel, row: `L\0${rel}\0${sha256(target)}\n` });
      } else {
        throw new Error(`unsupported repository entry type: ${rel}`);
      }
    }
  }
  await walk(root, "", 0);
  rows.sort((a, b) => utf8Sort(a.path, b.path));
  const hash = createHash("sha256").update(Buffer.from(`${FINGERPRINT_BASIS}\0`));
  for (const { row } of rows) hash.update(Buffer.from(row));
  return { algorithm: "sha256", basis: FINGERPRINT_BASIS, digest: hash.digest("hex") };
}

async function classify(root) {
  const names = await readdir(root);
  for (const name of names) {
    if (name === ".git") continue;
    if (name === ".muster") {
      if ((await readdir(join(root, name))).length === 0) continue;
    }
    return "brownfield";
  }
  return "greenfield";
}

const MANIFEST_NAMES = new Set([
  "package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb",
  "Cargo.toml", "Cargo.lock", "pyproject.toml", "requirements.txt", "go.mod", "Gemfile",
]);
const INSTRUCTION_NAMES = new Set(["AGENTS.md", "CLAUDE.md", "GEMINI.md", "copilot-instructions.md"]);
const SOURCE_NAMES = new Set(["src", "lib", "app", "apps", "packages"]);
const TEST_NAMES = new Set(["test", "tests", "__tests__", "spec"]);

async function learnFacts(root) {
  const rows = [];
  const sourceRoots = new Set();
  const testRoots = new Set();
  const extensions = new Set();
  let total = 0;
  let count = 0;
  async function walk(abs, prefix, depth) {
    if (depth > INIT_LIMITS.learnDepth) return;
    for (const name of (await readdir(abs)).sort(utf8Sort)) {
      if (!prefix && (name === ".git" || name === ".muster")) continue;
      const rel = prefix ? `${prefix}/${name}` : name;
      const path = join(abs, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) continue;
      if (info.isDirectory()) {
        if (SOURCE_NAMES.has(name)) sourceRoots.add(rel);
        if (TEST_NAMES.has(name)) testRoots.add(rel);
        if (await realGitMarker(path)) continue;
        await walk(path, rel, depth + 1);
      } else if (info.isFile()) {
        const dot = name.lastIndexOf(".");
        if (dot >= 0) extensions.add(name.slice(dot).toLowerCase());
        if (++count > INIT_LIMITS.learnFiles) throw new Error("project learning limit exceeded");
        if (!MANIFEST_NAMES.has(name) && !INSTRUCTION_NAMES.has(name)) continue;
        const opened = await readNoFollowRegular(path, INIT_LIMITS.learnFileBytes, rel, info);
        total += opened.info.size;
        if (total > INIT_LIMITS.learnTotalBytes) throw new Error("project learning limit exceeded");
        rows.push({
          bytes: opened.info.size,
          content: opened.bytes,
          instruction: INSTRUCTION_NAMES.has(name),
          path: rel,
          sha256: sha256(opened.bytes),
        });
      }
    }
  }
  await walk(root, "", 0);
  return { extensions, rows, sourceRoots, testRoots };
}

export async function learnProjectProfile(dir) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  const classification = owned?.receipt.classification ?? await classify(root);
  const { extensions, rows, sourceRoots, testRoots } = await learnFacts(root);
  const languages = new Set();
  const frameworks = new Set();
  const managers = new Set();
  const runners = new Set();
  let monorepo = false;
  let library = false;
  for (const [language, suffixes] of Object.entries({
    javascript: [".js", ".mjs", ".cjs", ".jsx"],
    typescript: [".ts", ".tsx"],
    python: [".py"],
    rust: [".rs"],
    go: [".go"],
    ruby: [".rb"],
  })) if (suffixes.some((suffix) => extensions.has(suffix))) languages.add(language);
  for (const row of rows) {
    const name = basename(row.path);
    if (name === "package.json") {
      languages.add("javascript");
      managers.add("npm");
      try {
        const pkg = JSON.parse(row.content.toString("utf8"));
        const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) };
        for (const framework of ["express", "fastify", "next", "react", "vue", "svelte", "nestjs"]) if (deps[framework]) frameworks.add(framework);
        const test = pkg.scripts?.test;
        for (const runner of ["node --test", "vitest", "jest", "mocha"]) if (typeof test === "string" && test.includes(runner)) runners.add(runner);
        monorepo ||= !!pkg.workspaces;
        library ||= !!(pkg.main || pkg.exports);
      } catch {}
    } else if (name === "package-lock.json") managers.add("npm");
    else if (name === "pnpm-lock.yaml") managers.add("pnpm");
    else if (name === "yarn.lock") managers.add("yarn");
    else if (name === "bun.lockb") managers.add("bun");
    else if (name === "Cargo.toml" || name === "Cargo.lock") { languages.add("rust"); managers.add("cargo"); }
    else if (name === "pyproject.toml" || name === "requirements.txt") { languages.add("python"); managers.add("pip"); }
    else if (name === "go.mod") { languages.add("go"); managers.add("go"); }
    else if (name === "Gemfile") { languages.add("ruby"); managers.add("bundler"); }
  }
  const factRows = (instruction) => rows.filter((row) => row.instruction === instruction)
    .map(({ bytes, path, sha256: digest }) => ({ bytes, path, sha256: digest })).sort((a, b) => utf8Sort(a.path, b.path));
  const shape = classification === "greenfield" ? "empty" : monorepo ? "monorepo" :
    sourceRoots.size || frameworks.size ? "application" : library ? "library" : "unknown";
  return {
    format: PROFILE_FORMAT,
    schemaVersion: 1,
    classification,
    facts: {
      frameworks: [...frameworks].sort(utf8Sort),
      instructionFiles: factRows(true),
      languages: [...languages].sort(utf8Sort),
      manifests: factRows(false),
      packageManagers: [...managers].sort(utf8Sort),
      shape,
      sourceRoots: [...sourceRoots].sort(utf8Sort),
      testRunners: [...runners].sort(utf8Sort),
      vcs: await rootVcs(root),
    },
    repositoryFingerprint: await repositoryFingerprint(root),
  };
}

function exactKeys(value, keys) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    JSON.stringify(Object.keys(value).sort(utf8Sort)) === JSON.stringify([...keys].sort(utf8Sort));
}

function validFileRows(rows) {
  return Array.isArray(rows) && rows.every((row) => exactKeys(row, ["bytes", "path", "sha256"]) &&
    Number.isInteger(row.bytes) && row.bytes >= 0 && row.bytes <= INIT_LIMITS.learnFileBytes &&
    HEX64.test(row.sha256) && (() => { try { safeRelative(row.path); return true; } catch { return false; } })()) &&
    new Set(rows.map((row) => row.path)).size === rows.length &&
    JSON.stringify(rows.map((row) => row.path)) === JSON.stringify(rows.map((row) => row.path).sort(utf8Sort));
}

function validSortedPaths(values) {
  return Array.isArray(values) && values.every((path) => {
    try { safeRelative(path); return true; } catch { return false; }
  }) && new Set(values).size === values.length &&
    JSON.stringify(values) === JSON.stringify([...values].sort(utf8Sort));
}

function rowsSortedByPath(rows) {
  return JSON.stringify(rows.map((row) => row.path)) ===
    JSON.stringify(rows.map((row) => row.path).sort(utf8Sort));
}

function validateProfile(profile) {
  if (!exactKeys(profile, ["format", "schemaVersion", "classification", "facts", "repositoryFingerprint"]) ||
      profile.format !== PROFILE_FORMAT || profile.schemaVersion !== 1 ||
      !["greenfield", "brownfield"].includes(profile.classification) ||
      !exactKeys(profile.facts, ["frameworks", "instructionFiles", "languages", "manifests", "packageManagers", "shape", "sourceRoots", "testRunners", "vcs"]) ||
      !["empty", "library", "application", "monorepo", "unknown"].includes(profile.facts.shape) ||
      !validFileRows(profile.facts.manifests) || !validFileRows(profile.facts.instructionFiles) ||
      !exactKeys(profile.facts.vcs, ["branch", "head", "kind", "layout"]) ||
      !["git", "none"].includes(profile.facts.vcs.kind) ||
      !["directory", "worktree-file", "none"].includes(profile.facts.vcs.layout) ||
      !(profile.facts.vcs.branch === null || typeof profile.facts.vcs.branch === "string") ||
      !(profile.facts.vcs.head === null || GIT_HEAD.test(profile.facts.vcs.head)) ||
      !exactKeys(profile.repositoryFingerprint, ["algorithm", "basis", "digest"]) ||
      profile.repositoryFingerprint.algorithm !== "sha256" || profile.repositoryFingerprint.basis !== FINGERPRINT_BASIS ||
      !HEX64.test(profile.repositoryFingerprint.digest)) throw new Error("invalid project profile");
  for (const key of ["frameworks", "languages", "packageManagers", "sourceRoots", "testRunners"]) {
    const values = profile.facts[key];
    if (!Array.isArray(values) || values.some((x) => typeof x !== "string" || !x) ||
        new Set(values).size !== values.length || JSON.stringify(values) !== JSON.stringify([...values].sort(utf8Sort))) {
      throw new Error("invalid project profile");
    }
  }
  return profile;
}

function validateReceipt(receipt) {
  if (!exactKeys(receipt, ["format", "schemaVersion", "classification", "phase", "profileDigest", "artifacts", "nativeInit", "finalStateFingerprint"]) ||
      receipt.format !== RECEIPT_FORMAT || receipt.schemaVersion !== 1 ||
      !["greenfield", "brownfield"].includes(receipt.classification) ||
      !["prepared", "finalized"].includes(receipt.phase) || !HEX64.test(receipt.profileDigest) ||
      !exactKeys(receipt.artifacts, ["created", "preserved", "skipped"]) ||
      !validSortedPaths(receipt.artifacts.created) || !validSortedPaths(receipt.artifacts.preserved) ||
      !Array.isArray(receipt.artifacts.skipped) ||
      receipt.artifacts.skipped.some((row) => !exactKeys(row, ["path", "reason"]) ||
        !["exists", "brownfield", "native-pending", "unsafe"].includes(row.reason) ||
        (() => { try { safeRelative(row.path); return false; } catch { return true; } })()) ||
      new Set(receipt.artifacts.skipped.map((row) => row.path)).size !== receipt.artifacts.skipped.length ||
      !rowsSortedByPath(receipt.artifacts.skipped) ||
      !exactKeys(receipt.nativeInit, ["state", "reason", "expectedArtifacts", "baseline", "attemptId", "handoffAcknowledged", "evidence"]) ||
      !["not-requested", "handoff", "attempted", "completed"].includes(receipt.nativeInit.state) ||
      !(receipt.nativeInit.reason === null || ["not-callable", "unavailable", "instruction-present"].includes(receipt.nativeInit.reason)) ||
      !validSortedPaths(receipt.nativeInit.expectedArtifacts) ||
      receipt.nativeInit.expectedArtifacts.some((path) => !NATIVE_ARTIFACTS.has(path)) ||
      !Array.isArray(receipt.nativeInit.baseline) ||
      receipt.nativeInit.baseline.length !== receipt.nativeInit.expectedArtifacts.length ||
      receipt.nativeInit.baseline.some((row, index) =>
        !exactKeys(row, ["bytes", "path", "sha256"]) || row.path !== receipt.nativeInit.expectedArtifacts[index] ||
        !((row.bytes === null && row.sha256 === null) ||
          (Number.isInteger(row.bytes) && row.bytes >= 0 && row.bytes <= INIT_LIMITS.learnFileBytes && HEX64.test(row.sha256)))) ||
      !(receipt.nativeInit.attemptId === null || HEX64.test(receipt.nativeInit.attemptId)) ||
      typeof receipt.nativeInit.handoffAcknowledged !== "boolean" ||
      !exactKeys(receipt.finalStateFingerprint, ["algorithm", "basis", "digest"]) ||
      receipt.finalStateFingerprint.algorithm !== "sha256" || receipt.finalStateFingerprint.basis !== FINGERPRINT_BASIS ||
      !HEX64.test(receipt.finalStateFingerprint.digest)) throw new Error("invalid init receipt");
  const evidence = receipt.nativeInit.evidence;
  if (evidence !== null) {
    if (!["artifact-delta", "preexisting-artifact-confirmed", "call-result"].includes(evidence.kind) ||
        !Array.isArray(evidence.artifacts) || evidence.artifacts.length === 0 ||
        new Set(evidence.artifacts.map((row) => row.path)).size !== evidence.artifacts.length ||
        !rowsSortedByPath(evidence.artifacts)) throw new Error("invalid init receipt");
    for (const row of evidence.artifacts) {
      safeRelative(row.path);
      if (evidence.kind === "artifact-delta") {
        if (!exactKeys(row, ["after", "before", "path"]) || !HEX64.test(row.after) ||
            !(row.before === null || HEX64.test(row.before))) throw new Error("invalid init receipt");
      } else if (!exactKeys(row, ["path", "sha256"]) || !HEX64.test(row.sha256)) throw new Error("invalid init receipt");
    }
    if (evidence.kind === "call-result") {
      if (!exactKeys(evidence, ["kind", "artifacts", "resultDigest"]) || !HEX64.test(evidence.resultDigest)) throw new Error("invalid init receipt");
    } else if (!exactKeys(evidence, ["kind", "artifacts"])) throw new Error("invalid init receipt");
  }
  const native = receipt.nativeInit;
  const computedAttemptId = sha256(canonicalInitJson({
    expectedArtifacts: native.expectedArtifacts,
    profileDigest: receipt.profileDigest,
  }));
  const baselineByPath = new Map(native.baseline.map((row) => [row.path, row]));
  const evidenceMatchesBaseline = evidence === null || evidence.artifacts.every((row) => {
    const baseline = baselineByPath.get(row.path);
    if (!baseline) return false;
    if (evidence.kind === "artifact-delta") return row.before === baseline.sha256;
    if (evidence.kind === "preexisting-artifact-confirmed") return baseline.sha256 !== null;
    return true;
  });
  const stateIsValid =
    (native.state === "not-requested" &&
      native.reason === null && native.expectedArtifacts.length === 0 &&
      native.baseline.length === 0 && native.attemptId === null &&
      native.handoffAcknowledged === false && evidence === null) ||
    (native.state === "handoff" &&
      native.reason !== null && native.attemptId === computedAttemptId &&
      evidence === null &&
      (!native.handoffAcknowledged || native.reason === "unavailable")) ||
    (native.state === "attempted" &&
      native.reason === null && native.attemptId === computedAttemptId &&
      native.handoffAcknowledged === false && evidence === null) ||
    (native.state === "completed" &&
      native.attemptId === computedAttemptId &&
      native.handoffAcknowledged === false && evidence !== null);
  const phaseIsValid = receipt.phase === "prepared" ||
    native.state === "completed" ||
    (native.state === "handoff" && native.reason === "unavailable" && native.handoffAcknowledged);
  if (!stateIsValid || !phaseIsValid || !evidenceMatchesBaseline) {
    throw new Error("invalid init receipt");
  }
  return receipt;
}

async function readOwned(root) {
  const profileFile = await readRegular(root, INIT_PATHS.profile, INIT_LIMITS.learnFileBytes);
  const receiptFile = await readRegular(root, INIT_PATHS.receipt, INIT_LIMITS.learnFileBytes);
  if (!!profileFile !== !!receiptFile) throw new Error("owned init files must both be absent or present");
  if (!profileFile) return null;
  let profile;
  let receipt;
  try {
    profile = validateProfile(parseStrictJson(profileFile.bytes, "project profile"));
    receipt = validateReceipt(parseStrictJson(receiptFile.bytes, "init receipt"));
  } catch (error) {
    throw new Error(error.message.includes("receipt") ? error.message : "invalid owned init state");
  }
  if (profile.classification !== receipt.classification ||
      sha256(canonicalInitJson(profile)) !== receipt.profileDigest) throw new Error("owned init state does not match");
  if (receipt.nativeInit.state === "completed") {
    const current = await artifactSnapshot(
      root, receipt.nativeInit.evidence.artifacts.map((row) => row.path),
    );
    for (let index = 0; index < current.length; index++) {
      const persisted = receipt.nativeInit.evidence.artifacts[index];
      const expectedHash = receipt.nativeInit.evidence.kind === "artifact-delta"
        ? persisted.after
        : persisted.sha256;
      if (current[index].sha256 !== expectedHash) {
        throw new Error(`completed evidence artifact changed or is missing: ${persisted.path}`);
      }
    }
  }
  return { profile, receipt };
}

export async function readInitReceipt(dir) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  return owned?.receipt ?? null;
}

async function writeReceipt(root, receipt) {
  validateReceipt(receipt);
  await atomicWrite(root, INIT_PATHS.receipt, Buffer.from(prettyInitJson(receipt)));
}

function initialReceipt(profile) {
  return {
    format: RECEIPT_FORMAT,
    schemaVersion: 1,
    classification: profile.classification,
    phase: "prepared",
    profileDigest: sha256(canonicalInitJson(profile)),
    artifacts: { created: [], preserved: [], skipped: [] },
    nativeInit: {
      state: "not-requested", reason: null, expectedArtifacts: [], baseline: [],
      attemptId: null, handoffAcknowledged: false, evidence: null,
    },
    finalStateFingerprint: profile.repositoryFingerprint,
  };
}

export async function initializeProject(dir) {
  const root = await validateRoot(dir);
  const existing = await readOwned(root);
  if (existing) return observeNativeInit(root);
  const classification = await classify(root);
  if (classification === "greenfield" && (await absent(join(root, ".git")))) await initGit(root);
  const profile = await learnProjectProfile(root);
  profile.classification = classification;
  await mkdir(join(root, ".muster"), { recursive: false }).catch((error) => {
    if (error.code !== "EEXIST") throw error;
  });
  const receipt = initialReceipt(profile);
  await atomicWrite(root, INIT_PATHS.profile, Buffer.from(prettyInitJson(profile)));
  await atomicWrite(root, INIT_PATHS.receipt, Buffer.from(prettyInitJson(receipt)));
  return envelope(receipt);
}

async function artifactSnapshot(root, paths) {
  const result = [];
  for (const path of paths) {
    const file = await readRegular(root, path, INIT_LIMITS.learnFileBytes);
    result.push(file
      ? { bytes: file.info.size, path, sha256: sha256(file.bytes) }
      : { bytes: null, path, sha256: null });
  }
  return result;
}

function expectedArtifacts(paths) {
  if (!Array.isArray(paths) || paths.length > INIT_LIMITS.nativeArtifacts) throw new Error("invalid expected artifacts");
  const result = [...new Set(paths.map(safeRelative))].sort(utf8Sort);
  if (result.length !== paths.length || result.some((path) => !NATIVE_ARTIFACTS.has(path))) throw new Error("invalid expected artifacts");
  return result;
}

export async function observeNativeInit(dir) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const { receipt } = owned;
  if (!["handoff", "attempted"].includes(receipt.nativeInit.state) || !receipt.nativeInit.baseline.length) return envelope(receipt);
  const current = await artifactSnapshot(root, receipt.nativeInit.expectedArtifacts);
  const artifacts = [];
  for (let i = 0; i < current.length; i++) {
    const before = receipt.nativeInit.baseline[i];
    const after = current[i];
    if (after.sha256 !== before.sha256 && after.sha256 !== null) {
      artifacts.push({ after: after.sha256, before: before.sha256, path: after.path });
    }
  }
  return envelope(receipt, artifacts.length ? { kind: "artifact-delta", artifacts } : null);
}

async function readEvidence(root, rel) {
  if (!rel) throw new Error("evidence file is required");
  const file = await readRegular(root, safeRelative(rel), INIT_LIMITS.evidenceBytes);
  if (!file) throw new Error("evidence file does not exist");
  return { value: parseStrictJson(file.bytes, "evidence file"), bytes: file.bytes };
}

async function completionEvidence(root, receipt, kind, evidenceFile) {
  const expected = receipt.nativeInit.expectedArtifacts;
  if (kind === "call-result") {
    if (receipt.nativeInit.state !== "attempted") {
      throw new Error("call-result evidence requires an attempted native init");
    }
    if (!evidenceFile) throw new Error("evidence file is required");
    if (expected.includes(safeRelative(evidenceFile))) {
      throw new Error("call-result evidence file must not be an expected artifact");
    }
  }
  if (kind === "artifact-delta") {
    const observed = await observeNativeInit(root);
    if (!observed.observedNativeEvidence) throw new Error("artifact delta evidence is not present");
    return observed.observedNativeEvidence;
  }
  const { value } = await readEvidence(root, evidenceFile);
  const current = await artifactSnapshot(root, expected);
  if (kind === "preexisting-confirmed") {
    if (!exactKeys(value, ["format", "schemaVersion", "confirmation", "artifacts"]) ||
        value.format !== "muster.native-init-confirmation" || value.schemaVersion !== 1 ||
        value.confirmation !== "already-initialized") throw new Error("invalid pre-existing confirmation");
    const artifacts = expectedArtifacts(value.artifacts);
    const rows = [];
    for (const path of artifacts) {
      const index = expected.indexOf(path);
      if (index < 0 || receipt.nativeInit.baseline[index].sha256 === null ||
          current[index].sha256 !== receipt.nativeInit.baseline[index].sha256) throw new Error("pre-existing artifact confirmation does not match baseline");
      rows.push({ path, sha256: current[index].sha256 });
    }
    if (!rows.length) throw new Error("confirmation requires artifacts");
    return { kind: "preexisting-artifact-confirmed", artifacts: rows };
  }
  if (kind === "call-result") {
    if (!exactKeys(value, ["format", "schemaVersion", "ok", "operation", "attemptId", "artifacts"]) ||
        value.format !== "muster.native-init-result" || value.schemaVersion !== 1 ||
        value.ok !== true || value.operation !== "native-init") throw new Error("invalid native init call result");
    if (value.attemptId !== receipt.nativeInit.attemptId) {
      throw new Error("native init call result attempt id does not match");
    }
    const artifacts = expectedArtifacts(value.artifacts);
    if (!artifacts.length) throw new Error("call result requires artifacts");
    const rows = artifacts.map((path) => {
      const index = expected.indexOf(path);
      if (index < 0 || current[index].sha256 === null) throw new Error("call result artifact is missing");
      return { path, sha256: current[index].sha256 };
    });
    return { kind: "call-result", artifacts: rows, resultDigest: sha256(canonicalInitJson(value)) };
  }
  throw new Error("invalid evidence kind");
}

export async function transitionNativeInit(dir, {
  to, reason = null, expectedArtifacts: requested = [], evidenceKind = null, evidenceFile = null,
}) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const receipt = owned.receipt;
  const from = receipt.nativeInit.state;
  if (to === from) return envelope(receipt);
  if (from === "completed") throw new Error("completed native init state is absorbing");
  if (from === "not-requested" && ["handoff", "attempted"].includes(to)) {
    const expected = expectedArtifacts(requested);
    if (to === "handoff" && !["not-callable", "unavailable", "instruction-present"].includes(reason)) {
      throw new Error("handoff requires a valid reason");
    }
    if (to === "attempted" && reason !== null) throw new Error("attempted transition does not accept a reason");
    const baseline = await artifactSnapshot(root, expected);
    const attemptId = sha256(canonicalInitJson({ expectedArtifacts: expected, profileDigest: receipt.profileDigest }));
    receipt.nativeInit = {
      state: to, reason, expectedArtifacts: expected, baseline, attemptId,
      handoffAcknowledged: false, evidence: null,
    };
  } else if (["handoff", "attempted"].includes(from) && to === "completed") {
    receipt.nativeInit.evidence = await completionEvidence(root, receipt, evidenceKind, evidenceFile);
    receipt.nativeInit.state = "completed";
    receipt.nativeInit.handoffAcknowledged = false;
  } else {
    throw new Error(`invalid native init transition: ${from} -> ${to}`);
  }
  await writeReceipt(root, receipt);
  return envelope(receipt);
}

export async function acknowledgeNativeInitHandoff(dir, { reason }) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const receipt = owned.receipt;
  if (receipt.nativeInit.state !== "handoff" || receipt.nativeInit.reason !== "unavailable" || reason !== "unavailable") {
    throw new Error("only an unavailable handoff can be acknowledged");
  }
  if (receipt.nativeInit.handoffAcknowledged) return envelope(receipt);
  receipt.nativeInit.handoffAcknowledged = true;
  await writeReceipt(root, receipt);
  return envelope(receipt);
}

const FINAL_SEEDS = {
  ".gitignore": "node_modules/\n.muster/\n*.log\n",
  "README.md": "# Project\n\nInitialized by muster.\n",
  "docs/design/.gitkeep": "",
  "docs/plan/.gitkeep": "",
};

export async function finalizeInitialization(dir) {
  const root = await validateRoot(dir);
  const owned = await readOwned(root);
  if (!owned) throw new Error("project is not initialized");
  const receipt = owned.receipt;
  if (receipt.phase === "finalized") return envelope(receipt);
  if (receipt.nativeInit.state !== "completed" &&
      !(receipt.nativeInit.state === "handoff" && receipt.nativeInit.reason === "unavailable" &&
        receipt.nativeInit.handoffAcknowledged)) throw new Error("native initialization is pending");
  const created = [];
  const preserved = [];
  const skipped = [];
  for (const [path, content] of Object.entries(FINAL_SEEDS).sort(([a], [b]) => utf8Sort(a, b))) {
    if (receipt.classification === "brownfield") {
      skipped.push({ path, reason: "brownfield" });
    } else if (await absent(join(root, ...path.split("/")))) {
      await atomicWrite(root, path, Buffer.from(content));
      created.push(path);
    } else {
      const existing = await readRegular(root, path, INIT_LIMITS.learnFileBytes);
      if (!existing) throw new Error(`unsafe finalization target: ${path}`);
      preserved.push(path);
      skipped.push({ path, reason: "exists" });
    }
  }
  receipt.phase = "finalized";
  receipt.artifacts = { created: created.sort(utf8Sort), preserved: preserved.sort(utf8Sort), skipped: skipped.sort((a, b) => utf8Sort(a.path, b.path)) };
  receipt.finalStateFingerprint = await repositoryFingerprint(root);
  await writeReceipt(root, receipt);
  return envelope(receipt);
}
