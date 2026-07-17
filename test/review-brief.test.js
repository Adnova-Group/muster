import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  MUTANT_KILL_TRIGGER_RE,
  CITATION_TRIGGER_RE,
  SURFACE_TRIGGER_RE,
  detectReviewTriggers,
  lightBriefEligible,
} from "../src/review-brief.js";

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");

// fast-path-token-gap item, lever 1: a lighter reviewer brief for the fast path's single
// (reviewerCount:1) reviewer dispatch -- but ONLY when the diff cannot plausibly trigger one
// of review-gate/SKILL.md's own content-conditioned gates (citation guard, mutant-kill gate,
// or a surface-type definition-of-done gate). Any one of those triggers firing means the FULL
// plugin/skills/review-gate/SKILL.md brief is used, unchanged -- criterion 2 (no scope
// reduction) is a hard constraint, enforced here by construction: the light brief is never
// even offered to a diff that could need what it omits.

test("detectReviewTriggers: no triggers on an ordinary small application-code diff", () => {
  const t = detectReviewTriggers(["src/keyword.js", "src/scope.js"]);
  assert.deepEqual(t, { mutantKill: false, citation: false, surface: false, any: false });
});

test("detectReviewTriggers: mutant-kill fires on a test file", () => {
  const t = detectReviewTriggers(["test/scope.test.js"]);
  assert.equal(t.mutantKill, true);
  assert.equal(t.any, true);
});

test("detectReviewTriggers: mutant-kill fires on an eval dataset.json", () => {
  const t = detectReviewTriggers(["eval/modes/dataset.json"]);
  assert.equal(t.mutantKill, true);
  assert.equal(t.any, true);
});

test("detectReviewTriggers: mutant-kill fires on a lint/doctor rule file", () => {
  assert.equal(detectReviewTriggers(["src/prompt-lint.js"]).mutantKill, true);
  assert.equal(detectReviewTriggers(["src/doctor.js"]).mutantKill, true);
});

test("detectReviewTriggers: citation fires on any changed markdown file (conservative -- docs may cite claims)", () => {
  const t = detectReviewTriggers(["docs/some-doc.md"]);
  assert.equal(t.citation, true);
  assert.equal(t.any, true);
});

test("detectReviewTriggers: citation also fires on diff TEXT carrying a `[src: ...]` anchor even with no .md path", () => {
  const t = detectReviewTriggers(["src/foo.js"], { diffText: "+some text [src: anchor-1] more text" });
  assert.equal(t.citation, true);
});

test("detectReviewTriggers: surface fires on UI-globbed paths (components/, *.css, *.scss, app/**/page.*)", () => {
  assert.equal(detectReviewTriggers(["components/Button.tsx"]).surface, true);
  assert.equal(detectReviewTriggers(["src/styles/main.css"]).surface, true);
  assert.equal(detectReviewTriggers(["src/styles/main.scss"]).surface, true);
  assert.equal(detectReviewTriggers(["app/dashboard/page.tsx"]).surface, true);
});

test("detectReviewTriggers: empty/absent diffFiles is safe (no triggers, not a crash)", () => {
  assert.deepEqual(detectReviewTriggers(), { mutantKill: false, citation: false, surface: false, any: false });
  assert.deepEqual(detectReviewTriggers([]), { mutantKill: false, citation: false, surface: false, any: false });
});

test("detectReviewTriggers: rejects a non-array diffFiles (fail loud, not silently treat-as-empty)", () => {
  assert.throws(() => detectReviewTriggers("not-an-array"), /diffFiles must be an array/i);
});

test("lightBriefEligible: false whenever reviewerCount is not exactly 1, regardless of diff content", () => {
  assert.equal(lightBriefEligible({ reviewerCount: 2, diffFiles: ["src/keyword.js"] }), false);
  assert.equal(lightBriefEligible({ reviewerCount: 0, diffFiles: [] }), false);
});

test("lightBriefEligible: true for reviewerCount:1 with no trigger in the diff", () => {
  assert.equal(lightBriefEligible({ reviewerCount: 1, diffFiles: ["src/keyword.js", "src/scope.js"] }), true);
});

test("lightBriefEligible: false for reviewerCount:1 the moment ANY trigger fires -- criterion 2, no scope reduction", () => {
  assert.equal(lightBriefEligible({ reviewerCount: 1, diffFiles: ["test/keyword.test.js"] }), false, "mutant-kill trigger");
  assert.equal(lightBriefEligible({ reviewerCount: 1, diffFiles: ["docs/notes.md"] }), false, "citation trigger");
  assert.equal(lightBriefEligible({ reviewerCount: 1, diffFiles: ["components/Widget.tsx"] }), false, "surface trigger");
  assert.equal(lightBriefEligible({ reviewerCount: 1, diffFiles: ["src/foo.js"], diffText: "[src: x]" }), false, "citation-in-text trigger");
});

test("regex sanity: each exported trigger regex actually matches its documented example", () => {
  assert.ok(MUTANT_KILL_TRIGGER_RE.test("test/foo.test.js"));
  assert.ok(CITATION_TRIGGER_RE.test("docs/foo.md"));
  assert.ok(SURFACE_TRIGGER_RE.test("components/Foo.tsx"));
});

// ── criterion 2 proof (no scope reduction for a SMALL diff) ─────────────────────────────
// The item's own brief requires proving the trimmed fast-path reviewer still catches a
// small-diff defect class, not just asserting it in prose. Two independent proofs:
//
//  1. Fixture/mutant proof: a representative small-diff defect (e.g. a path-traversal bug --
//     unsanitized input reaching a file-read call, small enough to land in a single-reviewer,
//     sub-threshold diff with no test/docs/UI file touched, so lightBriefEligible is true and
//     the LIGHT brief is what a reviewer actually gets) is exactly the class
//     fast-path-brief.md's own "Security" check line names explicitly -- read the REAL file
//     off disk (never a copy-pasted string that could drift from what ships).
//  2. Construction proof: the moment ANY of the three content triggers fires, eligibility is
//     false and the FULL brief (with its own additive surface/citation/mutant-kill gates) is
//     used instead -- already covered by the "false for reviewerCount:1 the moment ANY
//     trigger fires" case above; nothing this module offers ever substitutes the light brief
//     for a diff that could need what it omits.
test("criterion 2 proof: the light brief's real on-disk content still requires checking for a representative small-diff security-defect class (path traversal / unsanitized input to a file/shell/network call)", async () => {
  const brief = await read("plugin/skills/review-gate/fast-path-brief.md");
  assert.match(
    brief,
    /path traversal/i,
    "fast-path-brief.md must explicitly require checking for path traversal (a representative small-diff security defect class)"
  );
  assert.match(
    brief,
    /unsanitized input reaching a shell\/file\/network call/i,
    "fast-path-brief.md must explicitly require checking for unsanitized input reaching a shell/file/network call"
  );
  // Sanity: the SAME defect-fixture scenario (a diff touching only application source, no
  // test/docs/UI file) is exactly what lightBriefEligible reports eligible for -- the light
  // brief above is genuinely what a reviewer would see for this fixture, not a hypothetical.
  assert.equal(
    lightBriefEligible({ reviewerCount: 1, diffFiles: ["src/fs-util.js"] }),
    true,
    "sanity: the fixture's own diff shape is light-brief-eligible"
  );
});
