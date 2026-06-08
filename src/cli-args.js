// Pure, testable CLI arg/error helpers. Kept out of cli.js so cli.js can run its
// dispatch unconditionally (it is the bin entry, invoked both directly and via the
// `muster` symlink) without a fragile is-main guard, while tests import from here.

// Parse the `domain` verb args: an optional `--domain <value>` override plus the
// outcome string. The token consumed as the flag value must NOT also be read as the
// outcome. Returns { override, outcome }; outcome is "" when no remaining text is
// present (caller should fail on the missing required arg).
export function parseDomainArgs(rest) {
  const di = rest.indexOf("--domain");
  const override = di >= 0 ? rest[di + 1] : undefined;
  const skip = new Set(di >= 0 ? [di, di + 1] : []);
  const outcome = rest.find((_, i) => !skip.has(i)) || "";
  return { override, outcome };
}

// Format a caught error for stderr: full stack under DEBUG, friendly message otherwise.
export function formatError(e, env = process.env) {
  return env.DEBUG ? (e.stack || e.message) : e.message;
}
