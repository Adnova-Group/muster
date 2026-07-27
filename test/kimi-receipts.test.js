// Kimi-native token receipts: per-dispatch usage attribution from wire.jsonl.
// Fixtures under test/fixtures/kimi-session-usage/ are TRIMMED captures of a
// real `kimi -p` run (kimi v0.29.1, 2026-07-27) that dispatched one explore
// subagent -- the usage.record shapes are verbatim, only prompt/systemPrompt
// text was cut. See docs/research/kimi-code-cli.md sec 8's dated probe note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseWireUsage, sumUsage, readSessionUsage, KIMI_USAGE_FIELDS } from "../src/kimi-receipts.js";

const FIXTURE_SESSION = fileURLToPath(new URL("./fixtures/kimi-session-usage", import.meta.url));

// --- parseWireUsage ----------------------------------------------------------

test("parseWireUsage: extracts usage records in file order from a real captured wire", async () => {
  const wire = await readFile(path.join(FIXTURE_SESSION, "agents/main/wire.jsonl"), "utf8");
  const records = parseWireUsage(wire);
  assert.equal(records.length, 2);
  assert.deepEqual(records[0], {
    model: "kimi-code/k3",
    usageScope: "turn",
    time: 1785118896625,
    usage: { inputOther: 3196, output: 157, inputCacheRead: 19200, inputCacheCreation: 0 }
  });
  assert.deepEqual(records[1].usage, { inputOther: 640, output: 17, inputCacheRead: 22272, inputCacheCreation: 0 });
});

test("parseWireUsage: pins the captured field names (the token-gap measurement reads these)", () => {
  assert.deepEqual([...KIMI_USAGE_FIELDS], ["inputOther", "output", "inputCacheRead", "inputCacheCreation"]);
});

test("parseWireUsage: ignores non-usage records and blank lines", () => {
  const wire = [
    '{"type":"metadata","protocol_version":"1.4","created_at":1}',
    "",
    '{"type":"context.append_loop_event","event":{"type":"step.end","usage":{"inputOther":9,"output":9,"inputCacheRead":9,"inputCacheCreation":9}},"time":2}',
    '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4},"usageScope":"turn","time":3}'
  ].join("\n");
  const records = parseWireUsage(wire);
  assert.equal(records.length, 1); // the step.end's embedded usage is NOT double-counted
  assert.equal(records[0].usage.inputOther, 1);
});

test("parseWireUsage: defaults missing usage fields to zero and rejects non-numbers", () => {
  const [record] = parseWireUsage('{"type":"usage.record","usage":{"output":5}}');
  assert.deepEqual(record.usage, { inputOther: 0, output: 5, inputCacheRead: 0, inputCacheCreation: 0 });
  assert.equal(record.model, null);
  assert.throws(() => parseWireUsage('{"type":"usage.record","usage":{"output":"lots"}}'), /usage\.output must be a finite number/);
});

test("parseWireUsage: fails loud with the line number on malformed JSON (never silently undercounts)", () => {
  assert.throws(() => parseWireUsage('{"type":"metadata"}\n{"type":"usage.rec'), /line 2 is not valid JSON/);
  assert.throws(() => parseWireUsage(null), /must be a string/);
});

// --- sumUsage ----------------------------------------------------------------

test("sumUsage: folds records into input/total conveniences", () => {
  const sum = sumUsage([
    { model: "kimi-code/k3", usage: { inputOther: 100, output: 10, inputCacheRead: 200, inputCacheCreation: 50 } },
    { model: "kimi-code/k3", usage: { inputOther: 7, output: 3, inputCacheRead: 0, inputCacheCreation: 0 } }
  ]);
  assert.equal(sum.inputOther, 107);
  assert.equal(sum.output, 13);
  assert.equal(sum.input, 357); // 107 + 200 + 50
  assert.equal(sum.total, 370); // input + output
  assert.equal(sum.records, 2);
  assert.deepEqual(sum.models, ["kimi-code/k3"]);
  assert.deepEqual(sumUsage([]), {
    inputOther: 0, output: 0, inputCacheRead: 0, inputCacheCreation: 0,
    input: 0, total: 0, records: 0, models: []
  });
});

// --- readSessionUsage --------------------------------------------------------

test("readSessionUsage: attributes tokens per dispatch on a real captured session tree", async () => {
  const session = await readSessionUsage(FIXTURE_SESSION);
  // main: the orchestrator's own two steps
  assert.equal(session.agents.main.type, "main");
  assert.equal(session.agents.main.parentAgentId, null);
  assert.deepEqual(
    (({ inputOther, output, inputCacheRead, inputCacheCreation }) => ({ inputOther, output, inputCacheRead, inputCacheCreation }))(session.agents.main),
    { inputOther: 3836, output: 174, inputCacheRead: 41472, inputCacheCreation: 0 }
  );
  // agent-0: the ONE dispatch -- its wire sum IS the dispatch's consumption
  assert.equal(session.agents["agent-0"].type, "sub");
  assert.equal(session.agents["agent-0"].parentAgentId, "main");
  assert.deepEqual(
    (({ inputOther, output, inputCacheRead, inputCacheCreation }) => ({ inputOther, output, inputCacheRead, inputCacheCreation }))(session.agents["agent-0"]),
    { inputOther: 2403, output: 443, inputCacheRead: 26624, inputCacheCreation: 0 }
  );
  assert.deepEqual(Object.keys(session.dispatches), ["agent-0"]); // main is never a dispatch
  assert.equal(session.dispatches["agent-0"].total, 29470); // 2403 + 26624 + 443
  // session total = main + dispatch
  assert.equal(session.total.records, 5);
  assert.equal(session.total.total, session.agents.main.total + session.agents["agent-0"].total);
});

test("readSessionUsage: works without state.json (agents tree alone, non-main defaults to sub)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-receipts-"));
  await mkdir(path.join(dir, "agents/main"), { recursive: true });
  await mkdir(path.join(dir, "agents/agent-0"), { recursive: true });
  await writeFile(path.join(dir, "agents/agent-0/wire.jsonl"),
    '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4},"usageScope":"turn","time":1}\n');
  const session = await readSessionUsage(dir);
  assert.equal(session.agents.main.records, 0); // no wire file -> zero, not an error
  assert.equal(session.dispatches["agent-0"].total, 10);
  assert.equal(session.total.total, 10);
});

test("readSessionUsage: throws when the session dir has no agents tree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-receipts-"));
  await assert.rejects(() => readSessionUsage(dir), /cannot read agents tree/);
  await assert.rejects(() => readSessionUsage(""), /sessionDir is required/);
});
