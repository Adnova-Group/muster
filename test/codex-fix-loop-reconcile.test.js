import assert from "node:assert/strict";
import { test } from "node:test";
import { createCodexFixLoopBinding, planCodexFixContinuation } from "../src/codex-fix-loop.js";

test("Codex fix continuation retains worker context and sends only blocker deltas", () => {
  const roleProfile = {
    id: "muster-runner",
    model: "gpt-5.6-sol",
    reasoningEffort: "medium",
    sandboxMode: "workspace-write",
    developerInstructions: "Implement and verify."
  };
  const context = {
    cwd: "/worktrees/item",
    baseSha: "a".repeat(40),
    codexVersion: "codex-cli 0.145.0",
    roleProfilePath: "/profiles/muster-runner.toml",
    roleProfile
  };
  const binding = createCodexFixLoopBinding({
    lane: "spawn_agent",
    workerId: "/root/item-builder",
    ...context
  });

  const continuation = planCodexFixContinuation({
    binding,
    current: context,
    reviewState: {
      sentBlockers: ["old finding"],
      currentBlockers: ["old finding", "repair exact-SHA mismatch"]
    }
  });

  assert.equal(continuation.mechanism, "followup_task");
  assert.equal(continuation.target, "/root/item-builder");
  assert.deepEqual(continuation.blockers, ["repair exact-SHA mismatch"]);
  assert.doesNotMatch(continuation.message, /old finding|prior transcript|success criteria/i);
});
