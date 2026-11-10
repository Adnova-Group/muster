import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { bareCapabilities } from "./test-support/capabilities-helpers.js";

const CATALOG = new URL("../catalog/", import.meta.url);
const AGENTS_DIR = new URL("../plugin/agents/", import.meta.url);

// Agent layer: provenance is honored per source, the ladder prefers installed > agent > skill,
// every agent file has a catalog entry (and vice versa), and the dispatch docs wire chosen.kind.

// muster-test-writer and muster-integration-checker: the dev-team seats (docs/strategy/dev-team-topologies.md).
const GSD_SEATS = ["muster-executor", "muster-test-writer", "muster-integration-checker"];

test("muster agents credit their upstream (atomic-claude role concept, gsd-core for the lifecycle seats); vendored agents carry MIT provenance", async () => {
  const catalog = await loadCatalog(CATALOG);
  const agents = catalog.filter(e => e.kind === "agent");
  assert.ok(agents.length >= 13, "expected the muster + vendored agents");
  for (const a of agents) {
    assert.ok(!("adapted_from" in a.provenance) && !("inspired_by" in a.provenance), `${a.id}: adapted_from/inspired_by are retired`);
    if (a.id.startsWith("muster-")) {
      assert.equal(a.provenance.license, "Apache-2.0", `${a.id} should be Apache-2.0`);
      // muster-runner is a multi-source clean-room synthesis; the role specialists
      // take only the role concept from atomic-claude (full record: vendor/manifest.yaml).
      // The stage-2 lifecycle seats are adapted from gsd-core agents; the reviewer keeps its
      // atomic-claude role concept alongside the gsd-code-reviewer body.
      if (a.id === "muster-runner") assert.ok(a.provenance.upstream.includes("obra/superpowers"), "muster-runner credits its mechanism sources");
      else if (GSD_SEATS.includes(a.id)) assert.deepEqual(a.provenance.upstream, ["open-gsd/gsd-core"], `${a.id} must credit gsd-core`);
      else if (a.id === "muster-reviewer") assert.deepEqual(a.provenance.upstream, ["open-gsd/gsd-core", "damusix/atomic-claude"], "muster-reviewer credits gsd-core and atomic-claude");
      else assert.deepEqual(a.provenance.upstream, ["damusix/atomic-claude"], `${a.id} must credit atomic-claude`);
    } else if (a.id.startsWith("intent-")) {
      // Merge-tracked from ghaida/intent (CC0-1.0 public-domain dedication).
      assert.equal(a.provenance.license, "CC0-1.0", `${a.id} vendored intent agent should be CC0-1.0`);
      assert.deepEqual(a.provenance.upstream, ["ghaida/intent"], `${a.id} must record its upstream source`);
    } else {
      assert.equal(a.provenance.license, "MIT", `${a.id} vendored agent should be MIT`);
      assert.deepEqual(a.provenance.upstream, ["wshobson/agents"], `${a.id} must record its upstream source`);
    }
  }
});

test("the ladder prefers installed external agent > muster agent > skill", async () => {
  const catalog = await loadCatalog(CATALOG);
  // bare machine: implement has no installed external -> a muster agent wins over any skill
  const bare = resolveCapabilities(catalog, bareCapabilities());
  assert.equal(bare.roles.implement.chosen.kind, "agent", "muster agent should win implement on a bare machine");
  assert.equal(bare.roles.implement.chosen.id, "muster-executor", "the executor is the default implementer (rank 56)");

  // if an external agent is installed for a role, it outranks the built-in agent
  const externalForImplement = catalog.find(e => e.kind === "external" && e.roles.includes("implement"));
  if (externalForImplement) {
    const m = externalForImplement.detect.match;
    const withExt = resolveCapabilities(catalog, { plugins: [m], skills: [m], mcpServers: [m], agents: [m] });
    assert.equal(withExt.roles.implement.chosen.source, "installed", "installed external must win when present");
  }
});

// The stage-2 Workflow seats are dispatched by agent type (`muster:muster-planner`, ...)
// from plugin/workflows/*.js, never through capability routing, and they have no Codex
// profile (Workflow is a Claude Code primitive). So they carry no catalog entry; the
// executor and reviewer seats replace routable agents and keep theirs.
const WORKFLOW_ONLY_SEATS = ["muster-planner", "muster-plan-checker", "muster-verifier"];

test("every plugin/agents/*.md has a catalog entry and every agent entry has a file", async () => {
  const catalog = await loadCatalog(CATALOG);
  const agentIds = new Set(catalog.filter(e => e.kind === "agent").map(e => e.id));
  const files = (await readdir(AGENTS_DIR)).filter(f => f.endsWith(".md"));
  const fileIds = new Set(files.map(f => f.slice(0, -3)).filter(id => !WORKFLOW_ONLY_SEATS.includes(id)));
  for (const id of WORKFLOW_ONLY_SEATS) assert.ok(!agentIds.has(id), `${id} is a Workflow-only seat and must stay out of capability routing`);
  for (const id of agentIds) assert.ok(fileIds.has(id), `agent "${id}" has no plugin/agents/${id}.md`);
  for (const id of fileIds) assert.ok(agentIds.has(id), `orphan agent file ${id}.md has no catalog entry`);
});

// Revival stage 2b: this pins the frozen Codex lane input; the Claude command/skill moved to the Workflow core.
test("orchestrator + go dispatch by chosen.kind and apply the role model", async () => {
  const orch = await readFile(new URL("../codex/frozen/skills/orchestrator/SKILL.md", import.meta.url), "utf8");
  assert.match(orch, /chosen\.kind/, "orchestrator must dispatch by chosen.kind");
  assert.match(orch, /subagent_type|agentType/, "orchestrator must dispatch agents as the subagent type");
  assert.match(orch, /model.*override|override.*model/i, "orchestrator must pass the role model as an override");
  // go.md is the canonical hands-off runner; the autopilot.md alias was retired
  // in 0.7.0.
  const go = await readFile(new URL("../codex/frozen/commands/go.md", import.meta.url), "utf8");
  assert.match(go, /chosen\.kind|provider kind/, "go must note provider-kind dispatch");
});
