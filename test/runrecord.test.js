import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendState, appendFollowup } from "../src/memory.js";

async function dir() { return mkdtemp(join(tmpdir(), "muster-rr-")); }

test("appendState appends ordered lines to a run STATE file", async () => {
  const d = await dir();
  await appendState(d, "run1", "wave 0 started");
  await appendState(d, "run1", "wave 0 passed review");
  const md = await readFile(join(d, "run1.state.md"), "utf8");
  const lines = md.trim().split("\n");
  assert.match(lines[0], /wave 0 started/);
  assert.match(lines[1], /wave 0 passed review/);
});

test("appendFollowup records non-blocking findings", async () => {
  const d = await dir();
  await appendFollowup(d, "run1", { severity: "risk", note: "magic number" });
  const md = await readFile(join(d, "run1.followups.md"), "utf8");
  assert.match(md, /risk/);
  assert.match(md, /magic number/);
});
