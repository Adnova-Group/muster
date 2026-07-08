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
