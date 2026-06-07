import { test } from "node:test";
import assert from "node:assert/strict";
import { validateManifest } from "../src/vendor.js";

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
