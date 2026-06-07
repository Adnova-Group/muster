import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }
async function exists(p) { try { await stat(p); return true; } catch { return false; } }

const FRAMEWORKS = ["next", "react-native", "expo", "react", "vue", "svelte", "angular",
  "express", "fastify", "nestjs", "prisma", "vite"];
const FRONTEND = new Set(["react", "vue", "svelte", "angular", "vite", "next"]);
const BACKEND = new Set(["express", "fastify", "nestjs", "prisma"]);

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

  return {
    greenfield, languages, frameworks, shape, packageManager, testRunner,
    vcs: { isRepo, branch: null, dirty: false, hasRemote: false },
    signals: frameworks
  };
}
