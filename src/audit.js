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

// opts.paths, when non-empty, scopes the whole audit to those paths/subsystems. Kept as
// a plain list of trimmed strings so the default (whole-repo) path stays byte-identical.
function normalizePaths(paths) {
  if (!Array.isArray(paths)) return [];
  return paths.filter(p => typeof p === "string" && p.trim()).map(p => p.trim());
}

// opts.backlog switches to the read-only backlog sweep the $muster-audit skill's backlog
// mode drives (plugin/commands/audit.md): the SAME parallel dimension sweep + consolidate,
// but the ranked ledger is CAPTURED into a backlog instead of remediated. The `implement` +
// review-gate crew members and the fix/verify plan stages are dropped; a single read-only
// `capture` stage replaces them. opts.paths (either mode) scopes the sweep to given paths.
export function buildAuditManifest(caps = {}, opts = {}) {
  const backlog = !!opts.backlog;
  const paths = normalizePaths(opts.paths);
  const scoped = paths.length > 0;
  const scopeSuffix = scoped ? ` (scope: ${paths.join(", ")})` : "";
  const stage = makeStage(caps, scoped ? `scoped review: ${paths.join(", ")}` : "whole-codebase review");
  const dimensions = opts.prompting ? [...AUDIT_DIMENSIONS, PROMPT_DIMENSION] : AUDIT_DIMENSIONS;

  const crew = dimensions.map(d => stage(d.role, `audit: ${d.focus}${scopeSuffix}`));
  if (!backlog) {
    // Remediation crew — dropped in read-only backlog mode.
    crew.push(stage("implement", "audit: remediate findings"));
    crew.push(stage("code-review", "audit: review-gate + verify"));
  }

  const recs = collectRecommendations(caps, dimensions.map(d => d.role));

  const auditTasks = dimensions.map(d => ({
    id: `audit-${d.id}`,
    task: `audit ${d.focus} (read-only; findings: severity/location/problem/fix)${scopeSuffix}`,
    mode: "single",
    deps: []
  }));

  const plan = [
    ...auditTasks,
    { id: "consolidate", task: "dedupe + rank all findings into one ledger", mode: "single", deps: auditTasks.map(t => t.id) }
  ];
  if (backlog) {
    plan.push({
      id: "capture",
      task: "write the ranked findings ledger to a capture-gated backlog (.muster/backlog.md, highest severity first); read-only — no fixes, no commits",
      mode: "single",
      deps: ["consolidate"]
    });
  } else {
    plan.push({ id: "fix", task: "remediate all findings (TDD: failing test first where behavior changes); defer only with written reason", mode: "single", deps: ["consolidate"] });
    plan.push({ id: "verify", task: "review-gate + full suite green; confirm no regressions", mode: "single", deps: ["fix"] });
  }

  return {
    outcome: backlog
      ? `Audit the codebase into a ranked read-only backlog${scopeSuffix}`
      : `Audit + remediate the codebase${scopeSuffix}`,
    successCriteria: backlog
      ? [
          "findings ledger across all dimensions",
          "ranked capture-gated backlog written (highest severity first)",
          "read-only: no code changed, no fix/verify waves"
        ]
      : [
          "findings ledger across all dimensions",
          "every issue fixed or explicitly deferred with reason",
          "regression tests added for behavior fixes",
          "full suite green",
          "no regressions introduced"
        ],
    crew,
    recommendations: recs,
    degradations: [],
    plan
  };
}
