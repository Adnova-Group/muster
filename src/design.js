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
  sha256,
} from "./fs-safe.js";

export const DESIGN_SOURCE = Object.freeze({
  name: "Impeccable",
  repository: "https://github.com/pbakaus/impeccable",
  ref: "035c8f319edd019936525a062fe99e83ca8d12c6",
  license: "Apache-2.0",
});

// Workflow vocabulary follows Impeccable's command metadata at the pinned ref
// (skill/scripts/command-metadata.json), restated in Muster's own words.
const WORKFLOW_METADATA = {
  craft: ["Compatibility alias for ordinary new design work; adds no behavior of its own.", "[feature description]"],
  init: ["Capture the durable product and design context needed by later work.", ""],
  document: ["Document an incumbent visual system in canonical DESIGN.md form from the code, confirming descriptive language with the user.", ""],
  extract: ["Consolidate reusable patterns, components, and tokens.", "[target]"],
  live: ["Prepare an interactive visual-iteration session on chosen elements.", ""],
  generate: ["Produce N variants of one named element in a stated direction for the user to choose from. Web only; on native targets offer bolder or quieter instead.", "[count] [direction] variants of [element]"],
  adapt: ["Adapt a design across sizes, devices, platforms, and touch contexts.", "[target] [context]"],
  animate: ["Add purposeful motion and micro-interactions.", "[target]"],
  audit: ["Audit accessibility, performance, theming, responsiveness, touch interaction, and anti-patterns; report P0-P3 findings with a remediation plan.", "[area]"],
  bolder: ["Increase visual impact while preserving usability.", "[target]"],
  clarify: ["Improve UX copy, labels, instructions, and error messages.", "[target]"],
  colorize: ["Apply a more expressive and coherent color system.", "[target]"],
  critique: ["Evaluate hierarchy, information architecture, resonance, and cognitive load with scored, persona-based findings.", "[area]"],
  delight: ["Add useful moments of personality and delight.", "[target]"],
  distill: ["Remove unnecessary complexity and visual noise.", "[target]"],
  harden: ["Handle edge cases, overflow, i18n, interrupted gestures, and production resilience.", "[target]"],
  onboard: ["Design onboarding, first-run, activation, and empty-state experiences.", "[target]"],
  layout: ["Improve spacing, composition, rhythm, and hierarchy.", "[target]"],
  optimize: ["Improve perceived and measured interface performance.", "[target]"],
  overdrive: ["Explore technically ambitious, high-impact interaction design.", "[target]"],
  polish: ["Run a final alignment, spacing, consistency, and detail pass at the sizes the surface ships at, closing any prior critique findings it resolves.", "[target]"],
  quieter: ["Reduce visual intensity while preserving clarity and quality.", "[target]"],
  shape: ["Shape UX and UI direction before implementation through a short discovery interview (one round by default) and a confirmed brief.", "[feature]"],
  typeset: ["Improve typography, hierarchy, sizing, line breaks, and readability.", "[target]"],
};

export const DESIGN_WORKFLOWS = Object.freeze(
  Object.entries(WORKFLOW_METADATA).map(([id, [description, argumentHint]]) =>
    Object.freeze({ id, description, argumentHint })),
);

const WORKFLOW_IDS = new Set(DESIGN_WORKFLOWS.map(({ id }) => id));
// `generate` reuses the refinement vocabulary as its direction axis instead of
// inventing new action names (Impeccable reference/generate.md, Step 1).
export const GENERATE_DIRECTIONS = Object.freeze(["bolder", "quieter", "distill", "polish", "typeset",
  "colorize", "layout", "adapt", "animate", "delight", "overdrive"]);
const GENERATE_MAX_VARIANTS = 8;
const WORKFLOW_GUIDANCE = {
  generate: [
    `Map the requested direction onto one of: ${GENERATE_DIRECTIONS.join(", ")}; carry any extra intent alongside it. If the request names no direction, ask one question offering that list before writing anything.`,
    `Default to 3 variants when no count is given; never exceed ${GENERATE_MAX_VARIANTS}.`,
    "Write the variants by the mapped direction's own playbook (plugin/builtins/impeccable-<direction>/SKILL.md); Impeccable's live-browser generate lane is not vendored.",
    "Make each variant a complete replacement of the named element that differs on a distinct primary axis, keep the incumbent identity, and let the user pick one before anything else changes.",
  ],
};
// Skills per workflow. Impeccable is the workflow engine and DESIGN.md the canonical context.
// `primary` is the vendored Impeccable playbook (plugin/builtins/impeccable-*, merge-tracked in
// vendor/manifest.yaml): the packet defers the design method to it and keeps only muster's
// orchestration (context gate, DESIGN.md write flow, receipt). `skills` are supporting builtins
// vendored by their own manifest entries and referenced by id and path only. Skills resolve to
// plugin/builtins/<id>/SKILL.md, agents to plugin/agents/<id>.md. `uupm` says how a workflow uses
// uupm-ui-ux-pro-max's search:
//   query      data-backed candidates for a style/color/type/layout/motion choice; the user confirms
//   checklist  its rule-priority table and pre-delivery checklist, beside the workflow's own checks
//   lookup     domain or stack implementation guidance
// `mobbin` marks the workflows that choose a pattern, flow or screen structure: when the session
// has Mobbin MCP tools (detect-and-use, never bundled) they search Mobbin for real references first.
// plugin/commands/design/references/supporting-skills.md records why each skill serves its workflows.
export const DESIGN_PRECEDENCE = Object.freeze(["project DESIGN.md", "accessibility/WCAG",
  "Impeccable workflow guidance",
  "supporting skills and references (uupm, typeui, intent, pfd, emil, gsap, taste, hallmark, anthropic, jk, elaya, addy, Mobbin)"]);
export const IMPECCABLE_CORE = "impeccable-core";
export const IMPECCABLE_CRAFT_FLOOR = "impeccable-craft-floor";
export const UUPM_SKILL = "uupm-ui-ux-pro-max";
export const UUPM_SEARCH_SCRIPT = "scripts/search.py";
export const UUPM_REFERENCE_FILES = Object.freeze(["references/quick-reference.md", "references/pro-rules.md"]);
// Mobbin MCP search tools (https://docs.mobbin.com/mcp/features.md, read 2026-11-10). The saved-content
// tools (create_collection, save_content, add_comment) write to the user's Mobbin account and are
// never called by a design workflow.
export const MOBBIN_SERVER_RE = /mobbin/i;
export const MOBBIN_SEARCH_TOOLS = Object.freeze(["search_screens", "search_flows", "search_sections"]);
// pfd is CC BY-SA 4.0: name it with its attribution, never quote it.
export const PFD_ATTRIBUTION = "Perception-First Design (skovalik/perception-first-design, CC BY-SA 4.0)";
const GSAP = ["gsap-core", "gsap-timeline", "gsap-scrolltrigger", "gsap-plugins", "gsap-react", "gsap-frameworks", "gsap-utils"];
// Workflows with their own vendored Impeccable reference; the others run on impeccable-core alone.
const OWN_REFERENCE = new Set(["adapt", "animate", "audit", "bolder", "clarify", "colorize", "critique", "delight",
  "distill", "harden", "layout", "optimize", "overdrive", "polish", "quieter", "shape", "typeset", "onboard",
  "extract", "document"]);
// Workflows that never edit UI code skip the craft floor (read immediately before any UI edit).
const NO_UI_EDIT = new Set(["init", "document", "audit", "critique", "shape"]);
const support = (id, skills, { agents = [], uupm = null, mobbin = false } = {}) => Object.freeze({
  primary: Object.freeze([IMPECCABLE_CORE, ...(OWN_REFERENCE.has(id) ? [`impeccable-${id}`] : []),
    ...(NO_UI_EDIT.has(id) ? [] : [IMPECCABLE_CRAFT_FLOOR])]),
  skills: Object.freeze(skills), agents: Object.freeze(agents), uupm, mobbin,
});
export const DESIGN_SUPPORT = Object.freeze({
  craft: support("craft", [UUPM_SKILL, "uupm-ui-styling", "typeui", "anthropic-frontend-design",
    "taste-design-taste-frontend", "taste-redesign-existing-projects", "taste-stitch-design-taste", "hallmark",
    "elaya-landing-page-design", "elaya-figma-designer", "jk-build-design", "addy-frontend-ui-engineering",
    "emil-pick-ui-library", "impeccable-operate"], { uupm: "query", mobbin: true }),
  init: support("init", [UUPM_SKILL, "uupm-brand", "intent-intent", "impeccable-document"], { uupm: "query" }),
  document: support("document", ["uupm-design-system"]),
  extract: support("extract", ["uupm-design-system"]),
  live: support("live", ["emil-prototype", "jk-variant", "jk-state-machine"]),
  generate: support("generate", ["typeui", UUPM_SKILL, "emil-prototype", "jk-variant", "taste-stitch-design-taste"],
    { uupm: "query", mobbin: true }),
  adapt: support("adapt", ["intent-transpose", UUPM_SKILL, "emil-mobile-native", "jk-better-layout"], { uupm: "lookup" }),
  animate: support("animate", [UUPM_SKILL, "emil-animate", "emil-choreograph", "emil-apple-design",
    "emil-find-animation-opportunities", "emil-animation-vocabulary", "emil-animate-expo", ...GSAP], { uupm: "query" }),
  audit: support("audit", [UUPM_SKILL, "intent-evaluate", "intent-include", "jk-better-accessibility",
    "addy-browser-testing-with-devtools"], { agents: ["intent-vigil"], uupm: "checklist" }),
  bolder: support("bolder", [UUPM_SKILL, "anthropic-frontend-design", "taste-design-taste-frontend",
    "taste-high-end-visual-design", "taste-industrial-brutalist-ui", "taste-redesign-existing-projects", "hallmark"],
    { uupm: "query", mobbin: true }),
  clarify: support("clarify", ["intent-articulate", "uupm-brand", "pfd", "jk-better-writing"], { agents: ["intent-wren"] }),
  colorize: support("colorize", [UUPM_SKILL, "jk-better-colors"], { uupm: "query" }),
  critique: support("critique", [UUPM_SKILL, "intent-evaluate", "pfd", "jk-better-interface", "jk-interface-review",
    "emil-review-animations"], { agents: ["intent-vigil"], uupm: "checklist" }),
  delight: support("delight", [UUPM_SKILL, "intent-articulate", "emil-design-eng", "emil-find-animation-opportunities"],
    { uupm: "query" }),
  distill: support("distill", ["pfd", "intent-organize", "emil-remove-animations", "taste-minimalist-ui"]),
  harden: support("harden", ["intent-fortify", "intent-include", "intent-localize", "emil-break-ui", "jk-break",
    "jk-state-machine", "jk-better-layout", "jk-better-accessibility"], { agents: ["intent-vigil"] }),
  onboard: support("onboard", ["intent-journey", "intent-fortify", "intent-articulate", "intent-measure", "pfd",
    "jk-better-writing"], { agents: ["intent-wren"], mobbin: true }),
  layout: support("layout", [UUPM_SKILL, "intent-wireframe", "typeui", "jk-better-layout", "impeccable-operate"],
    { uupm: "query", mobbin: true }),
  optimize: support("optimize", [UUPM_SKILL, "emil-animation-performance", "gsap-performance",
    "addy-browser-testing-with-devtools"], { uupm: "lookup" }),
  overdrive: support("overdrive", [UUPM_SKILL, "emil-choreograph", "emil-apple-design", "gsap-scrolltrigger",
    "gsap-plugins", "gsap-timeline", "taste-high-end-visual-design", "taste-industrial-brutalist-ui"],
    { uupm: "query", mobbin: true }),
  polish: support("polish", [UUPM_SKILL, "emil-design-eng", "emil-review-animations", "jk-better-ui"], { uupm: "checklist" }),
  quieter: support("quieter", [UUPM_SKILL, "emil-remove-animations", "taste-minimalist-ui"], { uupm: "query" }),
  shape: support("shape", ["intent-strategize", "intent-journey", "intent-wireframe", "intent-measure", "pfd", UUPM_SKILL,
    "anthropic-frontend-design"], { agents: ["intent-ember"], uupm: "query", mobbin: true }),
  typeset: support("typeset", [UUPM_SKILL, "jk-better-typography"], { uupm: "query" }),
});
const UUPM_GUIDANCE = {
  query: `For each style, color, type, layout or motion choice, run ${UUPM_SKILL}'s ${UUPM_SEARCH_SCRIPT} (--design-system for a product-wide direction, --domain for one concern) for data-backed candidates; present them, let the user confirm, and record the confirmed choice in DESIGN.md through this workflow. Never treat its --persist output as design context.`,
  checklist: `Apply ${UUPM_SKILL}'s rule-priority table and its pre-delivery checklist (${UUPM_REFERENCE_FILES[1]}) beside this workflow's own checks; report each finding once.`,
  lookup: `Look up implementation guidance with ${UUPM_SKILL}'s ${UUPM_SEARCH_SCRIPT} by --domain or by the detected --stack; treat results as recommendations.`,
};
const MOBBIN_GUIDANCE = [
  `Only if this session has tools from an MCP server whose name matches /mobbin/i: before choosing a pattern, flow or screen structure, search Mobbin for real references (${MOBBIN_SEARCH_TOOLS[1]} for multi-step flows, ${MOBBIN_SEARCH_TOOLS[0]} for single screens, ${MOBBIN_SEARCH_TOOLS[2]} for website sections), cite the apps and screens you used, then synthesize. Without those tools, skip this step and do not mention it.`,
  "Mobbin screens are third-party product screenshots, used as reference only: never copy proprietary assets or brand elements into the user's product, and never let them override DESIGN.md.",
];

function supportGuidance(workflow) {
  const entry = DESIGN_SUPPORT[workflow];
  if (!entry) return [];
  const name = (id) => (id === "pfd" ? `pfd (${PFD_ATTRIBUTION})` : id);
  const lines = [
    `Primary playbook, read first (plugin/builtins/<id>/SKILL.md): ${entry.primary.join(", ")}. Follow it for the design method; this packet adds only muster's context gate, DESIGN.md write flow and receipt.`,
  ];
  if (entry.skills.length > 0) {
    lines.push(`Supporting skills, read on demand by builtin id (plugin/builtins/<id>/SKILL.md): ${entry.skills.map(name).join(", ")}. Use a stack-specific skill (gsap-*, emil-animate-expo, uupm-ui-styling) only where the project already uses that stack.`);
  }
  if (entry.agents.length > 0) {
    lines.push(`Supporting agents (plugin/agents/<id>.md): ${entry.agents.join(", ")}.`);
  }
  if (entry.uupm) {
    lines.push(UUPM_GUIDANCE[entry.uupm]);
    lines.push(`If Python 3 is unavailable, read ${UUPM_SKILL}'s ${UUPM_REFERENCE_FILES.join(" and ")} and its data/ files instead of running the search.`);
  }
  if (entry.mobbin) lines.push(...MOBBIN_GUIDANCE);
  lines.push(`When sources disagree: ${DESIGN_PRECEDENCE.join(" > ")}.`);
  return lines;
}
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
    support: DESIGN_SUPPORT[workflow],
    prompt: [
      "You are Muster's design workflow specialist.",
      `Run the ${workflow} workflow. ${metadata.description}`,
      ...(WORKFLOW_GUIDANCE[workflow] || []),
      "Treat the resolved DESIGN.md digest receipt as canonical context.",
      ...supportGuidance(workflow),
      "Return a concise Markdown checklist of proposed work and verification.",
      `<design-scope>${xmlText(scope)}</design-scope>`,
    ].join("\n"),
  };
}
