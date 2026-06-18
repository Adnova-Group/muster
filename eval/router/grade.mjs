#!/usr/bin/env node
// Router eval report. Loads the router's produced manifests (out/<id>.json) + the judge
// scores (results.json), grades each via grade-lib, and prints the per-case + aggregate
// report. Grading logic lives in grade-lib.mjs (shared with the CI regression test).
//
// Usage: node eval/router/grade.mjs [results.json]
import { readFile } from "node:fs/promises";
import { gradeCase } from "./grade-lib.mjs";

const here = new URL(".", import.meta.url);
const dataset = JSON.parse(await readFile(new URL("dataset.json", here), "utf8"));
const resultsPath = process.argv[2] ? new URL(process.argv[2], `file://${process.cwd()}/`) : new URL("results.json", here);
const results = JSON.parse(await readFile(resultsPath, "utf8"));
const byId = Object.fromEntries(results.cases.map(c => [c.id, c]));

async function loadManifest(id) {
  try { return JSON.parse(await readFile(new URL(`out/${id}.json`, here), "utf8")); }
  catch { return null; }
}

const rows = [];
for (const c of dataset.cases) {
  const r = byId[c.id];
  const manifest = await loadManifest(c.id);
  const g = gradeCase({ manifest, judgeScore: r ? r.judgeScore : 0, expectRoles: c.expectRoles, passThreshold: dataset.passThreshold });
  rows.push({ id: c.id, ...g, note: r ? g.note : "MISSING judge result" });
}

const passing = rows.filter(r => r.passing).length;
const avg = rows.reduce((s, r) => s + r.score, 0) / rows.length;
console.log("Router eval —", rows.length, "cases, passThreshold", dataset.passThreshold);
console.log("".padEnd(72, "-"));
for (const r of rows)
  console.log(`${r.passing ? "PASS" : "FAIL"}  ${r.id.padEnd(20)} code ${String(r.code).padStart(2)}/10  judge ${String(r.model).padStart(2)}/10  -> ${r.score.toFixed(1)}  (${r.note})`);
console.log("".padEnd(72, "-"));
console.log(`accuracy ${(100 * passing / rows.length).toFixed(0)}%  (${passing}/${rows.length})   avg score ${avg.toFixed(2)}/10`);
