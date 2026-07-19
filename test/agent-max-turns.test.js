import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { parse } from "yaml";

// Claude Code's subagent frontmatter supports a hard `maxTurns` cap
// (docs/research/claude-code-cli.md:142, subagents-config source at :262). This
// test pins the class -> cap sizing table (mirrored, with rationale, as a comment
// block in plugin/agents/muster-builder.md) so every plugin/agents/*.md def carries
// a native cap coherent with its role class instead of relying on prose alone.

const AGENTS_DIR = new URL("../plugin/agents/", import.meta.url);

const CLASS_MAP = {
  // mechanical/surgical -- 1-2 file edits, read-only locating, doc/tutorial recipes
  // over given sources. Lowest ceiling: the task shape is bounded by construction.
  15: [
    "muster-surgeon",
    "muster-investigator",
    "wsh-api-documenter",
    "wsh-tutorial-engineer",
  ],
  // implementation -- the default lane. 25 is the existing burn-lesson prose ceiling
  // (one-follow-up-max quota discipline), now enforced natively instead of by prose
  // alone. Every wsh "engineer"/builder role not named in another tier lands here.
  25: [
    "muster-builder",
    "wsh-business-analyst",
    "wsh-content-marketer",
    "wsh-customer-support",
    "wsh-data-engineer",
    "wsh-data-scientist",
    "wsh-database-optimizer",
    "wsh-debugger",
    "wsh-devops-troubleshooter",
    "wsh-frontend-developer",
    "wsh-legacy-modernizer",
    "wsh-ml-engineer",
    "wsh-prompt-engineer",
    "wsh-test-automator",
  ],
  // review/strategy -- gates other work (verdicts, architecture, retrospectives);
  // needs headroom for a deep re-read plus re-verification, coherent with Codex's
  // own 10-heartbeat review/strategy-class extension ceiling (PR #83).
  35: [
    "muster-reviewer",
    "muster-strategist",
    "muster-improver",
    "wsh-code-reviewer",
    "wsh-backend-architect",
    "wsh-cloud-architect",
    "wsh-docs-architect",
  ],
  // security -- the one rare, high-consequence xhigh lane, coherent with Codex's
  // own 14-heartbeat wsh-security-auditor-specific extension ceiling (PR #83).
  40: [
    "wsh-security-auditor",
  ],
  // orchestrator -- NOT a leaf. muster-runner drives a whole item lifecycle
  // (detect -> route -> spec gate -> build wave -> review gate with up to 3 fix
  // loops -> disposition), dispatching builder/reviewer SUB-agents and waiting on
  // them; its turns are mostly cheap dispatch-and-wait, not leaf rumination the
  // burn-lesson ceiling guards against. A leaf-sized cap (the 25 it wrongly
  // carried) kills it mid-lifecycle -- observed 2026-07-19 halting every
  // go-backlog runner right after baseline. This is a runaway backstop, not a
  // work budget; it must never falsely terminate a legitimate lifecycle.
  200: [
    "muster-runner",
  ],
};

function expectedCapFor(id) {
  for (const [cap, ids] of Object.entries(CLASS_MAP)) {
    if (ids.includes(id)) return Number(cap);
  }
  return undefined;
}

test("class map classifies each agent exactly once (no duplicates)", () => {
  const classified = Object.values(CLASS_MAP).flat();
  assert.equal(new Set(classified).size, classified.length, "an agent id appears in more than one tier");
});

test("the sizing tiers are monotonically ordered mechanical < implementation < review/strategy < security < orchestrator", () => {
  const tiers = Object.keys(CLASS_MAP).map(Number).sort((a, b) => a - b);
  assert.deepEqual(tiers, [15, 25, 35, 40, 200]);
});

test("every plugin/agents/*.md carries a maxTurns cap coherent with its role class", async () => {
  const files = (await readdir(AGENTS_DIR)).filter(f => f.endsWith(".md"));
  assert.ok(files.length > 0, "plugin/agents must contain agent defs");

  const classified = Object.values(CLASS_MAP).flat();
  let covered = 0;
  for (const file of files) {
    const id = file.slice(0, -3);
    const expected = expectedCapFor(id);
    assert.ok(expected !== undefined, `${id} is not classified in the sizing table -- add it to CLASS_MAP`);
    const src = await readFile(new URL(file, AGENTS_DIR), "utf8");
    const m = src.match(/^---\n([\s\S]*?)\n---/);
    assert.ok(m, `${id}.md missing YAML frontmatter`);
    const fm = parse(m[1]);
    assert.equal(typeof fm.maxTurns, "number", `${id} maxTurns must be a number`);
    assert.equal(fm.maxTurns, expected, `${id} maxTurns should be ${expected} for its role class`);
    covered++;
  }
  assert.equal(covered, classified.length,
    `iterated ${covered} agent files but the sizing table classifies ${classified.length} entries -- keep CLASS_MAP and plugin/agents in sync (a new agent file needs a new CLASS_MAP entry, and vice versa)`);
});
