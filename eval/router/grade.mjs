#!/usr/bin/env node
// Router eval grader. Deterministic half of the harness: given the router's outputs (the
// Crew Manifests it produced per case) plus the LLM-judge scores, it code-grades each
// manifest (validates + checks expected-role coverage + flags all-inline crews), combines
// with the judge score, and reports per-case + aggregate accuracy.
//
// Usage: node eval/router/grade.mjs eval/router/results.json
//   results.json = { "cases": [ { "id", "manifest": <object|string>, "judgeScore": 0-10,
//                                 "judgeReason": "..." } ] }
// The dataset (tasks, expectRoles, passThreshold) is read from eval/router/dataset.json.
import { readFile } from "node:fs/promises";
import { validateManifest } from "../../src/manifest.js";

const here = new URL(".", import.meta.url);
const dataset = JSON.parse(await readFile(new URL("dataset.json", here), "utf8"));
const resultsPath = process.argv[2] || new URL("results.json", here).pathname;
const results = JSON.parse(await readFile(resultsPath, "utf8"));
const byId = Object.fromEntries(results.cases.map(c => [c.id, c]));

// Every stage/role/provider name a manifest mentions, lowercased, for loose role coverage.
function manifestTokens(m) {
  const t = new Set();
  for (const c of m.crew || []) { if (c.stage) t.add(String(c.stage).toLowerCase()); if (c.provider) t.add(String(c.provider).toLowerCase()); }
  for (const p of m.plan || []) if (p.task) String(p.task).toLowerCase().split(/\W+/).forEach(w => t.add(w));
  return t;
}
const covers = (m, role) => {
  const tok = manifestTokens(m);
  const r = role.toLowerCase();
  for (const x of tok) if (x.includes(r) || r.includes(x)) return true;
  return false;
};

function codeGradeManifest(manifest, expectRoles) {
  let m;
  try { m = typeof manifest === "string" ? JSON.parse(manifest) : manifest; }
  catch { return { score: 0, reason: "output is not valid JSON" }; }
  const v = validateManifest(m);
  if (!v.ok) return { score: 0, reason: `invalid manifest: ${v.errors.slice(0, 2).join("; ")}` };
  const crew = m.crew || [];
  if (crew.length > 0 && crew.every(c => c.source === "inline"))
    return { score: 3, reason: "valid but crew is all-inline (routing bypassed)" };
  const hit = expectRoles.filter(r => covers(m, r)).length;
  const coverage = expectRoles.length ? hit / expectRoles.length : 1;
  // Structural validity (6) + a routing-shape bonus scaled by expected-role coverage (4).
  return { score: Math.round(6 + coverage * 4), reason: `valid, role coverage ${hit}/${expectRoles.length}` };
}

async function loadManifest(id) {
  try { return JSON.parse(await readFile(new URL(`out/${id}.json`, here), "utf8")); }
  catch { return null; }
}

const rows = [];
for (const c of dataset.cases) {
  const r = byId[c.id];
  if (!r) { rows.push({ id: c.id, code: 0, model: 0, score: 0, passing: false, note: "MISSING judge result" }); continue; }
  const manifest = await loadManifest(c.id);
  const code = manifest ? codeGradeManifest(manifest, c.expectRoles) : { score: 0, reason: "no manifest output" };
  const model = Math.max(0, Math.min(10, Number(r.judgeScore) || 0));
  const score = (code.score + model) / 2;
  rows.push({ id: c.id, code: code.score, model, score, passing: score >= dataset.passThreshold, note: code.reason });
}

const passing = rows.filter(r => r.passing).length;
const avg = rows.reduce((s, r) => s + r.score, 0) / rows.length;
console.log("Router eval —", rows.length, "cases, passThreshold", dataset.passThreshold);
console.log("".padEnd(58, "-"));
for (const r of rows)
  console.log(`${r.passing ? "PASS" : "FAIL"}  ${r.id.padEnd(20)} code ${String(r.code).padStart(2)}/10  judge ${String(r.model).padStart(2)}/10  -> ${r.score.toFixed(1)}  (${r.note})`);
console.log("".padEnd(58, "-"));
console.log(`accuracy ${(100 * passing / rows.length).toFixed(0)}%  (${passing}/${rows.length})   avg score ${avg.toFixed(2)}/10`);
