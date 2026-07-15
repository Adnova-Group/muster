import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { exists, readJson } from "./fs-util.js";

const pexec = promisify(execFile);
async function git(cwd, args) {
  try { const { stdout } = await pexec("git", args, { cwd }); return stdout.trim(); } catch { return null; }
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
