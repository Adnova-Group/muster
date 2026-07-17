import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveCapabilities } from "../src/capabilities.js";
import { tmpProject } from "../test-support/helpers.js";
import { bareCapabilities } from "./test-support/capabilities-helpers.js";

const catalog = [
  { id: "serena", kind: "external", roles: ["code-navigation"], rank: 90, recommended: true,
    detect: { kind: "mcp_server", match: "serena" } },
  { id: "muster-grep-nav", kind: "builtin", roles: ["code-navigation"], rank: 30,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "muster-planner", kind: "builtin", roles: ["plan"], rank: 50,
    provenance: { adapted_from: "superpowers", license: "MIT" } }
];

test("installed external wins over builtin", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: ["serena"] });
  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "serena", source: "installed", kind: "mcp" });
});

test("falls back to builtin when external absent", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "muster-grep-nav", source: "builtin", kind: "skill" });
});

test("recommends a better absent external", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["code-navigation"].recommendations.some(r => r.includes("serena")));
});

test("no recommendation when the recommended external is installed", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: ["serena"] });
  assert.equal(a.roles["code-navigation"].recommendations.length, 0);
});

test("role with neither external nor builtin resolves to inline", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  assert.deepEqual(a.roles["plan"].chosen, { id: "muster-planner", source: "builtin", kind: "skill" });
  assert.deepEqual(a.roles["security-review"].chosen, { id: "inline", source: "inline", kind: "inline" });
});

const agentCatalog = [
  { id: "muster-agent-planner", kind: "agent", roles: ["plan"], rank: 50,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "muster-skill-planner", kind: "builtin", roles: ["brainstorm"], rank: 50,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "low-agent", kind: "agent", roles: ["implement"], rank: 20,
    provenance: { adapted_from: "Muster", license: "Apache-2.0" } },
  { id: "ext-agent", kind: "external", roles: ["implement"], rank: 90, recommended: true,
    detect: { kind: "agent", match: "ext-agent" } }
];

test("agent builtin resolves with chosen.kind === agent", () => {
  const a = resolveCapabilities(agentCatalog, bareCapabilities());
  assert.deepEqual(a.roles["plan"].chosen, { id: "muster-agent-planner", source: "builtin", kind: "agent" });
});

test("builtin skill resolves with chosen.kind === skill", () => {
  const a = resolveCapabilities(agentCatalog, bareCapabilities());
  assert.deepEqual(a.roles["brainstorm"].chosen, { id: "muster-skill-planner", source: "builtin", kind: "skill" });
});

test("installed external agent beats a lower-ranked built-in agent", () => {
  const a = resolveCapabilities(agentCatalog, { plugins: [], skills: [], mcpServers: [], agents: ["ext-agent"] });
  assert.deepEqual(a.roles["implement"].chosen, { id: "ext-agent", source: "installed", kind: "agent" });
});

test("Cowork advertises only MCP or inline providers it can actually invoke", () => {
  const a = resolveCapabilities(
    [...catalog, ...agentCatalog],
    {
      runtime: "cowork",
      plugins: ["legacy-plugin"],
      skills: ["muster-skill-planner"],
      agents: ["ext-agent"],
      mcpServers: ["serena"],
    },
  );

  assert.deepEqual(a.roles["code-navigation"].chosen, { id: "serena", source: "installed", kind: "mcp" });
  assert.deepEqual(a.roles.implement.chosen, { id: "inline", source: "inline", kind: "inline" });
  assert.deepEqual(a.roles.plan.chosen, { id: "inline", source: "inline", kind: "inline" });
  assert.ok(
    Object.values(a.roles).every(({ chosen, chain }) =>
      [chosen, ...chain].every((provider) => provider.kind === "mcp" || provider.kind === "inline")),
    "Cowork capability output must not advertise agent or skill dispatch targets",
  );
  assert.deepEqual(a.skills, [], "Cowork has no invocable skill namespace");
});

import { loadCatalog } from "../src/catalog.js";
test("debug role resolves to a built-in on a bare machine (not inline)", async () => {
  const cat = await loadCatalog(new URL("../catalog/", import.meta.url));
  const a = resolveCapabilities(cat, { plugins: [], skills: [], mcpServers: [] });
  assert.ok(a.roles["debug"], "debug role must exist");
  assert.equal(a.roles["debug"].chosen.source, "builtin");
  assert.notEqual(a.roles["debug"].chosen.id, "inline");
});

// ---------------------------------------------------------------------------
// skills inventory: skills: [{id, source, description}]
// ---------------------------------------------------------------------------

test("skills inventory: installed skill description is parsed from SKILL.md frontmatter (~/.claude/skills lane)", async () => {
  const home = await tmpProject({
    ".claude/skills/my-skill/SKILL.md":
      "---\nname: my-skill\ndescription: Parses frontmatter to find installed skill descriptions.\n---\n# My Skill\n"
  });
  const a = resolveCapabilities(catalog, { plugins: [], skills: ["my-skill"], mcpServers: [] }, home);
  const found = a.skills.find(s => s.id === "my-skill");
  assert.ok(found, "installed skill must appear in the skills inventory");
  assert.equal(found.source, "installed");
  assert.ok(found.description.length > 0, "installed skill description must be non-empty");
  assert.equal(found.description, "Parses frontmatter to find installed skill descriptions.");
});

test("skills inventory: plugin-shipped skill (nested under .claude/plugins) also resolves a description", async () => {
  const home = await tmpProject({
    // marketplace OFFERS this — must never be matched (mirrors plugin-inventory.js's own rule)
    ".claude/plugins/marketplaces/kw/offered/skills/plugin-skill/SKILL.md":
      "---\ndescription: offered, not installed — must not win\n---\n",
    ".claude/plugins/cache/official/plugin-skill/1.0.0/skills/plugin-skill/SKILL.md":
      "---\ndescription: Ships with an installed plugin.\n---\n# Plugin skill\n"
  });
  const a = resolveCapabilities(catalog, { plugins: [], skills: ["plugin-skill"], mcpServers: [] }, home);
  const found = a.skills.find(s => s.id === "plugin-skill");
  assert.equal(found.description, "Ships with an installed plugin.");
});

test("skills inventory: missing SKILL.md degrades to an empty description, never throws", async () => {
  const home = await tmpProject({});
  assert.doesNotThrow(() => resolveCapabilities(catalog, { plugins: [], skills: ["ghost-skill"], mcpServers: [] }, home));
  const a = resolveCapabilities(catalog, { plugins: [], skills: ["ghost-skill"], mcpServers: [] }, home);
  const found = a.skills.find(s => s.id === "ghost-skill");
  assert.equal(found.description, "");
});

test("skills inventory: builtin skills carry their catalog description", () => {
  const withDesc = [
    ...catalog,
    { id: "muster-described", kind: "builtin", roles: ["plan"], rank: 10, description: "A described builtin skill.",
      provenance: { adapted_from: "Muster", license: "Apache-2.0" } }
  ];
  const a = resolveCapabilities(withDesc, { plugins: [], skills: [], mcpServers: [] });
  const found = a.skills.find(s => s.id === "muster-described");
  assert.deepEqual(found, { id: "muster-described", source: "builtin", description: "A described builtin skill." });
});

test("skills inventory: builtin skill without a catalog description degrades to an empty string, not undefined", () => {
  const a = resolveCapabilities(catalog, { plugins: [], skills: [], mcpServers: [] });
  const found = a.skills.find(s => s.id === "muster-grep-nav");
  assert.deepEqual(found, { id: "muster-grep-nav", source: "builtin", description: "" });
});

test("skills inventory: an installed skill takes precedence over a same-id builtin entry (no duplicate)", async () => {
  const home = await tmpProject({});
  const a = resolveCapabilities(catalog, { plugins: [], skills: ["muster-grep-nav"], mcpServers: [] }, home);
  const matches = a.skills.filter(s => s.id === "muster-grep-nav");
  assert.equal(matches.length, 1, "no duplicate entries for the same id");
  assert.equal(matches[0].source, "installed");
});

// Regression: a plain scalar `description:` whose value contains a mid-string
// ": " (e.g. muster's own router/orchestrator/domain-router skills, which all
// read "... Glass-box: every choice ...") is not valid as a YAML flow-mapping
// value; parsing the whole frontmatter block with a strict YAML parser throws
// on it, and the old blanket catch degraded it to "". The description line
// must be pulled out with a targeted, scalar-safe extraction instead.
test("skills inventory: a description containing a mid-string colon-space parses in full, not via a strict YAML parse", async () => {
  const home = await tmpProject({
    ".claude/skills/glass-box-skill/SKILL.md":
      "---\nname: glass-box-skill\ndescription: Assemble a thing from parts. Glass-box: every choice carries rationale, evidence, and fallback.\n---\n# Glass box skill\n"
  });
  const a = resolveCapabilities(catalog, { plugins: [], skills: ["glass-box-skill"], mcpServers: [] }, home);
  const found = a.skills.find(s => s.id === "glass-box-skill");
  assert.ok(found, "installed skill must appear in the skills inventory");
  assert.equal(
    found.description,
    "Assemble a thing from parts. Glass-box: every choice carries rationale, evidence, and fallback."
  );
});

test("skills inventory: a quoted description strips its surrounding quotes", async () => {
  const home = await tmpProject({
    ".claude/skills/quoted-skill/SKILL.md":
      '---\nname: quoted-skill\ndescription: "Has a colon: right here, and is quoted."\n---\n'
  });
  const a = resolveCapabilities(catalog, { plugins: [], skills: ["quoted-skill"], mcpServers: [] }, home);
  const found = a.skills.find(s => s.id === "quoted-skill");
  assert.equal(found.description, "Has a colon: right here, and is quoted.");
});
