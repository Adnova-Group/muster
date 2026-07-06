// Citation guard: deterministic checker for research/content artifacts that cite claims inline
// as `[src: <anchor>]`, where every anchor must resolve to an entry in a "Sources" list at the
// artifact's end (`- <anchor>: <url-or-file+line>`). Code over model: whether an anchor resolves
// is a pure regex match, no LLM judgment needed.
//
// LIMITATION (by design, v1): this does NOT detect "claims" linguistically -- it has no notion of
// what counts as an assertive statistic, quote, or named fact. It only reports (a) anchors that
// fail to resolve against the Sources list (dangling -- an automatic FAIL) and (b) paragraphs
// with zero citations at all (uncited -- handed to a human/reviewer to judge: is this actually a
// claim needing evidence, or just connective prose?). See plugin/skills/review-gate/SKILL.md for
// how the two are used differently downstream.

const CITE_SOURCE = "\\[src:\\s*([A-Za-z0-9_.-]+)\\s*\\]";
// Loose match: any `[src: ...]`, whatever the anchor's contents, so a malformed anchor (one
// outside the allowed charset -- e.g. a stray space or punctuation from a typo) is still found
// and reported instead of silently vanishing because CITE_SOURCE alone never matched it.
const CITE_SOURCE_LOOSE = "\\[src:\\s*([^\\]]*)\\]";
const ANCHOR_RE = /^[A-Za-z0-9_.-]+$/;
const SOURCE_ENTRY_RE = /^[-*]\s+([A-Za-z0-9_.-]+)\s*:\s*(.+)$/;

// Match a heading line, returning its level (# count) and trimmed text, or null.
function headingMatch(line) {
  const m = /^(#{1,6})\s*(.*)$/.exec(line);
  return m ? { level: m[1].length, text: m[2].trim() } : null;
}

// Find the "Sources" section: the first "Sources" heading (any level, case-insensitive, not
// inside a fenced code block) through the line before the next heading at the SAME OR HIGHER
// level, or EOF if none follows. That range -- and only that range -- is source-list territory;
// a later heading (e.g. "## Appendix") ends it, and everything from there on is body prose again,
// subject to the same claim/citation scanning as the rest of the document.
function findSourcesMask(lines, fence) {
  const sourceMask = new Array(lines.length).fill(false);
  for (let i = 0; i < lines.length; i++) {
    if (fence[i]) continue;
    const h = headingMatch(lines[i]);
    if (!h || !/^sources$/i.test(h.text)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      if (fence[j]) continue;
      const h2 = headingMatch(lines[j]);
      if (h2 && h2.level <= h.level) { end = j; break; }
    }
    for (let k = i; k < end; k++) sourceMask[k] = true;
    break; // v1: only the first Sources heading is recognized
  }
  return sourceMask;
}

// Parse the "Sources" section lines into an anchor -> { target, lines } map. `lines` tracks
// every 1-based line number the anchor was declared on, so a duplicate declaration can be
// reported as a (non-fatal) warning without losing the original entry.
function parseSources(lines, sourceMask) {
  const map = new Map();
  lines.forEach((line, i) => {
    if (!sourceMask[i]) return;
    const m = SOURCE_ENTRY_RE.exec(line.trim());
    if (!m) return;
    const anchor = m[1];
    if (!map.has(anchor)) map.set(anchor, { target: m[2].trim(), lines: [] });
    map.get(anchor).lines.push(i + 1);
  });
  return map;
}

// Blank out single-backtick inline code spans (`...`) on a line so a `[src: x]` mentioned as
// documentation of the citation syntax itself -- e.g. "use `[src: x]` to cite" -- is masked just
// like a fenced code block: neither a real citation nor a dangling one.
function maskInlineCode(line) {
  return line.replace(/`[^`]*`/g, (m) => " ".repeat(m.length));
}

// Mark which lines of `body` sit inside a fenced (```) code block. A fence line itself counts as
// "inside" (it's markup, not prose or a real citation) so neither a heading nor a `[src: x]`
// mention inside example code is mistaken for a claim or a real citation.
function fenceMask(lines) {
  const mask = [];
  let inFence = false;
  for (const line of lines) {
    const isFence = /^\s*```/.test(line);
    mask.push(inFence || isFence);
    if (isFence) inFence = !inFence;
  }
  return mask;
}

// A bullet (-, *, +) or numbered (1. / 1)) list item start. Continuation lines of a wrapped item
// (e.g. an indented second physical line) don't match this and stay folded into the same item.
const LIST_ITEM_RE = /^\s*(?:[-*+]|\d+[.)])\s+/;

// Split body prose into paragraphs (blank-line separated), each tagged with its 1-based starting
// line number. Fenced code blocks and heading-only lines are excluded -- neither is a claim. A
// contiguous list block is split further: each list item is its own claim unit (a wrapped
// multi-line item stays one unit); non-list prose paragraphs are left as a single unit as before.
function paragraphs(lines, mask) {
  const out = [];
  let cur = [], start = null;
  const flush = () => {
    if (!cur.length) return;
    if (LIST_ITEM_RE.test(cur[0])) {
      let itemLines = [cur[0]], itemStart = start;
      for (let i = 1; i < cur.length; i++) {
        if (LIST_ITEM_RE.test(cur[i])) {
          out.push({ text: itemLines.join("\n"), line: itemStart });
          itemLines = [cur[i]];
          itemStart = start + i;
        } else {
          itemLines.push(cur[i]);
        }
      }
      out.push({ text: itemLines.join("\n"), line: itemStart });
    } else {
      out.push({ text: cur.join("\n"), line: start });
    }
    cur = []; start = null;
  };
  lines.forEach((line, i) => {
    if (mask[i] || !line.trim() || /^\s*#{1,6}\s/.test(line)) { flush(); return; }
    if (start === null) start = i + 1;
    cur.push(maskInlineCode(line));
  });
  flush();
  return out;
}

// Check `text` for citation hygiene. Returns:
//   { ok, claims, cited, uncited: [lineNumbers], danglingAnchors: [{anchor, line}],
//     malformedCitations: [{line, raw}], warnings: [{type, anchor, lines}] }
// `ok` is false when a dangling anchor OR a malformed anchor exists (both auto-fail); uncited
// paragraphs and warnings are non-fatal and never flip `ok` on their own.
export function checkCitations(text) {
  const src = String(text ?? "");
  const lines = src.split("\n");
  const fence = fenceMask(lines);
  const sourceMask = findSourcesMask(lines, fence);
  const sources = parseSources(lines, sourceMask);
  const mask = lines.map((_, i) => fence[i] || sourceMask[i]);

  const danglingAnchors = [];
  const malformedCitations = [];
  lines.forEach((line, i) => {
    if (mask[i]) return; // a `[src: x]` mentioned inside example code is not a real citation
    const re = new RegExp(CITE_SOURCE_LOOSE, "g");
    let m;
    while ((m = re.exec(maskInlineCode(line)))) {
      const raw = m[1].trim();
      if (!ANCHOR_RE.test(raw)) {
        // Anchor has chars outside the allowed set (e.g. a stray space/typo): report it plainly
        // rather than letting it silently fall through as an ordinary uncited paragraph.
        malformedCitations.push({ line: i + 1, raw });
      } else if (!sources.has(raw)) {
        danglingAnchors.push({ anchor: raw, line: i + 1 });
      }
    }
  });

  const paras = paragraphs(lines, mask);
  const citeTest = new RegExp(CITE_SOURCE);
  const uncited = paras.filter((p) => !citeTest.test(p.text)).map((p) => p.line);

  const warnings = [];
  for (const [anchor, entry] of sources) {
    // A duplicate source declaration is a hygiene smell, not a failure: the anchor still
    // resolves fine, so it never flips `ok` -- just surfaced for a human to tidy up.
    if (entry.lines.length > 1) warnings.push({ type: "duplicate-source", anchor, lines: entry.lines });
  }

  return {
    ok: danglingAnchors.length === 0 && malformedCitations.length === 0,
    claims: paras.length,
    cited: paras.length - uncited.length,
    uncited,
    danglingAnchors,
    malformedCitations,
    warnings,
  };
}
