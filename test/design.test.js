import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";
import {
  DESIGN_SOURCE,
  DESIGN_WORKFLOWS,
  addDesignIgnore,
  designGate,
  designProviderCheck,
  detectDesignEvidence,
  initializeDesign,
  installDesignProvider,
  readDesignIgnores,
  resolveDesignContext,
  runDesignWorkflow,
  scanDesign,
} from "../src/design.js";

const tmp = () => mkdtemp(join(tmpdir(), "muster-design-"));
const DESIGN = "# Design System\n\n<!-- muster:design-schema 1 -->\n\n## Direction\nPrecise and calm.\n";

test("the bundled design vocabulary exposes exactly 23 pinned Impeccable-inspired workflows", () => {
  assert.equal(DESIGN_WORKFLOWS.length, 23);
  assert.equal(new Set(DESIGN_WORKFLOWS.map((entry) => entry.id)).size, 23);
  assert.deepEqual(
    DESIGN_WORKFLOWS.map((entry) => entry.id),
    ["craft", "init", "document", "extract", "live", "adapt", "animate", "audit", "bolder",
      "clarify", "colorize", "critique", "delight", "distill", "harden", "onboard", "layout",
      "optimize", "overdrive", "polish", "quieter", "shape", "typeset"],
  );
  assert.equal(DESIGN_SOURCE.ref, "32930818a109fafa87199babe92fa8e530cff5d3");
  assert.equal(DESIGN_SOURCE.license, "Apache-2.0");
});

test("distribution metadata and public docs preserve the exact source pin and workflow surface", async () => {
  const root = join(import.meta.dirname, "..");
  const metadata = JSON.parse(await readFile(join(root, "vendor/impeccable.json"), "utf8"));
  const notice = await readFile(join(root, "NOTICE"), "utf8");
  const docs = await readFile(join(root, "docs/design.md"), "utf8");
  const command = await readFile(join(root, "plugin/commands/design.md"), "utf8");
  assert.equal(metadata.ref, DESIGN_SOURCE.ref);
  assert.equal(metadata.license, "Apache-2.0");
  assert.deepEqual(metadata.workflows, DESIGN_WORKFLOWS.map(({ id }) => id));
  assert.match(notice, new RegExp(DESIGN_SOURCE.ref));
  assert.match(docs, new RegExp(DESIGN_SOURCE.ref));
  assert.match(docs, /muster design init \. --content-file confirmed-design\.md/);
  assert.match(docs, /muster design ignores \[dir\] --add <pattern>/);
  assert.match(docs, /muster design run <workflow> \[dir\] --target <path>/);
  for (const { id } of DESIGN_WORKFLOWS) assert.match(command, new RegExp(`\\b${id}\\b`));
});

test("resolveDesignContext selects a target workspace and inherits root DESIGN.md", async () => {
  const root = await tmp();
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
  await writeFile(join(root, "DESIGN.md"), DESIGN);
  await mkdir(join(root, "apps/store/src"), { recursive: true });
  await writeFile(join(root, "apps/store/package.json"), '{"name":"store"}');
  const inherited = await resolveDesignContext(root, { target: "apps/store/src/page.tsx" });
  assert.equal(inherited.isMonorepo, true);
  assert.equal(inherited.scopeRoot, join(root, "apps/store"));
  assert.equal(inherited.designPath, join(root, "DESIGN.md"));
  assert.equal(inherited.inherited, true);

  await writeFile(join(root, "apps/store/DESIGN.md"), DESIGN.replace("calm", "bright"));
  const local = await resolveDesignContext(root, { target: "apps/store/src/page.tsx" });
  assert.equal(local.designPath, join(root, "apps/store/DESIGN.md"));
  assert.equal(local.inherited, false);
});

test("design init is attended, refuses overwrite, and emits a digest receipt", async () => {
  const root = await tmp();
  const hold = await initializeDesign(root);
  assert.equal(hold.status, "HUMAN-HOLD");
  assert.match(hold.question, /design direction/i);

  const source = join(root, "answer.md");
  await writeFile(source, DESIGN);
  const created = await initializeDesign(root, { contentFile: source });
  assert.equal(created.status, "created");
  assert.match(created.receipt.digest, /^[a-f0-9]{64}$/);
  assert.equal(await readFile(join(root, "DESIGN.md"), "utf8"), DESIGN);

  await writeFile(source, DESIGN.replace("calm", "loud"));
  const existing = await initializeDesign(root, { contentFile: source });
  assert.equal(existing.status, "exists");
  assert.equal(await readFile(join(root, "DESIGN.md"), "utf8"), DESIGN);
});

test("design mutations reject symlinked package and state ancestry without external writes", async () => {
  const root = await tmp();
  const externalPackage = await tmp();
  const externalState = await tmp();
  await mkdir(join(root, ".git"));
  await mkdir(join(root, "apps"));
  await mkdir(join(externalPackage, "src"));
  await writeFile(join(root, "package.json"), JSON.stringify({ workspaces: ["apps/*"] }));
  await writeFile(join(externalPackage, "package.json"), '{"name":"escaped"}');
  await symlink(externalPackage, join(root, "apps/store"), "dir");
  const source = join(root, "confirmed.md");
  await writeFile(source, DESIGN);

  await assert.rejects(
    initializeDesign(root, { target: "apps/store/src/App.tsx", contentFile: source }),
    /symlink|contained/i,
  );
  await assert.rejects(readFile(join(externalPackage, "DESIGN.md"), "utf8"), /ENOENT/);

  await symlink(externalState, join(root, ".muster"), "dir");
  await assert.rejects(addDesignIgnore(root, "generated/**"), /symlink/i);
  await assert.rejects(installDesignProvider(root), /symlink/i);
  await assert.rejects(readFile(join(externalState, "design-ignores"), "utf8"), /ENOENT/);
  await assert.rejects(readFile(join(externalState, "design-provider.json"), "utf8"), /ENOENT/);
});

test("designGate returns immediately for non-design work and requires a current receipt for design writes", async () => {
  let traversals = 0;
  const resolveContext = async () => { traversals += 1; throw new Error("must not traverse"); };
  const ordinary = await designGate("/unused", { outcome: "refactor database indexes", write: true, resolveContext });
  assert.equal(ordinary.required, false);
  assert.equal(traversals, 0);

  const root = await tmp();
  const blocked = await designGate(root, { outcome: "implement responsive checkout UI", write: true });
  assert.equal(blocked.allowed, false);
  assert.equal(blocked.status, "HUMAN-HOLD");
  await writeFile(join(root, "DESIGN.md"), DESIGN);
  const allowed = await designGate(root, { outcome: "implement responsive checkout UI", write: true });
  assert.equal(allowed.allowed, true);
  assert.match(allowed.receipt.digest, /^[a-f0-9]{64}$/);
  assert.equal(allowed.receipt.scopeRoot, root);
});

test("read-only audit reports missing context as a finding instead of a blocker", async () => {
  const root = await tmp();
  const result = await designGate(root, { outcome: "audit the product UX", write: false, audit: true });
  assert.equal(result.allowed, true);
  assert.equal(result.finding.severity, "risk");
  assert.match(result.finding.note, /DESIGN\.md/);
});

test("bounded evidence detection caches once per unchanged wave and invalidates on scope digest", async () => {
  const root = await tmp();
  await mkdir(join(root, "src"));
  await writeFile(join(root, "src/App.tsx"), "export function App(){return <main className=\"card\">Hello</main>}\n");
  let scans = 0;
  const scan = async (...args) => { scans += 1; return detectDesignEvidence(...args); };
  const first = await scanDesign(root, { wave: "wave-1", scan });
  const second = await scanDesign(root, { wave: "wave-1", scan });
  assert.equal(first.hasEvidence, true);
  assert.deepEqual(second, first);
  assert.equal(scans, 1);
  await writeFile(join(root, "DESIGN.md"), DESIGN);
  await scanDesign(root, { wave: "wave-1", scan });
  assert.equal(scans, 2);
});

test("provider check keeps Node 20 core support and gates only the optional detector at 22.12", async () => {
  const root = await tmp();
  const oldNode = await designProviderCheck(root, { nodeVersion: "22.11.0" });
  assert.equal(oldNode.internal.available, true);
  assert.equal(oldNode.optionalDetector.supported, false);
  const supported = await designProviderCheck(root, { nodeVersion: "22.12.0" });
  assert.equal(supported.optionalDetector.supported, true);
});

test("design ignores are scoped, stable, and deduplicated", async () => {
  const root = await tmp();
  await addDesignIgnore(root, "vendor/**");
  await addDesignIgnore(root, "vendor/**");
  await addDesignIgnore(root, "generated/**");
  assert.deepEqual(await readDesignIgnores(root), ["generated/**", "vendor/**"]);
});

test("every workflow produces a context-gated harness-neutral dispatch packet", async () => {
  const root = await tmp();
  await writeFile(join(root, "DESIGN.md"), DESIGN);
  for (const workflow of DESIGN_WORKFLOWS) {
    const packet = await runDesignWorkflow(root, workflow.id, { target: "src/App.tsx", args: "checkout" });
    assert.equal(packet.workflow, workflow.id);
    assert.equal(packet.provider, "internal");
    assert.equal(packet.source.ref, DESIGN_SOURCE.ref);
    assert.equal(packet.context.designPath, join(root, "DESIGN.md"));
    assert.match(packet.context.digest, /^[a-f0-9]{64}$/);
    assert.match(packet.prompt, new RegExp(`\\b${workflow.id}\\b`, "i"));
  }
});
