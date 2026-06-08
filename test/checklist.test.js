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
