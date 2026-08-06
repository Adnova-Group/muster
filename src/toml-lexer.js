// Generic config.toml line lexer -- extracted out of codex-install-hooks.js
// (hooks-lexer-extraction, 2026-08-06). These primitives carry zero hook
// semantics: they know nothing about hooks.json, hook trust, or hook state --
// only how to decode a quoted TOML key, recognize a TOML table header, and
// track the multiline-string/array-depth lexical state a line leaves behind
// for the next one. codex-install-hooks.js's parseConfigTomlTrustSections
// (hook-trust-section-specific: it hard-codes the "hooks.state" table name)
// is the only in-repo consumer of the full set today, but nothing here
// depends on that -- codex-thread-limits.js's decodeTomlKey also consumes
// decodeTomlQuotedKey below for its own, unrelated [agents] section parsing.

export function decodeTomlQuotedKey(raw) {
  if (typeof raw !== "string" || raw.length < 2) return null;
  const quote = raw[0];
  if (quote === "'") return raw.at(-1) === "'" && !raw.slice(1, -1).includes("'") ? raw.slice(1, -1) : null;
  if (quote !== '"' || raw.at(-1) !== '"') return null;
  const body = raw.slice(1, -1);
  if (!/^(?:[^"\\]|\\[\\"tnrbf]|\\u[0-9a-fA-F]{4}|\\U[0-9a-fA-F]{8})*$/.test(body)) return null;
  return body.replace(/\\(u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|.)/g, (_, escape) => {
    if (escape[0] === "u" || escape[0] === "U") return String.fromCodePoint(parseInt(escape.slice(1), 16));
    return { "\\": "\\", '"': '"', t: "\t", n: "\n", r: "\r", b: "\b", f: "\f" }[escape] ?? escape;
  });
}


const HOOK_STATE_HEADER = /^\s*\[hooks\.state\.((?:"(?:[^"\\]|\\.)*")|(?:'[^']*'))\]\s*(?:#.*)?$/;

const HOOK_STATE_KEY = /^(.*):([a-z][a-z0-9_]*):(\d+):(\d+)$/;


function basicQuoteEscaped(line, index) {
  let slashes = 0;
  for (let cursor = index - 1; cursor >= 0 && line[cursor] === "\\"; cursor--) slashes++;
  return slashes % 2 === 1;
}


export function inspectTomlHeader(line) {
  const start = line.search(/\S/);
  if (start < 0 || line[start] !== "[") return { header: false, safe: true };
  const array = line[start + 1] === "[";
  let index = start + (array ? 2 : 1);
  const whitespace = () => { while (/\s/.test(line[index] ?? "")) index++; };
  const component = () => {
    if (line[index] === '"' || line[index] === "'") {
      const start = index;
      const quote = line[index++];
      while (index < line.length) {
        if (line[index] === quote && (quote === "'" || !basicQuoteEscaped(line, index))) {
          index++;
          let decoded;
          try { decoded = decodeTomlQuotedKey(line.slice(start, index)); } catch { return false; }
          return decoded !== null && !/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\uD800-\uDFFF]/u.test(decoded);
        }
        index++;
      }
      return false;
    }
    const match = line.slice(index).match(/^[A-Za-z0-9_-]+/);
    if (!match) return false;
    index += match[0].length;
    return true;
  };
  whitespace();
  if (!component()) return { header: false, safe: false };
  while (true) {
    whitespace();
    const closes = array ? line.startsWith("]]", index) : line[index] === "]";
    if (closes) {
      const rest = line.slice(index + (array ? 2 : 1));
      return /^\s*(?:#.*)?$/.test(rest)
        ? { header: true, safe: true }
        : { header: false, safe: false };
    }
    if (line[index++] !== ".") return { header: false, safe: false };
    whitespace();
    if (!component()) return { header: false, safe: false };
  }
}

// TOML table-shaped text is inert while it lives inside a multiline string.
// Track only the lexical states that can cross line boundaries; ordinary
// basic/literal strings and comments are consumed within their own line. If a
// single-line string is unterminated, mark the document unsafe so trust fails
// closed and reconciliation returns the original bytes unchanged.

export function scanTomlLine(line, multiline, arrayDepth) {
  let mode = multiline;
  let depth = arrayDepth;
  for (let index = 0; index < line.length;) {
    if (mode === "basic") {
      if (line[index] === '"' && !basicQuoteEscaped(line, index)) {
        let run = 1;
        while (line[index + run] === '"') run++;
        if (run >= 3 && run <= 5) { mode = null; index += run; }
        else if (run > 5) return { multiline: mode, arrayDepth: depth, safe: false };
        else index += run;
      } else index++;
      continue;
    }
    if (mode === "literal") {
      if (line[index] === "'") {
        let run = 1;
        while (line[index + run] === "'") run++;
        if (run >= 3 && run <= 5) { mode = null; index += run; }
        else if (run > 5) return { multiline: mode, arrayDepth: depth, safe: false };
        else index += run;
      } else index++;
      continue;
    }
    const char = line[index];
    if (char === "#") break;
    if (line.startsWith('"""', index)) { mode = "basic"; index += 3; continue; }
    if (line.startsWith("'''", index)) { mode = "literal"; index += 3; continue; }
    if (char === '"') {
      let closed = false;
      for (index++; index < line.length; index++) if (line[index] === '"' && !basicQuoteEscaped(line, index)) {
        index++; closed = true; break;
      }
      if (!closed) return { multiline: null, arrayDepth: depth, safe: false };
      continue;
    }
    if (char === "'") {
      const closing = line.indexOf("'", index + 1);
      if (closing < 0) return { multiline: null, arrayDepth: depth, safe: false };
      index = closing + 1;
      continue;
    }
    if (char === "[") depth++;
    else if (char === "]") {
      if (depth === 0) return { multiline: mode, arrayDepth: depth, safe: false };
      depth--;
    }
    index++;
  }
  return { multiline: mode, arrayDepth: depth, safe: true };
}


export function splitTomlLines(text) {
  const lines = [], endings = [];
  let offset = 0;
  while (offset < text.length) {
    const newline = text.indexOf("\n", offset);
    if (newline < 0) { lines.push(text.slice(offset)); endings.push(""); break; }
    const crlf = newline > offset && text[newline - 1] === "\r";
    lines.push(text.slice(offset, crlf ? newline - 1 : newline));
    endings.push(crlf ? "\r\n" : "\n");
    offset = newline + 1;
  }
  return { lines, endings };
}
