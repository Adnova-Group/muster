import { test } from "node:test";
import assert from "node:assert/strict";
import { proposeVariations, optimizePrompt } from "../src/prompt-optimize.js";

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
