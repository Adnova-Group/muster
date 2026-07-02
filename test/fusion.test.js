/**
 * Tests for src/fusion.js: validateFusionMap + fuse()
 *
 * TDD: written before the implementation. Run with `node --test`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { validateFusionMap, fuse } from "../src/fusion.js";

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const MAP_OK = {
  consensus: ["both agree on X"],
  contradictions: [{ point: "Y differs", candidates: ["a", "b"] }],
  partialCoverage: ["Z only in a"],
  uniqueInsights: ["a has extra W"],
  blindSpots: ["neither covers Q"],
};

// Minimal map that satisfies the agreement gate (disagreement score >= 1 default)
const MAP_DISAGREEMENT = {
  consensus: [],
  contradictions: [{ point: "something differs", candidates: ["a", "b"] }],
  partialCoverage: [],
  uniqueInsights: [],
  blindSpots: [],
};

// Map with no disagreement at all — score 0
const MAP_AGREE = {
  consensus: ["same"],
  contradictions: [],
  partialCoverage: [],
  uniqueInsights: [],
  blindSpots: [],
};

const CANDIDATES_3 = [
  { id: "alpha", total: 9, passing: true, model: "claude-3", content: "response alpha" },
  { id: "beta",  total: 7, passing: true, model: "gpt-4",    content: "response beta"  },
  { id: "gamma", total: 5, passing: true, model: "gemini",   content: "response gamma" },
];

// Candidates with a non-passing entry mixed in
const CANDIDATES_MIXED = [
  { id: "pass1", total: 10, passing: true  },
  { id: "fail1", total: 20, passing: false },
  { id: "pass2", total:  8, passing: true  },
];

// ---------------------------------------------------------------------------
// 1. validateFusionMap
// ---------------------------------------------------------------------------

test("validateFusionMap: returns ok=true when all required keys are present arrays", () => {
  const result = validateFusionMap(MAP_OK);
  assert.equal(result.ok, true);
  assert.deepEqual(result.errors, []);
});

test("validateFusionMap: rejects null / non-object input", () => {
  for (const bad of [null, undefined, "string", 42, []]) {
    const r = validateFusionMap(bad);
    assert.equal(r.ok, false, `expected ok=false for ${JSON.stringify(bad)}`);
    assert.ok(r.errors.length > 0, "must have at least one error");
  }
});

test("validateFusionMap: error message for missing 'consensus'", () => {
  const { consensus: _, ...rest } = MAP_OK;
  const r = validateFusionMap(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("consensus")), `errors must mention 'consensus': ${r.errors}`);
});

test("validateFusionMap: error message for missing 'contradictions'", () => {
  const { contradictions: _, ...rest } = MAP_OK;
  const r = validateFusionMap(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("contradictions")), `errors must mention 'contradictions': ${r.errors}`);
});

test("validateFusionMap: error message for missing 'partialCoverage'", () => {
  const { partialCoverage: _, ...rest } = MAP_OK;
  const r = validateFusionMap(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("partialCoverage")), `errors must mention 'partialCoverage': ${r.errors}`);
});

test("validateFusionMap: error message for missing 'uniqueInsights'", () => {
  const { uniqueInsights: _, ...rest } = MAP_OK;
  const r = validateFusionMap(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("uniqueInsights")), `errors must mention 'uniqueInsights': ${r.errors}`);
});

test("validateFusionMap: error message for missing 'blindSpots'", () => {
  const { blindSpots: _, ...rest } = MAP_OK;
  const r = validateFusionMap(rest);
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("blindSpots")), `errors must mention 'blindSpots': ${r.errors}`);
});

test("validateFusionMap: error when required key is present but not an array", () => {
  const r = validateFusionMap({ ...MAP_OK, contradictions: "not an array" });
  assert.equal(r.ok, false);
  assert.ok(r.errors.some(e => e.includes("contradictions")), `errors must mention 'contradictions': ${r.errors}`);
});

test("validateFusionMap: lenient about entry shapes — strings and objects both ok in contradictions/uniqueInsights", () => {
  const r = validateFusionMap({
    ...MAP_OK,
    contradictions: ["string entry", { point: "obj entry", candidates: ["a"] }],
    uniqueInsights: ["plain string", { point: "with meta" }],
  });
  assert.equal(r.ok, true, `should be ok: ${r.errors}`);
});

test("validateFusionMap: accumulates multiple errors for multiple missing keys", () => {
  const r = validateFusionMap({ consensus: [] }); // missing 4 keys
  assert.equal(r.ok, false);
  assert.ok(r.errors.length >= 4, `expected >= 4 errors, got ${r.errors.length}: ${r.errors}`);
});

// ---------------------------------------------------------------------------
// 2. fuse() — fallback branches
// ---------------------------------------------------------------------------

test("fuse: mode=fallback reason=invalid-map when map fails validation", () => {
  const r = fuse(CANDIDATES_3, { badKey: "oops" });
  assert.equal(r.mode, "fallback");
  assert.equal(r.reason, "invalid-map");
  assert.ok("winner" in r, "fallback must include winner");
});

test("fuse: fallback winner is a pickWinner-shaped object with a winner field", () => {
  const r = fuse(CANDIDATES_3, null);
  assert.equal(r.mode, "fallback");
  assert.ok(r.winner && typeof r.winner === "object", "winner must be an object");
  assert.ok("winner" in r.winner, "winner object must have a winner field (from pickWinner)");
});

test("fuse: mode=fallback reason=single-or-none-passing when 0 candidates pass", () => {
  const noPassing = [
    { id: "a", total: 10, passing: false },
    { id: "b", total:  8, passing: false },
  ];
  const r = fuse(noPassing, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fallback");
  assert.equal(r.reason, "single-or-none-passing");
});

test("fuse: mode=fallback reason=single-or-none-passing when exactly 1 candidate passes", () => {
  const onePassing = [
    { id: "a", total: 10, passing: true  },
    { id: "b", total:  8, passing: false },
  ];
  const r = fuse(onePassing, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fallback");
  assert.equal(r.reason, "single-or-none-passing");
});

// ---------------------------------------------------------------------------
// 3. Agreement gate
// ---------------------------------------------------------------------------

test("fuse: mode=fallback reason=candidates-agree when disagreementScore < default threshold (1)", () => {
  // MAP_AGREE has score 0 (all arrays empty)
  const r = fuse(CANDIDATES_3, MAP_AGREE);
  assert.equal(r.mode, "fallback");
  assert.equal(r.reason, "candidates-agree");
});

test("fuse: mode=fuse when disagreementScore >= default threshold (1)", () => {
  // MAP_DISAGREEMENT has contradictions.length = 1, score = 1 >= 1
  const r = fuse(CANDIDATES_3, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fuse");
});

test("fuse: env MUSTER_FUSE_MIN_DISAGREEMENT overrides threshold — high threshold causes agree fallback", () => {
  // MAP_OK has score = 1+1+1+1 = 4; set threshold to 5 to force fallback
  const old = process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
  process.env.MUSTER_FUSE_MIN_DISAGREEMENT = "5";
  try {
    const r = fuse(CANDIDATES_3, MAP_OK);
    assert.equal(r.mode, "fallback");
    assert.equal(r.reason, "candidates-agree");
  } finally {
    if (old === undefined) delete process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
    else process.env.MUSTER_FUSE_MIN_DISAGREEMENT = old;
  }
});

test("fuse: env MUSTER_FUSE_MIN_DISAGREEMENT overrides threshold — low threshold allows fuse", () => {
  // MAP_AGREE has score 0; set threshold to 0 to allow fuse
  const old = process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
  process.env.MUSTER_FUSE_MIN_DISAGREEMENT = "0";
  try {
    const r = fuse(CANDIDATES_3, MAP_AGREE);
    assert.equal(r.mode, "fuse");
  } finally {
    if (old === undefined) delete process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
    else process.env.MUSTER_FUSE_MIN_DISAGREEMENT = old;
  }
});

test("fuse: negative MUSTER_FUSE_MIN_DISAGREEMENT clamps to default — agreement gate stays active", () => {
  // Buggy behaviour: -5 is accepted → `0 < -5` is false → fuses (gate silently disabled).
  // Fixed behaviour: -5 is rejected → default threshold 1 → `0 < 1` true → candidates-agree fallback.
  const old = process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
  process.env.MUSTER_FUSE_MIN_DISAGREEMENT = "-5";
  try {
    const r = fuse(CANDIDATES_3, MAP_AGREE); // disagreementScore = 0
    assert.equal(r.mode, "fallback");
    assert.equal(r.reason, "candidates-agree");
  } finally {
    if (old === undefined) delete process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
    else process.env.MUSTER_FUSE_MIN_DISAGREEMENT = old;
  }
});

test("fuse: MUSTER_FUSE_MIN_DISAGREEMENT='2.9' falls back to default 1 (float rejected, not parseInt-truncated to 2)", () => {
  // Old parseInt("2.9",10) = 2 — silently wrong. New envInt rejects non-integer strings -> def=1.
  const old = process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
  process.env.MUSTER_FUSE_MIN_DISAGREEMENT = "2.9";
  try {
    // MAP_DISAGREE score = 1; default threshold = 1 → fuse (not fallback as "2" would cause).
    const r = fuse(CANDIDATES_3, MAP_DISAGREEMENT);
    assert.equal(r.mode, "fuse", "2.9 must use default 1, allowing fuse when score=1");
  } finally {
    if (old === undefined) delete process.env.MUSTER_FUSE_MIN_DISAGREEMENT;
    else process.env.MUSTER_FUSE_MIN_DISAGREEMENT = old;
  }
});

test("fuse: MUSTER_FUSE_TOPK='-1' falls back to default 3 (COV-1: negative topK guard)", () => {
  const candidates = [
    { id: "a", total: 9, passing: true },
    { id: "b", total: 8, passing: true },
    { id: "c", total: 7, passing: true },
    { id: "d", total: 6, passing: true },
  ];
  const old = process.env.MUSTER_FUSE_TOPK;
  process.env.MUSTER_FUSE_TOPK = "-1";
  try {
    const r = fuse(candidates, MAP_DISAGREEMENT);
    assert.equal(r.mode, "fuse");
    assert.equal(r.topK.length, 3, "negative TOPK must fall back to default 3");
  } finally {
    if (old === undefined) delete process.env.MUSTER_FUSE_TOPK;
    else process.env.MUSTER_FUSE_TOPK = old;
  }
});

test("fuse: MUSTER_FUSE_TOPK='abc' falls back to default 3 (COV-1: junk topK guard)", () => {
  const candidates = [
    { id: "a", total: 9, passing: true },
    { id: "b", total: 8, passing: true },
    { id: "c", total: 7, passing: true },
    { id: "d", total: 6, passing: true },
  ];
  const old = process.env.MUSTER_FUSE_TOPK;
  process.env.MUSTER_FUSE_TOPK = "abc";
  try {
    const r = fuse(candidates, MAP_DISAGREEMENT);
    assert.equal(r.mode, "fuse");
    assert.equal(r.topK.length, 3, "junk TOPK must fall back to default 3");
  } finally {
    if (old === undefined) delete process.env.MUSTER_FUSE_TOPK;
    else process.env.MUSTER_FUSE_TOPK = old;
  }
});

// ---------------------------------------------------------------------------
// CORE-2 — Array.isArray guard on fuse()
// ---------------------------------------------------------------------------

test("fuse: non-array candidates (plain object) returns clean fallback, no throw", () => {
  const r = fuse({}, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fallback");
  assert.equal(r.reason, "invalid-candidates");
  assert.ok("winner" in r, "fallback must include winner");
});

test("fuse: null candidates returns clean fallback, no throw", () => {
  const r = fuse(null, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fallback");
  assert.equal(r.reason, "invalid-candidates");
});

test("fuse: scalar candidates (number) returns clean fallback, no throw", () => {
  const r = fuse(42, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fallback");
  assert.equal(r.reason, "invalid-candidates");
});

// ---------------------------------------------------------------------------
// 4. Top-K selection
// ---------------------------------------------------------------------------

test("fuse: top-K defaults to 3 and caps at passing.length", () => {
  // CANDIDATES_3 has 3 passing — topK should have 3 ids
  const r = fuse(CANDIDATES_3, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fuse");
  assert.ok(Array.isArray(r.topK));
  assert.equal(r.topK.length, 3);
});

test("fuse: top-K caps at passing.length when fewer than K pass", () => {
  // CANDIDATES_MIXED has 2 passing, K=3 → topK.length should be 2
  const bigMap = {
    consensus: [],
    contradictions: [{ point: "c", candidates: ["pass1", "pass2"] }],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
  };
  const r = fuse(CANDIDATES_MIXED, bigMap);
  assert.equal(r.mode, "fuse");
  assert.equal(r.topK.length, 2, "topK must not exceed passing.length");
  // fail1 must NOT be selected since it is not passing
  assert.ok(!r.topK.includes("fail1"), "non-passing candidate must not appear in topK");
});

test("fuse: picks candidates with highest total scores for top-K", () => {
  const candidates = [
    { id: "low",  total: 2, passing: true  },
    { id: "mid",  total: 6, passing: true  },
    { id: "high", total: 9, passing: true  },
    { id: "top",  total: 10, passing: true },
    // default K=3 → should pick top, high, mid
  ];
  const r = fuse(candidates, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fuse");
  assert.ok(r.topK.includes("top"),  "top scorer must be in topK");
  assert.ok(r.topK.includes("high"), "second scorer must be in topK");
  assert.ok(r.topK.includes("mid"),  "third scorer must be in topK");
  assert.ok(!r.topK.includes("low"), "lowest scorer must NOT be in topK");
});

test("fuse: env MUSTER_FUSE_TOPK overrides K", () => {
  // 4 passing candidates, env K=2 → topK.length should be 2
  const candidates = [
    { id: "a", total: 9, passing: true },
    { id: "b", total: 8, passing: true },
    { id: "c", total: 7, passing: true },
    { id: "d", total: 6, passing: true },
  ];
  const old = process.env.MUSTER_FUSE_TOPK;
  process.env.MUSTER_FUSE_TOPK = "2";
  try {
    const r = fuse(candidates, MAP_DISAGREEMENT);
    assert.equal(r.mode, "fuse");
    assert.equal(r.topK.length, 2);
  } finally {
    if (old === undefined) delete process.env.MUSTER_FUSE_TOPK;
    else process.env.MUSTER_FUSE_TOPK = old;
  }
});

// ---------------------------------------------------------------------------
// 5. De-identification — no model/agent leaks into synthesizerInput
// ---------------------------------------------------------------------------

test("fuse: synthesizerInput references have no model/agent/id fields (de-identified)", () => {
  const r = fuse(CANDIDATES_3, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fuse");
  const refs = r.synthesizerInput.references;
  assert.ok(Array.isArray(refs), "references must be an array");
  for (const ref of refs) {
    assert.ok(!("model"  in ref), `reference must not include 'model': ${JSON.stringify(ref)}`);
    assert.ok(!("agent"  in ref), `reference must not include 'agent': ${JSON.stringify(ref)}`);
    assert.ok(!("id"     in ref), `reference must not include 'id': ${JSON.stringify(ref)}`);
    assert.ok("index"   in ref,   "reference must have 'index'");
    assert.ok("content" in ref,   "reference must have 'content'");
  }
});

test("fuse: synthesizerInput uses content field when present", () => {
  const r = fuse(CANDIDATES_3, MAP_DISAGREEMENT);
  const refs = r.synthesizerInput.references;
  // CANDIDATES_3 all have content fields; they should appear in refs
  const contents = refs.map(r => r.content);
  assert.ok(contents.includes("response alpha") || contents.includes("response beta") || contents.includes("response gamma"),
    "at least one candidate's content field should be used");
});

test("fuse: synthesizerInput falls back to text field when content is absent", () => {
  const candidates = [
    { id: "x", total: 9, passing: true, text: "text-field-content" },
    { id: "y", total: 8, passing: true, text: "other-text" },
    { id: "z", total: 7, passing: true, text: "third-text" },
  ];
  const r = fuse(candidates, MAP_DISAGREEMENT);
  const contents = r.synthesizerInput.references.map(ref => ref.content);
  assert.ok(contents.some(c => c === "text-field-content" || c === "other-text" || c === "third-text"),
    "should use text field when content is absent");
});

test("fuse: synthesizerInput uses placeholder when neither content nor text is present (no id leak)", () => {
  const candidates = [
    { id: "bare-x", total: 9, passing: true },
    { id: "bare-y", total: 8, passing: true },
    { id: "bare-z", total: 7, passing: true },
  ];
  const r = fuse(candidates, MAP_DISAGREEMENT);
  const contents = r.synthesizerInput.references.map(ref => ref.content);
  // Must use neutral placeholder, not leak candidate ids
  assert.ok(contents.every(c => c === "[content unavailable]"),
    `all contents should be the placeholder: ${contents}`);
  assert.ok(!contents.some(c => ["bare-x", "bare-y", "bare-z"].includes(c)),
    `content must not contain candidate ids: ${contents}`);
});

test("fuse: synthesizerInput includes fusionMap", () => {
  const r = fuse(CANDIDATES_3, MAP_DISAGREEMENT);
  assert.deepEqual(r.synthesizerInput.fusionMap, MAP_DISAGREEMENT);
});

// ---------------------------------------------------------------------------
// 6. Deterministic hash-based ordering (decoupled from score order)
// ---------------------------------------------------------------------------

test("fuse: same input always produces same topK order (deterministic)", () => {
  const r1 = fuse(CANDIDATES_3, MAP_DISAGREEMENT);
  const r2 = fuse(CANDIDATES_3, MAP_DISAGREEMENT);
  assert.deepEqual(r1.topK, r2.topK, "topK order must be deterministic across calls");
  assert.deepEqual(
    r1.synthesizerInput.references.map(r => r.index),
    r2.synthesizerInput.references.map(r => r.index),
    "reference indices must be stable"
  );
});

test("fuse: topK order is NOT simply descending by score (hash-based decoupling)", () => {
  // Craft candidates so the hash order is verifiably different from score order.
  // We select by score (z=10 > y=9 > x=8) but hash order should differ.
  // For djb2-style hash: "z"->122, "y"->121, "x"->120 map to specific hashes.
  // The test checks that at least one call to fuse produces an order != ["z","y","x"].
  const candidates = [
    { id: "z", total: 10, passing: true, content: "resp-z" },
    { id: "y", total:  9, passing: true, content: "resp-y" },
    { id: "x", total:  8, passing: true, content: "resp-x" },
  ];
  const r = fuse(candidates, MAP_DISAGREEMENT);
  assert.equal(r.mode, "fuse");
  // topK must include all three (K=3, 3 passing)
  assert.equal(r.topK.length, 3);
  assert.ok(r.topK.includes("z") && r.topK.includes("y") && r.topK.includes("x"));
  // The score-desc order would be ["z","y","x"]. Verify hash produces a different order.
  const scoreOrder = ["z", "y", "x"];
  assert.notDeepEqual(r.topK, scoreOrder,
    "hash-based order should differ from naive score-descending order for ['z','y','x']");
});

// ---------------------------------------------------------------------------
// 7. CLI wire tests — muster fuse <candidates.json> <fusion-map.json>
// ---------------------------------------------------------------------------

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join, dirname } from "node:path";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";

const pexecFile = promisify(execFile);
const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, "../src/cli.js");

async function cliRun(args) {
  return pexecFile(process.execPath, [CLI, ...args]);
}

test("cli wire: muster fuse exits 0 and returns valid JSON", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-fuse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const cFile = join(tmp, "candidates.json");
  const mFile = join(tmp, "map.json");

  await writeFile(cFile, JSON.stringify([
    { id: "p1", total: 9, passing: true,  content: "resp 1" },
    { id: "p2", total: 7, passing: true,  content: "resp 2" },
    { id: "f1", total: 5, passing: false, content: "resp 3" },
  ]));
  await writeFile(mFile, JSON.stringify({
    consensus: [],
    contradictions: [{ point: "detail", candidates: ["p1", "p2"] }],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
  }));

  const { stdout } = await cliRun(["fuse", cFile, mFile]);
  const result = JSON.parse(stdout);
  assert.ok(result && typeof result === "object", "must return a JSON object");
});

test("cli wire: muster fuse returns mode=fuse for a valid disagreeing map", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-fuse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const cFile = join(tmp, "candidates.json");
  const mFile = join(tmp, "map.json");

  await writeFile(cFile, JSON.stringify([
    { id: "p1", total: 9, passing: true, content: "resp 1" },
    { id: "p2", total: 7, passing: true, content: "resp 2" },
  ]));
  await writeFile(mFile, JSON.stringify({
    consensus: [],
    contradictions: [{ point: "A vs B", candidates: ["p1", "p2"] }],
    partialCoverage: [],
    uniqueInsights: [],
    blindSpots: [],
  }));

  const { stdout } = await cliRun(["fuse", cFile, mFile]);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "fuse");
  assert.ok(Array.isArray(result.topK), "topK must be an array");
  assert.ok(result.synthesizerInput && Array.isArray(result.synthesizerInput.references));
});

test("cli wire: muster fuse returns mode=fallback for an invalid map", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-fuse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));

  const cFile = join(tmp, "candidates.json");
  const mFile = join(tmp, "map.json");

  await writeFile(cFile, JSON.stringify([
    { id: "p1", total: 9, passing: true },
    { id: "p2", total: 7, passing: true },
  ]));
  // Map missing required keys
  await writeFile(mFile, JSON.stringify({ someOtherKey: [] }));

  const { stdout } = await cliRun(["fuse", cFile, mFile]);
  const result = JSON.parse(stdout);
  assert.equal(result.mode, "fallback");
  assert.equal(result.reason, "invalid-map");
});

test("cli wire: muster fuse exits non-zero when candidates file is missing", async () => {
  try {
    await cliRun(["fuse"]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.ok(err.code !== 0);
  }
});

test("cli wire: muster fuse exits non-zero when fusion-map file is missing from args", async (t) => {
  const tmp = await mkdtemp(join(tmpdir(), "muster-fuse-"));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const cFile = join(tmp, "candidates.json");
  await writeFile(cFile, JSON.stringify([]));
  try {
    await cliRun(["fuse", cFile]);
    assert.fail("should have exited non-zero");
  } catch (err) {
    assert.ok(err.code !== 0);
  }
});
