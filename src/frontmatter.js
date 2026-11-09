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

// Split a frontmatter body into its top-level key blocks: each block is the key's
// line plus every following indented / sequence-continuation / blank line. Lines
// outside any key block (top-level comments) form keyless blocks.
export function topLevelBlocks(yamlText) {
  const blocks = [];
  for (const line of String(yamlText).split(/\r?\n/)) {
    const top = line.match(/^([A-Za-z_][\w-]*):/);
    if (top) blocks.push({ key: top[1], lines: [line] });
    else if (blocks.at(-1)?.key && (/^(\s|-\s|-$)/.test(line) || line.trim() === "")) blocks.at(-1).lines.push(line);
    else blocks.push({ key: null, lines: [line] });
  }
  return blocks;
}

// Lenient frontmatter parse. Each top-level block is parsed on its own, and a
// single-line value that strict YAML rejects -- a plain scalar with a mid-string
// ": ", which several of muster's own skill descriptions carry (see
// plugin-inventory.js) -- is taken verbatim instead of failing the whole header.
export function parseFrontmatterLenient(yamlText, parseYaml) {
  const data = {};
  for (const block of topLevelBlocks(yamlText)) {
    if (!block.key) continue;
    try {
      Object.assign(data, parseYaml(block.lines.join("\n")) || {});
    } catch (error) {
      if (block.lines.filter(line => line.trim()).length !== 1) throw error;
      data[block.key] = block.lines[0].slice(block.key.length + 1).trim();
    }
  }
  return data;
}
