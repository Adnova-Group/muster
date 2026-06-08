import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest, toBuiltin, generateNotice } from "../src/vendor.js";

test("validateManifest accepts a well-formed manifest", () => {
  const doc = { sources: [
    { id: "superpowers", kind: "local", repo: "obra/superpowers", license: "MIT",
      items: [{ from: "brainstorming/SKILL.md", id: "sp-brainstorm", roles: ["brainstorm"] }] }
  ]};
  assert.deepEqual(validateManifest(doc), { ok: true, errors: [] });
});

test("validateManifest rejects missing license / bad kind / itemless", () => {
  const doc = { sources: [{ id: "x", kind: "ftp", items: "no" }] };
  const r = validateManifest(doc);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /license/.test(e)));
  assert.ok(r.errors.some(e => /kind/.test(e)));
  assert.ok(r.errors.some(e => /items/.test(e)));
});

test("validateManifest rejects item missing from/id/roles", () => {
  const doc = { sources: [{ id: "s", kind: "local", license: "MIT", items: [{ id: "only" }] }] };
  const r = validateManifest(doc);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => /from/.test(e)));
  assert.ok(r.errors.some(e => /roles/.test(e)));
});

const src = `---\nname: brainstorming\ndescription: Explore before building\n---\n\n# Brainstorming\nDo the thing.\n`;
const item = { from: "brainstorming/SKILL.md", id: "sp-brainstorm", roles: ["brainstorm"] };
const source = { repo: "obra/superpowers", license: "MIT" };

test("toBuiltin merges provenance frontmatter, preserves body", () => {
  const r = toBuiltin(src, item, source);
  assert.equal(r.path, "plugin/builtins/sp-brainstorm/SKILL.md");
  assert.match(r.content, /muster_builtin: true/);
  assert.match(r.content, /adapted_from: obra\/superpowers brainstorming\/SKILL.md/);
  assert.match(r.content, /license: MIT/);
  assert.match(r.content, /name: brainstorming/);
  assert.match(r.content, /Do the thing\./);
});

test("toBuiltin emits a valid catalog builtin entry", () => {
  const r = toBuiltin(src, item, source);
  assert.deepEqual(r.catalogEntry, {
    id: "sp-brainstorm", kind: "builtin", roles: ["brainstorm"], rank: 50,
    provenance: { adapted_from: "obra/superpowers brainstorming/SKILL.md", license: "MIT" }
  });
});

test("toBuiltin derives name/description when source has no frontmatter", () => {
  const r = toBuiltin("# Bare\nbody", { from: "x.md", id: "wsh-x", roles: ["implement"] }, source);
  assert.match(r.content, /name: wsh-x/);
  assert.match(r.content, /body/);
});

test("toBuiltin is idempotent", () => {
  assert.equal(toBuiltin(src, item, source).content, toBuiltin(src, item, source).content);
});

test("toBuiltin keeps adapted_from on one line (no yaml wrapping)", () => {
  const longItem = { from: "plugins/some-very-long-marketplace-path/agents/extremely-long-agent-name.md", id: "wsh-x", roles: ["implement"] };
  const r = toBuiltin("# x\nbody", longItem, { repo: "wshobson/agents", license: "MIT" });
  const line = r.content.split("\n").find(l => l.startsWith("adapted_from:"));
  assert.ok(line.includes("extremely-long-agent-name.md"), "adapted_from must be on a single unwrapped line");
});

test("generateNotice lists each source repo + license once", () => {
  const entries = [
    { provenance: { adapted_from: "obra/superpowers a/SKILL.md", license: "MIT" } },
    { provenance: { adapted_from: "obra/superpowers b/SKILL.md", license: "MIT" } },
    { provenance: { adapted_from: "wshobson/agents x.md", license: "MIT" } }
  ];
  const n = generateNotice(entries);
  assert.match(n, /obra\/superpowers \(MIT\)/);
  assert.match(n, /wshobson\/agents \(MIT\)/);
  assert.equal((n.match(/obra\/superpowers/g) || []).length, 1);
});
