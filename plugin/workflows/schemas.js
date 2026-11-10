// Result schemas for the muster Workflow scripts (docs/strategy/stage-2-contracts.md).
//
// This file has no `meta` export, so Claude Code's workflow loader skips it. Workflow
// scripts run as isolated function bodies with no imports, so plan.js, build.js and
// backlog.js each inline a copy of the schemas they pass to agent().
// test/workflows.test.js asserts that every inlined copy deep-equals the exports here.

const str = { type: "string" };
const strList = { type: "array", items: str };

export const EXEC_RESULT = {
  type: "object",
  properties: {
    taskId: str,
    status: { type: "string", enum: ["done", "blocked", "error"] },
    branch: str,
    commit: str,
    worktree: str,
    filesChanged: strList,
    testsRun: strList,
    testsPassed: { type: "boolean" },
    selfCheck: { type: "string", enum: ["PASSED", "FAILED"] },
    deviations: strList,
    skillsApplied: {
      type: "array",
      items: { type: "object", properties: { id: str, how: str, quote: str }, required: ["id", "how"] },
    },
  },
  required: ["taskId", "status", "branch", "commit", "worktree", "filesChanged", "testsRun", "testsPassed", "selfCheck", "deviations"],
};

export const REVIEW_RESULT = {
  type: "object",
  properties: {
    taskId: str,
    verdict: { type: "string", enum: ["PASS", "FAIL", "ABSTAIN"] },
    commitReviewed: str,
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: { severity: str, file: str, line: { type: "integer" }, summary: str },
        required: ["severity", "file", "summary"],
      },
    },
    testsRun: strList,
    testsPassed: { type: "boolean" },
  },
  required: ["taskId", "verdict", "commitReviewed", "findings", "testsRun", "testsPassed"],
};

export const VERIFY_RESULT = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "GAPS", "ABSTAIN"] },
    truths: {
      type: "array",
      items: {
        type: "object",
        properties: { claim: str, status: str, evidence: str },
        required: ["claim", "status", "evidence"],
      },
    },
    gaps: strList,
  },
  required: ["verdict", "truths", "gaps"],
};

export const CHECK_RESULT = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["PASS", "ISSUES"] },
    issues: {
      type: "array",
      items: {
        type: "object",
        properties: { dimension: str, severity: str, required_property: str, summary: str },
        required: ["dimension", "severity", "summary"],
      },
    },
  },
  required: ["verdict", "issues"],
};

// Planner return value. Not in the stage-2 contract table: the planner writes PLAN.md
// to disk and reports where it went and how many tasks it holds.
export const PLAN_RESULT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["done", "blocked", "error"] },
    planPath: str,
    taskCount: { type: "integer" },
    summary: str,
  },
  required: ["status", "planPath", "taskCount", "summary"],
};
