import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initScratchpad } from "../src/scratchpad.js";

async function fileExists(p) {
  try { await readFile(p, "utf8"); return true; } catch { return false; }
}

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

  it("rejects a runId containing path traversal and scaffolds nothing outside dir", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-scratch-"));
    // A "../escape" runId would join out of the scratchpad store — a directory-
    // creation primitive that escapes the named dir. Must throw before any mkdir.
    await assert.rejects(
      () => initScratchpad(tmp, "../escape"),
      /invalid runId/,
      "a runId containing .. or a separator must throw");
    assert.equal(await fileExists(join(tmp, "..", "escape", "BRIEF.md")), false,
      "no scratchpad may be scaffolded outside the target dir");
    assert.equal(await fileExists(join(tmp, "scratchpad", "..", "escape", "BRIEF.md")), false,
      "nothing may escape via the scratchpad subdir either");
  });

  it("rejects runIds with separators or backslashes", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "muster-scratch-"));
    await assert.rejects(() => initScratchpad(tmp, "a/b"), /invalid runId/);
    await assert.rejects(() => initScratchpad(tmp, "a\\b"), /invalid runId/);
  });
});
