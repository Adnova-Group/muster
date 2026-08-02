import { execFile as execFileCb } from "node:child_process";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative } from "node:path";
import { promisify } from "node:util";

const execFileDefault = promisify(execFileCb);
const MAX_PACKAGE_BYTES = 64 * 1024;
const CODEX_TARGETS = {
  "linux:x64": ["@openai/codex-linux-x64", "x86_64-unknown-linux-musl", "codex"],
  "linux:arm64": ["@openai/codex-linux-arm64", "aarch64-unknown-linux-musl", "codex"],
  "darwin:x64": ["@openai/codex-darwin-x64", "x86_64-apple-darwin", "codex"],
  "darwin:arm64": ["@openai/codex-darwin-arm64", "aarch64-apple-darwin", "codex"],
  "win32:x64": ["@openai/codex-win32-x64", "x86_64-pc-windows-msvc", "codex.exe"],
  "win32:arm64": ["@openai/codex-win32-arm64", "aarch64-pc-windows-msvc", "codex.exe"]
};

function canonicalRegularFile(path, label) {
  if (typeof path !== "string" || !path || !isAbsolute(path)) throw new Error(`${label} must be an absolute path`);
  const canonical = realpathSync(path);
  if (!statSync(canonical).isFile()) throw new Error(`${label} is not a regular file: ${path}`);
  return canonical;
}

function containedFile(root, path, label) {
  const canonicalRoot = realpathSync(root);
  const canonical = canonicalRegularFile(path, label);
  const rel = relative(canonicalRoot, canonical);
  if (!rel || rel.startsWith("..") || isAbsolute(rel)) throw new Error(`${label} escapes the trusted Codex package root`);
  return { canonicalRoot, canonical };
}

// Codex injects CODEX_MANAGED_PACKAGE_ROOT for the package generation that
// started this session. Resolve only that root and process.execPath; never
// execute PATH candidates while discovering either identity.
export function resolveCodexRuntimeIdentity({
  env = process.env,
  nodeExecPath = process.execPath,
  codexPackageRoot = env.CODEX_MANAGED_PACKAGE_ROOT,
  platform = process.platform,
  arch = process.arch,
} = {}) {
  const node = canonicalRegularFile(nodeExecPath, "Node executable");
  if (typeof codexPackageRoot !== "string" || !codexPackageRoot || !isAbsolute(codexPackageRoot)) {
    throw new Error("trusted Codex package identity is unavailable (CODEX_MANAGED_PACKAGE_ROOT is not an absolute path)");
  }
  const packagePath = join(codexPackageRoot, "package.json");
  const entryPath = join(codexPackageRoot, "bin", "codex.js");
  const { canonicalRoot, canonical: packageJson } = containedFile(codexPackageRoot, packagePath, "Codex package manifest");
  const codex = containedFile(canonicalRoot, entryPath, "Codex executable").canonical;
  const packageStat = statSync(packageJson);
  if (packageStat.size > MAX_PACKAGE_BYTES) throw new Error("Codex package manifest exceeds the 64 KiB identity limit");
  const manifest = JSON.parse(readFileSync(packageJson, "utf8"));
  if (manifest?.name !== "@openai/codex" || typeof manifest.version !== "string" || !manifest.version) {
    throw new Error("trusted Codex package manifest has an unexpected name or version");
  }
  const target = CODEX_TARGETS[`${platform}:${arch}`];
  if (!target) throw new Error(`unsupported Codex native target: ${platform}-${arch}`);
  const [platformPackage, triple, executable] = target;
  let nativeCandidate = join(canonicalRoot, "vendor", triple, "bin", executable);
  try { nativeCandidate = containedFile(canonicalRoot, nativeCandidate, "Codex native executable").canonical; }
  catch (error) {
    if (error.code !== "ENOENT") throw error;
    const requireFromCodex = createRequire(packageJson);
    const platformManifest = canonicalRegularFile(requireFromCodex.resolve(`${platformPackage}/package.json`), "Codex platform package manifest");
    const platformRoot = realpathSync(dirname(platformManifest));
    const platformPackageJson = JSON.parse(readFileSync(platformManifest, "utf8"));
    if (platformPackageJson?.name !== "@openai/codex" || !String(platformPackageJson.version || "").startsWith(`${manifest.version}-`)) {
      throw new Error("trusted Codex platform package has an unexpected name or version");
    }
    nativeCandidate = containedFile(platformRoot, join(platformRoot, "vendor", triple, "bin", executable), "Codex native executable").canonical;
  }
  return Object.freeze({ node, codex, nativeCodex: nativeCandidate, version: manifest.version, packageRoot: canonicalRoot });
}

export function runCodexCommand(execFile = execFileDefault, identity, args, options = {}) {
  if (!identity?.node || !identity?.codex) throw new Error("a trusted Codex runtime identity is required");
  return execFile(identity.node, [identity.codex, ...args], options);
}

export function codexMcpOverlay(nodeExecPath = process.execPath) {
  const node = canonicalRegularFile(nodeExecPath, "Node executable");
  return { mcpServers: { muster: { command: node, args: ["./runtime/muster-mcp.mjs"], cwd: "." } } };
}

export function codexVersionMatches(stdout, expected) {
  const found = String(stdout || "").match(/^(?:codex-cli|codex) v?([^\s\r\n]+)\r?\n?$/)?.[1] || null;
  return { found, ok: found === expected };
}
