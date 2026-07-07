import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { parse } from "yaml";
import { loadCatalog } from "../src/catalog.js";
import { resolveCapabilities } from "../src/capabilities.js";
import { matchProviders } from "../src/match.js";
import { modelForRole } from "../src/model.js";

// muster-runner: the dispatchable single-item lifecycle agent. These tests pin its
// DISPATCH CONTRACT deterministically (code >> model): the brief inputs it requires,
// the receipts it must return, and the gate rules it may never relax. A live dispatch
// of a freshly added agent type needs a Claude Code session restart, so this file is
// the in-CI proof that the contract travels with the definition (the restart-and-
// dispatch verification is a documented post-merge human step).

// Uncapped model policy, same guard as test/agents.muster.test.js.
delete process.env.MUSTER_MAX_TIER;

const catalogDir = new URL("../catalog/", import.meta.url);
const defUrl = new URL("../plugin/agents/muster-runner.md", import.meta.url);
const BARE = { plugins: [], skills: [], mcpServers: [], agents: [] };

async function readDef() {
  return readFile(defUrl, "utf8");
}

test("catalog entry: muster-runner is an agent with primary role lifecycle", async () => {
  const catalog = await loadCatalog(catalogDir);
  const entry = catalog.find(e => e.id === "muster-runner");
  assert.ok(entry, "catalog/agents.muster.yaml must carry a muster-runner entry");
  assert.equal(entry.kind, "agent");
  assert.equal(entry.roles[0], "lifecycle", "primary role (roles[0]) drives model policy");
  assert.ok(typeof entry.description === "string" && entry.description.trim().length > 0);
});

test("the lifecycle role resolves to muster-runner on a bare machine", async () => {
  const catalog = await loadCatalog(catalogDir);
  const caps = resolveCapabilities(catalog, BARE);
  assert.equal(caps.roles["lifecycle"].chosen.id, "muster-runner");
  assert.equal(caps.roles["lifecycle"].chosen.kind, "agent");
  assert.equal(caps.roles["lifecycle"].model, "sonnet",
    "lifecycle drives via delegation, not peak judgment — default sonnet tier");
});

test("muster-runner is reachable via muster match (description search)", async () => {
  const catalog = await loadCatalog(catalogDir);
  // The phrasing a driver (coordination / go-backlog) or a human would actually search.
  for (const task of [
    "drive one backlog item through the full lifecycle to a review-gated PR",
    "unattended single item worktree runner with review gate and receipts",
  ]) {
    const ranked = matchProviders(task, catalog, BARE);
    const hit = ranked.find(r => r.id === "muster-runner");
    assert.ok(hit, `matchProviders(${JSON.stringify(task)}) must surface muster-runner`);
  }
});

test("frontmatter: name/description/tools/model present, model matches role policy", async () => {
  const src = await readDef();
  const m = src.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(m, "muster-runner.md missing YAML frontmatter");
  const fm = parse(m[1]);
  assert.equal(fm.name, "muster-runner");
  assert.ok(fm.description && fm.description.length > 0);
  assert.equal(fm.model, modelForRole("lifecycle"));
  const tools = String(fm.tools || "");
  for (const t of ["Read", "Write", "Edit", "Bash", "Grep", "Glob"]) {
    assert.ok(tools.includes(t), `runner needs ${t} to build; tools: ${tools}`);
  }
  assert.ok(tools.includes("Task") || tools.includes("Agent"),
    "runner must be able to dispatch subagents (reviewer discipline) — needs the Agent/Task tool");
});

test("dispatch contract: the brief inputs the runner requires are named", async () => {
  const src = await readDef();
  // A dispatcher reading the def must see exactly what the BRIEF must carry.
  assert.match(src, /## Dispatch contract/i, "def must carry an explicit dispatch-contract section");
  for (const input of [
    /\bitem\b.*\bid\b|\bid\b.*\bitem\b/i, // the work item id
    /outcome|brief/i,                      // the outcome / brief text
    /worktree|branch/i,                    // isolation target
    /\bbase\b/i,                           // base ref
    /disposition/i,                        // forced disposition (pr)
  ]) {
    assert.match(src, input, `brief input ${input} must be named in the def`);
  }
});

test("dispatch contract: receipts the runner must return are named", async () => {
  const src = await readDef();
  assert.match(src, /receipts/i);
  assert.match(src, /files touched|files changed/i, "receipts must include files touched");
  assert.match(src, /pasted, not paraphrased|pasted output|paste.*output/i,
    "test evidence must be pasted, not paraphrased");
  assert.match(src, /VERDICT: PASS/, "receipts must carry the reviewer's explicit verdict");
  assert.match(src, /PR (URL|link)/i, "receipts must carry the PR URL (or the blocker)");
});

test("gate rules: explicit PASS, re-review after fixes, bounded loop, fail-loud", async () => {
  const src = await readDef();
  assert.match(src, /VERDICT: PASS/, "gate requires the explicit PASS verdict");
  assert.match(src, /re-review|back to the (same )?reviewer/i,
    "fix loops must return to the reviewer — a fix pass never self-certifies");
  assert.match(src, /BLOCKED/, "BLOCKED must be a first-class reportable outcome");
  assert.match(src, /never .*(push|merge).*main|never merge/i,
    "the runner may never merge or push to main");
  assert.match(src, /\b(three|3)\b.*(fix|attempt|loop)|(fix|attempt|loop).*\b(three|3)\b/i,
    "the fix loop must be bounded with loud escalation, not an unbounded grind");
});

test("TDD is encoded: failing test first, watch it fail", async () => {
  const src = await readDef();
  assert.match(src, /failing test/i);
  assert.match(src, /watch it fail|fails? for the right reason/i);
});
