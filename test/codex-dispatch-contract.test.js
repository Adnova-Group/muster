// codex-dispatch-single-source item (audit 2026-07-29, slice D): the skill split left two
// maintained copies of the Codex dispatch contract -- scripts/build-codex.mjs's wholesale
// replacement texts and the canonical reference
// (plugin/skills/orchestrator/references/codex-dispatch.md) -- and they had already drifted
// on the fork_turns semantics and dropped the v1 (`multi_agent_v1`) shape entirely. The
// build now extracts the fork contract paragraph and the v1/v2 shapes table VERBATIM from
// the reference (loadCodexDispatchContract, throw-on-miss) and embeds them into the
// shipped orchestrator skill and go-backlog command. These guards pin that the shipped
// prose carries the reference's exact blocks, so a future hand-edit to either side fails
// here instead of silently forking the contract again.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repoRoot, selectedPluginRoot } from "../test-support/codex-helpers.js";

const REFERENCE = join(repoRoot, "plugin", "skills", "orchestrator", "references", "codex-dispatch.md");

// Mirrors loadCodexDispatchContract's extraction in scripts/build-codex.mjs exactly.
async function extractRefBlock(startMarker) {
  const ref = await readFile(REFERENCE, "utf8");
  const start = ref.indexOf(startMarker);
  const end = start < 0 ? -1 : ref.indexOf("\n\n", start);
  assert.ok(start >= 0 && end >= 0, `reference block starting at ${JSON.stringify(startMarker)} must exist`);
  return ref.slice(start, end);
}

test("shipped Codex orchestrator embeds the reference's fork_turns contract verbatim", async () => {
  const forkTurns = await extractRefBlock("`fork_turns` (v2 only)");
  const orchestrator = await readFile(join(selectedPluginRoot, "internal-skills", "orchestrator", "SKILL.md"), "utf8");
  assert.ok(
    orchestrator.includes(forkTurns),
    "orchestrator must carry the reference's fork_turns paragraph byte-for-byte (single source: references/codex-dispatch.md)"
  );
  // the aligned semantics: mechanism (positive string is the useful middle) AND the
  // standing quota policy (explicit user request only, never "all")
  assert.match(forkTurns, /useful middle/);
  assert.match(forkTurns, /explicitly requests/);
  assert.match(forkTurns, /never use `"all"`/);
});

test("shipped Codex go-backlog command routes production waves through codex-wave only", async () => {
  const goBacklog = await readFile(join(selectedPluginRoot, "commands", "go-backlog.md"), "utf8");
  assert.match(goBacklog, /codex-wave <wave\.json>/);
  assert.match(goBacklog, /Production waves are process-only/);
  assert.match(goBacklog, /never invoke a shared-CWD or inline dispatch path from the backlog or manifest/);
});

test("shipped Codex orchestrator carries BOTH multi-agent API shapes, not v2-only", async () => {
  const shapesTable = await extractRefBlock("| | v2 (`sol`, `terra`)");
  const orchestrator = await readFile(join(selectedPluginRoot, "internal-skills", "orchestrator", "SKILL.md"), "utf8");
  assert.ok(
    orchestrator.includes(shapesTable),
    "orchestrator must carry the reference's v1/v2 shapes table byte-for-byte"
  );
  assert.match(orchestrator, /multi_agent_v1\.spawn_agent/, "muster's core tier (gpt-5.6-luna) is v1 -- the v1 shape must ship");
  assert.match(orchestrator, /collaboration\.spawn_agent/);
  assert.match(orchestrator, /VERSION-DEPENDENT/, "the version-dependence warning must ship with the table");
  assert.match(orchestrator, /never hardcode one shape/);
});
