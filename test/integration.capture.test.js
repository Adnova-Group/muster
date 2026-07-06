import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Capture domain: the conversation-to-backlog generator — the third and final backlog
// generator alongside the interview skill's decomposition check and audit's backlog mode.
// It is pure protocol markdown (no new deterministic src/ code): these tests assert the
// command reuses the shared backlog-write machinery rather than re-deriving a divergent format.

test("capture.md reuses the interview skill's decomposition/backlog machinery by reference", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  assert.match(cmd, /interview skill/i, "capture.md must reference the interview skill's shared rules");
  assert.match(cmd, /plugin\/skills\/interview\/SKILL\.md/, "capture.md must point at the interview skill file");
});

test("capture.md follows the shared backlog item grammar (id/deps/measurable/dedupe)", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  assert.match(cmd, /muster assess/, "capture.md must validate each item via assess");
  assert.match(cmd, /clear: ?true/, "capture.md must require clear:true per item");
  assert.match(cmd, /\{id:/, "capture.md must require an {id} slug per item");
  assert.match(cmd, /\{deps: ?none\}/, "capture.md must require explicit {deps: none} for independent items");
  assert.match(cmd, /dedupe|Dedupe/i, "capture.md must dedupe against the existing backlog");
  assert.match(cmd, /skip/i, "capture.md must skip duplicate items rather than append them");
});

test("capture.md gates the write on human approval via AskUserQuestion before writing", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  assert.match(cmd, /AskUserQuestion/, "capture.md must use the AskUserQuestion selection UI");
  // the present/approve step must precede the write step
  const presentIdx = cmd.search(/\*\*Present\*\*/);
  const writeIdx = cmd.search(/\*\*Write\*\*/);
  assert.ok(presentIdx > -1 && writeIdx > -1 && presentIdx < writeIdx, "approval must precede the write");
});

test("capture.md create-or-appends the backlog file and never clobbers existing lines", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  assert.match(cmd, /\.muster\/backlog\.md/, "capture.md must target .muster/backlog.md");
  assert.match(cmd, /NEVER remove, reorder, or rewrite/i, "capture.md must never clobber existing backlog lines");
});

test("capture.md offers run-first-item / run-whole-backlog / just-save after writing", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  assert.match(cmd, /first item now/i);
  assert.match(cmd, /muster:sprint/);
  assert.match(cmd, /just save/i);
});

test("capture.md's extract step names explicit exclusions with a >10 candidate cap", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  const exclusionsIdx = cmd.search(/\*\*Exclusions\*\*/);
  const capIdx = cmd.search(/\*\*Cap\*\*/);
  assert.ok(exclusionsIdx > -1, "capture.md must have an explicit Exclusions list in the extract step");
  assert.ok(capIdx > exclusionsIdx, "the candidate cap must follow the exclusions list");
  // structural: the exclusions block itself must enumerate at least 3 distinct bullet lines,
  // not just contain the word "Exclusions" somewhere in prose.
  const block = cmd.slice(exclusionsIdx, capIdx);
  const bulletLines = block.split("\n").filter((line) => /^\s*-\s+\S/.test(line));
  assert.ok(bulletLines.length >= 3, `exclusions list must name at least 3 exclusion classes, found ${bulletLines.length}`);
  assert.match(cmd, /more than 10 candidates/i, "capture.md must cap candidates at 10");
  assert.match(cmd, /held back/i, "capture.md must say how many candidates were held back past the cap");
});

test("capture.md's Present step offers Cancel alongside Approve/Edit/Drop in the same block", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  const presentIdx = cmd.search(/\*\*Present\*\*/);
  const writeIdx = cmd.search(/\*\*Write\*\*/);
  assert.ok(presentIdx > -1 && writeIdx > -1 && presentIdx < writeIdx);
  const presentBlock = cmd.slice(presentIdx, writeIdx);
  assert.match(presentBlock, /Approve all/, "Approve all must appear in the Present step block");
  assert.match(presentBlock, /\*\*Edit\*\*/, "Edit must appear in the Present step block");
  assert.match(presentBlock, /Drop <named items>/, "Drop must appear in the Present step block");
  assert.match(presentBlock, /Cancel \(capture nothing\)/, "Cancel (capture nothing) must appear in the same Present step block as the other options");
});

test("capture.md's fold-in cap is expressed as a number, not vague language", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  const match = cmd.match(/capped at (\d+) reword attempts?/i);
  assert.ok(match, "capture.md must express the reword cap as a concrete number of attempts");
  const cap = Number(match[1]);
  assert.equal(cap, 2, "the reword cap must be 2 attempts before falling back to UNMEASURABLE");
  assert.match(cmd, /UNMEASURABLE/, "capture.md must mark cap-exhausted items UNMEASURABLE in the offer list");
  assert.match(cmd, /never fabricate a metric/i, "capture.md must forbid fabricating a metric to force clear:true");
});

test("capture.md revalidates an edited item (assess + dedupe) before it is re-offered", async () => {
  const cmd = await readFile(new URL("../plugin/commands/capture.md", import.meta.url), "utf8");
  const presentIdx = cmd.search(/\*\*Present\*\*/);
  const writeIdx = cmd.search(/\*\*Write\*\*/);
  const presentBlock = cmd.slice(presentIdx, writeIdx);
  const revalidateIdx = presentBlock.search(/re-enters step 2/i);
  const reofferIdx = presentBlock.search(/re-offered/i);
  assert.ok(revalidateIdx > -1, "capture.md must state the edited item re-enters step 2 validation");
  assert.ok(reofferIdx > -1, "capture.md must state the edited item is re-offered");
  assert.ok(revalidateIdx < reofferIdx, "revalidation must be ordered before re-offer, not after");
});
