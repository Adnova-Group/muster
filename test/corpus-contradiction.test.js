// test/corpus-contradiction.test.js — cross-file contradiction checker for
// muster's instruction corpus (adapted from peva3/anchor's corpus quality
// audit, MIT license; clean-room reimplementation for muster's own term set).
//
// Shared vocabulary — the surface taxonomy enum, review-gate names, the
// reviewer severity tags, mode names and their legacy-alias mappings, the
// review-verdict terms, the muster-runner agent id, the role vocabulary, and
// the fix-iteration cap — is DEFINED once in a canonical source and QUOTED
// verbatim elsewhere across plugin/commands, plugin/skills, and
// plugin/agents. Each test below extracts the canonical value(s) LIVE from
// their source of truth, then asserts every known quote site still carries
// the byte-identical value: a rename, typo, or stale quote in EITHER the
// canonical source or a quote site fails the matching assertion.
//
// The term registry lives here in code (TERM_REGISTRY below), not a prose
// doc — source of truth stays executable, per the item's "prefer code over
// the model" directive.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { ROLES } from "../src/roles.js";
import { escapeRe } from "../src/keyword.js";
import { sliceMdSection } from "./test-support/md-section-helpers.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

// Markdown prose soft-wraps mid-sentence (e.g. orchestrator/SKILL.md's surface
// line breaks between "surface:" and its value at the 100-col margin); collapse
// all whitespace runs (including the wrap's newline+indent) to a single space
// before substring-matching quoted spans that may straddle a wrap point.
const normalizeWs = (text) => text.replace(/\s+/g, " ");

// ── term registry (enumerated) ──────────────────────────────────────────────
// Documents WHERE each shared term is canonically DEFINED and every file
// that QUOTES it. Purely descriptive (the assertions live in the tests
// below); the meta-test just keeps this table honest as entries are added.
const TERM_REGISTRY = [
  { name: "surface taxonomy enum", canonicalSource: "src/manifest.js (SURFACES)",
    quotedAt: ["plugin/skills/router/SKILL.md", "plugin/skills/orchestrator/SKILL.md"] },
  { name: "gate names + surface trigger", canonicalSource: "plugin/skills/review-gate/SKILL.md (3 numbered gate headings)",
    quotedAt: ["plugin/skills/orchestrator/SKILL.md"] },
  { name: "reviewer severity vocabulary", canonicalSource: "plugin/agents/muster-reviewer.md (severity tags)",
    quotedAt: ["plugin/skills/review-gate/SKILL.md"] },
  { name: "mode names + legacy-alias mappings", canonicalSource: "plugin/commands/*.md (frontmatter name: + alias-stub bodies)",
    quotedAt: ["plugin/commands/*.md (cross-references + alias targets)"] },
  { name: "review-verdict terms", canonicalSource: "plugin/agents/muster-reviewer.md (VERDICT: lines)",
    quotedAt: ["plugin/agents/muster-runner.md"] },
  { name: "muster-runner agent id", canonicalSource: "plugin/agents/muster-runner.md (frontmatter name:)",
    quotedAt: ["plugin/commands/go-backlog.md", "plugin/skills/coordination/SKILL.md"] },
  { name: "role vocabulary", canonicalSource: "src/roles.js (ROLES)",
    quotedAt: ["plugin/commands/diagnose.md", "plugin/skills/review-gate/SKILL.md"] },
  { name: "fix-iteration cap", canonicalSource: "plugin/skills/review-gate/SKILL.md (REVIEW_GATE_MAX_ITERATIONS)",
    quotedAt: ["plugin/skills/orchestrator/SKILL.md", "plugin/agents/muster-runner.md"] },
];

test("term registry: every entry names a canonical source and at least one quote site", () => {
  assert.equal(TERM_REGISTRY.length, 8, "expected 8 registered shared terms");
  for (const t of TERM_REGISTRY) {
    assert.ok(t.name && t.canonicalSource, `registry entry missing name/canonicalSource: ${JSON.stringify(t)}`);
    assert.ok(Array.isArray(t.quotedAt) && t.quotedAt.length > 0, `${t.name}: quotedAt must list at least one file`);
  }
});

// ── term 1: surface taxonomy enum ───────────────────────────────────────────
// Canonical: src/manifest.js's SURFACES Set literal. Not exported (module-
// private), so extracted from source text — same live-extraction approach
// website-docs.test.js uses for cli.js's usage string.
function extractSurfaces(manifestSrc) {
  const m = manifestSrc.match(/const SURFACES = new Set\(\[([^\]]+)\]\)/);
  assert.ok(m, "could not locate the SURFACES literal in src/manifest.js");
  return m[1].split(",").map((s) => s.trim().replace(/^"|"$/g, "")).filter(Boolean);
}

test("surface taxonomy: router.md's pipe-enum matches manifest.js's SURFACES exactly", async () => {
  const [manifestSrc, routerMd] = await Promise.all([
    read("src/manifest.js"),
    read("plugin/skills/router/SKILL.md"),
  ]);
  const surfaces = extractSurfaces(manifestSrc);
  assert.deepEqual(surfaces, ["ui", "copy", "integration", "none"], "sanity: known canonical order");
  const enumString = surfaces.map((s) => `"${s}"`).join(" | ");
  assert.ok(
    routerMd.includes(`surface: ${enumString}`),
    `router/SKILL.md must quote "surface: ${enumString}" verbatim (manifest.js's SURFACES is canonical)`
  );
});

test("surface taxonomy: orchestrator.md's surface-line tokens match manifest.js's SURFACES exactly", async () => {
  const [manifestSrc, orchestratorMd] = await Promise.all([
    read("src/manifest.js"),
    read("plugin/skills/orchestrator/SKILL.md"),
  ]);
  const surfaces = extractSurfaces(manifestSrc);
  const normalized = normalizeWs(orchestratorMd);
  for (const s of surfaces) {
    assert.ok(
      normalized.includes(`\`surface: ${s}\``),
      `orchestrator/SKILL.md is missing/mismatched token \`surface: ${s}\` (manifest.js's SURFACES is canonical)`
    );
  }
});

// ── term 2: review-gate names + their surface trigger ──────────────────────
// Canonical: plugin/skills/review-gate/SKILL.md's three numbered
// "## Surface-type definition-of-done gates" headings, each carrying the
// `surface` value that fires it.
function extractGateSurfaceMap(reviewGateMd) {
  // Scope to this section only (up to the next `## ` heading, e.g. the
  // Mutant-kill gate section) — its own numbered evidence-shape list
  // ("1. **The mutation**" etc.) matches the same heading pattern below,
  // and an unscoped scan would over-count. This was the checker's own
  // known tripwire: legitimate additions to other gate sections vs actual
  // drift in the surface-type gates must stay distinguishable.
  const section = sliceMdSection(reviewGateMd, "Surface-type definition-of-done gates");
  assert.ok(section, "review-gate/SKILL.md is missing the surface-type gates section");
  const headingRe = /\d+\.\s+\*\*([^*]+)\*\*/g;
  const headings = [...section.matchAll(headingRe)].map((m) => ({ name: m[1], index: m.index }));
  assert.equal(headings.length, 3, "expected exactly 3 surface-type gates");
  const map = {};
  headings.forEach((h, i) => {
    const end = i + 1 < headings.length ? headings[i + 1].index : section.length;
    const block = section.slice(h.index, end);
    const sm = block.match(/`surface`(?: field)? is `"([a-z]+)"`/);
    assert.ok(sm, `could not find the surface trigger for gate "${h.name}"`);
    map[h.name] = sm[1];
  });
  return map;
}

test("gate names: orchestrator.md's surface-line gate names + mapping match review-gate.md's headings exactly", async () => {
  const [reviewGateMd, orchestratorMd] = await Promise.all([
    read("plugin/skills/review-gate/SKILL.md"),
    read("plugin/skills/orchestrator/SKILL.md"),
  ]);
  const map = extractGateSurfaceMap(reviewGateMd);
  assert.deepEqual(
    map,
    { "Design/UX gate": "ui", "Humanizer gate": "copy", "Live-verification gate": "integration" },
    "sanity: known canonical gate/surface pairing"
  );
  const normalized = normalizeWs(orchestratorMd);
  for (const [gateName, surfaceValue] of Object.entries(map)) {
    assert.ok(
      normalized.includes(`\`surface: ${surfaceValue}\` -> the ${gateName}`),
      `orchestrator/SKILL.md must read "\`surface: ${surfaceValue}\` -> the ${gateName}" verbatim (review-gate/SKILL.md is canonical)`
    );
  }
});

// ── term 3: reviewer severity vocabulary ────────────────────────────────────
// Canonical: plugin/agents/muster-reviewer.md's three bracketed severity
// tags (the only place the vocabulary is DEFINED); review-gate/SKILL.md
// QUOTES it as a findings-shape enum.
function extractSeverityTags(reviewerMd) {
  const m = reviewerMd.match(/each tagged ([^.]+)\./);
  assert.ok(m, "could not find the severity-tag sentence in muster-reviewer.md");
  const tags = [...m[1].matchAll(/`\[([a-z]+)\]`/g)].map((x) => x[1]);
  return tags;
}

test("severity vocabulary: review-gate.md's findings shape matches muster-reviewer.md's severity tags exactly", async () => {
  const [reviewerMd, reviewGateMd] = await Promise.all([
    read("plugin/agents/muster-reviewer.md"),
    read("plugin/skills/review-gate/SKILL.md"),
  ]);
  const tags = extractSeverityTags(reviewerMd);
  assert.deepEqual(tags, ["blocker", "risk", "nit"], "sanity: known canonical severity order");
  const enumString = tags.map((t) => `"${t}"`).join("|");
  assert.ok(
    reviewGateMd.includes(`severity: ${enumString}`),
    `review-gate/SKILL.md's findings shape must read "severity: ${enumString}" verbatim (muster-reviewer.md is canonical)`
  );
});

// ── term 4: mode names + legacy-alias mappings ──────────────────────────────
// Canonical: every plugin/commands/*.md file's frontmatter `name:` field
// (the registered mode-name vocabulary) plus the three legacy-alias stub
// files' declared targets.
const COMMAND_FILES = ["audit", "autopilot", "capture", "diagnose", "go-backlog", "go",
  "plan-backlog", "plan", "run", "runner", "sprint"];
const ALIAS_TARGETS = { autopilot: "go", sprint: "go-backlog", run: "plan" };

async function loadCommandNames() {
  const names = new Set();
  for (const f of COMMAND_FILES) {
    const src = await read(`plugin/commands/${f}.md`);
    const m = src.match(/^name:\s*(\S+)/m);
    assert.ok(m, `plugin/commands/${f}.md missing frontmatter name:`);
    assert.equal(m[1], f, `plugin/commands/${f}.md's frontmatter name should read "${f}"`);
    names.add(m[1]);
  }
  return names;
}

test("mode names: every legacy-alias stub's frontmatter description and body name the identical target", async () => {
  for (const [alias, target] of Object.entries(ALIAS_TARGETS)) {
    const src = await read(`plugin/commands/${alias}.md`);
    const descMatch = src.match(/description:\s*"Legacy alias of \/muster:(\S+?)\s*—/);
    assert.ok(descMatch, `${alias}.md's frontmatter description must read "Legacy alias of /muster:<target> —"`);
    const bodyMatch = src.match(/\/muster:\S+ is now \/muster:(\S+)\s*—/);
    assert.ok(bodyMatch, `${alias}.md's body must read "/muster:${alias} is now /muster:<target> —"`);
    assert.equal(descMatch[1], target, `${alias}.md's frontmatter description names the wrong alias target`);
    assert.equal(bodyMatch[1], target, `${alias}.md's body names the wrong alias target`);
    assert.equal(descMatch[1], bodyMatch[1], `${alias}.md's frontmatter and body disagree on the alias target`);
  }
});

test("mode names: every legacy-alias target is a real registered mode name", async () => {
  const names = await loadCommandNames();
  for (const [alias, target] of Object.entries(ALIAS_TARGETS)) {
    assert.ok(names.has(target), `${alias}.md's alias target "${target}" is not a registered command name`);
  }
});

test("mode names: every '(vs /muster:X...)' cross-reference in plugin/commands/*.md names a real registered mode", async () => {
  const names = await loadCommandNames();
  let checked = 0;
  for (const f of COMMAND_FILES) {
    const src = await read(`plugin/commands/${f}.md`);
    for (const m of src.matchAll(/\(vs `?\/muster:([a-z-]+)/g)) {
      checked++;
      assert.ok(names.has(m[1]), `${f}.md's "(vs /muster:${m[1]})" cross-reference does not name a registered mode`);
    }
  }
  assert.ok(checked > 0, "expected to find at least one '(vs /muster:X)' cross-reference");
});

// ── term 5: review-verdict terms ────────────────────────────────────────────
// Canonical: plugin/agents/muster-reviewer.md's `VERDICT: X` lines (the only
// place the verdict vocabulary is DEFINED). muster-runner.md's dispatch
// contract quotes the PASS line as its disposition gate.
function extractVerdictTerms(reviewerMd) {
  return [...reviewerMd.matchAll(/`(VERDICT: [A-Z_]+)`/g)].map((m) => m[1]);
}

test("dispatch-contract terms: muster-runner.md quotes muster-reviewer.md's VERDICT: PASS verbatim", async () => {
  const [reviewerMd, runnerMd] = await Promise.all([
    read("plugin/agents/muster-reviewer.md"),
    read("plugin/agents/muster-runner.md"),
  ]);
  const terms = extractVerdictTerms(reviewerMd);
  assert.deepEqual(terms, ["VERDICT: PASS", "VERDICT: CHANGES_REQUESTED"], "sanity: known canonical verdict terms");
  const passTerm = terms.find((t) => t.endsWith("PASS"));
  const occurrences = runnerMd.split(`\`${passTerm}\``).length - 1;
  assert.ok(occurrences >= 1, `muster-runner.md must quote \`${passTerm}\` verbatim at least once (muster-reviewer.md is canonical)`);
});

test("dispatch-contract terms: muster-runner's agent id matches its frontmatter name everywhere it's quoted as a subagent type", async () => {
  const [runnerMd, goBacklogMd, coordinationMd] = await Promise.all([
    read("plugin/agents/muster-runner.md"),
    read("plugin/commands/go-backlog.md"),
    read("plugin/skills/coordination/SKILL.md"),
  ]);
  const fm = runnerMd.match(/^name:\s*(\S+)/m);
  assert.ok(fm, "muster-runner.md missing frontmatter name:");
  const agentId = fm[1];
  assert.equal(agentId, "muster-runner", "sanity: known canonical agent id");
  for (const [label, text] of [["go-backlog.md", goBacklogMd], ["coordination/SKILL.md", coordinationMd]]) {
    assert.ok(
      text.includes(`subagent type \`${agentId}\``),
      `${label} must quote "subagent type \`${agentId}\`" verbatim (muster-runner.md's frontmatter name is canonical)`
    );
  }
});

// ── term 6: role vocabulary ──────────────────────────────────────────────────
// Canonical: src/roles.js's exported ROLES array. Individual role
// identifiers get quoted in backtick-role form ("role `x`" / "roles `x`
// and/,/ `y`") across plugin/commands and plugin/skills — every quoted role
// must be a real member.
function extractQuotedRoles(text) {
  // Anchor the whole role/roles + backtick-list span (comma-, "and"-, or
  // slash-separated); negative lookbehind on a leading hyphen/word-char
  // excludes compound words like "fixed-role" (router/SKILL.md's "the
  // fixed-role `chosen` ladder" is not a role-vocabulary quote).
  const anchorRe = /(?<![-\w])roles?\s+`[a-z][a-z0-9-]*`(?:\s*(?:,|and|\/)\s*`[a-z][a-z0-9-]*`)*/g;
  const found = [];
  for (const m of text.matchAll(anchorRe)) {
    for (const rm of m[0].matchAll(/`([a-z][a-z0-9-]*)`/g)) found.push(rm[1]);
  }
  return found;
}

test("role vocabulary: every backtick-quoted role name in plugin/commands and plugin/skills is a real member of roles.js's ROLES", async () => {
  const targets = ["plugin/commands/diagnose.md", "plugin/skills/review-gate/SKILL.md"];
  let checked = 0;
  for (const t of targets) {
    const text = await read(t);
    for (const r of extractQuotedRoles(text)) {
      checked++;
      assert.ok(ROLES.includes(r), `${t} quotes role \`${r}\`, which is not in roles.js's ROLES vocabulary`);
    }
  }
  assert.equal(checked, 7, "expected exactly 7 quoted role names across the two target files");
});

// ── term 7: fix-iteration cap ────────────────────────────────────────────────
// Canonical: plugin/skills/review-gate/SKILL.md's REVIEW_GATE_MAX_ITERATIONS
// numeric value. Quoted as the numeral ("3 fix iterations") in
// orchestrator.md and as the word form ("three fix loops") in
// muster-runner.md.
const NUMBER_WORDS = { 1: "one", 2: "two", 3: "three", 4: "four", 5: "five" };

function extractFixIterationCap(reviewGateMd) {
  const m = reviewGateMd.match(/REVIEW_GATE_MAX_ITERATIONS`?\s*=\s*(\d+)/);
  assert.ok(m, "could not find REVIEW_GATE_MAX_ITERATIONS's numeric value in review-gate/SKILL.md");
  return Number(m[1]);
}

test("fix-iteration cap: orchestrator.md and muster-runner.md quote review-gate.md's REVIEW_GATE_MAX_ITERATIONS exactly", async () => {
  const [reviewGateMd, orchestratorMd, runnerMd] = await Promise.all([
    read("plugin/skills/review-gate/SKILL.md"),
    read("plugin/skills/orchestrator/SKILL.md"),
    read("plugin/agents/muster-runner.md"),
  ]);
  const cap = extractFixIterationCap(reviewGateMd);
  assert.equal(cap, 3, "sanity: known canonical fix-iteration cap");

  assert.ok(
    orchestratorMd.includes(`${cap} fix iterations`),
    `orchestrator/SKILL.md must read "${cap} fix iterations" verbatim (review-gate/SKILL.md's REVIEW_GATE_MAX_ITERATIONS is canonical)`
  );

  const word = NUMBER_WORDS[cap];
  assert.ok(word, `no word form registered for cap ${cap}`);
  assert.ok(
    runnerMd.includes(`${word} fix loops`),
    `muster-runner.md must read "${word} fix loops" verbatim (review-gate/SKILL.md's REVIEW_GATE_MAX_ITERATIONS is canonical)`
  );
});

// ── residue scan: verb-rename leftovers outside the plugin/ prose scan ─────
// Every test above is a "shared term, quoted in N known places" pattern (TERM_REGISTRY).
// The tests below are a DIFFERENT shape — not quote-site matching but residue scanning:
// they pin surfaces that a `/muster:X` verb rename can drift on but that live outside
// plugin/commands, plugin/skills, plugin/agents (this file's original scope), namely
// cowork/'s MCP prose, plugin/hooks/'s scale-gate messages, and src/'s header comments.
// A prior rename (cowork MCP verbs, pre-tool-use.js scale-gate messages, run.md-step-0b
// header comments) left stale vocabulary on all three that this file's original scope
// never reached; each test below pins one surface so the next rename cannot repeat that.
// Deliberately NOT added to TERM_REGISTRY above -- these aren't "canonical source, quoted
// elsewhere" pairs, they're "must not reference the pre-rename vocabulary outside an
// explicitly named allowance" scans.

// ── residue 1: cowork/ prose — pre-rename verb citations ───────────────────
// Before the cowork rename (PR #17), the legacy verbs were named directly; after it,
// each of the three cowork/ prose files carries exactly ONE alias-note line that still
// cites the pre-rename verbs (run/autopilot/sprint) on purpose, as backward-compatibility
// documentation -- everywhere else in the file must use the current names (plan/go/
// go-backlog). A pre-rename citation is either the slash form (`/muster:run`, matched
// with a trailing word boundary so `/muster:runner` does not false-positive) or the
// bare arrow-mapping form mcp-server.mjs's alias line uses ("run -> plan"). Returns the
// 1-based line numbers carrying at least one such citation; a healthy file has exactly
// one entry (the alias-note line) in this array.
function findPreRenameVerbLines(text) {
  const re = /\/muster:(?:run|autopilot|sprint)\b|\b(?:run|autopilot|sprint)\s*->\s*[a-z-]+/gi;
  const hitLines = [];
  text.split("\n").forEach((line, i) => {
    re.lastIndex = 0; // stateful global regex — reset before every .test() call
    if (re.test(line)) hitLines.push(i + 1);
  });
  return hitLines;
}

test("cowork/ prose: mcp-server.mjs, sprint-protocol.md, and README.md cite pre-rename verbs (run/autopilot/sprint) only on their one alias-note line", async () => {
  const targets = [
    { path: "cowork/mcp-server.mjs", aliasLine: 87 },
    { path: "cowork/sprint-protocol.md", aliasLine: 9 },
    { path: "cowork/README.md", aliasLine: 7 },
  ];
  for (const { path, aliasLine } of targets) {
    const text = await read(path);
    const hitLines = findPreRenameVerbLines(text);
    assert.deepEqual(
      hitLines,
      [aliasLine],
      `${path} must cite pre-rename verbs (run/autopilot/sprint) only on its alias-note line ${aliasLine}; found citations on line(s) ${JSON.stringify(hitLines)}`
    );
  }
});

// ── residue 2: plugin/hooks/ border-invitation message — value before verb ─
// pre-tool-use.js's border-invitation message builder (warnBorder) executes
// hook-side effects at module load (it reads stdin synchronously), so this
// file can never be `import`ed by a test -- it is read as TEXT and the
// function body sliced out by name, the same live-extraction approach this
// file already uses for src/manifest.js's SURFACES and muster-reviewer.md's
// severity tags. Per the enforcement-model redesign, the message must SELL
// VALUE before naming the verb (guidance.js: CREW_INVITATION), not command
// first -- the inverse ordering of the old scale-gate messages this replaced.
function extractFunctionBody(hookSrc, functionName) {
  const re = new RegExp(`function ${escapeRe(functionName)}\\([^)]*\\)\\s*\\{\\n([\\s\\S]*?)\\n\\}`, "m");
  const m = hookSrc.match(re);
  assert.ok(m, `could not find function ${functionName}(...) in pre-tool-use.js`);
  return m[1];
}

test("border-invitation message: warnBorder sells the shared value sentence before naming the verb", async () => {
  const hookSrc = await read("plugin/hooks/pre-tool-use.js");
  const body = extractFunctionBody(hookSrc, "warnBorder");
  const invitationIdx = body.indexOf("CREW_INVITATION");
  const verbIdx = body.indexOf("/muster:go");
  assert.ok(invitationIdx >= 0, "warnBorder must reference the shared value sentence (guidance.js: CREW_INVITATION)");
  assert.ok(verbIdx >= 0, "warnBorder must instruct via /muster:go");
  assert.ok(
    invitationIdx < verbIdx,
    "warnBorder must sell the value (CREW_INVITATION) BEFORE naming the verb -- invitation, not command",
  );
});

test("pre-tool-use.js: no residue of the deleted wave-guard/scale-gate machinery", async () => {
  const hookSrc = await read("plugin/hooks/pre-tool-use.js");
  for (const dead of ["denyScale", "warnScaleAllow", "warnCumulativeDrift", "MUSTER_WAVE_GUARD", "MUSTER_SCALE_GATE"]) {
    assert.ok(
      !hookSrc.includes(dead),
      `pre-tool-use.js must not reference deleted "${dead}" (removed by the enforcement-model redesign)`,
    );
  }
});

// ── residue 3: src/ header comments — no live citation of a dead mode-file step ──
// run.md, sprint.md, and autopilot.md were retired to one-line alias stubs (their
// step-numbered content moved to plan.md/go.md/go-backlog.md). A src/ comment MAY
// still name one of them historically (e.g. "run.md/sprint.md are now dead alias
// stubs" — src/batch-plan.js's header) but must never cite a SPECIFIC STEP in a dead
// file ("run.md step 0b") as if it were still the doc to consult — that citation
// only makes sense against a step-numbered file, and the numbering no longer exists
// there. A citation counts as historical (allowed) when a marker word (dead/legacy/
// "now ... alias"/former/renamed) appears within the surrounding ~200-char window;
// otherwise it is flagged as a live reference to content that no longer exists.
const DEAD_MODE_FILES = ["run.md", "sprint.md", "autopilot.md"];
const HISTORICAL_MARKER_RE = /\bdead\b|\blegacy\b|\bnow (?:a |an )?(?:legacy )?alias\b|\bformer(?:ly)?\b|\brenamed\b/i;

function findLiveDeadModeFileStepCitations(src) {
  const hits = [];
  for (const file of DEAD_MODE_FILES) {
    const re = new RegExp(`${escapeRe(file)}\\s+step\\b`, "gi");
    let m;
    while ((m = re.exec(src))) {
      const windowStart = Math.max(0, m.index - 200);
      const window = src.slice(windowStart, m.index + m[0].length + 50);
      if (!HISTORICAL_MARKER_RE.test(window)) {
        hits.push({ file, snippet: src.slice(Math.max(0, m.index - 40), m.index + 60).trim() });
      }
    }
  }
  return hits;
}

test("src/ header comments: no src/*.js file cites a dead mode-file step (run.md/sprint.md/autopilot.md step N) as a live, non-historical reference", async () => {
  const files = (await readdir(new URL("../src/", import.meta.url))).filter((f) => f.endsWith(".js"));
  assert.ok(files.length >= 10, "sanity: expected many src/*.js files to scan");
  for (const f of files) {
    const text = await read(`src/${f}`);
    const hits = findLiveDeadModeFileStepCitations(text);
    assert.deepEqual(hits, [], `src/${f} cites a dead mode-file step as a live reference: ${JSON.stringify(hits)}`);
  }
});

// ── residue 4: "run.md step 0b" is gone even from historical-attribution comments ──
// eval/modes/grade-modes.mjs and test/batch-plan.test.js legitimately attribute the
// batch-ref grammar to the pre-migration run.md (historical, not a live reference —
// so residue 3's HISTORICAL_MARKER_RE allowance already lets them cite "run.md" by
// name). But "step 0b" is a specific step number that no longer exists in any doc
// after the rename, historical or not: a reader can't verify or find "step 0b"
// anywhere. These two comments must name the file as historical without citing that
// dead step number.
test('eval/modes/grade-modes.mjs and test/batch-plan.test.js no longer cite "run.md step 0b" (dead step number) even as historical attribution', async () => {
  for (const f of ["eval/modes/grade-modes.mjs", "test/batch-plan.test.js"]) {
    const text = await read(f);
    assert.ok(!/run\.md step 0b/i.test(text), `${f} still cites the dead "run.md step 0b" step number`);
  }
});

// ── residue 5: "sprint.md step 1" is gone too -- sprint.md is a dead alias stub, its
// step-numbered content moved to go-backlog.md step 1 (src/batch-plan.js's own header
// already cites the live "go-backlog.md step 1" location). test/batch-plan.test.js's
// parseBacklogRef header comment still cited "sprint.md step 1" -- reworded to name the
// live go-backlog.md location, same historical-comment-cleanup pattern as residue 4.
test('test/batch-plan.test.js no longer cites "sprint.md step 1" (dead step reference; the live grammar location is go-backlog.md step 1)', async () => {
  const text = await read("test/batch-plan.test.js");
  assert.ok(!/sprint\.md step 1/i.test(text), 'test/batch-plan.test.js still cites the stale "sprint.md step 1" reference');
});
