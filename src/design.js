import { createHash } from "node:crypto";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  assertContainedNoSymlinkPath,
  atomicWrite,
  readNoFollowRegular,
} from "./fs-safe.js";

export const DESIGN_SOURCE = Object.freeze({
  name: "Impeccable",
  repository: "https://github.com/pbakaus/impeccable",
  ref: "32930818a109fafa87199babe92fa8e530cff5d3",
  license: "Apache-2.0",
});

const WORKFLOW_METADATA = {
  craft: ["Compatibility entry point for ordinary new design work.", "[feature description]"],
  init: ["Capture the durable product and design context needed by later work.", ""],
  document: ["Document an incumbent visual system in canonical DESIGN.md form.", ""],
  extract: ["Consolidate reusable patterns, components, and tokens.", "[target]"],
  live: ["Prepare an interactive visual-iteration session.", ""],
  adapt: ["Adapt a design across sizes, devices, and contexts.", "[target] [context]"],
  animate: ["Add purposeful motion and micro-interactions.", "[target]"],
  audit: ["Audit accessibility, performance, responsiveness, and design quality.", "[area]"],
  bolder: ["Increase visual impact while preserving usability.", "[target]"],
  clarify: ["Improve UX copy, labels, instructions, and error messages.", "[target]"],
  colorize: ["Apply a more expressive and coherent color system.", "[target]"],
  critique: ["Evaluate hierarchy, information architecture, resonance, and cognitive load.", "[area]"],
  delight: ["Add useful moments of personality and delight.", "[target]"],
  distill: ["Remove unnecessary complexity and visual noise.", "[target]"],
  harden: ["Handle edge cases, overflow, i18n, and production resilience.", "[target]"],
  onboard: ["Design onboarding, first-run, activation, and empty-state experiences.", "[target]"],
  layout: ["Improve spacing, composition, rhythm, and hierarchy.", "[target]"],
  optimize: ["Improve perceived and measured interface performance.", "[target]"],
  overdrive: ["Explore technically ambitious, high-impact interaction design.", "[target]"],
  polish: ["Run a final alignment, spacing, consistency, and detail pass.", "[target]"],
  quieter: ["Reduce visual intensity while preserving clarity and quality.", "[target]"],
  shape: ["Shape UX and UI direction before implementation.", "[feature]"],
  typeset: ["Improve typography, hierarchy, sizing, and readability.", "[target]"],
};

export const DESIGN_WORKFLOWS = Object.freeze(
  Object.entries(WORKFLOW_METADATA).map(([id, [description, argumentHint]]) =>
    Object.freeze({ id, description, argumentHint })),
);

const WORKFLOW_IDS = new Set(DESIGN_WORKFLOWS.map(({ id }) => id));
const DESIGN_NAMES = ["DESIGN.md", "Design.md", "design.md"];
const UI_EXTENSIONS = new Set([".css", ".scss", ".sass", ".less", ".styl", ".html", ".htm",
  ".jsx", ".tsx", ".vue", ".svelte", ".astro", ".swift", ".kt", ".kts", ".xml"]);
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", ".next", ".nuxt", ".cache",
  "coverage", "vendor", ".muster"]);
const MAX_SCAN_FILES = 250;
const MAX_SCAN_MS = 500;
const MAX_SCAN_OUTPUT = 64 * 1024;
const IGNORE_PATH = join(".muster", "design-ignores");
const PROVIDER_PATH = join(".muster", "design-provider.json");
const MAX_CACHE_ENTRIES = 64;
const scanCache = new Map();

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function xmlText(value) {
  return String(value).replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

async function exists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function firstDesign(dir) {
  for (const name of DESIGN_NAMES) {
    const candidate = join(dir, name);
    if (await exists(candidate)) return candidate;
  }
  return null;
}

function inside(path, root) {
  const rel = relative(root, path);
  return rel === "" || (!rel.startsWith(`..${sep}`) && rel !== ".." && !isAbsolute(rel));
}

async function findRepoRoot(start) {
  let cursor = resolve(start);
  while (true) {
    if (await exists(join(cursor, ".git"))) return cursor;
    const parent = dirname(cursor);
    if (parent === cursor) return resolve(start);
    cursor = parent;
  }
}

async function packageWorkspaces(repoRoot) {
  try {
    const pkg = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));
    const workspaces = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
    return Array.isArray(workspaces) && workspaces.length > 0;
  } catch {
    return false;
  }
}

async function isMonorepo(repoRoot) {
  if (await packageWorkspaces(repoRoot)) return true;
  for (const marker of ["pnpm-workspace.yaml", "turbo.json", "nx.json", "lerna.json"]) {
    if (await exists(join(repoRoot, marker))) return true;
  }
  return false;
}

async function nearestPackageRoot(target, repoRoot) {
  let cursor = target;
  try {
    if (!(await stat(cursor)).isDirectory()) cursor = dirname(cursor);
  } catch {
    cursor = extname(cursor) ? dirname(cursor) : cursor;
  }
  while (inside(cursor, repoRoot)) {
    if (cursor !== repoRoot && await exists(join(cursor, "package.json"))) return cursor;
    if (cursor === repoRoot) break;
    cursor = dirname(cursor);
  }
  return repoRoot;
}

export async function resolveDesignContext(cwd = process.cwd(), options = {}) {
  const absCwd = resolve(cwd);
  const repoRoot = await findRepoRoot(absCwd);
  const monorepo = await isMonorepo(repoRoot);
  const target = options.target
    ? resolve(absCwd, options.target)
    : absCwd;
  if (!inside(target, repoRoot)) throw new Error("design target must remain inside the repository");
  const scopeRoot = monorepo ? await nearestPackageRoot(target, repoRoot) : repoRoot;
  const local = await firstDesign(scopeRoot);
  const rootDesign = scopeRoot !== repoRoot ? await firstDesign(repoRoot) : null;
  const designPath = local || rootDesign;
  if (designPath) {
    const [scopeReal, designReal] = await Promise.all([realpath(scopeRoot), realpath(designPath)]);
    if (!inside(designReal, repoRoot) || !inside(scopeReal, repoRoot)) {
      throw new Error("DESIGN.md resolution crossed a symlink outside the repository");
    }
  }
  return {
    repoRoot,
    scopeRoot,
    isMonorepo: monorepo,
    designPath,
    inherited: Boolean(designPath && scopeRoot !== repoRoot && designPath === rootDesign),
  };
}

export async function designStatus(cwd = process.cwd(), options = {}) {
  const context = await resolveDesignContext(cwd, options);
  if (!context.designPath) return { ...context, status: "missing", receipt: null };
  const text = await readFile(context.designPath, "utf8");
  const file = await stat(context.designPath);
  return {
    ...context,
    status: "ready",
    receipt: {
      format: "muster.design-context",
      version: 1,
      scopeRoot: context.scopeRoot,
      designPath: context.designPath,
      digest: sha256(text),
      bytes: file.size,
      sourceRef: DESIGN_SOURCE.ref,
    },
  };
}

export function qualifiesDesignOutcome(outcome) {
  if (typeof outcome !== "string" || !outcome.trim()) return false;
  return /\b(ui|ux|design|frontend|front-end|brand|visual|interface|responsive|accessibility|a11y|typograph|layout|animation|motion|onboarding|landing page|website|human-facing)\b/i.test(outcome);
}

export async function designGate(cwd, options = {}) {
  const required = qualifiesDesignOutcome(options.outcome);
  if (!required) return { required: false, allowed: true, receipt: null };
  const resolveContext = options.resolveContext || resolveDesignContext;
  const context = await resolveContext(cwd, options);
  if (!context.designPath) {
    if (options.audit && options.write !== true) {
      return {
        required: true,
        allowed: true,
        receipt: null,
        finding: {
          severity: "risk",
          note: `No canonical DESIGN.md was resolved for audited scope ${context.scopeRoot}.`,
        },
      };
    }
    return {
      required: true,
      allowed: false,
      status: "HUMAN-HOLD",
      question: `No canonical DESIGN.md was resolved for ${context.scopeRoot}. Run an attended \`muster design init\` before human-facing implementation.`,
      receipt: null,
    };
  }
  const status = await designStatus(cwd, options);
  return { required: true, allowed: true, receipt: status.receipt };
}

function validateDesignText(text) {
  if (typeof text !== "string" || !text.trim()) throw new Error("DESIGN.md content must be non-empty");
  if (!/^#\s+\S/m.test(text)) throw new Error("DESIGN.md content must contain a top-level heading");
}

export async function initializeDesign(cwd = process.cwd(), options = {}) {
  const context = await resolveDesignContext(cwd, options);
  if (context.designPath) return { ...(await designStatus(cwd, options)), status: "exists" };
  if (!options.contentFile) {
    return {
      status: "HUMAN-HOLD",
      scopeRoot: context.scopeRoot,
      question: "What confirmed design direction, visual constraints, typography, color, and component principles should canonical DESIGN.md preserve?",
    };
  }
  const text = await readFile(resolve(cwd, options.contentFile), "utf8");
  validateDesignText(text);
  const destination = join(context.scopeRoot, "DESIGN.md");
  await assertContainedNoSymlinkPath(context.repoRoot, destination, { allowMissingFinal: true });
  try {
    // `wx` is one atomic exclusive create: it neither follows nor replaces an
    // existing final-component symlink. The ancestry guard above rejects
    // package-directory symlinks before any bytes are published.
    await writeFile(destination, text, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    return { status: "exists", ...(await designStatus(cwd, options)) };
  }
  const ready = await designStatus(cwd, options);
  return { ...ready, status: "created" };
}

async function ensureDesignStateDir(repoRoot) {
  const stateDir = join(repoRoot, ".muster");
  try {
    await mkdir(stateDir, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  await assertContainedNoSymlinkPath(repoRoot, stateDir);
  return stateDir;
}

async function readOwnedOptional(repoRoot, path, maxBytes) {
  try {
    await lstat(dirname(path));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  await assertContainedNoSymlinkPath(repoRoot, path, { allowMissingFinal: true });
  try {
    const { bytes } = await readNoFollowRegular(path, {
      maxBytes,
      label: relative(repoRoot, path),
      requireSingleLink: true,
    });
    return bytes.toString("utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function publishOwned(repoRoot, path, text, mode = 0o644) {
  await assertContainedNoSymlinkPath(repoRoot, path, { allowMissingFinal: true });
  return atomicWrite(path, text, {
    mode,
    fsyncDir: true,
    beforeRename: () => assertContainedNoSymlinkPath(repoRoot, path, { allowMissingFinal: true }),
  });
}

export async function readDesignIgnores(cwd = process.cwd()) {
  const repoRoot = await findRepoRoot(cwd);
  const text = await readOwnedOptional(repoRoot, join(repoRoot, IGNORE_PATH), 64 * 1024);
  if (text === null) return [];
  return [...new Set(text
    .split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#")))].sort();
}

export async function addDesignIgnore(cwd = process.cwd(), pattern) {
  if (typeof pattern !== "string" || !pattern.trim() || pattern.includes("\0") || /[\r\n]/.test(pattern)) {
    throw new Error("design ignore pattern must be one non-empty line");
  }
  const repoRoot = await findRepoRoot(cwd);
  const values = [...new Set([...(await readDesignIgnores(repoRoot)), pattern.trim()])].sort();
  await ensureDesignStateDir(repoRoot);
  await publishOwned(repoRoot, join(repoRoot, IGNORE_PATH), `${values.join("\n")}\n`);
  return { path: join(repoRoot, IGNORE_PATH), ignores: values };
}

function ignored(rel, patterns) {
  return patterns.some((pattern) => {
    const prefix = pattern.replace(/\*\*.*$/, "").replace(/\/+$/, "");
    return rel === prefix || rel.startsWith(`${prefix}/`);
  });
}

export async function detectDesignEvidence(cwd = process.cwd(), options = {}) {
  const root = resolve(cwd);
  const started = Date.now();
  try {
    const rootStat = await stat(root);
    if (rootStat.isFile()) {
      const name = root.split(sep).at(-1);
      const hasEvidence = DESIGN_NAMES.includes(name) || UI_EXTENSIONS.has(extname(name).toLowerCase());
      return { hasEvidence, evidence: hasEvidence ? [name] : [], scannedFiles: 1, truncated: false, timeoutMs: MAX_SCAN_MS };
    }
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return { hasEvidence: false, evidence: [], scannedFiles: 0, truncated: false, timeoutMs: MAX_SCAN_MS };
  }
  const ignores = options.ignores || await readDesignIgnores(root);
  const queue = [root];
  const evidence = [];
  let scannedFiles = 0;
  let truncated = false;
  while (queue.length > 0 && scannedFiles < MAX_SCAN_FILES && Date.now() - started < MAX_SCAN_MS) {
    const dir = queue.shift();
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const rel = relative(root, path).split(sep).join("/");
      if (ignored(rel, ignores)) continue;
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) queue.push(path);
        continue;
      }
      if (!entry.isFile()) continue;
      scannedFiles += 1;
      if (DESIGN_NAMES.includes(entry.name) || UI_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
        evidence.push(rel);
      }
      if (scannedFiles >= MAX_SCAN_FILES || JSON.stringify(evidence).length >= MAX_SCAN_OUTPUT) {
        truncated = true;
        break;
      }
    }
  }
  if (queue.length > 0 || Date.now() - started >= MAX_SCAN_MS) truncated = true;
  return {
    hasEvidence: evidence.length > 0,
    evidence: evidence.slice(0, MAX_SCAN_FILES),
    scannedFiles,
    truncated,
    timeoutMs: MAX_SCAN_MS,
  };
}

async function contextStamp(cwd, options) {
  const context = await resolveDesignContext(cwd, options);
  if (!context.designPath) return `${context.scopeRoot}:missing`;
  const file = await stat(context.designPath);
  return `${context.scopeRoot}:${context.designPath}:${file.size}:${file.mtimeMs}`;
}

export async function scanDesign(cwd = process.cwd(), options = {}) {
  const stamp = await contextStamp(cwd, options);
  const key = `${resolve(cwd)}\0${options.wave || "default"}\0${stamp}`;
  if (scanCache.has(key)) return scanCache.get(key);
  const scan = options.scan || detectDesignEvidence;
  const result = await scan(cwd, options);
  if (scanCache.size >= MAX_CACHE_ENTRIES) scanCache.delete(scanCache.keys().next().value);
  scanCache.set(key, result);
  return result;
}

export async function detectAuditDesignEvidence(cwd = process.cwd(), paths = []) {
  const root = resolve(cwd);
  const scopes = Array.isArray(paths) && paths.length > 0 ? paths : ["."];
  let incomplete = false;
  for (const scope of scopes) {
    const candidate = resolve(root, scope);
    if (!inside(candidate, root)) continue;
    try {
      const result = await detectDesignEvidence(candidate);
      if (result.hasEvidence) return true;
      if (result.truncated) incomplete = true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return incomplete ? "unknown" : false;
}

function nodeSupportsOptionalDetector(version) {
  const [major = 0, minor = 0] = String(version).replace(/^v/, "").split(".").map(Number);
  return major > 22 || (major === 22 && minor >= 12);
}

export async function designProviderCheck(cwd = process.cwd(), options = {}) {
  const repoRoot = await findRepoRoot(cwd);
  let installed = null;
  const providerText = await readOwnedOptional(repoRoot, join(repoRoot, PROVIDER_PATH), 64 * 1024);
  if (providerText !== null) installed = JSON.parse(providerText);
  const nodeVersion = options.nodeVersion || process.versions.node;
  return {
    internal: { available: true, source: DESIGN_SOURCE, installed: Boolean(installed), receipt: installed },
    optionalDetector: {
      supported: nodeSupportsOptionalDetector(nodeVersion),
      requiredNode: ">=22.12",
      activeNode: nodeVersion,
    },
  };
}

export async function installDesignProvider(cwd = process.cwd()) {
  const repoRoot = await findRepoRoot(cwd);
  const path = join(repoRoot, PROVIDER_PATH);
  const receipt = {
    format: "muster.design-provider",
    version: 1,
    provider: "internal",
    source: DESIGN_SOURCE,
    digest: sha256(JSON.stringify(DESIGN_SOURCE)),
  };
  await ensureDesignStateDir(repoRoot);
  try {
    await assertContainedNoSymlinkPath(repoRoot, path, { allowMissingFinal: true });
    await writeFile(path, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o644 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const existing = JSON.parse(await readOwnedOptional(repoRoot, path, 64 * 1024));
    if (existing.digest !== receipt.digest) {
      throw new Error("existing design provider receipt is not owned by this pinned provider; refusing overwrite");
    }
  }
  return designProviderCheck(repoRoot);
}

export async function runDesignWorkflow(cwd, workflow, options = {}) {
  if (!WORKFLOW_IDS.has(workflow)) {
    throw new Error(`unknown design workflow "${workflow}" (expected one of ${[...WORKFLOW_IDS].join(", ")})`);
  }
  const gate = await designGate(cwd, {
    ...options,
    outcome: `design workflow ${workflow} ${options.args || options.target || "interface"}`,
    write: workflow !== "audit" && workflow !== "critique",
    audit: workflow === "audit" || workflow === "critique",
  });
  if (!gate.allowed) return gate;
  const metadata = DESIGN_WORKFLOWS.find((entry) => entry.id === workflow);
  const scope = options.args || options.target || "the requested human-facing surface";
  return {
    workflow,
    provider: "internal",
    source: DESIGN_SOURCE,
    context: gate.receipt,
    target: options.target || null,
    args: options.args || "",
    prompt: [
      "You are Muster's design workflow specialist.",
      `Run the ${workflow} workflow. ${metadata.description}`,
      "Treat the resolved DESIGN.md digest receipt as canonical context.",
      "Return a concise Markdown checklist of proposed work and verification.",
      `<design-scope>${xmlText(scope)}</design-scope>`,
    ].join("\n"),
  };
}
