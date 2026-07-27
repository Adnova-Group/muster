// test/docs-currency.test.js — 0.4.1 currency drift guard for user-facing docs.
//
// Backlog item docs-currency-041: keep the agent count, role count, and the muster-authored
// agent roster in README/docs/architecture.md/website/** anchored to their authoritative
// sources (src/roles.js, plugin/agents/) rather than hand-maintained numbers that can drift
// (see docs/anti-patterns.md #9, "Generated-artifact model-tier drift", for the same class
// of problem in a different artifact). Also pins that the two docs added alongside the
// muster-runner agent (docs/anti-patterns.md, docs/binding-interface.md) stay reachable from
// the docs/architecture.md index.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { CODEX_COUNTS, CODEX_MODEL_POLICY } from "../src/codex.js";
import { ROLES } from "../src/roles.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

async function musterAgentIds() {
  const files = await readdir(new URL("plugin/agents/", root));
  return files
    .filter((f) => f.startsWith("muster-") && f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""))
    .sort();
}

// ─── role count anchored to src/roles.js ─────────────────────────────────────

test("docs/architecture.md's stated role count matches src/roles.js", async () => {
  const text = await read("docs/architecture.md");
  const m = text.match(/There are (\d+) of them \(see `src\/roles\.js`\)/);
  assert.ok(m, "docs/architecture.md must state the role count anchored to src/roles.js");
  assert.equal(Number(m[1]), ROLES.length, `doc says ${m[1]} roles, src/roles.js has ${ROLES.length}`);
});

test("website/reference/architecture.md's stated role count matches src/roles.js", async () => {
  const text = await read("website/reference/architecture.md");
  const m = text.match(/There are (\d+) of them \(`src\/roles\.js`\)/);
  assert.ok(m, "website/reference/architecture.md must state the role count anchored to src/roles.js");
  assert.equal(Number(m[1]), ROLES.length, `doc says ${m[1]} roles, src/roles.js has ${ROLES.length}`);
});

test("website/reference/concepts.md's stated role count matches src/roles.js", async () => {
  const text = await read("website/reference/concepts.md");
  const m = text.match(/(\d+) in all\)/);
  assert.ok(m, "website/reference/concepts.md must state the role count as 'N in all'");
  assert.equal(Number(m[1]), ROLES.length, `doc says ${m[1]} roles, src/roles.js has ${ROLES.length}`);
});

// ─── muster-authored agent roster anchored to plugin/agents/ ────────────────

test("docs/architecture.md's clean-room specialists sentence lists every muster-authored agent in plugin/agents/, and no others", async () => {
  const text = await read("docs/architecture.md");
  const sentence = text.match(/Alongside the vendored material, Muster ships its own clean-room specialists in `plugin\/agents\/`:[^\n]*\./);
  assert.ok(sentence, "docs/architecture.md must carry the 'Alongside the vendored material...' clean-room specialists sentence");
  const ids = await musterAgentIds();
  for (const id of ids) {
    assert.match(sentence[0], new RegExp("`" + id + "`"), `docs/architecture.md's clean-room specialists sentence is missing \`${id}\``);
  }
  const listed = [...sentence[0].matchAll(/`(muster-[a-z]+)`/g)].map((m) => m[1]);
  for (const id of new Set(listed)) {
    assert.ok(ids.includes(id), `docs/architecture.md's clean-room specialists sentence names \`${id}\`, which has no file in plugin/agents/`);
  }
});

test("website/about/credits.md lists every muster-authored agent in plugin/agents/, and no others", async () => {
  const text = await read("website/about/credits.md");
  const ids = await musterAgentIds();
  for (const id of ids) {
    assert.match(text, new RegExp("\\*\\*" + id + "\\*\\*"), `website/about/credits.md is missing **${id}**`);
  }
  const listed = [...text.matchAll(/\*\*(muster-[a-z]+)\*\*/g)].map((m) => m[1]);
  for (const id of new Set(listed)) {
    assert.ok(ids.includes(id), `website/about/credits.md names **${id}**, which has no file in plugin/agents/`);
  }
});

// ─── new-doc reachability from the docs index ────────────────────────────────

test("docs/architecture.md points at the anti-pattern ledger (docs/anti-patterns.md reachable from the docs index)", async () => {
  const text = await read("docs/architecture.md");
  assert.match(
    text,
    /docs\/anti-patterns\.md/,
    "docs/architecture.md must reference docs/anti-patterns.md so the ledger is reachable from the architecture index"
  );
});

// ─── research/current-state references anchored to generated Codex sources ──

const ownedCurrencyDocs = [
  "docs/research/codex-cli.md",
  "docs/research/codex-desktop.md",
  "docs/research/kimi-code-cli.md",
  "docs/fast-path-token-gap.md"
];

test("current research docs identify the shared live agent manifest", async () => {
  for (const path of [
    "docs/research/codex-cli.md",
    "docs/research/kimi-code-cli.md",
    "docs/fast-path-token-gap.md",
  ]) {
    const text = await read(path);
    assert.match(
      text,
      /catalog\/agents\.manifest\.json/,
      `${path} must identify the shared live catalog/agents.manifest.json`
    );
  }
});

test("current Codex research inventories match the generated plugin surface", async () => {
  const totalSkills = CODEX_COUNTS.publicSkills + CODEX_COUNTS.internalSkills;
  const expectedInventory = new RegExp(
    `${totalSkills} skills \\(${CODEX_COUNTS.publicSkills} public \\+ ${CODEX_COUNTS.internalSkills} internal\\).*${CODEX_COUNTS.mcpTools} MCP tools`
  );
  for (const path of ["docs/research/codex-cli.md", "docs/research/codex-desktop.md"]) {
    const text = await read(path);
    assert.match(text, expectedInventory, `${path} must state the current generated Codex surface`);
    assert.match(text, /\$muster-init/, `${path} must include Init in the current public skill inventory`);
  }
});

test("current Codex docs match live model policy, installer, marketplace, and dispatch-version behavior", async () => {
  const [architecture, cli, desktop] = await Promise.all([
    read("docs/architecture.md"),
    read("docs/research/codex-cli.md"),
    read("docs/research/codex-desktop.md"),
  ]);
  const scout = CODEX_MODEL_POLICY.tiers.scout;
  const core = CODEX_MODEL_POLICY.tiers.core;
  assert.match(architecture, new RegExp(`bounded[^.]+${core.model}[^.]+${core.effort}`, "i"));
  assert.match(architecture, new RegExp(`locator[^.]+${scout.model}[^.]+${scout.effort}`, "i"));
  assert.match(architecture, /security[^.]+gpt-5\.6-sol[^.]+xhigh/i);

  for (const [path, text] of [["docs/research/codex-cli.md", cli], ["docs/research/codex-desktop.md", desktop]]) {
    assert.match(text, /ensureCodexThreadLimits[\s\S]{0,260}restoreCodexThreadLimits/);
    assert.doesNotMatch(text, /nothing in muster currently writes[^.]+max_threads/i, `${path} must not present the retired thread-limit gap as current`);
  }
  assert.match(desktop, /source:[\s\S]{0,80}path:[\s\S]{0,40}\.\/\.agents\/plugins\/plugin/);
  assert.doesNotMatch(desktop, /entry uses `source:[\s\S]{0,100}path:\s*\n?\s*["`]?\.\x2fplugin/i);
  assert.match(cli, /resolveCodexMultiAgentVersion[\s\S]{0,220}(?:v1[\s\S]{0,80}v2|v2[\s\S]{0,80}v1)/);
  assert.doesNotMatch(cli, /muster hardcodes the v2 packet/i);
});

test("ChatGPT Work compatibility is explicitly unverified rather than inherited from Codex", async () => {
  for (const path of [
    "docs/research/gpt-work.md",
    "docs/research/reference-harness-design.md",
    "docs/strategy/native-delegation.md",
  ]) {
    const text = await read(path);
    assert.match(text, /Work-mode load probe|Work load probe/i, `${path} must name the missing compatibility probe`);
    assert.match(text, /unverified/i, `${path} must label compatibility unverified`);
    assert.doesNotMatch(text, /Codex lane covers (?:ChatGPT Work|it)|ChatGPT Work = Codex substrate|same AGENTS\.md\/skills\/hooks\/MCP surface/i);
  }
});

test("current Cowork research uses the live MCP tool count and phase-3-gated dispatch contract", async () => {
  const manifest = JSON.parse(await read("cowork/manifest.json"));
  for (const path of [
    "docs/research/claude-cowork.md",
    "docs/research/reference-harness-design.md",
    "docs/strategy/native-delegation.md",
  ]) {
    const text = await read(path);
    assert.match(text, new RegExp(`${manifest.tools.length}-tool MCP server`), `${path} must state the live Cowork tool count`);
    assert.doesNotMatch(text, /\b21-tool MCP server\b|all twenty-one tools/i, `${path} must not present the retired count as current`);
    assert.doesNotMatch(text, /Dispatch is confirmed working/i, `${path} must not claim dispatch without a retained phase-3 receipt`);
    assert.match(text, /phase-3/i, `${path} must identify the dispatch evidence gate`);
  }
});
