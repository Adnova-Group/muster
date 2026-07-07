// Pure grading logic for the router eval, shared by the CLI report (grade.mjs) and the
// CI regression test (test/router-eval.test.js). No IO here — callers pass the manifests.
import { validateManifest } from "../../src/manifest.js";
import { lastColonSegment } from "../../src/match.js";

// Every crew member's stage, lowercased. Stage is the role name verbatim — validateManifest
// requires it, and every crew builder in this codebase sets it exactly — so it's the only
// reliable match target for expected-role coverage.
export function manifestTokens(m) {
  const t = new Set();
  for (const c of m.crew || []) if (c.stage) t.add(String(c.stage).toLowerCase());
  return t;
}

// Exact stage match, not substring/token overlap: this used to also fold in provider names
// and plan-task words (split(/\W+/) on the task text) and match via `x.includes(r) ||
// r.includes(x)`. A plan task ending in punctuation (e.g. "...findings.") makes split(/\W+/)
// yield a trailing "" token, and `r.includes("")` is true for ANY role `r` — so that trailing
// empty token alone made covers() report every expected role "covered" regardless of actual
// crew composition (see eval/modes/grade-lib.mjs's roleCoverage / crewCoversRoles checks,
// which document and avoid the same trap with the same exact-match fix).
export function covers(m, role) {
  return manifestTokens(m).has(role.toLowerCase());
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

// --- Skill-binding assertions (Luca regression, t7) -------------------------------------
// "skills[] is non-empty" is an explicit anti-pattern: a router could bind an arbitrary or
// wrong skill and still pass a bare non-empty check. These helpers assert against the
// ACTUAL bound skill id — compared via last-colon-segment, namespace-insensitive, mirroring
// src/match.js's lastColonSegment — and require both prose fields (rationale, evidence) to
// carry real content, not just be present-but-blank.

// True if `task.skills` contains a binding whose last-colon-segment id matches `wantId`
// AND that binding carries non-empty rationale + evidence strings.
export function bindsSkill(task, wantId) {
  const want = lastColonSegment(wantId).toLowerCase();
  return (task?.skills || []).some(s =>
    s && typeof s.id === "string" && lastColonSegment(s.id).toLowerCase() === want &&
    typeof s.rationale === "string" && s.rationale.trim().length > 0 &&
    typeof s.evidence === "string" && s.evidence.trim().length > 0
  );
}

// True if the manifest's `degradations` array records a skill-gap line for `techniqueId`
// (last-colon-segment, case-insensitive substring match against the free-text line).
export function hasSkillGapDegradation(manifest, techniqueId) {
  const want = lastColonSegment(techniqueId).toLowerCase();
  return (manifest?.degradations || []).some(d =>
    typeof d === "string" && d.toLowerCase().includes("skill-gap") && d.toLowerCase().includes(want));
}

// True if the manifest's `recommendations` array proposes a fix naming `techniqueId` — not
// just a bare mention, the gap protocol requires a concrete next step (author/install).
export function hasSkillGapRecommendation(manifest, techniqueId) {
  const want = lastColonSegment(techniqueId).toLowerCase();
  return (manifest?.recommendations || []).some(r => typeof r === "string" && r.toLowerCase().includes(want));
}
