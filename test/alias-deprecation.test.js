// test/alias-deprecation.test.js — drift guard for the legacy-alias deprecation
// window (item: legacy-alias-retirement, opening the sunset of run/autopilot/sprint).
//
// This item starts the window, it does not close it: a dated one-time notice ships
// naming the replacement verb and a concrete retirement target, docs across the repo
// stop claiming the aliases are "not deprecated on any schedule," and — critically —
// nothing about the alias's own behavior changes yet (it still delegates to its
// target verb, byte-identical Read-and-execute directive). These tests pin the two
// fixed tokens the notice carries (DEPRECATION_DATE, RETIREMENT_TARGET) across every
// surface that documents the aliases' fate, and re-assert the "no behavior change"
// promise against the same alias-shape contract test/mode-evals.test.js already pins.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

// Single source of truth for this test file's own expectations. The command files
// themselves are the actual canonical source (each carries its own dated notice);
// these constants exist so every assertion below checks for the SAME date/target,
// not independently-typo-able copies of the same two facts.
const DEPRECATION_DATE = "2026-07-17";
const RETIREMENT_TARGET = "muster 0.7.0";
const ALIASES = { run: "plan", autopilot: "go", sprint: "go-backlog" };

test("deprecation notice: every alias command file's guidance line carries the dated notice and names the retirement target", async () => {
  for (const alias of Object.keys(ALIASES)) {
    const text = await read(`plugin/commands/${alias}.md`);
    assert.ok(
      text.includes(`Deprecation notice (${DEPRECATION_DATE})`),
      `${alias}.md must carry "Deprecation notice (${DEPRECATION_DATE})"`,
    );
    assert.ok(
      text.includes(`retires in ${RETIREMENT_TARGET}`),
      `${alias}.md must name the retirement target "retires in ${RETIREMENT_TARGET}"`,
    );
  }
});

test("deprecation notice: the notice lives in the SAME paragraph as the heads-up line, not a new third paragraph (alias-shape stays exactly 2 paragraphs)", async () => {
  for (const alias of Object.keys(ALIASES)) {
    const text = await read(`plugin/commands/${alias}.md`);
    const fmMatch = text.match(/^---\n[\s\S]*?\n---\n/);
    assert.ok(fmMatch, `${alias}.md must open with a --- frontmatter block`);
    const body = text.slice(fmMatch[0].length).trim();
    const paragraphs = body.split(/\n\n+/).map((p) => p.trim()).filter(Boolean);
    assert.equal(paragraphs.length, 2, `${alias}.md body must stay exactly 2 paragraphs — the deprecation notice must not add a third`);
    assert.match(paragraphs[0], /^Heads-up for the user/, `${alias}.md's first paragraph must still open with the heads-up line`);
    assert.match(paragraphs[0], new RegExp(`Deprecation notice \\(${DEPRECATION_DATE}\\)`), `${alias}.md's guidance paragraph must carry the deprecation notice`);
  }
});

test("deprecation notice: no behavior change during the window — each alias still delegates to its target verb unchanged", async () => {
  for (const [alias, target] of Object.entries(ALIASES)) {
    const text = await read(`plugin/commands/${alias}.md`);
    assert.match(
      text,
      new RegExp(`Read plugin/commands/${target}\\.md \\(resolve relative to this file's own directory / the plugin root\\) and execute its instructions exactly, with the arguments given to this command\\.`),
      `${alias}.md must still delegate byte-identically to ${target}.md — the deprecation window changes the notice, never the behavior`,
    );
  }
});

test("deprecation notice: README.md's alias line names the same notice date and retirement target, and no longer claims an open-ended window", async () => {
  const text = await read("README.md");
  assert.ok(text.includes(DEPRECATION_DATE), `README.md must name the deprecation date ${DEPRECATION_DATE}`);
  assert.ok(text.includes(RETIREMENT_TARGET), `README.md must name the retirement target ${RETIREMENT_TARGET}`);
  assert.doesNotMatch(text, /not deprecated on any schedule/, "README.md must not still claim the aliases are undeprecated");
});

test("deprecation notice: docs/architecture.md names the same notice date and retirement target", async () => {
  const text = await read("docs/architecture.md");
  assert.ok(text.includes(DEPRECATION_DATE), `docs/architecture.md must name the deprecation date ${DEPRECATION_DATE}`);
  assert.ok(text.includes(RETIREMENT_TARGET), `docs/architecture.md must name the retirement target ${RETIREMENT_TARGET}`);
});

test("deprecation notice: website reference/modes.md and guides/install.md name the retirement target", async () => {
  for (const f of ["website/reference/modes.md", "website/guides/install.md"]) {
    const text = await read(f);
    assert.ok(text.includes(RETIREMENT_TARGET), `${f} must name the retirement target ${RETIREMENT_TARGET}`);
    assert.doesNotMatch(text, /not deprecated on any schedule/, `${f} must not still claim the aliases are undeprecated`);
  }
});

test("deprecation notice: website guides/quickstart.md names the retirement target once per alias section (3 total)", async () => {
  const text = await read("website/guides/quickstart.md");
  const escaped = RETIREMENT_TARGET.replace(/\./g, "\\.");
  const hits = text.match(new RegExp(escaped, "g")) || [];
  assert.equal(hits.length, 3, "expected the retirement target named once in each of run/autopilot/sprint's one-line notes");
});
