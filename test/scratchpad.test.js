import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initScratchpad } from "../src/scratchpad.js";

describe("initScratchpad", () => {
  it("creates BRIEF.md, STATE.md, FOLLOWUPS.md on first call (created length 3)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-scratch-"));
    const result = await initScratchpad(tmp, "r1");
    assert.equal(result.created.length, 3, `expected 3 created files, got: ${JSON.stringify(result.created)}`);
    assert.ok(result.created.includes("BRIEF.md"));
    assert.ok(result.created.includes("STATE.md"));
    assert.ok(result.created.includes("FOLLOWUPS.md"));
    assert.ok(result.path.endsWith("/scratchpad/r1"), `unexpected path: ${result.path}`);
  });

  it("is idempotent: second call returns created length 0", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-scratch-"));
    await initScratchpad(tmp, "r1");
    const result2 = await initScratchpad(tmp, "r1");
    assert.equal(result2.created.length, 0, `expected 0 created on second call, got: ${JSON.stringify(result2.created)}`);
  });
});
