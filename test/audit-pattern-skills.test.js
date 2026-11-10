// test/audit-pattern-skills.test.js — audit-pillar-pattern-library item, extended by
// audit-pattern-batch2 (the 10th, documentation, pattern skill).
//
// Proves the item's hard criterion: 0 audit pillars remain persona-only. Every pillar named
// (architecture, tech-debt, coverage, simplification, readability, security, UX/design,
// prompt quality, dead-code/duplication, documentation) resolves to a real, on-disk hunt-list
// pattern file, and buildAuditManifest's generated plan composes it onto the dimension's persona.
// Revival stage 2b moved the files from plugin/skills/ to plugin/commands/audit/references/
// (read by path, so they cost nothing per session) and the binding from a `skills` array to
// the hunt-list paths named in each audit task's own text.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { AUDIT_DIMENSIONS, buildAuditManifest, PATTERN_SKILL } from "../src/audit.js";
import { validateManifest } from "../src/manifest.js";
import { scanRepoPrompts } from "../src/prompt-scan.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

// The 10 named pillars (the audit-pillar-pattern-library item's original 9, plus the
// audit-pattern-batch2 item's approved 10th, `documentation`), mapped to the dimension
// id(s)/skill id that cover them. 10 pillar NAMES, but only 8 are dispatched crew dimensions --
// dead-code/duplication composes into tech-debt + simplification, and documentation composes
// into readability + design-ux, instead of either adding its own crew role (see src/audit.js's
// PATTERN_SKILL comment for the full rationale).
const NAMED_PILLARS = {
  architecture: "audit-pattern-architecture",
  "tech-debt": "audit-pattern-tech-debt",
  coverage: "audit-pattern-coverage",
  simplification: "audit-pattern-simplification",
  readability: "audit-pattern-readability",
  security: "audit-pattern-security",
  "UX/design": "audit-pattern-design-ux",
  "prompt quality": "audit-pattern-prompt-quality",
  "dead-code/duplication": "audit-pattern-dead-code-duplication",
  documentation: "audit-pattern-documentation",
};

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  assert.ok(m, "file must open with a --- frontmatter block");
  return m[1];
}

// ── (a) every pillar has a resolvable pattern skill: 0 persona-only ────────────────────────

const REF_DIR = "plugin/commands/audit/references";

test("every one of the 10 named pillars resolves to an on-disk hunt list with matching frontmatter name", async () => {
  for (const [pillar, skillId] of Object.entries(NAMED_PILLARS)) {
    const text = await read(`${REF_DIR}/${skillId}.md`).catch((e) => {
      assert.fail(`pillar "${pillar}" has no resolvable hunt list at ${REF_DIR}/${skillId}.md: ${e.message}`);
    });
    const fm = frontmatter(text);
    assert.match(fm, new RegExp(`^name:\\s*${skillId}\\s*$`, "m"), `${skillId}/SKILL.md frontmatter name must match its directory`);
    assert.match(fm, /^description:\s*\S/m, `${skillId}/SKILL.md must carry a non-empty description`);
  }
});

test("every audit-pattern-* hunt list is one of the 10 named pillars, and none is a listed skill any more", async () => {
  const files = (await readdir(new URL(REF_DIR, root), { withFileTypes: true }))
    .filter((d) => d.isFile() && d.name.startsWith("audit-pattern-"))
    .map((d) => d.name.replace(/\.md$/, ""));
  assert.deepEqual(files.sort(), Object.values(NAMED_PILLARS).sort());
  const skillDirs = (await readdir(new URL("plugin/skills", root), { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith("audit-pattern-"));
  assert.deepEqual(skillDirs, [], "audit-pattern-* must not ship as per-session skills");
});

test("PATTERN_SKILL covers every dimension id AUDIT_DIMENSIONS/PROMPT/DESIGN can produce, non-empty", () => {
  const ids = [...AUDIT_DIMENSIONS.map((d) => d.id), "prompt-quality", "design-ux"];
  for (const id of ids) {
    const bound = PATTERN_SKILL[id];
    assert.ok(Array.isArray(bound) && bound.length > 0, `dimension "${id}" has no bound pattern skill -- persona-only`);
    for (const entry of bound) {
      assert.equal(typeof entry.id, "string");
      assert.ok(entry.id.startsWith("audit-pattern-"), `${id}: bound skill id "${entry.id}" is not an audit-pattern-* skill`);
      assert.ok(entry.rationale && entry.rationale.trim().length > 0, `${id}: bound skill "${entry.id}" needs a non-empty rationale`);
    }
  }
});

test("the dead-code/duplication pillar composes into BOTH tech-debt and simplification (not a 9th crew role)", () => {
  for (const dim of ["tech-debt", "simplification"]) {
    assert.ok(
      PATTERN_SKILL[dim].some((s) => s.id === "audit-pattern-dead-code-duplication"),
      `dimension "${dim}" must bind audit-pattern-dead-code-duplication`
    );
  }
  assert.ok(!AUDIT_DIMENSIONS.some((d) => d.id === "dead-code-duplication"), "dead-code-duplication must not be a separate dispatched dimension");
});

test("the documentation pillar composes into BOTH readability and design-ux (not a 10th crew role)", () => {
  for (const dim of ["readability", "design-ux"]) {
    assert.ok(
      PATTERN_SKILL[dim].some((s) => s.id === "audit-pattern-documentation"),
      `dimension "${dim}" must bind audit-pattern-documentation`
    );
  }
  assert.ok(!AUDIT_DIMENSIONS.some((d) => d.id === "documentation"), "documentation must not be a separate dispatched dimension");
});

// ── (b) composition wiring: generated briefs (plan[].skills) carry the reference ───────────

const huntPaths = (dimId) => PATTERN_SKILL[dimId].map((s) => `<plugin root>/${REF_DIR.replace(/^plugin\//, "")}/${s.id}.md`);

test("buildAuditManifest: every dimension's plan task names its bound hunt list(s) by path", () => {
  const m = buildAuditManifest({}, { prompting: true, designEvidence: true });
  assert.ok(validateManifest(m).ok, `manifest must validate: ${JSON.stringify(validateManifest(m).errors)}`);
  const auditTasks = m.plan.filter((p) => p.id.startsWith("audit-"));
  assert.equal(auditTasks.length, 8, "6 core + prompt-quality + design-ux");
  for (const task of auditTasks) {
    const dimId = task.id.slice("audit-".length);
    assert.equal(task.skills, undefined, `plan task "${task.id}" must not carry a skills binding`);
    for (const path of huntPaths(dimId)) assert.ok(task.task.includes(path), `plan task "${task.id}" must name ${path}`);
  }
});

test("backlog mode and scoped mode still name the same hunt lists (composition survives every mode)", () => {
  const backlog = buildAuditManifest({}, { backlog: true, prompting: true, designEvidence: true });
  const scoped = buildAuditManifest({}, { paths: ["src/"] });
  for (const m of [backlog, scoped]) {
    const auditTasks = m.plan.filter((p) => p.id.startsWith("audit-"));
    assert.ok(auditTasks.length > 0);
    for (const task of auditTasks) {
      const dimId = task.id.slice("audit-".length);
      for (const path of huntPaths(dimId)) assert.ok(task.task.includes(path), `${task.id} must name ${path}`);
    }
  }
});

test("non-dimension plan tasks (consolidate/fix/verify/capture) carry no skills binding (no invention)", () => {
  const m = buildAuditManifest({}, { prompting: true, designEvidence: true });
  for (const task of m.plan.filter((p) => !p.id.startsWith("audit-"))) {
    assert.equal(task.skills, undefined, `plan task "${task.id}" must not invent a skills binding`);
  }
});

// ── (c) packaging-surface lint parity: the new skills pass the repo's own prompt-lint gate ──

test("every audit-pattern-* hunt list passes muster's own prompt-lint gate (repo-wide scan, 0 failing among them)", async () => {
  const result = await scanRepoPrompts(new URL("../", import.meta.url).pathname);
  const mine = result.prompts.filter((p) => p.file.startsWith(`${REF_DIR}/audit-pattern-`));
  assert.equal(mine.length, 10, "all 10 hunt lists must be discovered as prompt docs by the repo-wide scan");
  const failing = mine.filter((p) => !p.passing);
  assert.deepEqual(failing, [], `audit-pattern-* SKILL.md file(s) failing prompt-lint: ${JSON.stringify(failing)}`);
});
