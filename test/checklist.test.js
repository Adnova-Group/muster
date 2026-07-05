import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPlanChecklist } from "../src/checklist.js";

const plan = [
  { id: "a", task: "scaffold CRUD", mode: "single" },
  { id: "b", task: "token store", mode: "tournament" }
];

test("renders checkboxes; ticks done; annotates tournament", () => {
  const md = renderPlanChecklist(plan, ["a"]);
  assert.match(md, /- \[x\] a — scaffold CRUD/);
  assert.match(md, /- \[ \] b — token store \(tournament\)/);
});

test("no done ids -> all unchecked", () => {
  assert.match(renderPlanChecklist(plan), /- \[ \] a — scaffold CRUD/);
});

test("empty plan -> empty string", () => {
  assert.equal(renderPlanChecklist([]), "");
});

test("byte-identical: manifests without owns/frozen render unchanged", () => {
  const md = renderPlanChecklist(plan, ["a"]);
  assert.equal(md, "- [x] a — scaffold CRUD\n- [ ] b — token store (tournament)");
});

test("appends owns suffix when a task carries owns", () => {
  const withOwns = [{ id: "a", task: "scaffold CRUD", mode: "single", owns: ["src/manifest.js", "src/checklist.js"] }];
  const md = renderPlanChecklist(withOwns);
  assert.equal(md, "- [ ] a — scaffold CRUD [owns: src/manifest.js, src/checklist.js]");
});

test("appends frozen suffix when a task carries frozen", () => {
  const withFrozen = [{ id: "a", task: "scaffold CRUD", mode: "single", frozen: ["plugin/**"] }];
  const md = renderPlanChecklist(withFrozen);
  assert.equal(md, "- [ ] a — scaffold CRUD [frozen: plugin/**]");
});

test("appends combined owns | frozen suffix, owns first", () => {
  const both = [{ id: "a", task: "scaffold CRUD", mode: "single", owns: ["a"], frozen: ["c"] }];
  const md = renderPlanChecklist(both);
  assert.equal(md, "- [ ] a — scaffold CRUD [owns: a | frozen: c]");
});

test("combined owns | frozen suffix works alongside tournament annotation", () => {
  const both = [{ id: "b", task: "token store", mode: "tournament", owns: ["a", "b"], frozen: ["c"] }];
  const md = renderPlanChecklist(both);
  assert.equal(md, "- [ ] b — token store (tournament) [owns: a, b | frozen: c]");
});
