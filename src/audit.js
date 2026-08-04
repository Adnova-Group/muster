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

const DESIGN_DIMENSION = {
  id: "design-ux", role: "frontend",
  focus: "UX/design quality, accessibility, hierarchy, responsive behavior, and consistency; missing DESIGN.md is a finding, not a blocker"
};

// audit-pillar-pattern-library: every dimension's crew member composes with a versioned
// hunt-list PATTERN SKILL naming WHAT PATTERNS TO LOOK FOR, not just a persona -- one
// plugin/skills/audit-pattern-<pillar>/SKILL.md per pillar (see docs/decisions/
// audit-pillar-pattern-library.md for the full pillar x persona x pattern-source table). This
// reuses the audit protocol's EXISTING brief-binding mechanism unchanged: a plan task's
// `skills: [{id, rationale}]` field is already turned into a "REQUIRED SKILLS -- load before
// working" block by the orchestrator (plugin/skills/orchestrator/SKILL.md, "Required skills
// (brief binding)"), with report-back proof -- no new wiring, no protocol redesign.
//
// The "dead-code/duplication" pillar named by the item is NOT a dispatched dimension of its
// own (that would add a 9th crew role, a protocol redesign, out of scope): its hunt list
// (audit-pattern-dead-code-duplication) composes into BOTH `tech-debt` (dead-code half) and
// `simplification` (duplication half), whose `focus` text above already names those concerns.
export const PATTERN_SKILL = Object.freeze({
  architecture: [{
    id: "audit-pattern-architecture",
    rationale: "Hunt-list for the architecture audit dimension: boundary/coupling grep shapes, role-vocabulary and receipt-grammar drift checks."
  }],
  "tech-debt": [
    {
      id: "audit-pattern-tech-debt",
      rationale: "Hunt-list for the tech-debt audit dimension: zero-reference export sweep, orphaned-module detection, fs-safe/trackedMkdtempSync convention drift."
    },
    {
      id: "audit-pattern-dead-code-duplication",
      rationale: "Dead-code half of the dead-code/duplication pillar (composes with tech-debt); seeded verbatim from the 2026-08-04 cleanup-dead-exports survey."
    },
  ],
  coverage: [{
    id: "audit-pattern-coverage",
    rationale: "Hunt-list for the coverage audit dimension: untested-export sweep, branch/edge-path gaps, mutant-kill evidence check."
  }],
  simplification: [
    {
      id: "audit-pattern-simplification",
      rationale: "Hunt-list for the simplification audit dimension: repeated-shape/reuse-opportunity grep procedures, dedup-cluster precedent."
    },
    {
      id: "audit-pattern-dead-code-duplication",
      rationale: "Duplication half of the dead-code/duplication pillar (composes with simplification); seeded verbatim from the 2026-08-04 dedupe-crypto-helpers survey."
    },
  ],
  readability: [{
    id: "audit-pattern-readability",
    rationale: "Hunt-list for the readability audit dimension: oversized-function/misleading-indentation sweep, hand-rolled-duplication-of-an-existing-primitive check; seeded verbatim from the 2026-08-04 structure survey (split-codex-install + codex-install-lock-unification)."
  }],
  security: [{
    id: "audit-pattern-security",
    rationale: "Hunt-list for the security audit dimension: fs-safe.js routing check, path-traversal/symlink-guard classes, GUARD-SEP-003 remote-text re-anchoring coverage."
  }],
  "prompt-quality": [{
    id: "audit-pattern-prompt-quality",
    rationale: "Hunt-list for the prompt-quality audit dimension: points into src/prompt-lint.js's rule ids and `muster prompt scan` (single-source; read on demand, not duplicated here)."
  }],
  "design-ux": [{
    id: "audit-pattern-design-ux",
    rationale: "Hunt-list for the UX/design audit dimension: points into the pinned Impeccable audit/critique workflows and `muster design gate` (single-source; read on demand, not duplicated here)."
  }],
});

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
  const designEvidenceIncomplete = opts.designEvidence === "unknown";
  const scopeSuffix = scoped ? ` (scope: ${paths.join(", ")})` : "";
  const stage = makeStage(caps, scoped ? `scoped review: ${paths.join(", ")}` : "whole-codebase review");
  const dimensions = [
    ...AUDIT_DIMENSIONS,
    ...(opts.prompting ? [PROMPT_DIMENSION] : []),
    ...(opts.designEvidence ? [DESIGN_DIMENSION] : []),
  ];

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
    deps: [],
    skills: PATTERN_SKILL[d.id] || []
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
    plan.push({
      id: "fix",
      task: `remediate all findings (TDD: failing test first where behavior changes); defer only with written reason${
        opts.designEvidence
          ? "; before UX/design remediation, require a current `muster design gate` DESIGN.md digest receipt"
          : ""
      }`,
      mode: "single",
      deps: ["consolidate"]
    });
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
    degradations: designEvidenceIncomplete
      ? ["Design-evidence discovery was incomplete; audit-design-ux is included because truncation cannot establish absence."]
      : [],
    plan
  };
}
