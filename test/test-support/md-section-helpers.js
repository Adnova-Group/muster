// test/test-support/md-section-helpers.js — shared markdown section slicer for tests
// that extract a single "## <heading>" section from a doc so they can assert against
// its body alone, without incidental prose elsewhere in the file satisfying the check.
//
// Exports:
//   sliceMdSection(src, heading) — the text of the "## <heading>" section (everything
//                                   after the heading's own line, up to the next "## "
//                                   heading or end of string). Returns null when the
//                                   heading line is not found.

import { escapeRe } from "../../src/keyword.js";

/**
 * Slice the body of a `## <heading>` markdown section out of `src`: everything after
 * the heading's own line, up to (not including) the next top-level `## ` heading, or
 * end of string if this is the last section.
 *
 * @param {string} src
 * @param {string} heading - the heading text, exactly as it appears after "## " (regex
 *   metacharacters in it are escaped automatically)
 * @returns {string | null} the section body, or null if the heading line was not found
 */
export function sliceMdSection(src, heading) {
  // No "m" flag: "$" must mean true end-of-string here, not end-of-line — with
  // multiline "$" a blank line right after the heading (the common "## Heading\n\nBody"
  // shape) satisfies the lookahead at zero characters and the lazy capture stops
  // immediately, returning "". "(?:^|\n)" gives line-start matching for the heading
  // without turning on multiline "$".
  const re = new RegExp(`(?:^|\\n)## ${escapeRe(String(heading))}\\n([\\s\\S]*?)(?=\\n## |$)`);
  const m = src.match(re);
  return m ? m[1] : null;
}
