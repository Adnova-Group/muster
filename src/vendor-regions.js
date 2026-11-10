// Verbatim regions: protocol text an adapted agent carries byte-for-byte from an
// upstream file, marked so a future merge (or a reviewer) can see what must not
// be paraphrased. Marker grammar, one per line:
//
//   <!-- verbatim: <source> <upstream path>:<first>-<last> -->
//   ...exactly lines <first>..<last> of vendor/upstream/<source>/<upstream path>...
//   <!-- /verbatim -->
//
// The base copy under vendor/upstream/ is the pinned upstream file, so a region
// is checkable offline: its body must equal those base lines exactly. Pure; the
// caller supplies the base reader.

export const VERBATIM_OPEN_RE = /^<!-- verbatim: ([A-Za-z0-9_-]+) (\S+):(\d+)-(\d+) -->$/;
export const VERBATIM_CLOSE = "<!-- /verbatim -->";

// Every region in `text`, in order. Malformed nesting or an unclosed region is
// reported in `errors` rather than thrown, so one bad marker does not hide others.
export function parseVerbatimRegions(text) {
  const lines = text.split("\n");
  const regions = [];
  const errors = [];
  let open = null;
  lines.forEach((line, index) => {
    const m = line.match(VERBATIM_OPEN_RE);
    if (m) {
      if (open) errors.push(`line ${index + 1}: verbatim region opened inside the region opened at line ${open.openLine}`);
      open = { source: m[1], path: m[2], start: Number(m[3]), end: Number(m[4]), openLine: index + 1, body: [] };
      return;
    }
    if (line === VERBATIM_CLOSE) {
      if (!open) { errors.push(`line ${index + 1}: ${VERBATIM_CLOSE} without an open region`); return; }
      regions.push({ ...open, closeLine: index + 1, body: open.body.join("\n") });
      open = null;
      return;
    }
    if (open) open.body.push(line);
  });
  if (open) errors.push(`line ${open.openLine}: verbatim region never closed`);
  return { regions, errors };
}

// The lines first..last (1-based, inclusive) of a file's text, joined with "\n".
export function linesOf(text, first, last) {
  return text.split("\n").slice(first - 1, last).join("\n");
}

// Check every region of `text` against its base copy. `readBase(source, path)`
// returns the base file's text or null when there is no base copy.
export function checkVerbatimRegions(text, readBase) {
  const { regions, errors } = parseVerbatimRegions(text);
  for (const r of regions) {
    const at = `verbatim ${r.source} ${r.path}:${r.start}-${r.end} (line ${r.openLine})`;
    if (r.start < 1 || r.end < r.start) { errors.push(`${at}: invalid line range`); continue; }
    const base = readBase(r.source, r.path);
    if (base === null || base === undefined) { errors.push(`${at}: no base copy under vendor/upstream/${r.source}/`); continue; }
    if (r.end > base.split("\n").length) { errors.push(`${at}: range runs past the end of the base copy`); continue; }
    if (r.body !== linesOf(base, r.start, r.end)) errors.push(`${at}: body differs from the base copy`);
  }
  return { regions, errors };
}

// gsd runtime coupling an adapted agent must not carry: the gsd-tools / gsd_run
// CLI, the gsd SDK, `.planning/` state, `@~/.claude/gsd-core` includes and gsd
// slash commands. HTML comments (the verbatim markers, provenance notes) are
// exempt so a marker may name its upstream file.
const GSD_COUPLING_RES = [
  /gsd-tools/, /gsd_run/, /gsd-sdk/, /\.planning\b/, /~\/\.claude\/gsd/, /\$HOME\/\.claude\/gsd/,
  /(^|[\s`'"(])\/gsd[-:][a-z]/
];
export function gsdCouplingHits(text) {
  const hits = [];
  const stripped = text.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, " "));
  stripped.split("\n").forEach((line, index) => {
    for (const re of GSD_COUPLING_RES) {
      const m = line.match(re);
      if (m) hits.push({ line: index + 1, match: m[0].trim(), text: line.trim().slice(0, 120) });
    }
  });
  return hits;
}
