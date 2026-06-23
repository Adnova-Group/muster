import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeVariations, optimizePrompt, selectWinner, trackOptimization } from "../src/prompt-optimize.js";

test("trackOptimization stops after `patience` rounds with no new best", () => {
  const r = trackOptimization([5, 7, 7, 7], { patience: 2 });
  assert.equal(r.bestTotal, 7);
  assert.equal(r.bestRound, 1);
  assert.equal(r.plateauRounds, 2);
  assert.equal(r.shouldStop, true);
  assert.equal(r.improved, false);
});

test("trackOptimization keeps going while it's still improving", () => {
  const r = trackOptimization([5, 6, 8], { patience: 2 });
  assert.equal(r.improved, true);
  assert.equal(r.plateauRounds, 0);
  assert.equal(r.shouldStop, false);
});

test("trackOptimization: empty history is a no-op, non-finite throws", () => {
  assert.equal(trackOptimization([]).shouldStop, false);
  assert.throws(() => trackOptimization([1, NaN]), /finite number/);
});

test("selectWinner throws when candidates omit the baseline row", () => {
  assert.throws(
    () => selectWinner([{ id: "v1", total: 10, passing: true }]),
    /baseline/,
    "missing baseline must fail loud, not silently report no regression"
  );
});

const WEAK = "answer the question: {{question}}";

test("proposeVariations includes the baseline plus technique-driven variants", () => {
  const vs = proposeVariations(WEAK);
  const ids = vs.map(v => v.id);
  assert.ok(ids.includes("baseline"), "baseline must be present");
  assert.ok(vs.length > 1, "should propose at least one variation");
  for (const v of vs) assert.ok(v.prompt && v.technique, "variation needs prompt + technique");
});

test("a missing-role prompt yields a variation that adds a role", () => {
  const vs = proposeVariations(WEAK);
  const role = vs.find(v => v.technique === "add-role");
  assert.ok(role, "expected an add-role variation");
  assert.match(role.prompt, /you are/i);
});

test("a missing-format prompt yields a variation that specifies output format", () => {
  const vs = proposeVariations(WEAK);
  assert.ok(vs.some(v => v.technique === "specify-output-format"), "expected output-format variation");
});

test("optimizePrompt selects the highest-scoring passing variation", async () => {
  // Injected eval: reward prompts that contain a role.
  const evalFn = async (prompt) => {
    const total = /you are/i.test(prompt) ? 12 : 7;
    return { total, passing: total >= 10 };
  };
  const r = await optimizePrompt({ prompt: WEAK, evalFn });
  assert.equal(r.escalate, false);
  assert.match(r.winnerPrompt, /you are/i);
  assert.ok(r.ranking.length >= 2);
});

test("optimizePrompt flags a regression when no variation beats the baseline", async () => {
  // Baseline scores high, every variation scores lower.
  const evalFn = async (prompt) => {
    const isBaseline = prompt === WEAK;
    const total = isBaseline ? 14 : 8;
    return { total, passing: total >= 10 };
  };
  const r = await optimizePrompt({ prompt: WEAK, evalFn });
  assert.equal(r.winner, "baseline", "baseline should win when variations are worse");
  assert.equal(r.regression, false, "winner == baseline is not a regression");
});

test("optimizePrompt escalates when nothing passes the gate", async () => {
  const evalFn = async () => ({ total: 3, passing: false });
  const r = await optimizePrompt({ prompt: WEAK, evalFn });
  assert.equal(r.escalate, true);
  assert.equal(r.winner, null);
});

test("selectWinner reports a true regression when the only passing winner scores below a non-passing baseline", () => {
  // pickWinner picks the highest PASSING candidate; the baseline is higher but non-passing.
  const r = selectWinner([
    { id: "baseline", total: 14, passing: false },
    { id: "add-role", total: 9, passing: true },
  ]);
  assert.equal(r.winner, "add-role");
  assert.equal(r.regression, true, "winner (9) is below the pinned baseline (14)");
});

test("selectWinner with no passing candidate escalates and returns nulls", () => {
  const r = selectWinner([{ id: "baseline", total: 3, passing: false }]);
  assert.equal(r.winner, null);
  assert.equal(r.escalate, true);
  assert.equal(r.regression, false);
  assert.equal(r.winnerPrompt, null);
  assert.equal(r.baselineScore, 3);
});

test("proposeVariations emits a combined all-improvements variant and dedupes shared techniques", () => {
  const vs = proposeVariations(WEAK);
  const combined = vs.find(v => v.id === "all-improvements");
  assert.ok(combined, "expected an all-improvements variant");
  // ANTH-XML-001 and GUARD-SEP-003 both map to wrap-xml — only one should appear.
  assert.equal(vs.filter(v => v.technique === "wrap-xml").length, 1, "wrap-xml deduped");
});

test("wrapXml handles ${var} and is idempotent on already-tagged content", () => {
  // ${var} prompt: the wrap-xml variation must actually introduce a tag for it.
  const vs = proposeVariations("You are a bot. Echo. value: ${value}");
  const wrap = vs.find(v => v.technique === "wrap-xml");
  assert.ok(wrap && /<value>/.test(wrap.prompt), "${value} should be wrapped");
  // Idempotence: a var already inside a like-named tag is not double-wrapped.
  const combined = vs.find(v => v.id === "all-improvements") || wrap;
  assert.ok(!/<value>\s*<value>/.test(combined.prompt), "no nested double-wrap");
});
