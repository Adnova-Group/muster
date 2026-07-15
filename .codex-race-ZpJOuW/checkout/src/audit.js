import { collectRecommendations, makeStage } from "./crew.js";

export const AUDIT_DIMENSIONS = [
  { id: "architecture", role: "architecture-review", focus: "system architecture, boundaries, coupling" },
  { id: "tech-debt", role: "tech-debt", focus: "tech debt, dead code, outdated patterns" },
  { id: "coverage", role: "test-author", focus: "test coverage gaps, untested paths" },
  { id: "simplification", role: "refactor", focus: "simplification, reuse, duplication" },
  { id: "readability", role: "code-review", focus: "human readability, maintainability" },
  { id: "security", role: "security-review", focus: "security audit (injection, secrets, unsafe IO)" }
];

// The prompt-quality dimension is conditional: it is only added when the target project
// builds prompts/agents (detect.js emits the "prompting" signal). On a plain codebase it
// would have nothing to review, so the default audit stays at the six core dimensions.
const PROMPT_DIMENSION = {
  id: "prompt-quality", role: "prompt-quality",
  focus: "prompt structure + agent/tool-prompt quality (run `muster prompt scan` to find and lint repo prompts)"
};

export function buildAuditManifest(caps = {}, opts = {}) {
  const stage = makeStage(caps, "whole-codebase review");
  const dimensions = opts.prompting ? [...AUDIT_DIMENSIONS, PROMPT_DIMENSION] : AUDIT_DIMENSIONS;

  const crew = dimensions.map(d => stage(d.role, `audit: ${d.focus}`));
  crew.push(stage("implement", "audit: remediate findings"));
  crew.push(stage("code-review", "audit: review-gate + verify"));

  const recs = collectRecommendations(caps, dimensions.map(d => d.role));

  const auditTasks = dimensions.map(d => ({
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
