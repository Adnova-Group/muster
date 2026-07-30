// Kimi-native token receipts: per-dispatch usage attribution from wire.jsonl.
// Fixtures under test/fixtures/kimi-session-usage/ are TRIMMED captures of a
// real `kimi -p` run (kimi v0.29.1, 2026-07-27; shapes re-confirmed on v0.30.0, 2026-07-29) that dispatched one explore
// subagent -- the usage.record shapes are verbatim, only prompt/systemPrompt
// text was cut. See docs/research/kimi-code-cli.md sec 8's dated probe note.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir, writeFile, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseWireUsage, sumUsage, readSessionUsage, KIMI_USAGE_FIELDS,
  parseWireThinkingEfforts, readSessionThinkingEfforts,
  captureSessionId, resolveSessionForCwd, formatUsageLine, summarizeItemReceipts,
  UNKNOWN_REASONS
} from "../src/kimi-receipts.js";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";

const FIXTURE_SESSION = fileURLToPath(new URL("./fixtures/kimi-session-usage", import.meta.url));
const FIXTURE_SESSION_030 = fileURLToPath(new URL("./fixtures/kimi-session-usage-030", import.meta.url));
const FIXTURE_STDOUT = fileURLToPath(new URL("./fixtures/kimi-stream-stdout.jsonl", import.meta.url));
// Committed session dirs for the fallback resolver: sess-old/sess-new share
// one cwd (sess-new has the later state.json updatedAt); sess-other is a
// different cwd. The index file itself is written per-test into a temp dir so
// sessionDir paths can be absolute -- the real index never uses line order.
const FIXTURE_INDEX_SESSIONS = fileURLToPath(new URL("./fixtures/kimi-session-index/sessions", import.meta.url));
const LEG_CWD = "/repo/leg";

async function writeIndex(entries) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-receipts-index-"));
  const indexPath = path.join(dir, "session_index.jsonl");
  await writeFile(indexPath, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
  return indexPath;
}

const indexEntry = (id, dirName, workDir) => ({ sessionId: id, sessionDir: path.join(FIXTURE_INDEX_SESSIONS, dirName), workDir });

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

// --- parseWireThinkingEfforts -------------------------------------------------
// Canned llm.request shapes mirror the live probe (2026-07-27, kimi v0.29.1;
// re-confirmed on v0.30.0, 2026-07-29):
// k3 emits "low"/"high", kimi-for-coding emits "on"; the profile.bind record
// carries the config DEFAULT ("high" even in a low run) and must be ignored.

test("parseWireThinkingEfforts: one entry per llm.request, in file order, from the top-level field", () => {
  const wire = [
    '{"type":"metadata","protocol_version":"1.4","created_at":1}',
    '{"type":"profile.bind","modelAlias":"kimi-code/k3","thinkingEffort":"high"}', // config default -- NOT effective
    '{"type":"llm.request","kind":"loop","model":"k3","thinkingEffort":"low","time":2}',
    '{"type":"context.append_loop_event","event":{"type":"step.end"},"time":3}',
    '{"type":"llm.request","kind":"loop","model":"k3","thinkingEffort":"low","time":4}'
  ].join("\n");
  assert.deepEqual(parseWireThinkingEfforts(wire), ["low", "low"]);
});

test("parseWireThinkingEfforts: reads the k3 rungs and the kimi-for-coding \"on\" verbatim", () => {
  for (const effort of ["low", "high", "on"]) {
    const wire = `{"type":"llm.request","thinkingEffort":${JSON.stringify(effort)}}`;
    assert.deepEqual(parseWireThinkingEfforts(wire), [effort]);
  }
});

test("parseWireThinkingEfforts: a missing or empty field is null (unverifiable, never a pass)", () => {
  assert.deepEqual(parseWireThinkingEfforts('{"type":"llm.request","kind":"loop"}'), [null]);
  assert.deepEqual(parseWireThinkingEfforts('{"type":"llm.request","thinkingEffort":""}'), [null]);
  assert.deepEqual(parseWireThinkingEfforts('{"type":"llm.request","thinkingEffort":7}'), [null]);
});

test("parseWireThinkingEfforts: blank lines skipped, malformed JSON throws with its line number", () => {
  assert.deepEqual(parseWireThinkingEfforts('\n{"type":"llm.request","thinkingEffort":"high"}\n\n'), ["high"]);
  assert.throws(() => parseWireThinkingEfforts('{"type":"llm.request","thinkingEffort":"low"}\n{"type":"llm.req'), /line 2 is not valid JSON/);
  assert.throws(() => parseWireThinkingEfforts(null), /must be a string/);
});

test("readSessionThinkingEfforts: per-agent effort lists over a session tree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-effort-session-"));
  await mkdir(path.join(dir, "agents", "main"), { recursive: true });
  await mkdir(path.join(dir, "agents", "agent-0"), { recursive: true });
  await mkdir(path.join(dir, "agents", "agent-1"), { recursive: true }); // no wire file
  await writeFile(path.join(dir, "agents", "main", "wire.jsonl"),
    '{"type":"llm.request","thinkingEffort":"low"}\n{"type":"llm.request","thinkingEffort":"low"}\n');
  await writeFile(path.join(dir, "agents", "agent-0", "wire.jsonl"),
    '{"type":"profile.bind","thinkingEffort":"high"}\n{"type":"llm.request","thinkingEffort":"low"}\n');
  const byAgent = await readSessionThinkingEfforts(dir);
  assert.deepEqual(byAgent, {
    "agent-0": ["low"],
    "agent-1": [],
    main: ["low", "low"]
  });
  await assert.rejects(() => readSessionThinkingEfforts(""), /sessionDir is required/);
  await assert.rejects(() => readSessionThinkingEfforts(path.join(dir, "nope")), /cannot read agents tree/);
});

test("readSessionThinkingEfforts: a REAL 0.30.0 wire capture yields the llm.request effort, not the config.update default", async () => {
  // test/fixtures/kimi-session-usage-030/agents/main/wire.jsonl is a trimmed
  // VERBATIM capture (no reshaped fields, whole lines kept or dropped) of the
  // kimi v0.30.0 usage probe, 2026-07-29:
  // ~/.kimi-code/sessions/wd_kimi-030-usage-probe_b87663673b9b/session_7a873ee4-ef5f-49fb-bbd7-8fbf0e9b0c4e
  // (workDir /tmp/kimi-030-usage-probe). The v0.29.1 fixture carries zero
  // thinkingEffort fields; this one proves the parser against the real 0.30.0
  // llm.request shape (thinkingEffort + thinkingKeep + hashes), and that the
  // config.update record's thinkingEffort (the config DEFAULT) is ignored.
  const wire = await readFile(path.join(FIXTURE_SESSION_030, "agents/main/wire.jsonl"), "utf8");
  assert.ok(wire.includes('"thinkingEffort"'), "the fixture must actually carry thinkingEffort fields");
  assert.deepEqual(parseWireThinkingEfforts(wire), ["low"]);
  assert.deepEqual(await readSessionThinkingEfforts(FIXTURE_SESSION_030), { main: ["low"] });
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

test("readSessionUsage: refuses a session dir that canonically escapes its own parent (defense in depth)", async () => {
  // A sessionDir is a path FROM DATA (a session-index field, an items.json
  // resolution), so containment cannot live only in whichever caller remembers
  // to check: a planted symlink is lexically fine and must still refuse HERE,
  // in the shared readers, so no future caller inherits the gap (audit S2 P2).
  const root = await mkdtemp(path.join(os.tmpdir(), "kimi-receipts-contain-"));
  const outside = await mkdtemp(path.join(os.tmpdir(), "kimi-receipts-outside-"));
  await mkdir(path.join(outside, "agents/main"), { recursive: true });
  await writeFile(path.join(outside, "agents/main/wire.jsonl"),
    '{"type":"usage.record","model":"kimi-code/k3","usage":{"inputOther":1,"output":2,"inputCacheRead":3,"inputCacheCreation":4},"usageScope":"turn","time":1}\n');
  const linked = path.join(root, "session");
  await symlink(outside, linked);
  await assert.rejects(() => readSessionUsage(linked), /readSessionUsage: session dir .* contained under its own parent/);
  await assert.rejects(() => readSessionThinkingEfforts(linked), /readSessionThinkingEfforts: session dir .* contained under its own parent/);
  // summarizeItemReceipts reads resolution.sessionDir straight out of a
  // model-supplied items.json -- it inherits the same refusal.
  await assert.rejects(
    () => summarizeItemReceipts([
      { itemId: "item-1", resolution: { resolved: true, sessionId: "session_planted", sessionDir: linked, source: "captured" } }
    ]),
    /contained under its own parent/
  );
  // A real (unlinked) session tree at the same depth still reads.
  assert.equal((await readSessionUsage(outside)).total.total, 10);
});

// --- captureSessionId (PREFERRED: capture-at-dispatch) -----------------------

test("captureSessionId: extracts the session id from a real captured stream-json stdout", async () => {
  const stdout = await readFile(FIXTURE_STDOUT, "utf8");
  assert.equal(captureSessionId(stdout), "session_fb2161ac-ff97-40f2-9f2c-dd60f5e84c5f");
});

test("captureSessionId: returns null when stdout has no resume_hint (and skips non-JSON lines)", () => {
  assert.equal(captureSessionId('{"role":"assistant","content":"ok"}\n'), null);
  assert.equal(captureSessionId("not json at all\n\n" + '{"role":"meta","type":"other"}'), null);
  assert.equal(captureSessionId(""), null);
});

test("captureSessionId: rejects non-string input", () => {
  assert.throws(() => captureSessionId(null), /stdoutText must be a string/);
});

// --- resolveSessionForCwd (FALLBACK resolver) --------------------------------

test("resolveSessionForCwd: a captured id resolves even when the index has many sessions", async () => {
  const indexPath = await writeIndex([
    indexEntry("session_new", "sess-new", LEG_CWD),
    indexEntry("session_old", "sess-old", LEG_CWD),
    indexEntry("session_other", "sess-other", "/repo/other"),
    { sessionId: "session_unrelated", sessionDir: "/nonexistent/dir", workDir: "/elsewhere" }
  ]);
  const resolution = await resolveSessionForCwd({ indexPath, cwd: "/no/match/needed", capturedSessionId: "session_old" });
  assert.deepEqual(resolution, {
    resolved: true,
    sessionId: "session_old",
    sessionDir: path.join(FIXTURE_INDEX_SESSIONS, "sess-old"),
    source: "captured"
  });
});

test("resolveSessionForCwd: throws named errors for a captured id gone from the index or disk", async () => {
  const indexPath = await writeIndex([indexEntry("session_old", "sess-old", LEG_CWD)]);
  await assert.rejects(
    () => resolveSessionForCwd({ indexPath, cwd: LEG_CWD, capturedSessionId: "session_gone" }),
    /captured session session_gone not found in session index/
  );
  const deadPath = await writeIndex([{ sessionId: "session_dead", sessionDir: "/nonexistent/dir", workDir: LEG_CWD }]);
  await assert.rejects(
    () => resolveSessionForCwd({ indexPath: deadPath, cwd: LEG_CWD, capturedSessionId: "session_dead" }),
    /captured session session_dead has no readable session dir/
  );
});

test("resolveSessionForCwd: throws on an unreadable or malformed index (broken input, never UNKNOWN)", async () => {
  await assert.rejects(
    () => resolveSessionForCwd({ indexPath: "/nonexistent/session_index.jsonl", cwd: LEG_CWD }),
    /cannot read session index/
  );
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-receipts-index-"));
  const badPath = path.join(dir, "session_index.jsonl");
  await writeFile(badPath, '{"sessionId":"a","sessionDir":"/x","workDir":"/y"}\n{"sessionId":\n');
  await assert.rejects(() => resolveSessionForCwd({ indexPath: badPath, cwd: LEG_CWD }), /line 2 is not valid JSON/);
  await assert.rejects(() => resolveSessionForCwd({ indexPath: badPath }), /cwd is required/);
});

test("resolveSessionForCwd: newest-wins by state.json updatedAt, NEVER index line order", async () => {
  // sess-new is FIRST in the index -- line order alone would pick it for the
  // wrong reason; the assertion that matters is the source + the loser's
  // earlier updatedAt (01:00 vs 02:00).
  const indexPath = await writeIndex([
    indexEntry("session_new", "sess-new", LEG_CWD),
    indexEntry("session_old", "sess-old", LEG_CWD),
    indexEntry("session_other", "sess-other", "/repo/other")
  ]);
  const resolution = await resolveSessionForCwd({ indexPath, cwd: LEG_CWD });
  assert.equal(resolution.resolved, true);
  assert.equal(resolution.sessionId, "session_new");
  assert.equal(resolution.source, "index-newest");
});

test("resolveSessionForCwd: one candidate for the cwd resolves without reading state.json", async () => {
  const indexPath = await writeIndex([
    indexEntry("session_old", "sess-old", LEG_CWD),
    indexEntry("session_other", "sess-other", "/repo/other")
  ]);
  const resolution = await resolveSessionForCwd({ indexPath, cwd: "/repo/other" });
  assert.deepEqual(resolution, {
    resolved: true,
    sessionId: "session_other",
    sessionDir: path.join(FIXTURE_INDEX_SESSIONS, "sess-other"),
    source: "index-unique"
  });
});

test("resolveSessionForCwd: tied updatedAt across candidates is UNKNOWN-with-reason, never a throw", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-receipts-sessions-"));
  const state = '{"updatedAt":"2026-07-27T01:00:00.000Z","agents":{}}';
  for (const name of ["sess-a", "sess-b"]) {
    await mkdir(path.join(dir, name), { recursive: true });
    await writeFile(path.join(dir, name, "state.json"), state);
  }
  const indexPath = await writeIndex([
    { sessionId: "session_a", sessionDir: path.join(dir, "sess-a"), workDir: LEG_CWD },
    { sessionId: "session_b", sessionDir: path.join(dir, "sess-b"), workDir: LEG_CWD }
  ]);
  const resolution = await resolveSessionForCwd({ indexPath, cwd: LEG_CWD });
  assert.equal(resolution.resolved, false);
  assert.equal(resolution.reason, "ambiguous-tie");
  assert.deepEqual(resolution.candidates.sort(), ["session_a", "session_b"]);
});

test("resolveSessionForCwd: a candidate with missing updatedAt is UNKNOWN-with-reason", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "kimi-receipts-sessions-"));
  await mkdir(path.join(dir, "sess-a"), { recursive: true });
  await writeFile(path.join(dir, "sess-a/state.json"), '{"agents":{}}'); // no updatedAt
  await mkdir(path.join(dir, "sess-b"), { recursive: true });
  await writeFile(path.join(dir, "sess-b/state.json"), '{"updatedAt":"2026-07-27T01:00:00.000Z","agents":{}}');
  const indexPath = await writeIndex([
    { sessionId: "session_a", sessionDir: path.join(dir, "sess-a"), workDir: LEG_CWD },
    { sessionId: "session_b", sessionDir: path.join(dir, "sess-b"), workDir: LEG_CWD }
  ]);
  const resolution = await resolveSessionForCwd({ indexPath, cwd: LEG_CWD });
  assert.deepEqual(resolution, { resolved: false, reason: "missing-updated-at", candidates: ["session_a", "session_b"] });
});

test("resolveSessionForCwd: no sessions for the cwd is UNKNOWN, and reasons are pinned", async () => {
  const indexPath = await writeIndex([indexEntry("session_other", "sess-other", "/repo/other")]);
  const resolution = await resolveSessionForCwd({ indexPath, cwd: LEG_CWD });
  assert.deepEqual(resolution, { resolved: false, reason: "no-sessions-for-cwd", candidates: [] });
  assert.deepEqual([...UNKNOWN_REASONS], ["no-sessions-for-cwd", "ambiguous-tie", "missing-updated-at"]);
});

// --- batch accounting summary ------------------------------------------------

test("formatUsageLine: one compact line with session totals + per-dispatch breakdown", async () => {
  const usage = await readSessionUsage(FIXTURE_SESSION);
  assert.equal(
    formatUsageLine("item-7", usage),
    "item-7: session=kimi-session-usage total=74952 in=74335 out=617 cache-read=68096 cache-create=0 records=5 dispatches: agent-0=29470"
  );
  // the resolution source rides the line so a fallback attribution reads as one
  assert.equal(
    formatUsageLine("item-7", usage, "index-newest"),
    "item-7: session=kimi-session-usage source=index-newest total=74952 in=74335 out=617 cache-read=68096 cache-create=0 records=5 dispatches: agent-0=29470"
  );
});

test("summarizeItemReceipts: one line per item, source surfaced, UNKNOWN resolutions become lines (never throws)", async () => {
  const lines = await summarizeItemReceipts([
    { itemId: "item-1", resolution: { resolved: true, sessionId: "s", sessionDir: FIXTURE_SESSION, source: "captured" } },
    { itemId: "item-2", resolution: { resolved: false, reason: "ambiguous-tie", candidates: ["a", "b"] } },
    { itemId: "item-3", resolution: { resolved: false, reason: "no-sessions-for-cwd", candidates: [] } }
  ]);
  assert.equal(lines.length, 3); // input order preserved
  assert.match(lines[0], /^item-1: session=kimi-session-usage source=captured total=74952 /);
  assert.equal(lines[1], "item-2: UNKNOWN (ambiguous-tie)");
  assert.equal(lines[2], "item-3: UNKNOWN (no-sessions-for-cwd)");
});

test("summarizeItemReceipts: a multi-leg item sums its legs, labeled per-leg with each leg's source", async () => {
  const lines = await summarizeItemReceipts([
    {
      itemId: "item-4",
      resolutions: [
        { resolved: true, sessionId: "s1", sessionDir: FIXTURE_SESSION, source: "captured" },
        { resolved: true, sessionId: "s2", sessionDir: FIXTURE_SESSION, source: "index-newest" },
        { resolved: false, reason: "ambiguous-tie", candidates: ["a", "b"] }
      ]
    }
  ]);
  assert.equal(lines.length, 1);
  assert.equal(
    lines[0],
    "item-4: legs=3 total=149904 in=148670 out=1234 cache-read=136192 cache-create=0 records=10 legs: " +
    "leg-1[session=kimi-session-usage source=captured total=74952] " +
    "leg-2[session=kimi-session-usage source=index-newest total=74952] " +
    "leg-3=UNKNOWN(ambiguous-tie)"
  );
  // the fallback leg's index-newest label is on the line -- visible as a fallback,
  // not summed in silence
  assert.match(lines[0], /source=index-newest/);
});

// --- Live probe: the resume_hint shape, pinned against the installed binary --
// Same opt-in pattern as test/kimi-install.test.js's `kimi doctor config`
// probe: skipped when no kimi binary is on PATH; everything else in this file
// stays hermetic. A tiny `kimi -p --output-format stream-json` run must end
// with a session.resume_hint captureSessionId can parse -- this is the shape
// the process-lane accounting chain (go.md step 8 / go-backlog.md step 4)
// depends on.
test("live probe: captureSessionId parses a session id from a real `kimi -p` stream-json stdout", async (t) => {
  const { execFile: execFileCb } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const execFile = promisify(execFileCb);
  let stdout;
  try {
    ({ stdout } = await execFile(
      "kimi",
      ["-p", "Reply with the single word: ok", "--output-format", "stream-json"],
      { timeout: 180_000, maxBuffer: 16 * 1024 * 1024 }
    ));
  } catch (error) {
    if (error.code === "ENOENT") { t.skip("kimi binary not on PATH"); return; }
    throw error; // the binary ran and failed -- a real failure
  }
  assert.match(
    captureSessionId(stdout) ?? "",
    /^session_/,
    "stream-json stdout must carry a session.resume_hint with a session id"
  );
});

// --- Prose wiring: the batch/finish prose names the accounting line ---------

test("go-backlog.md's batch report names the Kimi token-accounting line and its rules", async () => {
  const text = await readFile(fileURLToPath(new URL("../plugin/commands/go-backlog.md", import.meta.url)), "utf8");
  // the three kimi-receipts entry points, named exactly (src/kimi-receipts.js is canonical);
  // the model reaches them through the CLI verbs (the two-layer boundary), never a direct call
  assert.match(text, /captureSessionId/, "go-backlog.md must name captureSessionId");
  assert.match(text, /`\$MUSTER_CLI kimi-session-usage --cwd <item worktree path> --stdout-file <captured stdout file>`/, "go-backlog.md must name the kimi-session-usage resolve arm with its exact arg shape");
  assert.match(text, /resolveSessionForCwd/, "go-backlog.md must name resolveSessionForCwd (the verb's resolution chain)");
  assert.match(text, /`\$MUSTER_CLI kimi-summarize-receipts <items.json>`/, "go-backlog.md must name the kimi-summarize-receipts verb");
  assert.match(text, /summarizeItemReceipts/, "go-backlog.md must name summarizeItemReceipts");
  // the two arms, stated explicitly: the capture/resolve chain is PROCESS-LANE ONLY
  assert.match(text, /Process-lane legs.*headless `kimi -p`/s, "go-backlog.md must scope the capture/resolve chain to process-lane (kimi -p) legs");
  assert.match(text, /at dispatch capture the leg's stream-json stdout/, "go-backlog.md must state the capture happens at dispatch on stream-json stdout");
  assert.match(text, /before the item's worktree teardown/, "go-backlog.md must state resolution happens before worktree teardown");
  // in-session Agent/AgentSwarm legs: parent-session dispatches view or omission,
  // NEVER per-worktree session resolution (their tokens index under the parent's cwd)
  assert.match(text, /In-session legs.*muster-runner` Agent-tool subagents/s, "go-backlog.md must name the in-session arm and its dispatch shape");
  assert.match(text, /PARENT session's agents tree, indexed under the parent's cwd/, "go-backlog.md must state in-session tokens index under the parent's cwd");
  assert.match(text, /no-sessions-for-cwd/, "go-backlog.md must state why per-worktree resolution can't work for in-session legs");
  assert.match(text, /per-worktree session resolution is never the arm here/, "go-backlog.md must forbid per-worktree resolution for in-session legs");
  assert.match(text, /`\$MUSTER_CLI kimi-session-usage --session-dir <parent session dir>`'s `dispatches` view/, "go-backlog.md must name the parent-session dispatches view as the in-session arm");
  assert.match(text, /omit the item's line and note the omission in STATE/, "go-backlog.md must state the in-session arm's omission fallback");
  // multi-leg items sum per-leg with each leg's resolution source surfaced
  assert.match(text, /one resolution PER LEG/, "go-backlog.md must state retried/fix-looped items carry one resolution per leg");
  assert.match(text, /labeled per-leg with each leg's resolution source/, "go-backlog.md must state the summary surfaces each leg's source");
  assert.match(text, /`captured`\/`index-unique`\/`index-newest`/, "go-backlog.md must enumerate the resolution sources");
  // the mechanics: transcribe into STATE
  assert.match(text, /next to each item's gate summary/, "go-backlog.md must state where the lines land in STATE");
  // UNKNOWN lines are normal after retries and NEVER block the report
  assert.match(text, /UNKNOWN \(<reason>\)` line is normal after retries and never blocks the report/, "go-backlog.md must state UNKNOWN lines never block the report");
  // the batch report table carries the tokens note, scoped to Kimi
  assert.match(text, /gate summary \| tokens \(Kimi only\) \| escalations/, "the batch report table must carry a tokens (Kimi only) column");
  // non-Kimi harnesses omit the line (the harness-conditional shape that lets the clause ship verbatim)
  assert.match(text, /non-Kimi harnesses omit the line/, "go-backlog.md must state non-Kimi harnesses omit the line");
});

test("go.md's finish (step 8) names the single-outcome accounting line", async () => {
  const text = await readFile(fileURLToPath(new URL("../plugin/commands/go.md", import.meta.url)), "utf8");
  assert.match(text, /captureSessionId/, "go.md must name captureSessionId");
  assert.match(text, /`\$MUSTER_CLI kimi-session-usage --cwd <worktree path> --stdout-file <captured stdout file>`/, "go.md must name the kimi-session-usage resolve arm with its exact arg shape");
  assert.match(text, /summarizeItemReceipts/, "go.md must name summarizeItemReceipts");
  // the goal run is a process-lane leg, and step 6 opts INTO stream-json so the
  // stdout step 8 captures exists at all (kimiGoalInvocation defaults streamJson: false)
  assert.match(text, /streamJson: true/, "go.md must name the streamJson:true opt-in at the goal invocation");
  assert.match(text, /process-lane leg/, "go.md must scope the capture chain to the process-lane leg");
  // in-session legs take the parent-session arm, never per-worktree resolution
  assert.match(text, /kimi-session-usage --session-dir <parent session dir>`\s+dispatches view/, "go.md must name the parent-session dispatches view for in-session legs");
  assert.match(text, /per-worktree session\s+resolution never applies/, "go.md must forbid per-worktree resolution for in-session legs");
  assert.match(text, /`captured`\/`index-unique`\/`index-newest`/, "go.md must state the summary surfaces each leg's resolution source");
  assert.match(text, /UNKNOWN never blocking/, "go.md must state UNKNOWN lines never block");
  assert.match(text, /non-Kimi harnesses omit the line/, "go.md must state non-Kimi harnesses omit the line");
});
