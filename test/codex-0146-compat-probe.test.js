import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareMcpContracts,
  evaluateConnectionReuse,
  evaluateSkillCatalogEvidence,
  validateGeneratedSkillInventory,
} from "../scripts/codex-0146-compat-probe.mjs";

const expectedSkills = [
  { name: "muster-go", locator: "/skills/muster-go/SKILL.md" },
  { name: "muster-runner", locator: "/skills/muster-runner/SKILL.md" },
];

test("skill-catalog pressure is UNKNOWN without captured host evidence", () => {
  assert.deepEqual(evaluateSkillCatalogEvidence({ expectedSkills }), {
    status: "UNKNOWN",
    reason: "host-skill-catalog-evidence-not-provided",
    expectedCount: 2,
  });
});

test("skill-catalog pressure passes only when truncation and every name/locator are observed", () => {
  const evidence = {
    descriptionTruncationObserved: true,
    entries: [
      {
        name: "muster:muster-go",
        locator: "file: r3/muster-go/SKILL.md",
        description: "Use for Muster orches...",
      },
      {
        name: "muster:muster-runner",
        locator: "file: r3/muster-runner/SKILL.md",
        description: "Use for Muster orches...",
      },
    ],
  };

  assert.deepEqual(evaluateSkillCatalogEvidence({ expectedSkills, evidence }), {
    status: "PASS",
    reason: "all-expected-names-and-locators-retained-under-observed-description-truncation",
    expectedCount: 2,
    observedCount: 2,
  });
});

test("skill-catalog pressure fails closed when host evidence omits an expected locator", () => {
  const evidence = {
    descriptionTruncationObserved: true,
    entries: [
      { name: "muster-go", locator: "/skills/muster-go/SKILL.md", description: "short..." },
      { name: "muster-runner", locator: "", description: "short..." },
    ],
  };

  assert.deepEqual(evaluateSkillCatalogEvidence({ expectedSkills, evidence }), {
    status: "FAIL",
    reason: "expected-skill-name-or-locator-missing",
    expectedCount: 2,
    observedCount: 2,
    missing: [{ name: "muster-runner", locator: "/skills/muster-runner/SKILL.md" }],
  });
});

test("MCP contract comparison covers initialize, tools/list, and representative tools/call", () => {
  const toolNames = ["muster_detect", ...Array.from({ length: 29 }, (_, index) => `muster_tool_${index}`)];
  const before = {
    protocolVersion: "2025-06-18",
    toolNames,
    representativeCall: { name: "muster_detect", ok: true, resultShape: ["greenfield", "languages", "vcs"] },
  };
  const after = {
    protocolVersion: "2025-06-18",
    toolNames: [...toolNames].reverse(),
    representativeCall: { name: "muster_detect", ok: true, resultShape: ["vcs", "languages", "greenfield"] },
  };

  assert.deepEqual(compareMcpContracts(before, after), {
    status: "PASS",
    reason: "mcp-contract-stable-across-rebuild",
    protocolVersion: "2025-06-18",
    toolCount: 30,
    representativeTool: "muster_detect",
  });

  assert.equal(compareMcpContracts(before, { ...after, toolNames: ["muster_detect"] }).status, "FAIL");
});

test("degenerate identical MCP snapshots cannot fabricate PASS", () => {
  const empty = {
    protocolVersion: undefined,
    toolNames: [],
    representativeCall: { name: "muster_detect", ok: true, resultShape: [] },
  };
  const result = compareMcpContracts(empty, empty);
  assert.equal(result.status, "FAIL");
  assert.deepEqual(result.failures, [
    "unsupported-initialize-protocol",
    "unexpected-tool-count",
    "muster-detect-tool-missing",
    "representative-result-shape-invalid",
  ]);
});

test("generated skill inventory is pinned to the canonical 13 public skills", () => {
  const empty = validateGeneratedSkillInventory([]);
  assert.equal(empty.status, "FAIL");
  assert.equal(empty.expectedCount, 13);
  assert.equal(empty.observedCount, 0);

  const canonical = [
    "autopilot", "muster", "muster-audit", "muster-capture", "muster-diagnose",
    "muster-go", "muster-go-backlog", "muster-init", "muster-plan",
    "muster-plan-backlog", "muster-runner", "run", "sprint",
  ];
  assert.equal(validateGeneratedSkillInventory(canonical).status, "PASS");
});

test("connection reuse stays bounded UNKNOWN because repository probes cannot observe host connection identity", () => {
  assert.deepEqual(evaluateConnectionReuse(), {
    status: "UNKNOWN",
    reason: "host-internal-mcp-connection-identity-unobservable",
    observed: false,
  });
});
