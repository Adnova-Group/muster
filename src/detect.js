import { readdir, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists, readJson } from "./fs-util.js";

const pexec = promisify(execFile);

// Mirror of init.js's safeGit/gitEnvironment (audit S3): detect runs git inside an
// arbitrary caller-supplied repo, so it must neutralize hostile repo config
// (core.fsmonitor, core.hooksPath, ...) and scrub the environment. Keep in sync
// with src/init.js; the fs-safety consolidation work owns the shared helper.
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

async function git(cwd, suffix) {
  const sandbox = await mkdtemp(join(tmpdir(), "muster-git-"));
  const args = [
    "--no-optional-locks", "-c", `core.hooksPath=${sandbox}`, "-c", "core.fsmonitor=false",
    "-c", "core.untrackedCache=false", "-c", "diff.external=", "-c", "pager.branch=false",
    ...suffix,
  ];
  try {
    const { stdout } = await pexec("git", args, { cwd, env: gitEnvironment(), encoding: "utf8" });
    return stdout.trim();
  } catch {
    return null;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

const FRAMEWORKS = ["next", "react-native", "expo", "react", "vue", "svelte", "angular",
  "express", "fastify", "nestjs", "prisma", "vite"];
const FRONTEND = new Set(["react", "vue", "svelte", "angular", "vite", "next"]);
const BACKEND = new Set(["express", "fastify", "nestjs", "prisma"]);
// LLM/agent SDKs whose presence means the project builds prompts/agents at runtime —
// the gate for the audit's prompt-quality dimension. Matched as exact deps or by scope.
const AI_SDKS = new Set(["@anthropic-ai/sdk", "openai", "langchain", "@langchain/core",
  "llamaindex", "@google/generative-ai", "cohere-ai", "ai", "@modelcontextprotocol/sdk",
  "@anthropic-ai/claude-agent-sdk", "@langchain/langgraph"]);
const AI_SCOPES = ["@langchain/", "@ai-sdk/", "@llamaindex/"];
const hasAiSdk = (depNames) =>
  depNames.some(d => AI_SDKS.has(d) || AI_SCOPES.some(s => d.startsWith(s)));

// Lightweight prompting check for callers (e.g. `muster audit`) that need only the signal
// and must NOT pay detectProject's git spawns. Reads package.json deps and nothing else.
export async function hasPromptingSignal(cwd) {
  const pkg = await readJson(join(cwd, "package.json"));
  if (!pkg) return false;
  return hasAiSdk(Object.keys({ ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) }));
}

export async function detectProject(cwd) {
  const pkg = await readJson(join(cwd, "package.json"));
  const isRepo = await exists(join(cwd, ".git"));
  const entries = await readdir(cwd).catch(() => []);
  const greenfield = !pkg && !isRepo && entries.filter(e => e !== ".git").length === 0;

  const deps = pkg ? { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}) } : {};
  const depNames = Object.keys(deps);
  const languages = [];
  if (pkg) languages.push("javascript");
  if (await exists(join(cwd, "tsconfig.json")) || depNames.includes("typescript")) languages.push("typescript");

  const frameworks = FRAMEWORKS.filter(f => depNames.includes(f));

  let packageManager = "unknown";
  if (await exists(join(cwd, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (await exists(join(cwd, "yarn.lock"))) packageManager = "yarn";
  else if (await exists(join(cwd, "package-lock.json"))) packageManager = "npm";
  else if (pkg) packageManager = "npm";

  let testRunner = "unknown";
  for (const t of ["vitest", "jest", "mocha", "ava"]) if (depNames.includes(t)) { testRunner = t; break; }

  let shape = "unknown";
  const hasFE = depNames.some(d => FRONTEND.has(d));
  const hasBE = depNames.some(d => BACKEND.has(d));
  if (depNames.includes("react-native") || depNames.includes("expo")) shape = "mobile";
  else if (hasFE && hasBE) shape = "fullstack";
  else if (hasFE) shape = "frontend";
  else if (hasBE) shape = "backend";
  else if (pkg && (pkg.main || pkg.exports) && !hasFE && !hasBE) shape = "library";

  if (await exists(join(cwd, "pnpm-workspace.yaml")) || (pkg && pkg.workspaces)) shape = "monorepo";

  let branch = null, dirty = false, hasRemote = false;
  if (isRepo) {
    branch = await git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"])
          ?? await git(cwd, ["symbolic-ref", "--short", "HEAD"]);
    const statusOut = await git(cwd, ["status", "--porcelain"]);
    dirty = statusOut !== null && statusOut !== "";
    const remoteOut = await git(cwd, ["remote"]);
    hasRemote = !!(remoteOut && remoteOut !== "");
  }

  const signals = [...frameworks];
  if (hasAiSdk(depNames)) signals.push("prompting");

  return {
    greenfield, languages, frameworks, shape, packageManager, testRunner,
    vcs: { isRepo, branch, dirty, hasRemote },
    signals
  };
}
