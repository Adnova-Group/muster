import { test } from "node:test";
import assert from "node:assert/strict";
import { matchFrontmatter } from "../src/frontmatter.js";

test("matchFrontmatter: LF-terminated frontmatter — raw/body/rest split correctly", () => {
  const text = "---\nname: x\ndescription: y\n---\n\nBody text.\n";
  const m = matchFrontmatter(text);
  assert.ok(m, "must match a well-formed LF frontmatter block");
  assert.equal(m.body, "name: x\ndescription: y");
  assert.equal(m.rest, "\nBody text.\n");
  assert.equal(m.raw + m.rest, text, "raw + rest must reconstruct the original text");
});

test("matchFrontmatter: CRLF-terminated frontmatter — raw/body/rest split correctly (regression)", () => {
  const text = "---\r\nname: x\r\ndescription: y\r\n---\r\n\r\nBody text.\r\n";
  const m = matchFrontmatter(text);
  assert.ok(m, "must match a CRLF frontmatter block");
  assert.equal(m.body, "name: x\r\ndescription: y");
  assert.equal(m.rest, "\r\nBody text.\r\n");
  assert.equal(m.raw + m.rest, text, "raw + rest must reconstruct the original text");
});

test("matchFrontmatter: no leading delimiter -> null", () => {
  assert.equal(matchFrontmatter("# Just a heading\nno frontmatter here"), null);
});

test("matchFrontmatter: unterminated frontmatter (no closing ---) -> null", () => {
  assert.equal(matchFrontmatter("---\nname: x\ndescription: y\nno closing delimiter"), null);
});

test("matchFrontmatter: closing delimiter at end-of-string (no trailing newline) matches", () => {
  const text = "---\nname: x\n---";
  const m = matchFrontmatter(text);
  assert.ok(m, "closing --- at EOF must still match");
  assert.equal(m.body, "name: x");
  assert.equal(m.rest, "");
});

test("matchFrontmatter: empty frontmatter block (blank line between delimiters) matches with empty body", () => {
  const text = "---\n\n---\nBody.\n";
  const m = matchFrontmatter(text);
  assert.ok(m);
  assert.equal(m.body, "");
  assert.equal(m.rest, "Body.\n");
});

test("matchFrontmatter: a bare '---' mid-document (not the real close) does not end the match early", () => {
  // The document body legitimately contains a horizontal-rule-style "---" line
  // before the real closing delimiter's own EOL/EOF requirement is satisfied.
  const text = "---\nname: x\n---not-a-real-close\n---\n\nBody.\n";
  const m = matchFrontmatter(text);
  assert.ok(m, "lazy match must keep scanning past a non-EOL/EOF '---' occurrence");
  assert.equal(m.body, "name: x\n---not-a-real-close");
  assert.equal(m.rest, "\nBody.\n");
});
