// Shared fixtures for the per-subsystem Codex test files (split out of the
// former test/codex.test.js monolith). Hoisted here instead of duplicated
// per file, mirroring the existing test-support/helpers.js convention.
import { execFile as execFileCb, spawn } from "node:child_process";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveCodexPlugin } from "../src/codex-release.js";

export const repoRoot = new URL("../", import.meta.url).pathname;
export const selectedPlugin = await resolveCodexPlugin(repoRoot);
export const selectedPluginRoot = selectedPlugin.pluginRoot;
export const execFile = promisify(execFileCb);

export const canonicalMusterMarketplace = {
  name: "muster",
  root: repoRoot,
  marketplaceSource: { sourceType: "local", source: repoRoot }
};
export const localMusterMarketplace = {
  name: "muster",
  root: repoRoot,
  marketplaceSource: { sourceType: "local", source: repoRoot }
};

export function runCodexHook(payload, cwd = repoRoot, hookPath = join(repoRoot, "codex", "hooks", "muster-hook.mjs"), env = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hookPath], { cwd, env: { ...process.env, ...env }, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "", stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", reject);
    child.on("exit", code => code === 0 ? resolve(stdout.trim() ? JSON.parse(stdout) : {}) : reject(new Error(stderr || `hook exited ${code}`)));
    child.stdin.end(JSON.stringify(payload));
  });
}
