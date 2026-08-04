// test/audit-pattern-skills.test.js — audit-pillar-pattern-library item, extended by
// audit-pattern-batch2 (the 10th, documentation, pattern skill).
//
// Proves the item's hard criterion: 0 audit pillars remain persona-only. Every pillar named
// (architecture, tech-debt, coverage, simplification, readability, security, UX/design,
// prompt quality, dead-code/duplication, documentation) resolves to a real, on-disk hunt-list
// pattern skill (plugin/skills/audit-pattern-<pillar>/SKILL.md), and buildAuditManifest's
// generated plan composes that skill onto the dimension's persona via the SAME `plan[].skills:
// [{id, rationale}]` brief-binding mechanism the orchestrator already turns into a "REQUIRED
// SKILLS -- load before working" block (plugin/skills/orchestrator/SKILL.md) -- no new wiring.
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

test("every one of the 10 named pillars resolves to an on-disk SKILL.md with matching frontmatter name", async () => {
  for (const [pillar, skillId] of Object.entries(NAMED_PILLARS)) {
    const text = await read(`plugin/skills/${skillId}/SKILL.md`).catch((e) => {
      assert.fail(`pillar "${pillar}" has no resolvable pattern skill at plugin/skills/${skillId}/SKILL.md: ${e.message}`);
    });
    const fm = frontmatter(text);
    assert.match(fm, new RegExp(`^name:\\s*${skillId}\\s*$`, "m"), `${skillId}/SKILL.md frontmatter name must match its directory`);
    assert.match(fm, /^description:\s*\S/m, `${skillId}/SKILL.md must carry a non-empty description`);
  }
});

test("every audit-pattern-* directory under plugin/skills is one of the 10 named pillars (no orphaned pattern skill)", async () => {
  const dirs = (await readdir(new URL("plugin/skills", root), { withFileTypes: true }))
    .filter((d) => d.isDirectory() && d.name.startsWith("audit-pattern-"))
    .map((d) => d.name);
  assert.deepEqual(dirs.sort(), Object.values(NAMED_PILLARS).sort());
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

test("buildAuditManifest: every dimension's plan task carries its bound pattern skill(s) in `skills`", () => {
  const m = buildAuditManifest({}, { prompting: true, designEvidence: true });
  assert.ok(validateManifest(m).ok, `manifest must validate: ${JSON.stringify(validateManifest(m).errors)}`);
  const auditTasks = m.plan.filter((p) => p.id.startsWith("audit-"));
  assert.equal(auditTasks.length, 8, "6 core + prompt-quality + design-ux");
  for (const task of auditTasks) {
    const dimId = task.id.slice("audit-".length);
    const expected = PATTERN_SKILL[dimId];
    assert.ok(Array.isArray(task.skills) && task.skills.length > 0, `plan task "${task.id}" has no skills binding -- composition not wired`);
    assert.deepEqual(task.skills, expected, `plan task "${task.id}".skills must equal PATTERN_SKILL["${dimId}"]`);
  }
});

test("backlog mode and scoped mode still carry the same skills bindings (composition survives every mode)", () => {
  const backlog = buildAuditManifest({}, { backlog: true, prompting: true, designEvidence: true });
  const scoped = buildAuditManifest({}, { paths: ["src/"] });
  for (const m of [backlog, scoped]) {
    const auditTasks = m.plan.filter((p) => p.id.startsWith("audit-"));
    assert.ok(auditTasks.length > 0);
    for (const task of auditTasks) {
      const dimId = task.id.slice("audit-".length);
      assert.deepEqual(task.skills, PATTERN_SKILL[dimId]);
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

test("every canonical audit-pattern-* SKILL.md passes muster's own prompt-lint gate (repo-wide scan, 0 failing among them)", async () => {
  const result = await scanRepoPrompts(new URL("../", import.meta.url).pathname);
  // Scoped to the CANONICAL plugin/skills/ location -- the pattern-library-ripples item added
  // a portable-package mirror at the repo-root skills/audit-pattern-*/SKILL.md too (the same
  // Agent Plugins shim convention every other plugin/skills/* entry already has), which also
  // matches a loose "audit-pattern-" substring filter; disambiguate by path prefix so this
  // count stays exactly 9 regardless of how many portable copies exist.
  const mine = result.prompts.filter((p) => p.file.startsWith("plugin/skills/audit-pattern-"));
  assert.equal(mine.length, 10, "all 10 canonical pattern skills must be discovered as prompt docs by the repo-wide scan");
  const failing = mine.filter((p) => !p.passing);
  assert.deepEqual(failing, [], `audit-pattern-* SKILL.md file(s) failing prompt-lint: ${JSON.stringify(failing)}`);
});

test("every portable audit-pattern-* skill shim (repo-root skills/) also passes prompt-lint", async () => {
  const result = await scanRepoPrompts(new URL("../", import.meta.url).pathname);
  const portable = result.prompts.filter((p) => p.file.startsWith("skills/audit-pattern-") && !p.file.startsWith("plugin/"));
  assert.equal(portable.length, 10, "all 10 portable pattern-skill shims must be discovered as prompt docs by the repo-wide scan");
  const failing = portable.filter((p) => !p.passing);
  assert.deepEqual(failing, [], `portable audit-pattern-* SKILL.md shim(s) failing prompt-lint: ${JSON.stringify(failing)}`);
});
