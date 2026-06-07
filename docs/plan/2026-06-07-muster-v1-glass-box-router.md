# Muster v1 Glass-Box Router — Implementation Plan (slice 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the deterministic core of Muster's glass-box router — a `muster` CLI that detects project context, discovers installed capabilities against a curated catalog, and persists run records to a plain-markdown memory — plus the Claude Code adapter (`/muster` command + router skill) that turns it into a visible Crew Manifest.

**Architecture:** Two layers. (1) A Node ESM CLI (`src/*.js`) of pure-ish functions over injected filesystem paths, emitting JSON — `detect`, `capabilities`, `memory`, `manifest validate`. (2) A thin Claude Code adapter (`plugin/`) whose `/muster` command shells out to `npx muster …` and whose router skill consumes the JSON to emit a Crew Manifest. Resolution ladder per role: installed external provider → bundled built-in → inline, with a non-blocking recommendation overlay.

**Tech Stack:** Node ≥ 20 (ESM), `node:test` + `node:assert` (zero build step), `yaml` (catalog parsing). No other runtime deps. License Apache-2.0.

**Source of truth:** `docs/design/2026-06-07-muster-v1-glass-box-router.md`. Slice 1 = existing-projects, interactive only. Out of scope: fan-out/tournament/review (slice 2), autopilot, greenfield bootstrap, non-software domains, ForceVue connector.

**Plan location note:** saved under `docs/plan/` to parallel the repo's `docs/design/` (overrides the skill default `docs/superpowers/plans/`).

---

## File structure (decomposition)

```
muster/
  package.json                 # npm pkg, bin: muster, type: module, dep: yaml
  LICENSE                      # Apache-2.0
  NOTICE                       # attribution for bundled built-ins
  .gitignore                   # node_modules, .muster/
  src/
    cli.js                     # arg parse + subcommand dispatch (only non-unit-tested file)
    detect.js                  # detectProject(cwd) -> ProjectProfile
    catalog.js                 # loadCatalog(dir) + validateCatalog(entries)
    harness.js                 # readInstalled(home) -> InstalledRaw  (Claude Code)
    capabilities.js            # resolveCapabilities(catalog, installed) -> AvailableCapabilities
    manifest.js                # validateManifest(obj) -> {ok, errors}
    memory.js                  # readMemory(dir, query) / writeMemory(dir, entry)
  catalog/
    software.yaml              # curated provider knowledge, v1 software roles
  plugin/                      # Claude Code adapter
    .claude-plugin/plugin.json
    commands/muster.md         # /muster <outcome>
    skills/router/SKILL.md     # router skill: inputs JSON -> Crew Manifest
  test/
    detect.test.js
    catalog.test.js
    harness.test.js
    capabilities.test.js
    manifest.test.js
    memory.test.js
    helpers.js                 # tmpdir fixture builders
```

**Shared data shapes** (used across tasks — defined once here, referenced by tasks):

```js
// ProjectProfile (detect.js)
{ greenfield: boolean, languages: string[], frameworks: string[],
  shape: "frontend"|"backend"|"fullstack"|"mobile"|"library"|"monorepo"|"unknown",
  packageManager: string, testRunner: string,
  vcs: { isRepo: boolean, branch: string|null, dirty: boolean, hasRemote: boolean },
  signals: string[] }

// Catalog entry (catalog/software.yaml -> catalog.js)
{ id: string, kind: "external"|"builtin", roles: string[], rank: number,
  detect?: { kind: "plugin"|"skill"|"mcp_server", match: string },  // external only
  recommended?: boolean, invoke?: string, notes?: string,
  provenance?: { adapted_from: string, license: string } }          // builtin only

// InstalledRaw (harness.js)
{ plugins: string[], skills: string[], mcpServers: string[] }

// AvailableCapabilities (capabilities.js)
{ roles: { [role]: { chosen: {id,source}, chain: [{id,source}], recommendations: string[] } },
  installedRaw: InstalledRaw }
// source ∈ "installed" | "builtin" | "inline"

// Crew Manifest (validated by manifest.js)
{ outcome: string, successCriteria: string[],
  crew: [{ stage: string, provider: string, source: string, rationale: string, evidence: string, fallback: string }],
  recommendations: string[], degradations: string[],
  plan: [{ task: string, mode: "single"|"tournament", note?: string }] }
```

---

## Task 0: Project scaffold

**Files:**
- Create: `package.json`, `LICENSE`, `NOTICE`, `.gitignore`, `test/helpers.js`, `test/smoke.test.js`

- [ ] **Step 1: Create `package.json`**

```json
{
  "name": "muster",
  "version": "0.1.0",
  "description": "Glass-box agentic orchestrator: detects context, assembles the right crew, and shows its reasoning.",
  "license": "Apache-2.0",
  "type": "module",
  "bin": { "muster": "src/cli.js" },
  "files": ["src", "catalog", "plugin", "LICENSE", "NOTICE"],
  "engines": { "node": ">=20" },
  "scripts": { "test": "node --test" },
  "dependencies": { "yaml": "^2.5.0" }
}
```

- [ ] **Step 2: Add `LICENSE` (Apache-2.0) and `NOTICE`**

Run: `printf '%s\n' 'Muster' 'Copyright 2026 Adnova Group' '' 'This product includes software adapted from third-party projects; see per-built-in provenance and additions below.' > NOTICE`
Then fetch the standard Apache-2.0 text into `LICENSE`:
Run: `curl -fsSL https://www.apache.org/licenses/LICENSE-2.0.txt -o LICENSE`
Expected: `LICENSE` is ~11KB beginning with "Apache License / Version 2.0".

- [ ] **Step 3: Add `.gitignore`**

```
node_modules/
.muster/
*.log
```

- [ ] **Step 4: Install dep**

Run: `npm install`
Expected: `node_modules/yaml` exists, `package-lock.json` created.

- [ ] **Step 5: Write fixture helper `test/helpers.js`**

```js
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

export async function tmpProject(files = {}) {
  const dir = await mkdtemp(join(tmpdir(), "muster-test-"));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, typeof content === "string" ? content : JSON.stringify(content));
  }
  return dir;
}
```

- [ ] **Step 6: Write smoke test `test/smoke.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";

test("tmpProject writes files", async () => {
  const dir = await tmpProject({ "package.json": { name: "x" } });
  assert.ok(dir.includes("muster-test-"));
});
```

- [ ] **Step 7: Run tests, expect pass**

Run: `npm test`
Expected: 1 test passing.

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json LICENSE NOTICE .gitignore test/
git commit -m "chore: scaffold muster npm package (Apache-2.0, node:test)"
```

---

## Task 1: Catalog loader + validator

**Files:**
- Create: `src/catalog.js`, `catalog/software.yaml`, `test/catalog.test.js`

- [ ] **Step 1: Write failing test `test/catalog.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateCatalog, loadCatalog } from "../src/catalog.js";

test("validateCatalog rejects entry missing id", () => {
  const { ok, errors } = validateCatalog([{ kind: "builtin", roles: ["plan"], rank: 1 }]);
  assert.equal(ok, false);
  assert.match(errors[0], /id/);
});

test("validateCatalog requires detect for external entries", () => {
  const { ok, errors } = validateCatalog([{ id: "x", kind: "external", roles: ["plan"], rank: 1 }]);
  assert.equal(ok, false);
  assert.match(errors[0], /detect/);
});

test("validateCatalog accepts a valid builtin + external", () => {
  const { ok } = validateCatalog([
    { id: "muster-planner", kind: "builtin", roles: ["plan"], rank: 50,
      provenance: { adapted_from: "superpowers", license: "MIT" } },
    { id: "serena", kind: "external", roles: ["code-navigation"], rank: 90,
      detect: { kind: "mcp_server", match: "serena" } }
  ]);
  assert.equal(ok, true);
});

test("loadCatalog reads + validates the shipped software catalog", async () => {
  const entries = await loadCatalog(new URL("../catalog/", import.meta.url));
  assert.ok(entries.length > 0);
  assert.ok(entries.every(e => e.id && e.kind && Array.isArray(e.roles)));
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/catalog.test.js`
Expected: FAIL — cannot find module `../src/catalog.js`.

- [ ] **Step 3: Implement `src/catalog.js`**

```js
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { parse } from "yaml";

const ROLES = new Set([
  "code-navigation", "docs-research", "brainstorm", "plan", "implement",
  "code-review", "security-review", "test-author", "refactor", "frontend", "tech-debt"
]);

export function validateCatalog(entries) {
  const errors = [];
  if (!Array.isArray(entries)) return { ok: false, errors: ["catalog must be an array"] };
  entries.forEach((e, i) => {
    const at = `entry[${i}]`;
    if (!e.id) errors.push(`${at}: missing id`);
    if (e.kind !== "external" && e.kind !== "builtin") errors.push(`${at}: kind must be external|builtin`);
    if (!Array.isArray(e.roles) || e.roles.length === 0) errors.push(`${at}: roles must be a non-empty array`);
    else for (const r of e.roles) if (!ROLES.has(r)) errors.push(`${at}: unknown role "${r}"`);
    if (typeof e.rank !== "number") errors.push(`${at}: rank must be a number`);
    if (e.kind === "external" && (!e.detect || !e.detect.kind || !e.detect.match))
      errors.push(`${at}: external entry needs detect.{kind,match}`);
    if (e.kind === "builtin" && (!e.provenance || !e.provenance.license))
      errors.push(`${at}: builtin entry needs provenance.{adapted_from,license}`);
  });
  return { ok: errors.length === 0, errors };
}

export async function loadCatalog(dir) {
  const base = dir instanceof URL ? fileURLToPath(dir) : dir;
  const files = (await readdir(base)).filter(f => f.endsWith(".yaml") || f.endsWith(".yml"));
  let entries = [];
  for (const f of files) entries = entries.concat(parse(await readFile(join(base, f), "utf8")) || []);
  const { ok, errors } = validateCatalog(entries);
  if (!ok) throw new Error("Invalid catalog:\n" + errors.join("\n"));
  return entries;
}
```

- [ ] **Step 4: Create `catalog/software.yaml`** (v1 software roles; built-ins carry verified provenance)

```yaml
# External providers — optional, detected at runtime. None assumed present.
- id: serena
  kind: external
  roles: [code-navigation]
  detect: { kind: mcp_server, match: serena }
  rank: 90
  recommended: true
  invoke: "use serena symbol tools (find_symbol, find_referencing_symbols)"
  notes: "LSP-grade navigation"
- id: context7
  kind: external
  roles: [docs-research]
  detect: { kind: mcp_server, match: context7 }
  rank: 90
  recommended: true
  invoke: "resolve-library-id then query-docs"
  notes: "live external library docs"
- id: superpowers
  kind: external
  roles: [brainstorm, plan, test-author, code-review]
  detect: { kind: plugin, match: superpowers }
  rank: 80
  invoke: "invoke the matching superpowers skill"
- id: pr-review-toolkit
  kind: external
  roles: [code-review, security-review]
  detect: { kind: plugin, match: pr-review-toolkit }
  rank: 70
  invoke: "dispatch the matching reviewer agent"
- id: wshobson-agents
  kind: external
  roles: [security-review, tech-debt]
  detect: { kind: plugin, match: agents }
  rank: 70
  invoke: "dispatch the matching wshobson specialist agent"

# Built-in defaults — Muster ships these (adapted, credited). Used when no installed provider.
- id: muster-planner
  kind: builtin
  roles: [brainstorm, plan]
  rank: 50
  provenance: { adapted_from: "superpowers writing-plans/brainstorming", license: "MIT" }
- id: muster-reviewer
  kind: builtin
  roles: [code-review]
  rank: 50
  provenance: { adapted_from: "wshobson/agents code-reviewer", license: "MIT" }
- id: muster-tdd
  kind: builtin
  roles: [test-author]
  rank: 50
  provenance: { adapted_from: "superpowers test-driven-development", license: "MIT" }
- id: muster-grep-nav
  kind: builtin
  roles: [code-navigation]
  rank: 30
  provenance: { adapted_from: "Muster (grep/ast-grep wrapper)", license: "Apache-2.0" }
- id: muster-webfetch-docs
  kind: builtin
  roles: [docs-research]
  rank: 30
  provenance: { adapted_from: "Muster (WebFetch wrapper)", license: "Apache-2.0" }
- id: muster-builder
  kind: builtin
  roles: [implement]
  rank: 50
  provenance: { adapted_from: "atomic-claude builder/surgeon archetypes", license: "MIT" }
```

- [ ] **Step 5: Run, expect pass**

Run: `node --test test/catalog.test.js`
Expected: 4 tests passing.

- [ ] **Step 6: Commit**

```bash
git add src/catalog.js catalog/software.yaml test/catalog.test.js
git commit -m "feat(catalog): loader + validator + v1 software provider knowledge"
```

---

## Task 2: Project detection (`ProjectProfile`)

**Files:**
- Create: `src/detect.js`, `test/detect.test.js`

- [ ] **Step 1: Write failing test `test/detect.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";
import { detectProject } from "../src/detect.js";

test("empty dir is greenfield", async () => {
  const dir = await tmpProject({});
  const p = await detectProject(dir);
  assert.equal(p.greenfield, true);
  assert.equal(p.shape, "unknown");
});

test("detects node + framework + package manager from manifest/lockfile", async () => {
  const dir = await tmpProject({
    "package.json": { dependencies: { next: "14.0.0", react: "18.0.0" }, devDependencies: { vitest: "1.0.0" } },
    "pnpm-lock.yaml": "lockfileVersion: '9.0'"
  });
  const p = await detectProject(dir);
  assert.equal(p.greenfield, false);
  assert.ok(p.languages.includes("javascript"));
  assert.ok(p.frameworks.includes("next"));
  assert.equal(p.packageManager, "pnpm");
  assert.equal(p.testRunner, "vitest");
  assert.ok(p.signals.includes("next"));
});

test("react-native marks mobile shape", async () => {
  const dir = await tmpProject({ "package.json": { dependencies: { "react-native": "0.74.0" } } });
  const p = await detectProject(dir);
  assert.equal(p.shape, "mobile");
});

test("frontend-only deps yield frontend shape", async () => {
  const dir = await tmpProject({ "package.json": { dependencies: { react: "18.0.0", vite: "5.0.0" } } });
  const p = await detectProject(dir);
  assert.equal(p.shape, "frontend");
});

test("unknown values never throw, reported as unknown", async () => {
  const dir = await tmpProject({ "README.md": "# hi" });
  const p = await detectProject(dir);
  assert.equal(p.packageManager, "unknown");
  assert.equal(p.testRunner, "unknown");
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/detect.test.js`
Expected: FAIL — cannot find module `../src/detect.js`.

- [ ] **Step 3: Implement `src/detect.js`**

```js
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
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/detect.test.js`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/detect.js test/detect.test.js
git commit -m "feat(detect): deterministic ProjectProfile from files (signals layer)"
```

---

## Task 3: Harness adapter (read installed capabilities)

**Files:**
- Create: `src/harness.js`, `test/harness.test.js`

- [ ] **Step 1: Write failing test `test/harness.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";
import { readInstalled } from "../src/harness.js";

test("reads plugin ids from installed_plugins.json", async () => {
  const home = await tmpProject({
    ".claude/plugins/installed_plugins.json": {
      version: 2, plugins: { "superpowers@official": [{}], "serena@official": [{}] }
    }
  });
  const r = await readInstalled(home);
  assert.deepEqual(r.plugins.sort(), ["serena", "superpowers"]);
});

test("missing files degrade to empty, never throw", async () => {
  const home = await tmpProject({});
  const r = await readInstalled(home);
  assert.deepEqual(r, { plugins: [], skills: [], mcpServers: [] });
});

test("reads mcp servers from settings", async () => {
  const home = await tmpProject({
    ".claude/settings.json": { mcpServers: { serena: {}, context7: {} } }
  });
  const r = await readInstalled(home);
  assert.deepEqual(r.mcpServers.sort(), ["context7", "serena"]);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/harness.test.js`
Expected: FAIL — cannot find module `../src/harness.js`.

- [ ] **Step 3: Implement `src/harness.js`**

```js
import { readFile } from "node:fs/promises";
import { join } from "node:path";

async function readJson(p) { try { return JSON.parse(await readFile(p, "utf8")); } catch { return null; } }

// plugin keys look like "name@marketplace" -> take the name part
function pluginName(key) { return key.split("@")[0]; }

export async function readInstalled(home) {
  const plugins = [];
  const pj = await readJson(join(home, ".claude/plugins/installed_plugins.json"));
  if (pj && pj.plugins) for (const key of Object.keys(pj.plugins)) plugins.push(pluginName(key));

  const mcpServers = [];
  const settings = await readJson(join(home, ".claude/settings.json"));
  if (settings && settings.mcpServers) mcpServers.push(...Object.keys(settings.mcpServers));

  // Skills are not enumerable from disk reliably in v1; left empty (router uses dynamic path).
  const skills = [];

  return {
    plugins: [...new Set(plugins)],
    skills: [...new Set(skills)],
    mcpServers: [...new Set(mcpServers)]
  };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/harness.test.js`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/harness.js test/harness.test.js
git commit -m "feat(harness): read installed plugins + mcp servers (Claude Code), degrade safely"
```

---

## Task 4: Capability resolution (the ladder)

**Files:**
- Create: `src/capabilities.js`, `test/capabilities.test.js`

- [ ] **Step 1: Write failing test `test/capabilities.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilities } from "../src/capabilities.js";

const catalog = [
  { id: "serena", kind: "external", roles: ["code-navigation"], rank: 90, recommended: true,
    detect: { kind: "mcp_server", match: "serena" } },
  { id: "muster-grep-nav", kind: "builtin", roles: ["code-navigation"], rank: 30,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "muster-planner", kind: "builtin", roles: ["plan"], rank: 50,
    provenance: { adapted_from: "superpowers", license: "MIT" } }
];

test("installed external wins over builtin", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: ["serena"] });
  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "serena", source: "installed" });
});

test("falls back to builtin when external absent", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "muster-grep-nav", source: "builtin" });
});

test("recommends a better absent external", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["code-navigation"].recommendations.some(r => r.includes("serena")));
});

test("no recommendation when the recommended external is installed", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: ["serena"] });
  assert.equal(a.roles["code-navigation"].recommendations.length, 0);
});

test("role with neither external nor builtin resolves to inline", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.deepEqual(a.roles["plan"].chosen, { id: "muster-planner", source: "builtin" });
  // a role present in ROLES but absent from catalog -> inline
  assert.deepEqual(a.roles["security-review"].chosen, { id: "inline", source: "inline" });
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/capabilities.test.js`
Expected: FAIL — cannot find module `../src/capabilities.js`.

- [ ] **Step 3: Implement `src/capabilities.js`**

```js
const ROLES = [
  "code-navigation", "docs-research", "brainstorm", "plan", "implement",
  "code-review", "security-review", "test-author", "refactor", "frontend", "tech-debt"
];

function isInstalled(entry, installed) {
  if (entry.kind !== "external" || !entry.detect) return false;
  const { kind, match } = entry.detect;
  if (kind === "plugin") return installed.plugins.includes(match);
  if (kind === "skill") return installed.skills.includes(match);
  if (kind === "mcp_server") return installed.mcpServers.includes(match);
  return false;
}

export function resolveCapabilities(catalog, installed) {
  const roles = {};
  for (const role of ROLES) {
    const forRole = catalog.filter(e => e.roles.includes(role)).sort((a, b) => b.rank - a.rank);
    const chain = [];
    let chosen = null;
    for (const e of forRole) {
      if (e.kind === "external" && isInstalled(e, installed)) {
        chain.push({ id: e.id, source: "installed" });
        if (!chosen) chosen = { id: e.id, source: "installed" };
      } else if (e.kind === "builtin") {
        chain.push({ id: e.id, source: "builtin" });
        if (!chosen) chosen = { id: e.id, source: "builtin" };
      }
    }
    if (!chosen) chosen = { id: "inline", source: "inline" };
    chain.push({ id: "inline", source: "inline" });

    // Recommendation overlay: a recommended external that is NOT installed and ranks above the chosen tier.
    const chosenRank = chosen.source === "installed"
      ? (forRole.find(e => e.id === chosen.id)?.rank ?? Infinity)
      : (chosen.source === "builtin" ? (forRole.find(e => e.id === chosen.id)?.rank ?? 0) : 0);
    const recommendations = [];
    for (const e of forRole) {
      if (e.kind === "external" && e.recommended && !isInstalled(e, installed) && e.rank > chosenRank) {
        recommendations.push(`install ${e.id} for ${role} — better than the ${chosen.id} fallback`);
      }
    }
    roles[role] = { chosen, chain, recommendations };
  }
  return { roles, installedRaw: installed };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/capabilities.test.js`
Expected: 5 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/capabilities.js test/capabilities.test.js
git commit -m "feat(capabilities): installed->builtin->inline ladder + recommendation overlay"
```

---

## Task 5: Crew Manifest validator

**Files:**
- Create: `src/manifest.js`, `test/manifest.test.js`

- [ ] **Step 1: Write failing test `test/manifest.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/manifest.js";

const valid = {
  outcome: "Add rate limiting",
  successCriteria: ["429 past N req/min", "tests green"],
  crew: [{ stage: "navigate", provider: "grep", source: "builtin",
           rationale: "no LSP", evidence: "no serena", fallback: "inline" }],
  recommendations: ["install serena"],
  degradations: ["nav fell to builtin"],
  plan: [{ task: "middleware", mode: "single" }]
};

test("accepts a well-formed manifest", () => {
  assert.deepEqual(validateManifest(valid), { ok: true, errors: [] });
});

test("rejects missing outcome / empty success criteria", () => {
  const r = validateManifest({ ...valid, outcome: "", successCriteria: [] });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /outcome/.test(e)));
  assert.ok(r.errors.some(e => /successCriteria/.test(e)));
});

test("rejects bad source and bad plan mode", () => {
  const r = validateManifest({
    ...valid,
    crew: [{ ...valid.crew[0], source: "magic" }],
    plan: [{ task: "x", mode: "parallel" }]
  });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /source/.test(e)));
  assert.ok(r.errors.some(e => /mode/.test(e)));
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/manifest.test.js`
Expected: FAIL — cannot find module `../src/manifest.js`.

- [ ] **Step 3: Implement `src/manifest.js`**

```js
const SOURCES = new Set(["installed", "builtin", "dynamic", "inline"]);
const MODES = new Set(["single", "tournament"]);

export function validateManifest(m) {
  const errors = [];
  if (!m || typeof m !== "object") return { ok: false, errors: ["manifest must be an object"] };
  if (!m.outcome || typeof m.outcome !== "string") errors.push("outcome: required non-empty string");
  if (!Array.isArray(m.successCriteria) || m.successCriteria.length === 0)
    errors.push("successCriteria: required non-empty array");
  if (!Array.isArray(m.crew) || m.crew.length === 0) errors.push("crew: required non-empty array");
  else m.crew.forEach((c, i) => {
    for (const f of ["stage", "provider", "rationale", "evidence", "fallback"])
      if (!c[f]) errors.push(`crew[${i}].${f}: required`);
    if (!SOURCES.has(c.source)) errors.push(`crew[${i}].source: must be one of ${[...SOURCES].join("|")}`);
  });
  for (const f of ["recommendations", "degradations"])
    if (!Array.isArray(m[f])) errors.push(`${f}: must be an array`);
  if (!Array.isArray(m.plan) || m.plan.length === 0) errors.push("plan: required non-empty array");
  else m.plan.forEach((p, i) => {
    if (!p.task) errors.push(`plan[${i}].task: required`);
    if (!MODES.has(p.mode)) errors.push(`plan[${i}].mode: must be single|tournament`);
  });
  return { ok: errors.length === 0, errors };
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/manifest.test.js`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/manifest.js test/manifest.test.js
git commit -m "feat(manifest): Crew Manifest schema validator"
```

---

## Task 6: Compounding memory (LLM-Wiki, plain markdown)

**Files:**
- Create: `src/memory.js`, `test/memory.test.js`

- [ ] **Step 1: Write failing test `test/memory.test.js`**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeMemory, readMemory } from "../src/memory.js";

async function dir() { return mkdtemp(join(tmpdir(), "muster-mem-")); }

test("writeMemory creates a markdown entry and an INDEX line", async () => {
  const d = await dir();
  const entry = { slug: "rate-limit-run", title: "Rate limit run",
    outcome: "Add rate limiting", body: "Chose token bucket.", links: ["express-notes"] };
  await writeMemory(d, entry);
  const md = await readFile(join(d, "rate-limit-run.md"), "utf8");
  assert.match(md, /title: Rate limit run/);
  assert.match(md, /Chose token bucket/);
  assert.match(md, /\[\[express-notes\]\]/);
  const index = await readFile(join(d, "INDEX.md"), "utf8");
  assert.match(index, /rate-limit-run\.md/);
});

test("readMemory returns entries matching a query substring", async () => {
  const d = await dir();
  await writeMemory(d, { slug: "a", title: "Auth refactor", outcome: "auth", body: "x" });
  await writeMemory(d, { slug: "b", title: "Billing", outcome: "billing", body: "y" });
  const hits = await readMemory(d, "auth");
  assert.equal(hits.length, 1);
  assert.equal(hits[0].slug, "a");
});

test("readMemory on empty dir returns []", async () => {
  assert.deepEqual(await readMemory(await dir(), "anything"), []);
});
```

- [ ] **Step 2: Run, expect fail**

Run: `node --test test/memory.test.js`
Expected: FAIL — cannot find module `../src/memory.js`.

- [ ] **Step 3: Implement `src/memory.js`**

```js
import { readdir, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

async function exists(p) { try { await stat(p); return true; } catch { return false; } }

export async function writeMemory(dir, entry) {
  await mkdir(dir, { recursive: true });
  const links = (entry.links || []).map(l => `[[${l}]]`).join(" ");
  const md = `---
title: ${entry.title}
outcome: ${entry.outcome}
---

${entry.body}

${links}
`;
  await writeFile(join(dir, `${entry.slug}.md`), md);

  const line = `- [${entry.title}](${entry.slug}.md) — ${entry.outcome}\n`;
  const indexPath = join(dir, "INDEX.md");
  const head = (await exists(indexPath)) ? await readFile(indexPath, "utf8") : "# Muster memory index\n\n";
  if (!head.includes(`${entry.slug}.md`)) await writeFile(indexPath, head + line);
}

export async function readMemory(dir, query) {
  if (!(await exists(dir))) return [];
  const files = (await readdir(dir)).filter(f => f.endsWith(".md") && f !== "INDEX.md");
  const q = query.toLowerCase();
  const hits = [];
  for (const f of files) {
    const content = await readFile(join(dir, f), "utf8");
    if (content.toLowerCase().includes(q)) hits.push({ slug: f.replace(/\.md$/, ""), content });
  }
  return hits;
}
```

- [ ] **Step 4: Run, expect pass**

Run: `node --test test/memory.test.js`
Expected: 3 tests passing.

- [ ] **Step 5: Commit**

```bash
git add src/memory.js test/memory.test.js
git commit -m "feat(memory): LLM-Wiki plain-markdown backend (INDEX + entries, [[links]])"
```

---

## Task 7: CLI wiring

**Files:**
- Create: `src/cli.js`

(The CLI is the only non-unit-tested module — it is thin dispatch. It is exercised by the integration test in Task 9.)

- [ ] **Step 1: Implement `src/cli.js`**

```js
#!/usr/bin/env node
import { detectProject } from "./detect.js";
import { loadCatalog } from "./catalog.js";
import { readInstalled } from "./harness.js";
import { resolveCapabilities } from "./capabilities.js";
import { validateManifest } from "./manifest.js";
import { writeMemory, readMemory } from "./memory.js";
import { homedir } from "node:os";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const CATALOG_DIR = new URL("../catalog/", import.meta.url);

function out(obj) { process.stdout.write(JSON.stringify(obj, null, 2) + "\n"); }
function fail(msg) { process.stderr.write(`muster: ${msg}\n`); process.exit(1); }

const [cmd, ...rest] = process.argv.slice(2);

try {
  if (cmd === "detect") {
    out(await detectProject(rest[0] || process.cwd()));
  } else if (cmd === "capabilities") {
    const catalog = await loadCatalog(CATALOG_DIR);
    out(resolveCapabilities(catalog, await readInstalled(rest[0] || homedir())));
  } else if (cmd === "manifest" && rest[0] === "validate") {
    const obj = JSON.parse(await readFile(rest[1], "utf8"));
    const r = validateManifest(obj);
    out(r);
    if (!r.ok) process.exit(2);
  } else if (cmd === "memory" && rest[0] === "write") {
    const dir = rest[1]; const entry = JSON.parse(await readFile(rest[2], "utf8"));
    await writeMemory(dir, entry); out({ ok: true });
  } else if (cmd === "memory" && rest[0] === "read") {
    out(await readMemory(rest[1], rest[2] || ""));
  } else {
    fail(`unknown command: ${[cmd, ...rest].join(" ")}\nUsage: muster <detect|capabilities|manifest validate <file>|memory read|write ...>`);
  }
} catch (e) {
  fail(e.message);
}
```

- [ ] **Step 2: Make executable + smoke-run each subcommand**

Run: `chmod +x src/cli.js && node src/cli.js detect . | head -5`
Expected: JSON `ProjectProfile` for the muster repo (shape likely "library"/"unknown", greenfield false).
Run: `node src/cli.js capabilities | head -20`
Expected: JSON `AvailableCapabilities` with each role resolved (builtin/inline depending on your machine).

- [ ] **Step 3: Commit**

```bash
git add src/cli.js
git commit -m "feat(cli): subcommand dispatch (detect/capabilities/manifest/memory)"
```

---

## Task 8: Claude Code adapter (`/muster` command + router skill)

**Files:**
- Create: `plugin/.claude-plugin/plugin.json`, `plugin/commands/muster.md`, `plugin/skills/router/SKILL.md`

- [ ] **Step 1: Create `plugin/.claude-plugin/plugin.json`**

```json
{
  "name": "muster",
  "description": "Glass-box agentic orchestrator: detect context, assemble the right crew, show the reasoning.",
  "version": "0.1.0",
  "commands": ["commands/muster.md"],
  "skills": ["skills/router/SKILL.md"]
}
```

- [ ] **Step 2: Create `plugin/commands/muster.md`** (the entrypoint; shells out to the CLI, then invokes the router skill)

```markdown
---
name: muster
description: Run the Muster glass-box router on a stated outcome. Usage: /muster <outcome>
---

The user's outcome: `$ARGUMENTS`

If `$ARGUMENTS` is empty, ask for the outcome and stop — Muster never runs without a stated outcome.

1. Run `npx muster detect` and `npx muster capabilities`. Capture both JSON blobs.
2. Run `npx muster memory read .muster/memory "<key terms from the outcome>"` and skim any prior entries.
3. Invoke the **router** skill with the outcome, the two JSON blobs, and any memory hits.
4. The router emits a Crew Manifest. Write it to `.muster/manifest.json`, then validate:
   `npx muster manifest validate .muster/manifest.json` — repair and re-validate until `ok: true`.
5. Show the manifest to the user (the Glass Box) and stop for approval (slice 1 is interactive).
6. After the run, append a memory entry: `npx muster memory write .muster/memory <entry.json>`.
```

- [ ] **Step 3: Create `plugin/skills/router/SKILL.md`** (the crew-assembly judgment; consumes deterministic JSON, emits the manifest)

```markdown
---
name: router
description: Assemble a Crew Manifest from a ProjectProfile + AvailableCapabilities + outcome. Glass-box: every choice carries rationale, evidence, and fallback.
---

# Router

You are given: an `outcome` string, a `ProjectProfile` JSON, an `AvailableCapabilities` JSON, and optional memory hits.

## Iron rules
- **Outcome-anchored.** Derive explicit, testable `successCriteria`. If you cannot, ask the user — do not invent.
- **Glass Box.** Every crew member records: chosen `provider`, `source` (installed/builtin/dynamic/inline), one-line `rationale`, the `evidence` from the profile/capabilities it rests on, and the `fallback` if absent.
- **Respect the ladder.** Use `AvailableCapabilities.roles[role].chosen` as the provider for that role. Surface its `recommendations` verbatim in the manifest `recommendations`.
- **Dynamic path.** If an installed plugin/MCP in `installedRaw` is clearly better for a role but absent from the catalog, you may choose it with `source: "dynamic"` and say why.
- **Plan annotations.** Decompose the outcome into `plan` tasks; tag each `single` (well-known) or `tournament` (high-uncertainty / quality-critical). Slice 1 executes sequentially; the tags are for slice 2.

## Output
Emit ONLY the Crew Manifest JSON matching this shape (validated by `muster manifest validate`):

\`\`\`json
{ "outcome": "...", "successCriteria": ["..."],
  "crew": [{ "stage": "...", "provider": "...", "source": "...", "rationale": "...", "evidence": "...", "fallback": "..." }],
  "recommendations": ["..."], "degradations": ["..."],
  "plan": [{ "task": "...", "mode": "single" }] }
\`\`\`
```

- [ ] **Step 4: Validate the example manifest end-to-end**

Create `test/fixtures/manifest.valid.json` with the example from Task 5, then run:
Run: `node src/cli.js manifest validate test/fixtures/manifest.valid.json`
Expected: `{ "ok": true, "errors": [] }`, exit 0.

- [ ] **Step 5: Commit**

```bash
git add plugin/ test/fixtures/manifest.valid.json
git commit -m "feat(adapter): Claude Code /muster command + router skill"
```

---

## Task 9: End-to-end integration test

**Files:**
- Create: `test/integration.test.js`

- [ ] **Step 1: Write the integration test**

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { tmpProject } from "./helpers.js";
import { detectProject } from "../src/detect.js";
import { loadCatalog } from "../src/catalog.js";
import { readInstalled } from "../src/harness.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { validateManifest } from "../src/manifest.js";

test("detect -> capabilities -> hand-built manifest validates (bare machine)", async () => {
  const proj = await tmpProject({ "package.json": { dependencies: { express: "4" } } });
  const home = await tmpProject({}); // nothing installed
  const profile = await detectProject(proj);
  const caps = resolveCapabilities(await loadCatalog(new URL("../catalog/", import.meta.url)), await readInstalled(home));

  assert.equal(profile.shape, "backend");
  // bare machine -> nav resolves to builtin, recommends serena
  assert.equal(caps.roles["code-navigation"].chosen.source, "builtin");
  assert.ok(caps.roles["code-navigation"].recommendations.length >= 1);

  // a router would produce something like this from the above:
  const manifest = {
    outcome: "Add rate limiting to the API",
    successCriteria: ["429 past N req/min/key", "tests green"],
    crew: [{
      stage: "implement",
      provider: caps.roles["implement"].chosen.id,
      source: caps.roles["implement"].chosen.source,
      rationale: "backend express service",
      evidence: `shape=${profile.shape}, express in deps`,
      fallback: "inline"
    }],
    recommendations: caps.roles["code-navigation"].recommendations,
    degradations: ["code-navigation fell to builtin (no LSP server)"],
    plan: [{ task: "rate-limit middleware", mode: "single" },
           { task: "token-bucket store", mode: "tournament", note: "in-mem vs redis" }]
  };
  assert.deepEqual(validateManifest(manifest), { ok: true, errors: [] });
});
```

- [ ] **Step 2: Run the full suite**

Run: `npm test`
Expected: all tests across all files passing.

- [ ] **Step 3: Update README pointer + commit**

Create a minimal `README.md`:

```markdown
# Muster

Glass-box agentic orchestrator. Detects your project, discovers the capabilities you have installed,
assembles the right crew, and shows its reasoning. Works on bare Claude Code; gets better with the
tools you already use.

- Design: `docs/design/2026-06-07-muster-v1-glass-box-router.md`
- Plan: `docs/plan/2026-06-07-muster-v1-glass-box-router.md`

CLI: `npx muster detect | capabilities | manifest validate <file> | memory read|write`
```

```bash
git add test/integration.test.js README.md
git commit -m "test(integration): detect->capabilities->manifest end-to-end; add README"
```

---

## Self-review (completed)

- **Spec coverage:** detect (§7) → Task 2; capabilities + catalog + ladder (§5,§8) → Tasks 1,3,4; Crew Manifest + glass-box fields (§9) → Tasks 5,8; outcome-anchoring (§10) → router skill Task 8; memory LLM-Wiki (§11) → Task 6; CLI/npm distribution (§4) → Tasks 0,7; Claude Code adapter (§4B) → Task 8. Deferred-by-design (greenfield/autopilot/fan-out) intentionally absent.
- **Placeholder scan:** every code step contains runnable code; commands have expected output. No TBD/TODO.
- **Type consistency:** `ProjectProfile`, `InstalledRaw`, `AvailableCapabilities`, Crew Manifest shapes match across detect/harness/capabilities/manifest/integration. `source` enum (`installed|builtin|dynamic|inline`) consistent in capabilities (emits installed/builtin/inline) and manifest validator (accepts all four; dynamic added by the router). Role list identical in `catalog.js` and `capabilities.js`.

## Notes for the executor
- `skills` enumeration from disk is intentionally empty in v1 (`harness.js`); the router covers skill-based providers via the dynamic path. A follow-up can wire a real skills source.
- Keep each module a pure-ish function over injected paths — do not hard-code `homedir()`/`cwd()` inside the logic modules (only `cli.js` injects them).
