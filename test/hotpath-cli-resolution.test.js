// Guards the performance-pass fix for criterion 1 (zero npx cold-starts in a run): every
// standalone run-entry command file must resolve $MUSTER_CLI ONCE, using the exact
// snippet src/cli-resolve.js exports (so the doc and the code cannot silently drift apart
// — same pattern as test/docs-currency.test.js for other anchored facts), and every
// hot-path skill file invoked during a single `/muster:go` run must reuse that variable
// instead of re-invoking `npx -y @adnova-group/muster` per call.
//
// The ONE allowed literal `npx -y @adnova-group/muster` per entry-point file is the
// fallback branch INSIDE the resolution snippet itself — that line is data (the last-resort
// invocation string), not a call site.
//
// weight-reduction item, criterion 4: audit.md/diagnose.md/capture.md/plan.md/
// plan-backlog.md were the remaining standalone entry points still on raw `npx -y` (named
// as follow-up candidates in docs/performance-pass.md's "Scope of this wave" section) —
// they now get the identical binding go.md/go-backlog.md already carry. runner.md,
// autopilot.md, sprint.md, and run.md were checked too: none shell a raw npx call
// themselves (they delegate to go.md/go-backlog.md's own instructions), so they need no
// snippet of their own and are deliberately not in this list.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { RESOLUTION_SHELL_SNIPPET } from "../src/cli-resolve.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

const NPX_MUSTER = /npx -y @adnova-group\/muster/g;

const ENTRY_POINT_FILES = [
  "plugin/commands/go.md",
  "plugin/commands/go-backlog.md",
  "plugin/commands/audit.md",
  "plugin/commands/diagnose.md",
  "plugin/commands/capture.md",
  "plugin/commands/plan.md",
  "plugin/commands/plan-backlog.md",
];

// Markdown nests the ```bash fence under a numbered list item, so every line in the doc
// carries extra leading whitespace beyond the snippet's own internal indentation
// (RESOLUTION_SHELL_SNIPPET's first line has none, its body lines have 2 spaces). Extract
// the fenced block and strip the common leading indent shared by every line before
// comparing — the snippet is semantically identical either way (shell ignores leading
// whitespace), only the markdown-nesting indent differs.
function extractBashFence(text) {
  const m = text.match(/```bash\n([\s\S]*?)\n *```/);
  if (!m) return null;
  const lines = m[1].split("\n");
  const commonIndent = Math.min(
    ...lines.filter((l) => l.trim().length > 0).map((l) => l.match(/^ */)[0].length)
  );
  return lines.map((l) => l.slice(commonIndent)).join("\n");
}

// Skill files read WITHIN a single go/go-backlog run's shell session — $MUSTER_CLI from
// the entry point's resolution step is still in scope, so these must carry ZERO literal
// npx call sites (they never re-embed the resolution snippet themselves).
const HOTPATH_SKILL_FILES = [
  "plugin/skills/orchestrator/SKILL.md",
  "plugin/skills/review-gate/SKILL.md",
  "plugin/skills/router/SKILL.md",
];

test("every standalone entry-point command file embeds the canonical CLI-resolution snippet (same shell logic as src/cli-resolve.js, modulo markdown list-nesting indent)", async () => {
  for (const file of ENTRY_POINT_FILES) {
    const text = await read(file);
    const fenced = extractBashFence(text);
    assert.ok(fenced, `${file} must have a \`\`\`bash fenced CLI-resolution snippet`);
    assert.equal(
      fenced, RESOLUTION_SHELL_SNIPPET,
      `${file}'s fenced snippet must match src/cli-resolve.js's RESOLUTION_SHELL_SNIPPET exactly (so doc and code cannot drift)`
    );
  }
});

test("every standalone entry-point command file carries exactly one literal npx-muster string — the fallback line inside the resolution snippet", async () => {
  for (const file of ENTRY_POINT_FILES) {
    const text = await read(file);
    const matches = text.match(NPX_MUSTER) || [];
    assert.equal(
      matches.length, 1,
      `${file}: expected exactly 1 literal 'npx -y @adnova-group/muster' (the snippet's fallback branch), found ${matches.length}`
    );
  }
});

test("hot-path skill files invoked within a go run carry zero literal npx-muster call sites", async () => {
  for (const file of HOTPATH_SKILL_FILES) {
    const text = await read(file);
    const matches = text.match(NPX_MUSTER) || [];
    assert.equal(
      matches.length, 0,
      `${file}: expected zero literal 'npx -y @adnova-group/muster' call sites (must reuse $MUSTER_CLI resolved by the invoking entry point), found ${matches.length}`
    );
  }
});

test("go.md's step 4 (spec gate) and orchestrator/SKILL.md's step 4c (review gate) both reference gate-cadence's small-task fast path", async () => {
  const go = await read("plugin/commands/go.md");
  assert.match(go, /gate-cadence/, "go.md must reference the gate-cadence fast path");

  const orchestrator = await read("plugin/skills/orchestrator/SKILL.md");
  assert.match(orchestrator, /gate-cadence/, "orchestrator/SKILL.md must consult gate-cadence");
  assert.match(orchestrator, /fastPath/, "orchestrator/SKILL.md must branch on fastPath");
});

test("orchestrator/SKILL.md and review-gate/SKILL.md dedup the capabilities lookup instead of re-invoking it per wave", async () => {
  const orchestrator = await read("plugin/skills/orchestrator/SKILL.md");
  assert.match(
    orchestrator,
    /\.muster\/capabilities\.json/,
    "orchestrator/SKILL.md must read the run's captured .muster/capabilities.json instead of re-invoking `capabilities` per wave"
  );

  const reviewGate = await read("plugin/skills/review-gate/SKILL.md");
  assert.match(
    reviewGate,
    /\.muster\/capabilities\.json/,
    "review-gate/SKILL.md's Inputs must read the run's captured .muster/capabilities.json, not re-invoke `capabilities`"
  );
});
