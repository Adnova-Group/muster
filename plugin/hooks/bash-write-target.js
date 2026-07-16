// bash-write-target.js — pure Bash command classification, used by
// pre-tool-use.js to key its warn-only border-invitation counter for
// high-confidence Bash file writes (see pre-tool-use.js's docblock). No
// caller treats a match as a deny; the classification itself is unchanged.
//
// bashWriteTarget(command): returns the offending fragment string when the
// command is a high-confidence file write, null otherwise.
//
// MATCH patterns (conservative — false positives deferred these):
//   sed with -i flag      \bsed\b[^|;&\n]*?\s-i(\s|$|')
//   tee to non-exempt     \btee\b\s+(-a\s+)?<non-exempt-token>
//   cp/mv to non-exempt   \bcp\b or \bmv\b — destination is the LAST token
//                         (handles flags and multiple sources; fail-open on
//                          ambiguous tokens containing shell metacharacters)
//   > or >> redirect whose target is not /dev/*, /tmp/*, or .muster/*
//     (fd-duplication 2>&1/>&2, heredoc openers <<WORD, and input <file
//      are stripped before scanning)
//
// KNOWN LIMITATION — quoted-string stripping handles balanced single- and
// double-quoted strings. Remaining edge cases: unbalanced quotes and heredoc
// bodies (redirect-looking text between <<MARKER and closing MARKER may still
// false-positive). A false positive here is no longer a deny anywhere in the
// hook stack -- it only affects the border-invitation counter's keying (see
// pre-tool-use.js), which is warn-only.
//
//
// tee multi-target: ALL non-flag tokens after `tee` are checked (A-SEC4).
// `tee /dev/null evil.js` — both targets are inspected; the second non-exempt
// one is caught. Previously only the first non-flag token was checked.
//
// Exemption targets (string-level, no fs resolution): /dev/*, /tmp/*, .muster/*
// Targets are path.normalize()'d before testing so `.muster/../app.js` (which
// resolves OUTSIDE .muster/) is not incorrectly treated as exempt.

import path from "node:path";

const EXEMPT_TARGET_RE = /^(\/dev\/|\/tmp\/|\.muster\/)/;

export function bashWriteTarget(command) {
  if (typeof command !== "string" || command.length === 0) return null;

  // 1. sed -i / sed --in-place
  // Handles `sed -i '...' file`, `sed -n -i ...`, `sed -i'' ...`,
  // `sed -i"" ...` (A-SEC3: double-quote suffix was previously missed),
  // and `sed --in-place ...` / `sed --in-place=.bak ...` (long form, A-SEC3).
  if (
    /\bsed\b[^|;&\n]*?\s-i(?:\s|$|'|")/.test(command) ||
    /\bsed\b[^|;&\n]*\s--in-place(?:\s|=|$)/.test(command)
  ) {
    return "sed -i";
  }

  // 2. tee to a non-exempt target
  // Iterate ALL non-flag tokens (A-SEC4: original only checked the first one,
  // allowing `tee /dev/null evil.js` to pass). Deny on the first non-exempt
  // token found.
  // A-SEC1: if any token contains $' (ANSI-C quoting), path.normalize cannot
  // evaluate the escape sequence — treat as ambiguous and deny.
  // A-SEC5: if any token contains $( (subshell), the path is unresolvable
  // at parse time — treat as ambiguous and deny.
  const teeMatch = command.match(/\btee\b([^|;&\n]*)/);
  if (teeMatch) {
    const tokens = teeMatch[1].trim().split(/\s+/).filter(Boolean);
    for (const t of tokens) {
      if (t.startsWith("-")) continue; // skip flag tokens
      // A-SEC1 + A-SEC5: ANSI-C quote or subshell in path → ambiguous → deny
      if (t.includes("$'") || t.includes("$(")) return `tee ${t}`;
      // A-SEC4: deny on first non-exempt token (checks ALL targets, not just first)
      if (!EXEMPT_TARGET_RE.test(path.normalize(t))) return `tee ${t}`;
    }
  }

  // 3. cp/mv to a non-exempt destination.
  //
  // Strategy: find the first cp/mv command segment (split on shell separators
  // |, ;, &&, ||, &), then extract its destination (last token). Fail-open on
  // anything ambiguous — tokens containing $( ) ` { } or unbalanced quotes.
  //
  // cp handles flags (`cp -r a b`), multiple sources (`cp a b c dir/`) — the
  // destination is always the final non-flag token. We allow the first segment
  // only, splitting on pipeline/sequence operators so `cp a b && echo` only
  // examines `cp a b` (destination `b`).
  const cpMvMatch = command.match(/(?:^|[|;&\n])\s*\b(cp|mv)\b(.*)/);
  if (cpMvMatch) {
    // Take only the first segment after cp/mv (stop at next |, ;, &, \n).
    const afterCmd = cpMvMatch[2];
    const segment = afterCmd.split(/[|;&\n]/)[0];
    // Split into tokens on whitespace. Skip redirection tokens (>, >>, <, <<).
    const rawTokens = segment.trim().split(/\s+/).filter(Boolean);
    // Fail-open if any token contains shell metacharacters that make the
    // destination ambiguous.
    const AMBIGUOUS_RE = /[$`{}()]/;
    if (rawTokens.some((t) => AMBIGUOUS_RE.test(t))) {
      // Ambiguous — cannot reliably determine destination; fail-open.
    } else {
      // Filter out flag tokens (start with -) and redirect operators.
      const REDIR_TOKEN_RE = /^>+$|^<+$/;
      const nonFlagTokens = rawTokens.filter(
        (t) => !t.startsWith("-") && !REDIR_TOKEN_RE.test(t),
      );
      // Need at least 2 tokens: one source and one destination.
      if (nonFlagTokens.length >= 2) {
        const dest = nonFlagTokens[nonFlagTokens.length - 1];
        if (!EXEMPT_TARGET_RE.test(path.normalize(dest))) {
          return `${cpMvMatch[1]} ${dest}`;
        }
      }
    }
  }

  // 4. Output redirection > or >> to a non-exempt target.
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

  // Strip quoted-string contents so `> ` inside them doesn't false-positive.
  // Handles balanced single- and double-quoted strings.
  // Runs AFTER sed/tee checks (those used the original string above) and
  // AFTER fd-dup/heredoc/input strips so those constructs are already gone.
  // Note: $'\x2e' (ANSI-C) has its inner quotes stripped to $QUOTED here,
  // preserving the leading `$` so the broad `$` check below still catches it.
  stripped = stripped.replace(/"[^"]*"|'[^']*'/g, "QUOTED");

  // A-SEC2 (broad, fail-closed): deny any redirect target containing `$`.
  // The hook cannot expand shell variables at parse time — $VAR, ${VAR},
  // $'...' (ANSI-C quoting, inner quotes stripped to $QUOTED above), and
  // $(...) (subshell) are all unresolvable and could bypass the exempt-prefix
  // check (e.g. `> /tmp/$VAR` where VAR expands to `../etc/passwd`).
  // Any `$` in a redirect target is therefore classified fail-closed (matched).
  const redirRe = />{1,2}\s*(\S+)/g;
  let m;
  while ((m = redirRe.exec(stripped)) !== null) {
    const target = m[1];
    if (target.includes("$")) return `> ${target}`;
    if (!EXEMPT_TARGET_RE.test(path.normalize(target))) {
      return `> ${target}`;
    }
  }

  return null;
}
