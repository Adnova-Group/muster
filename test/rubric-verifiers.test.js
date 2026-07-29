import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// rubric-verifiers item: an optional .muster/rubric.md, consumed by review-gate reviewer
// briefs and tournament judges when present, adopted from Anthropic's Claude-5
// context-engineering guidance (rubrics let a verifier agent check work against the user's
// stated taste). Both consumers are ALWAYS-ON verifiers already -- review-gate's reviewers,
// tournament's judge -- so the rubric rides along their existing dispatch, additive only:
// absence of the file changes nothing, and reviewers/judges propose against the rubric's own
// named dimensions rather than inventing new ones.

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

const REVIEW_GATE = "plugin/skills/review-gate/SKILL.md";
const TOURNAMENT = "plugin/skills/tournament/SKILL.md";
const FAST_PATH_BRIEF = "plugin/skills/review-gate/fast-path-brief.md";

test("review-gate/SKILL.md: rubric consumption is conditional on .muster/rubric.md existing", async () => {
  const text = await read(REVIEW_GATE);
  assert.match(
    text,
    /\.muster\/rubric\.md/,
    "review-gate/SKILL.md must name .muster/rubric.md"
  );
  assert.match(
    text,
    /when `\.muster\/rubric\.md` exists/i,
    "the rubric rule must be explicitly conditioned on the file existing"
  );
});

test("review-gate/SKILL.md: every reviewer brief includes the rubric's content verbatim as a RUBRIC: block", async () => {
  const text = await read(REVIEW_GATE);
  assert.match(
    text,
    /every\s+reviewer\s+brief\s+includes[^.]*verbatim[^.]*`RUBRIC:`/i,
    "review-gate/SKILL.md must require the rubric's content verbatim as a RUBRIC: block in every reviewer brief"
  );
});

test("review-gate/SKILL.md: findings that map to a rubric dimension cite it by name", async () => {
  const text = await read(REVIEW_GATE);
  assert.match(
    text,
    /findings?\s+that\s+maps?\s+to\s+a\s+rubric\s+dimension\s+cites?\s+(it|that\s+dimension)\s+by\s+name/i,
    "review-gate/SKILL.md must require findings mapped to a rubric dimension to cite it by name"
  );
});

test("review-gate/SKILL.md: reviewers propose against the rubric, never fabricate a dimension it does not carry", async () => {
  const text = await read(REVIEW_GATE);
  assert.match(
    text,
    /propose-not-invent/i,
    "review-gate/SKILL.md must name the propose-not-invent discipline for rubric dimensions"
  );
  assert.match(
    text,
    /reviewers never fabricate (a )?rubric dimensions?/i,
    "review-gate/SKILL.md must state reviewers never fabricate rubric dimensions"
  );
});

test("review-gate/SKILL.md: absence of .muster/rubric.md changes nothing", async () => {
  const text = await read(REVIEW_GATE);
  assert.match(
    text,
    /absence of (the file|`\.muster\/rubric\.md`) changes nothing/i,
    "review-gate/SKILL.md must state the absent-file case is a no-op"
  );
});

test("tournament/SKILL.md: the judge consumes the same .muster/rubric.md when present", async () => {
  const text = await read(TOURNAMENT);
  assert.match(
    text,
    /\.muster\/rubric\.md/,
    "tournament/SKILL.md must name .muster/rubric.md"
  );
  assert.match(
    text,
    /when `\.muster\/rubric\.md` exists/i,
    "tournament/SKILL.md must condition rubric consumption on the file existing, matching review-gate"
  );
});

test("tournament/SKILL.md: scoring cites rubric dimensions alongside the existing successCriteria", async () => {
  const text = await read(TOURNAMENT);
  assert.match(
    text,
    /cites?\s+rubric\s+dimensions?\s+(by\s+name\s+)?alongside\s+the\s+existing\s+(success\s?criteria|criteria)/i,
    "tournament/SKILL.md must require scoring justification to cite rubric dimensions alongside successCriteria"
  );
});

test("tournament/SKILL.md: absence of .muster/rubric.md leaves judge scoring unchanged", async () => {
  const text = await read(TOURNAMENT);
  assert.match(
    text,
    /absent (the file|`\.muster\/rubric\.md`)[^.]*(scoring is )?unchanged/i,
    "tournament/SKILL.md must state the absent-file case leaves scoring unchanged"
  );
});

test("tournament/SKILL.md: the judge propose-not-invents rubric dimensions too, not just review-gate's reviewers", async () => {
  const text = await read(TOURNAMENT);
  assert.match(
    text,
    /propose-not-invent/i,
    "tournament/SKILL.md must name the propose-not-invent discipline for the judge's rubric use"
  );
});

// review-gate/SKILL.md's own "Fast-path reviewer brief" section dispatches
// fast-path-brief.md INSTEAD OF the full file whenever reviewerCount:1 and no
// citation/mutant-kill/surface trigger fires -- a real, in-scope "reviewer brief"
// per the file's own taxonomy. "Every reviewer brief" is false unless this file
// carries the same rule too (review finding, fix loop 1).
test("fast-path-brief.md: rubric consumption is conditional on .muster/rubric.md existing", async () => {
  const text = await read(FAST_PATH_BRIEF);
  assert.match(
    text,
    /when `\.muster\/rubric\.md` exists/i,
    "fast-path-brief.md must condition rubric consumption on the file existing, matching review-gate/SKILL.md"
  );
});

test("fast-path-brief.md: includes the rubric's content verbatim as a RUBRIC: block", async () => {
  const text = await read(FAST_PATH_BRIEF);
  assert.match(
    text,
    /verbatim[^.]*`RUBRIC:`/i,
    "fast-path-brief.md must require the rubric's content verbatim as a RUBRIC: block"
  );
});

test("fast-path-brief.md: a finding mapped to a rubric dimension cites it by name", async () => {
  const text = await read(FAST_PATH_BRIEF);
  assert.match(
    text,
    /rubric\s+dimension\s+cites?\s+(it|that\s+dimension)\s+by\s+name/i,
    "fast-path-brief.md must require findings mapped to a rubric dimension to cite it by name"
  );
});

test("fast-path-brief.md: propose-not-invent -- never fabricates a rubric dimension the file does not carry", async () => {
  const text = await read(FAST_PATH_BRIEF);
  assert.match(
    text,
    /propose-not-invent/i,
    "fast-path-brief.md must name the propose-not-invent discipline for rubric dimensions"
  );
});

test("fast-path-brief.md: absence of .muster/rubric.md changes nothing", async () => {
  const text = await read(FAST_PATH_BRIEF);
  assert.match(
    text,
    /absent[^.]*(the file|`\.muster\/rubric\.md`)[^.]*(changes nothing|no-op|unchanged)/i,
    "fast-path-brief.md must state the absent-file case is a no-op"
  );
});
