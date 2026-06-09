// bash-write-target.js — pure Bash command classification for the wave-guard.
//
// bashWriteTarget(command): returns the offending fragment string when the
// command is a high-confidence file write, null otherwise.
//
// DENY patterns (conservative — false positives deferred these):
//   sed with -i flag      \bsed\b[^|;&\n]*?\s-i(\s|$|')
//   tee to non-exempt     \btee\b\s+(-a\s+)?<non-exempt-token>
//   > or >> redirect whose target is not /dev/*, /tmp/*, or .muster/*
//     (fd-duplication 2>&1/>&2, heredoc openers <<WORD, and input <file
//      are stripped before scanning)
//
// KNOWN LIMITATION — heredoc bodies: redirect-looking text inside a heredoc
// body (between <<MARKER and closing MARKER) may false-positive because we do
// not parse heredoc bodies. This is an accepted tradeoff: the simpler regex
// scanner avoids a full shell parser. The deny reason in pre-tool-use.js
// includes a note to use MUSTER_WAVE_GUARD=warn as the escape hatch.
// Example: `cat <<EOF\nhello > not-real\nEOF` may fire on the body line, but
// `cat <<EOF > file` correctly fires on the outer redirect (independently).
//
// Exemption targets (string-level, no fs resolution): /dev/*, /tmp/*, .muster/*

const EXEMPT_TARGET_RE = /^(\/dev\/|\/tmp\/|\.muster\/)/;

export function bashWriteTarget(command) {
  if (typeof command !== "string" || command.length === 0) return null;

  // 1. sed -i
  // Handles `sed -i '...' file`, `sed -n -i ...`, `sed -i'' ...`
  if (/\bsed\b[^|;&\n]*?\s-i(?:\s|$|')/.test(command)) {
    return "sed -i";
  }

  // 2. tee to a non-exempt target
  // Match: word boundary `tee`, optional -a flag, then the target token.
  const teeMatch = command.match(/\btee\b\s+(?:-a\s+)?(\S+)/);
  if (teeMatch) {
    const target = teeMatch[1];
    if (!EXEMPT_TARGET_RE.test(target)) {
      return `tee ${target}`;
    }
  }

  // 3. Output redirection > or >> to a non-exempt target.
  //
  // Strip safe constructs first, then scan for remaining > / >> tokens.
  //   Strip fd-duplication:    2>&1, >&2, 1>&2, etc.
  //   Strip heredoc openers:   <<[-]?WORD  (body not parsed — known limitation)
  //   Strip input redirects:   < file
  // Then find >>? followed by a file token; deny if not exempt.

  let stripped = command;
  // Strip fd-duplication: `2>&1`, `>&2`, `0>&1`, etc.
  stripped = stripped.replace(/\d*>&\d+/g, "");
  // Strip heredoc openers: `<<[-]?WORD`
  stripped = stripped.replace(/<<[-]?\w+/g, "");
  // Strip input redirects `< file` (not output, not heredoc)
  stripped = stripped.replace(/<\s*\S+/g, "");

  // Now find >>? followed by a file token
  const redirRe = />{1,2}\s*(\S+)/g;
  let m;
  while ((m = redirRe.exec(stripped)) !== null) {
    const target = m[1];
    if (!EXEMPT_TARGET_RE.test(target)) {
      return `> ${target}`;
    }
  }

  return null;
}
