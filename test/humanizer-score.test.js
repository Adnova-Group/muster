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
  const slop = "Moreover, it's important to note that we leverage a robust, seamless tapestry — a testament to our holistic paradigm. Notably, this serves as a pivotal game-changer. 🚀";
  const r = scoreHumanness(slop);
  assert.ok(r.score < 60, `expected low score, got ${r.score}`);
  assert.equal(r.passing, false);
  const cats = r.findings.map(f => f.category);
  assert.ok(cats.includes("tier1-vocab"));
  assert.ok(cats.includes("em/en-dash"));
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

for (const threshold of [-1, 101, NaN, Infinity, -Infinity]) {
  test(`threshold rejects ${String(threshold)}`, () => {
    assert.throws(() => scoreHumanness("Plain text.", { threshold }), /finite number between 0 and 100/);
  });
}

for (const threshold of [0, 100]) {
  test(`threshold accepts boundary ${threshold}`, () => {
    assert.equal(scoreHumanness("Plain text.", { threshold }).threshold, threshold);
  });
}

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

// --- 2026-11 upstream re-pin (blader/humanizer v4.0.0, avoid-ai-writing v3.38.0+) -------------

test("curly quotes are a weak tell, scored apart from dashes; in-word apostrophes do not count", () => {
  const r = scoreHumanness("He said “ship it” and we did. It didn’t break.");
  const curly = r.findings.find(f => f.category === "curly-quote");
  assert.equal(curly.count, 2, "two curly double quotes; the apostrophe in didn’t is not counted");
  assert.equal(curly.penalty, 4);
  assert.equal(r.findings.find(f => f.category === "em/en-dash"), undefined);
});

test("code, URLs, blockquotes and double-quoted examples are masked before scoring", () => {
  const doc = [
    "Avoid stock phrases such as \"I hope this helps\" and \"let's dive in\".",
    "",
    "> Moreover, we leverage a robust tapestry.",
    "",
    "Run `delve --robust` or see https://example.com/leverage-the-realm for details.",
    "",
    "```",
    "Certainly — this leverages a seamless paradigm.",
    "```",
  ].join("\n");
  const r = scoreHumanness(doc);
  assert.equal(r.score, 100, JSON.stringify(r.findings));
});

test("unquoted tells outside protected regions still count", () => {
  const r = scoreHumanness("I hope this helps. We leverage the realm — see `code`.");
  const cats = r.findings.map(f => f.category);
  for (const c of ["sycophancy", "tier1-vocab", "em/en-dash"]) assert.ok(cats.includes(c), c);
});

test("tier-2 words count only when two distinct ones share a paragraph", () => {
  assert.equal(scoreHumanness("A crucial fix.\n\nAn essential step.").findings.find(f => f.category === "tier2-cluster"), undefined);
  const r = scoreHumanness("A crucial fix and an essential step.\n\nWe navigate the myriad options.");
  const hit = r.findings.find(f => f.category === "tier2-cluster");
  assert.equal(hit.count, 2, "one hit per qualifying paragraph");
});

test("words moved to tier 2 no longer count alone", () => {
  for (const w of ["harness", "foster", "elevate", "facilitate", "multifaceted"]) {
    assert.equal(scoreHumanness(`We ${w} it.`).score, 100, w);
  }
  assert.equal(scoreHumanness("A meticulous, vibrant interplay.").findings.find(f => f.category === "tier1-vocab").count, 3);
});

test("cutoff disclaimers, hedge stacks and generic conclusions are detected", () => {
  const r = scoreHumanness("As of my last update, the plan could potentially work. The future looks bright.");
  const cats = r.findings.map(f => f.category);
  for (const c of ["cutoff-disclaimer", "hedge-stack", "generic-conclusion"]) assert.ok(cats.includes(c), c);
});

test("new staged-run-up signposts are detected", () => {
  const r = scoreHumanness("Here's the thing: without further ado, let's explore the data.");
  assert.equal(r.findings.find(f => f.category === "signposting").count, 3);
});

test("faux-insight and throat-clearing setups count as signposting (stop-slop, no-ai-slop)", () => {
  const r = scoreHumanness("Let me be clear. Here's what nobody tells you: what most people get wrong is the part everyone misses. The uncomfortable truth is simple.");
  assert.equal(r.findings.find(f => f.category === "signposting").count, 5);
  assert.equal(scoreHumanness("Most people get the setup right on the first try.").score, 100);
});
