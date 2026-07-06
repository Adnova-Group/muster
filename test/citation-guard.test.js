import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkCitations } from "../src/citation-guard.js";

const pexec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// Citation syntax: `[src: <anchor>]` inline; anchors resolve against a `## Sources` list at the
// end of the artifact (`- <anchor>: <url-or-file+line>`). v1 checks (a) every anchor resolves and
// (b) reports paragraphs with zero citations -- it does NOT judge whether a paragraph is actually
// a claim needing evidence (that's a human/reviewer call).

test("clean file: every anchor resolves, every paragraph cited -> ok, no uncited, no dangling", () => {
  const doc = [
    "Revenue grew 40% year over year [src: report2024].",
    "",
    "The team shipped the migration ahead of schedule [src: interview1].",
    "",
    "## Sources",
    "- report2024: https://example.com/annual-report",
    "- interview1: notes.md#L12",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.ok, true);
  assert.equal(r.claims, 2);
  assert.equal(r.cited, 2);
  assert.deepEqual(r.uncited, []);
  assert.deepEqual(r.danglingAnchors, []);
});

test("dangling anchor: a [src: x] with no matching Sources entry fails and is reported with its line", () => {
  const doc = [
    "Revenue grew 40% year over year [src: ghost].",
    "",
    "## Sources",
    "- report2024: https://example.com/annual-report",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.ok, false);
  assert.equal(r.danglingAnchors.length, 1);
  assert.equal(r.danglingAnchors[0].anchor, "ghost");
  assert.equal(r.danglingAnchors[0].line, 1);
});

test("uncited paragraph: reported by line number, but does not by itself fail ok", () => {
  const doc = [
    "Revenue grew 40% year over year [src: report2024].",
    "",
    "This paragraph makes a claim with no citation attached at all.",
    "",
    "## Sources",
    "- report2024: https://example.com/annual-report",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.ok, true, "uncited paragraphs alone do not fail -- they go to the reviewer");
  assert.equal(r.claims, 2);
  assert.equal(r.cited, 1);
  assert.deepEqual(r.uncited, [3], "uncited paragraph's starting line is reported");
});

test("both dangling anchor and uncited paragraph can be reported together", () => {
  const doc = [
    "Uncited claim with no bracket at all.",
    "",
    "Cited claim with a bad anchor [src: nope].",
    "",
    "## Sources",
    "- report2024: https://example.com/annual-report",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.ok, false);
  assert.deepEqual(r.uncited, [1]);
  assert.equal(r.danglingAnchors.length, 1);
  assert.equal(r.danglingAnchors[0].anchor, "nope");
});

test("headings and fenced code blocks are not counted as claim paragraphs", () => {
  const doc = [
    "# Report",
    "",
    "```js",
    "const uncited = true; // no [src: x] here either",
    "```",
    "",
    "Real prose claim with a citation [src: a].",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.claims, 1, "heading + code fence are excluded from claim paragraphs");
  assert.equal(r.cited, 1);
  assert.equal(r.ok, true);
});

test("F1: inline single-backtick code spans mask citation syntax like fenced blocks", () => {
  const doc = [
    "Use the syntax `[src: ghost]` inline in your writing to cite a claim.",
    "",
    "```md",
    "Another example: [src: ghost]",
    "```",
    "",
    "A real cited claim [src: real].",
    "",
    "## Sources",
    "- real: https://example.com",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.ok, true, "the backtick-quoted anchor is documentation, not a real citation or a dangling one");
  assert.deepEqual(r.danglingAnchors, []);
  assert.equal(r.claims, 2, "the inline-code line and the real claim are each a claim paragraph");
  assert.equal(r.cited, 1, "the inline code span does not count as a real citation");
  assert.deepEqual(r.uncited, [1]);
});

test("F2: only the Sources section (heading to next same-or-higher heading) is source-list territory; a following heading's content is body and gets scanned", () => {
  const doc = [
    "A cited claim [src: a].",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
    "## Appendix",
    "",
    "A stray claim in the appendix with a dangling anchor [src: ghost].",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.ok, false, "the appendix is body prose, not source-list territory -- its dangling anchor must be caught");
  assert.equal(r.danglingAnchors.length, 1);
  assert.equal(r.danglingAnchors[0].anchor, "ghost");
  assert.equal(r.danglingAnchors[0].line, 8);
  assert.equal(r.claims, 2, "the appendix paragraph is a claim unit too");
});

test("F3: contiguous list items are individual claim units, not one paragraph", () => {
  const doc = [
    "- Bullet one with a citation [src: a].",
    "- Bullet two with no citation.",
    "- Bullet three with no citation either.",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.claims, 3, "each list item is its own claim unit");
  assert.equal(r.cited, 1);
  assert.deepEqual(r.uncited, [2, 3], "the other two bullets are reported by their own line");
});

test("F3: a wrapped multi-line list item stays one claim unit", () => {
  const doc = [
    "- Bullet one that wraps",
    "  onto a second physical line [src: a].",
    "- Bullet two with no citation.",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.claims, 2, "the wrapped continuation line stays part of the first item");
  assert.equal(r.cited, 1);
  assert.deepEqual(r.uncited, [3]);
});

test("F4: an anchor with characters outside the allowed charset is reported as malformed, not silently downgraded to uncited", () => {
  const doc = [
    "A claim with a typo'd anchor [src: bad anchor!].",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.ok, false, "a malformed anchor must fail, not silently vanish as an uncited paragraph");
  assert.equal(r.malformedCitations.length, 1);
  assert.equal(r.malformedCitations[0].line, 1);
  assert.equal(r.malformedCitations[0].raw, "bad anchor!");
  assert.deepEqual(r.danglingAnchors, [], "a malformed anchor is reported once, not double-counted as dangling too");
});

test("F5: a duplicate source anchor is a non-fatal warning, not a failure", () => {
  const doc = [
    "A cited claim [src: a].",
    "",
    "## Sources",
    "- a: https://example.com/one",
    "- a: https://example.com/two",
    "",
  ].join("\n");
  const r = checkCitations(doc);
  assert.equal(r.ok, true, "a duplicate source entry is a warning, not a failure");
  assert.equal(r.warnings.length, 1);
  assert.equal(r.warnings[0].type, "duplicate-source");
  assert.equal(r.warnings[0].anchor, "a");
  assert.deepEqual(r.warnings[0].lines, [4, 5]);
});

test("no Sources section at all: every citation is dangling", () => {
  const doc = "A claim with a citation [src: report2024].";
  const r = checkCitations(doc);
  assert.equal(r.ok, false);
  assert.equal(r.danglingAnchors.length, 1);
  assert.equal(r.danglingAnchors[0].anchor, "report2024");
});

test("empty / nullish input never throws and reports a clean, empty result", () => {
  const empty = { ok: true, claims: 0, cited: 0, uncited: [], danglingAnchors: [], malformedCitations: [], warnings: [] };
  assert.deepEqual(checkCitations(""), empty);
  assert.deepEqual(checkCitations(undefined), empty);
  assert.deepEqual(checkCitations(null), empty);
});

test("deterministic: same input always produces the same result", () => {
  const doc = [
    "A cited claim [src: a].",
    "",
    "An uncited claim.",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
  ].join("\n");
  assert.deepEqual(checkCitations(doc), checkCitations(doc));
});

// --- CLI wiring: `muster citation-check <file>` -------------------------------

let dir;
test("setup tmp dir", async () => { dir = await mkdtemp(join(tmpdir(), "muster-citation-cli-")); });

test("citation-check CLI: clean file exits 0 and prints the report", async () => {
  const f = join(dir, "clean.md");
  await writeFile(f, [
    "A cited claim [src: a].",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
  ].join("\n"));
  const r = JSON.parse((await pexec("node", [CLI, "citation-check", f])).stdout);
  assert.equal(r.ok, true);
  assert.deepEqual(r.danglingAnchors, []);
});

test("citation-check CLI: dangling anchor exits 2 (auto-fail)", async () => {
  const f = join(dir, "dangling.md");
  await writeFile(f, [
    "A cited claim [src: ghost].",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
  ].join("\n"));
  await assert.rejects(
    () => pexec("node", [CLI, "citation-check", f]),
    (err) => {
      assert.equal(err.code, 2, "dangling anchors must exit 2");
      const r = JSON.parse(err.stdout);
      assert.equal(r.ok, false);
      assert.equal(r.danglingAnchors[0].anchor, "ghost");
      return true;
    }
  );
});

test("F4 CLI: malformed anchor is passed through the JSON report and exits 2", async () => {
  const f = join(dir, "malformed.md");
  await writeFile(f, [
    "A claim with a typo'd anchor [src: bad anchor!].",
    "",
    "## Sources",
    "- a: https://example.com",
    "",
  ].join("\n"));
  await assert.rejects(
    () => pexec("node", [CLI, "citation-check", f]),
    (err) => {
      assert.equal(err.code, 2, "malformed anchors must exit 2");
      const r = JSON.parse(err.stdout);
      assert.equal(r.ok, false);
      assert.equal(r.malformedCitations[0].raw, "bad anchor!");
      return true;
    }
  );
});
