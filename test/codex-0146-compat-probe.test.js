import { test } from "node:test";
import assert from "node:assert/strict";
import {
  compareMcpContracts,
  evaluateConnectionReuse,
  evaluateSkillCatalogEvidence,
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
  const before = {
    protocolVersion: "2025-06-18",
    toolNames: ["muster_assess", "muster_detect"],
    representativeCall: { name: "muster_detect", ok: true, resultShape: ["greenfield", "languages", "vcs"] },
  };
  const after = {
    protocolVersion: "2025-06-18",
    toolNames: ["muster_detect", "muster_assess"],
    representativeCall: { name: "muster_detect", ok: true, resultShape: ["vcs", "languages", "greenfield"] },
  };

  assert.deepEqual(compareMcpContracts(before, after), {
    status: "PASS",
    reason: "mcp-contract-stable-across-rebuild",
    protocolVersion: "2025-06-18",
    toolCount: 2,
    representativeTool: "muster_detect",
  });

  assert.equal(compareMcpContracts(before, { ...after, toolNames: ["muster_detect"] }).status, "FAIL");
});

test("connection reuse stays bounded UNKNOWN because repository probes cannot observe host connection identity", () => {
  assert.deepEqual(evaluateConnectionReuse(), {
    status: "UNKNOWN",
    reason: "host-internal-mcp-connection-identity-unobservable",
    observed: false,
  });
});
