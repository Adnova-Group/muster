import { chosen, collectRecommendations, modelFor } from "./crew.js";

export const AUDIT_DIMENSIONS = [
  { id: "architecture", role: "architecture-review", focus: "system architecture, boundaries, coupling" },
  { id: "tech-debt", role: "tech-debt", focus: "tech debt, dead code, outdated patterns" },
  { id: "coverage", role: "test-author", focus: "test coverage gaps, untested paths" },
  { id: "simplification", role: "refactor", focus: "simplification, reuse, duplication" },
  { id: "readability", role: "code-review", focus: "human readability, maintainability" },
  { id: "security", role: "security-review", focus: "security audit (injection, secrets, unsafe IO)" }
];

export function buildAuditManifest(caps = {}) {
  const stage = (role, rationale) => {
    const p = chosen(caps, role);
    return { stage: role, provider: p.id, source: p.source, model: modelFor(caps, role), rationale, evidence: "whole-codebase review", fallback: "inline" };
  };

  const crew = AUDIT_DIMENSIONS.map(d => stage(d.role, `audit: ${d.focus}`));
  crew.push(stage("implement", "audit: remediate findings"));
  crew.push(stage("code-review", "audit: review-gate + verify"));

  const recs = collectRecommendations(caps, AUDIT_DIMENSIONS.map(d => d.role));

  const auditTasks = AUDIT_DIMENSIONS.map(d => ({
    id: `audit-${d.id}`,
    task: `audit ${d.focus} (read-only; findings: severity/location/problem/fix)`,
    mode: "single",
    deps: []
  }));

  return {
    outcome: "Audit + remediate the codebase",
    successCriteria: [
      "findings ledger across all dimensions",
      "every issue fixed or explicitly deferred with reason",
      "regression tests added for behavior fixes",
      "full suite green",
      "no regressions introduced"
    ],
    crew,
    recommendations: recs,
    degradations: [],
    plan: [
      ...auditTasks,
      { id: "consolidate", task: "dedupe + rank all findings into one ledger", mode: "single", deps: auditTasks.map(t => t.id) },
      { id: "fix", task: "remediate all findings (TDD: failing test first where behavior changes); defer only with written reason", mode: "single", deps: ["consolidate"] },
      { id: "verify", task: "review-gate + full suite green; confirm no regressions", mode: "single", deps: ["fix"] }
    ]
  };
}
