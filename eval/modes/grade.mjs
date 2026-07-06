#!/usr/bin/env node
// Mode-prompt eval report. Loads dataset.json, resolves each code-graded case's artifacts
// (a checked-in fixture, inline `input`, or nothing — see grade-lib.mjs's ARTIFACT_KIND),
// grades it via grade-lib.mjs, and prints the per-case + aggregate report. `grading:
// "model"` cases are listed but not graded here — see README.md for why (they need a live
// model run; this stays a zero-cost, offline, CI-safe report over checked-in material).
//
// Usage: node eval/modes/grade.mjs
import { readFile } from "node:fs/promises";
import { gradeCase, ARTIFACT_KIND, resolveArtifactUrl } from "./grade-lib.mjs";

const here = new URL(".", import.meta.url);
const dataset = JSON.parse(await readFile(new URL("dataset.json", here), "utf8"));

async function loadArtifacts(testCase) {
  const kind = ARTIFACT_KIND[testCase.check];
  if (!kind || kind === "none") return undefined;
  // [P2 sec] resolveArtifactUrl contains the fixture read to the eval/modes/ tree --
  // see grade-core.mjs's header for why a bare `new URL(testCase.artifact, here)` isn't
  // safe to pass straight to readFile.
  const raw = testCase.artifact ? await readFile(resolveArtifactUrl(testCase.artifact, here), "utf8") : testCase.input;
  return kind === "json" ? JSON.parse(raw) : raw;
}

const rows = [];
let modelCount = 0;
for (const c of dataset.cases) {
  if (c.grading === "model") {
    modelCount++;
    continue;
  }
  const artifacts = await loadArtifacts(c);
  const g = gradeCase(c, artifacts);
  rows.push({ id: c.id, mode: c.mode, ...g });
}

const passing = rows.filter((r) => r.pass).length;
console.log("Mode-prompt eval —", rows.length, "code-graded cases (", modelCount, "model-graded cases excluded from this run)");
console.log("".padEnd(72, "-"));
for (const r of rows) {
  console.log(`${r.pass ? "PASS" : "FAIL"}  [${r.mode.padEnd(9)}] ${r.id}`);
  if (!r.pass) for (const chk of r.checks) if (!chk.ok) console.log(`        - ${chk.name}: ${chk.detail}`);
}
console.log("".padEnd(72, "-"));
console.log(`accuracy ${(100 * passing / rows.length).toFixed(0)}%  (${passing}/${rows.length})`);
if (passing < rows.length) process.exitCode = 1;
