import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access } from "node:fs/promises";
import { scoreHumanness } from "../src/humanizer-score.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const exists = (p) => access(new URL(p, root)).then(() => true, () => false);

test("public OSS essentials are present", async () => {
  for (const f of ["README.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "docs/architecture.md"]) {
    assert.equal(await exists(f), true, `${f} must exist for a public repo`);
  }
});

test("README has no dead links to removed internal docs", async () => {
  const readme = await read("README.md");
  for (const dead of ["docs/design/", "docs/plan/", "followups-slice", "pipeline-research"]) {
    assert.ok(!readme.includes(dead), `README must not link removed ${dead}`);
  }
});

test("public prose carries no em-dashes (humanizer rule)", async () => {
  for (const f of ["README.md", "docs/architecture.md", "CONTRIBUTING.md", "docs/anti-patterns.md"]) {
    const text = await read(f);
    assert.ok(!text.includes("—"), `${f} must be em-dash free`);
  }
});

test("package.json is npm-publish-ready", async () => {
  const pkg = JSON.parse(await read("package.json"));
  assert.ok(pkg.repository, "repository set");
  assert.ok(Array.isArray(pkg.keywords) && pkg.keywords.length > 0, "keywords set");
  assert.ok(Array.isArray(pkg.files) && pkg.files.length > 0, "files whitelist set");
  assert.ok(pkg.engines?.node, "engines.node set");
  assert.equal(pkg.license, "Apache-2.0");
});

test("package.json version === plugin/.claude-plugin/plugin.json version", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const plugin = JSON.parse(await read("plugin/.claude-plugin/plugin.json"));
  assert.equal(
    pkg.version,
    plugin.version,
    `package.json version (${pkg.version}) must match plugin.json version (${plugin.version})`
  );
});

test("CHANGELOG.md contains a heading for the current version", async () => {
  const pkg = JSON.parse(await read("package.json"));
  const changelog = await read("CHANGELOG.md");
  const heading = `## [${pkg.version}]`;
  assert.ok(
    changelog.includes(heading),
    `CHANGELOG.md must contain a "${heading}" heading for the current version`
  );
});

// ─── Humanizer output rules on committed public prose ───────────────────────
//
// Post-hoc contract tests: assert that specific AI-tell categories detected by
// humanizer-score.js are absent from the gated prose files. We check per-category
// findings rather than the overall score because some categories legitimately
// appear in these files:
//
//   EXCLUDED — em/en-dash-or-curly-quote: curly quotes appear around inline terms
//              (e.g. "Glass-box", "audit this code...") as a deliberate typographic
//              choice; em-dash is already gated by the test above.
//   EXCLUDED — emoji: README carries one intentional doc-link icon (📖), not an AI tell.
//   EXCLUDED — tier1-vocab: "harness" appears in "harness level" (the hook/wave runtime
//              concept), which is a real false-positive for this file set.
//
//   INCLUDED — sycophancy, signposting, banned-opener, copula-avoidance,
//              negative-parallelism: none of these belong in technical documentation;
//              false-positive risk is negligible, and all currently score clean.

const GATED_PROSE = ["README.md", "docs/architecture.md", "CONTRIBUTING.md", "docs/anti-patterns.md"];

test("public prose carries no sycophancy AI-tells (humanizer gate)", async () => {
  // "great question", "as an AI", "happy to help" never belong in technical docs.
  for (const f of GATED_PROSE) {
    const hit = scoreHumanness(await read(f)).findings.find(x => x.category === "sycophancy");
    assert.equal(hit, undefined,
      `${f}: sycophancy detected — ${JSON.stringify(hit?.examples)}`);
  }
});

test("public prose carries no AI-tell signposting (humanizer gate)", async () => {
  // "in today's world", "needless to say", "let's dive in", "in conclusion" are
  // filler that should never appear in good technical docs.
  for (const f of GATED_PROSE) {
    const hit = scoreHumanness(await read(f)).findings.find(x => x.category === "signposting");
    assert.equal(hit, undefined,
      `${f}: signposting detected — ${JSON.stringify(hit?.examples)}`);
  }
});

test("public prose carries no AI-tell banned sentence-openers (humanizer gate)", async () => {
  // "Certainly", "Moreover", "Additionally", "Furthermore", "Indeed", "Notably",
  // "Importantly", "Ultimately", "Overall" at line/paragraph starts are AI-tell patterns.
  // The regex only fires on line-start matches, keeping false-positive risk very low.
  for (const f of GATED_PROSE) {
    const hit = scoreHumanness(await read(f)).findings.find(x => x.category === "banned-opener");
    assert.equal(hit, undefined,
      `${f}: banned opener detected — ${JSON.stringify(hit?.examples)}`);
  }
});

test("public prose carries no copula-avoidance AI-tells (humanizer gate)", async () => {
  // "serves as", "stands as", "boasts", "plays a key/crucial role" substitute for plain
  // "is" in AI-generated prose. Currently absent; gate to catch regressions.
  for (const f of GATED_PROSE) {
    const hit = scoreHumanness(await read(f)).findings.find(x => x.category === "copula-avoidance");
    assert.equal(hit, undefined,
      `${f}: copula-avoidance detected — ${JSON.stringify(hit?.examples)}`);
  }
});

test("public prose carries no negative-parallelism AI-tells (humanizer gate)", async () => {
  // The "not just X ... it's Y" rhetorical pattern is a strong AI-tell.
  // Currently absent; assert to gate regressions.
  for (const f of GATED_PROSE) {
    const hit = scoreHumanness(await read(f)).findings.find(x => x.category === "negative-parallelism");
    assert.equal(hit, undefined,
      `${f}: negative-parallelism detected — ${JSON.stringify(hit?.examples)}`);
  }
});

// STATE dispatch invariant: SKIPPED — no deterministic committed fixture in
// test/fixtures/ contains a run STATE with both "edited files" and
// "dispatching ..." lines together. The .muster/STATE.md in the repo is an
// audit ledger, not a run-state artifact. Add this test when a run-STATE
// fixture is committed, or run it as a manual review-gate check against a
// real captured run output.
