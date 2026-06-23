import { test } from "node:test";
import assert from "node:assert/strict";
import { scoreHumanness } from "../src/humanizer-score.js";

test("clean human text scores high and passes", () => {
  const human = "We shipped the fix on Tuesday. It cut error rates by about a third, though the tail latency is still rough. Next we'll look at the retry path.";
  const r = scoreHumanness(human);
  assert.ok(r.score >= 90, `expected high score, got ${r.score}`);
  assert.equal(r.passing, true);
});

test("AI-slop text scores low and fails", () => {
  const slop = "Moreover, it's important to note that we leverage a robust, seamless tapestry — a testament to our holistic paradigm. Indeed, this serves as a pivotal game-changer. 🚀";
  const r = scoreHumanness(slop);
  assert.ok(r.score < 60, `expected low score, got ${r.score}`);
  assert.equal(r.passing, false);
  const cats = r.findings.map(f => f.category);
  assert.ok(cats.includes("tier1-vocab"));
  assert.ok(cats.includes("em/en-dash-or-curly-quote"));
  assert.ok(cats.includes("banned-opener"));
});

test("score is deterministic and bounded 0-100", () => {
  const t = "delve ".repeat(200);
  const a = scoreHumanness(t), b = scoreHumanness(t);
  assert.deepEqual(a, b, "same input must score identically");
  assert.ok(a.score >= 0 && a.score <= 100);
});

test("per-category penalty is capped (one noisy category can't dominate alone)", () => {
  const r = scoreHumanness("delve ".repeat(100));
  const vocab = r.findings.find(f => f.category === "tier1-vocab");
  assert.equal(vocab.penalty, 28, "tier1-vocab caps at 28");
  assert.equal(vocab.capped, true);
});

test("threshold is configurable", () => {
  const text = "We leverage the tool."; // one tier1 word -> penalty 4 -> score 96
  assert.equal(scoreHumanness(text, { threshold: 99 }).passing, false);
  assert.equal(scoreHumanness(text, { threshold: 90 }).passing, true);
});

test("empty input scores a perfect 100", () => {
  assert.equal(scoreHumanness("").score, 100);
  assert.equal(scoreHumanness(null).score, 100);
});

test("emoji detector ignores typographic dingbats but catches flag emoji (audit regression)", () => {
  assert.equal(scoreHumanness("Done ✓ — solid work ★").findings.find(f => f.category === "emoji"), undefined,
    "checkmark/star dingbats are not emoji tells");
  const flag = scoreHumanness("Shipped to the US market 🇺🇸");
  assert.ok(flag.findings.some(f => f.category === "emoji"), "flag emoji should be detected");
});
