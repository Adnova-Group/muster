import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access, readdir } from "node:fs/promises";
import { scoreHumanness } from "../src/humanizer-score.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const exists = (p) => access(new URL(p, root)).then(() => true, () => false);

test("public OSS essentials are present and published", async () => {
  for (const f of ["README.md", "LICENSE", "NOTICE", "CONTRIBUTING.md", "SECURITY.md", "docs/README.md", "docs/architecture.md"]) {
    assert.equal(await exists(f), true, `${f} must exist for a public repo`);
  }
  const pkg = JSON.parse(await read("package.json"));
  assert.ok(pkg.files.includes("SECURITY.md"), "the npm package must include SECURITY.md");
});

test("security policy documents the private reporting and disclosure contract", async () => {
  const security = await read("SECURITY.md");
  assert.match(security, /GitHub private vulnerability reporting|private security advisory/i);
  assert.match(security, /current minor release/i);
  assert.match(security, /acknowledge[\s\S]{0,100}(?:business )?days?/i);
  assert.match(security, /embargo|coordinated disclosure/i);
  assert.match(security, /muster doctor[\s\S]{0,180}redact/i);
});

test("README documents current install, lifecycle, and configuration boundaries", async () => {
  const readme = await read("README.md");
  const pkg = JSON.parse(await read("package.json"));
  const escapedVersion = pkg.version.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  for (const harness of ["Claude Code", "Codex", "Kimi", "Cowork"]) {
    assert.match(readme, new RegExp(harness), `README must name the ${harness} lane`);
  }
  assert.match(readme, new RegExp(`@adnova-group/muster@${escapedVersion}`));
  assert.match(readme, /npm exec|npx[\s\S]{0,180}(?:registry|provenance|download)/i);
  assert.match(readme, /--scope project[\s\S]{0,900}config\.toml[\s\S]{0,300}max_concurrent_threads_per_session/i);
  assert.match(readme, /--dry-run/);
  assert.match(readme, /uninstall codex --scope project/);
  assert.match(readme, /Claude Code-only lifecycle hooks|Claude-only lifecycle hooks/i);
  assert.match(readme, /classifies every payload[\s\S]{0,260}agent_id/i);
  assert.match(readme, /one hour[\s\S]{0,120}(?:stale|lease)/i);
  assert.match(readme, /directive-shaped prompt[\s\S]{0,220}corroborates orchestration scale/i);
  assert.match(readme, /15-minute cooldown[\s\S]{0,220}60 minutes/i);
  assert.match(readme, /full configuration reference/i);
  assert.match(readme, /active harness subscription/i);
});

test("contributor and architecture docs describe the current build and dispatch shape", async () => {
  const contributing = await read("CONTRIBUTING.md");
  for (const expected of ["yaml", "esbuild", "npm run build:codex", "npm run check:codex", "pretest", "prepublishOnly", "npm run docs:build", "`codex/`", "`cowork/`", "`scripts/`"]) {
    assert.ok(contributing.includes(expected), `CONTRIBUTING.md must include ${expected}`);
  }
  const architecture = await read("docs/architecture.md");
  assert.match(architecture, /two runtime dependencies[\s\S]{0,80}`yaml`[\s\S]{0,80}`esbuild`/i);
  assert.doesNotMatch(architecture, /single runtime dependency/i);
  assert.match(architecture, /catalog\/agents\.manifest\.json/);
  assert.doesNotMatch(architecture, /codex\/agents\.manifest\.json/);
  assert.match(architecture, /harness-neutral[\s\S]{0,220}(?:tier|effort|readOnly)/i);
  assert.match(architecture, /three nonredundant read-only briefs|three read-only briefs/i);
  assert.match(architecture, /system quality[\s\S]{0,220}coverage[\s\S]{0,180}security/i);
  assert.match(architecture, /five boundaries[^\n]*opt-in adapter probe[^\n]*native planning launcher/i);
  assert.match(architecture, /### Kimi adapter:[\s\S]*`install kimi --probe`/i);
  assert.match(architecture, /### Codex adapter:[\s\S]*`codex-plan`/i);
  const voice = await read("docs/profiles/VOICE.md");
  assert.doesNotMatch(voice, /single runtime dependency/i);
  assert.match(voice, /two runtime dependencies/i);
});

test("binding inventory and docs index match the public surface", async () => {
  const binding = await read("docs/binding-interface.md");
  assert.match(binding, /ten modes plus the three.*aliases/i);
  // Re-derived 2026-08-04: the 9 audit-pattern hunt-list skills widened the prose scope 33->42.
  assert.match(binding, /forty-two files|42 files/i);
  const index = await read("docs/README.md");
  for (const expected of ["Architecture", "Binding", "Operations", "Research", "Historical"]) {
    assert.match(index, new RegExp(`## ${expected}`, "i"));
  }
});

test("README has no dead links to removed internal docs", async () => {
  const readme = await read("README.md");
  for (const dead of ["docs/design/", "docs/plan/", "followups-slice", "pipeline-research"]) {
    assert.ok(!readme.includes(dead), `README must not link removed ${dead}`);
  }
});

test("public references document design and init in the ten primary modes", async () => {
  const readme = await read("README.md");
  const architecture = await read("docs/architecture.md");
  const modes = await read("website/reference/modes.md");
  assert.match(readme, /## The ten modes/);
  assert.match(architecture, /## The ten modes/);
  assert.match(modes, /# The ten modes/);
  for (const text of [readme, architecture, modes]) {
    assert.match(text, /Design[^\n]*\/muster:design/);
    assert.match(text, /Init[^\n]*\/muster:init \[dir\]/);
    assert.match(text, /native instruction|native initialization/i);
  }
});

test("init reference documents deterministic state, reruns, and model-neutral profiles", async () => {
  const files = [
    await read("README.md"),
    await read("docs/architecture.md"),
    await read("website/reference/commands.md"),
    await read("plugin/skills/greenfield/SKILL.md"),
  ];
  for (const text of files) {
    assert.match(text, /project-profile\.json/);
    assert.match(text, /init-receipt\.json/);
    assert.match(text, /deterministic|same-state|idempotent|rerun/i);
  }
  assert.match(files[0], /provider\/model-neutral|model-neutral|provider-neutral/i);
  assert.doesNotMatch(files[0], /Claude-specific model|claude-[a-z]|claude model/i);
});

test("CLI and greenfield references keep init separate from legacy setup", async () => {
  const commands = await read("website/reference/commands.md");
  const greenfield = await read("plugin/skills/greenfield/SKILL.md");
  assert.match(commands, /`init \[dir\]`[\s\S]*`init transition \[dir\]/);
  assert.match(commands, /`init acknowledge \[dir\] --reason unavailable`/);
  assert.match(commands, /`init finalize \[dir\]`/);
  assert.match(greenfield, /muster:init/);
  assert.match(greenfield, /muster setup \[dir\].*legacy/i);
  assert.doesNotMatch(greenfield, /Scaffold.*muster setup|setup.*README\/AGENTS seeds/i);
});

test("init docs bind safe greenfield git preparation, unavailable fallback, and evidence-file scope", async () => {
  const readme = await read("README.md");
  const architecture = await read("docs/architecture.md");
  const commands = await read("website/reference/commands.md");
  const modes = await read("website/reference/modes.md");
  const greenfield = await read("plugin/skills/greenfield/SKILL.md");
  for (const text of [readme, architecture, commands, modes, greenfield]) {
    assert.match(text, /greenfield[\s\S]{0,240}(?:initialize|create)[\s\S]{0,240}\.git/i);
    assert.match(text, /Copilot|unknown harness/i);
    assert.match(text, /acknowledge[^\n]*unavailable/i);
  }
  assert.match(commands, /--evidence-file[\s\S]*only for `?preexisting-confirmed`? and `?call-result`?/i);
  assert.match(commands, /artifact-delta[\s\S]*not[^\n]*--evidence-file/i);
});

test("newly changed README and modes prose remains humanizer-passing", async () => {
  for (const f of ["README.md", "website/reference/modes.md"]) {
    assert.equal(scoreHumanness(await read(f)).passing, true, `${f} must pass humanizer score`);
  }
});

test("Cowork sequential fallback retains dedicated per-item worktree isolation", async () => {
  const files = [
    "cowork/README.md",
    "cowork/sprint-protocol.md",
    "docs/research/claude-cowork.md",
    "website/guides/cowork.md",
  ];
  for (const file of files) {
    const text = await read(file);
    assert.match(
      text,
      /orchestrator[\s\S]{0,180}(?:creates?|create)[\s\S]{0,180}dedicated[\s\S]{0,80}(?:isolated )?(?:Git )?worktree[\s\S]{0,220}sequential/i,
      `${file} must keep sequential Cowork implementation in orchestrator-created per-item worktrees`,
    );
    assert.match(
      text,
      /(?:connected project|main tree)[\s\S]{0,180}coordination[\s\S]{0,180}(?:ordered )?integration/i,
      `${file} must reserve the connected tree for coordination and ordered integration`,
    );
    assert.doesNotMatch(
      text,
      /(?:every wave|one item at a time|write-capable wave items)[^\n]{0,120}(?:in|into) the (?:connected project|main tree)/i,
      `${file} must not send fallback implementation into the connected tree`,
    );
  }
});

test("Init public reference pins one instruction authority and holds conflicts", async () => {
  const files = [
    "README.md",
    "website/guides/codex.md",
    "website/guides/harnesses.md",
    "website/guides/quickstart.md",
    "website/reference/commands.md",
    "website/reference/modes.md",
  ];
  for (const file of files) {
    const text = await read(file);
    assert.match(text, /`AGENTS\.md` is authoritative/i, `${file} must name AGENTS.md as authoritative`);
    assert.match(
      text,
      /`CLAUDE\.md` contains exactly:[\s\S]{0,80}# Claude Code\n\n@AGENTS\.md/i,
      `${file} must pin the exact two-line CLAUDE.md content`,
    );
    assert.match(
      text,
      /(?:preparation baseline|baseline files?)[\s\S]{0,220}HUMAN-HOLD/i,
      `${file} must hold conflicting baseline instruction files`,
    );
  }
  const modes = await read("website/reference/modes.md");
  assert.match(modes, /reverse `AGENTS\.md` reference to `CLAUDE\.md` cannot satisfy/i);
});

test("public docs contain no stale 29-tool total claims", async () => {
  const roots = ["cowork", "docs", "website"];
  const files = ["README.md"];
  const exactComponentPhrase = "30 CLI-wrapper tools plus `muster_sprint_protocol`";
  for (const dir of roots) {
    const entries = await readdir(new URL(dir, root), { recursive: true });
    files.push(...entries.filter((entry) => entry.endsWith(".md")).map((entry) => `${dir}/${entry}`));
  }
  const staleTotal = /\b29(?:-tool\b|\s+(?:deterministic\s+)?tools?\b|\s+CLI(?:-|\s)?wrappers?\b|\s+CLI(?:-|\s)?wrapper(?:\s+MCP)?\s+tools?\b)/i;
  for (const file of files) {
    const text = (await read(file)).replaceAll(exactComponentPhrase, "");
    assert.doesNotMatch(
      text,
      staleTotal,
      `${file} may use 29 only in the exact component phrase "${exactComponentPhrase}"`,
    );
  }
  assert.match(await read("website/guides/codex.md"), new RegExp(exactComponentPhrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("command reference never pairs artifact-delta with an evidence file", async () => {
  const commands = await read("website/reference/commands.md");
  assert.match(commands, /`init transition \[dir\] --to completed --evidence artifact-delta`/);
  assert.match(commands, /`init transition \[dir\] --to completed --evidence preexisting-confirmed --evidence-file <path>`/);
  assert.match(commands, /`init transition \[dir\] --to completed --evidence call-result --evidence-file <path>`/);
  assert.doesNotMatch(
    commands,
    /`[^`]*--evidence(?:\s+|=)(?:artifact-delta|<[^>\n]*artifact-delta[^>]*>)[^`]*--evidence-file[^`]*`/,
    "artifact-delta completion must not advertise an evidence file",
  );
});

const MODEL_POLICY_DOCS = [
  "README.md",
  "docs/architecture.md",
  "website/reference/architecture.md",
  "website/reference/concepts.md",
  "website/reference/configuration.md",
  "website/reference/commands.md",
];

const withoutLegacyCompatibility = (text) =>
  text.replace(
    /<!-- legacy-tier-compat:start -->[\s\S]*?<!-- legacy-tier-compat:end -->/g,
    "",
  );

test("public model-policy docs teach the canonical ladder and isolate legacy aliases", async () => {
  for (const file of MODEL_POLICY_DOCS) {
    const text = await read(file);
    assert.match(
      text,
      /scout[\s\S]*core[\s\S]*prime[\s\S]*apex/i,
      `${file} must teach the complete canonical ladder in order`,
    );
    assert.doesNotMatch(
      withoutLegacyCompatibility(text),
      /\b(?:haiku|sonnet|opus|fable|MUSTER_ENABLE_FABLE)\b/i,
      `${file} may name legacy tiers only inside a labeled compatibility block`,
    );
  }
  const readme = await read("README.md");
  const configuration = await read("website/reference/configuration.md");
  for (const text of [readme, configuration]) {
    assert.match(text, /MUSTER_ENABLE_APEX/);
    assert.match(text, /MUSTER_MAX_TIER=(?:core|prime)/);
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
