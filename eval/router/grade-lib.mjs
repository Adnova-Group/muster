// Pure grading logic for the router eval, shared by the CLI report (grade.mjs) and the
// CI regression test (test/router-eval.test.js). No IO here — callers pass the manifests.
import { validateManifest } from "../../src/manifest.js";

// Every stage/role/provider name + plan-task word a manifest mentions, lowercased.
export function manifestTokens(m) {
  const t = new Set();
  for (const c of m.crew || []) { if (c.stage) t.add(String(c.stage).toLowerCase()); if (c.provider) t.add(String(c.provider).toLowerCase()); }
  for (const p of m.plan || []) if (p.task) String(p.task).toLowerCase().split(/\W+/).forEach(w => t.add(w));
  return t;
}

export function covers(m, role) {
  const r = role.toLowerCase();
  for (const x of manifestTokens(m)) if (x.includes(r) || r.includes(x)) return true;
  return false;
}

// Deterministic code grade: 0 if not valid JSON / invalid manifest; 3 if valid but the
// crew is all-inline (routing bypassed); otherwise 6 for structural validity plus up to 4
// scaled by expected-role coverage.
export function codeGradeManifest(manifest, expectRoles = []) {
  let m;
  try { m = typeof manifest === "string" ? JSON.parse(manifest) : manifest; }
  catch { return { score: 0, reason: "output is not valid JSON" }; }
  if (!m || typeof m !== "object") return { score: 0, reason: "no manifest" };
  const v = validateManifest(m);
  if (!v.ok) return { score: 0, reason: `invalid manifest: ${v.errors.slice(0, 2).join("; ")}` };
  const crew = m.crew || [];
  if (crew.length > 0 && crew.every(c => c.source === "inline"))
    return { score: 3, reason: "valid but crew is all-inline (routing bypassed)" };
  const hit = expectRoles.filter(r => covers(m, r)).length;
  const coverage = expectRoles.length ? hit / expectRoles.length : 1;
  return { score: Math.round(6 + coverage * 4), reason: `valid, role coverage ${hit}/${expectRoles.length}` };
}

// Combine the code grade with the LLM-judge score for one case.
export function gradeCase({ manifest, judgeScore, expectRoles, passThreshold = 7 }) {
  const code = manifest ? codeGradeManifest(manifest, expectRoles) : { score: 0, reason: "no manifest output" };
  const model = Math.max(0, Math.min(10, Number(judgeScore) || 0));
  const score = (code.score + model) / 2;
  return { code: code.score, model, score, passing: score >= passThreshold, note: code.reason };
}
