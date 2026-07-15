// Shared leading-YAML-frontmatter matcher (--- ... ---) for the whole
// project. Three consumers (vendor.js, plugin-inventory.js, prompt-discover.js)
// used to hand-roll their own delimiter regex, and they drifted: two were
// CRLF-tolerant, one (vendor.js) was not — a CRLF-terminated vendored source
// silently lost its frontmatter (splitFrontmatter fell through to the
// no-match path, dropping name/description without warning). One matcher,
// used everywhere, keeps that class of drift from recurring.
//
// CRLF-tolerant throughout (`\r?\n`): source files vendored from other repos,
// or authored on Windows, may use CRLF line endings.
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

// Matches a leading frontmatter block. Returns null when `text` has none —
// callers degrade to "no frontmatter" rather than throwing. On a match,
// returns:
//   - raw:  the whole matched block, delimiters included (for stripping)
//   - body: the YAML text between the delimiters (for parsing / line-scanning)
//   - rest: everything after the matched block (the document body)
// The closing delimiter must end the line (optional trailing spaces/tabs,
// then a newline or end-of-string) — a bare `---` embedded mid-line doesn't
// count as a close, so the lazy capture keeps scanning for the real one.
export function matchFrontmatter(text) {
  const str = String(text);
  const m = str.match(FRONTMATTER_RE);
  if (!m) return null;
  return { raw: m[0], body: m[1], rest: str.slice(m[0].length) };
}
