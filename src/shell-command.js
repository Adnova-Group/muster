// Generic POSIX/Windows shell command tokenizer and quoter -- extracted out
// of codex-install-hooks.js (hooks-lexer-extraction, 2026-08-06). These
// primitives know nothing about hooks, Codex, or trust: they only quote a
// path into a single shell token per platform, join two tokens into a
// command line, and parse either shape back into its tokens. The one
// Codex-flavored name in the set is formatCodexWindowsPath (WSL/native drive
// normalization) -- kept here rather than split further because
// windowsShellQuote depends on it directly and both stay generic string
// transforms with no hook awareness in their bodies.
//
// codex-install-hooks.js is still the only in-repo caller of shellCommand
// (it pins the hook runtime's interpreter/script into a hooks.json command),
// but parseHookCommand is intentionally reachable straight from here --
// scripts/check-codex.mjs imports it directly to avoid loading
// codex-install.js's full ~20-module install-family closure just to parse
// one string back into two tokens.

export function formatCodexWindowsPath(path) {
  const normalized = path.replaceAll("\\", "/");
  const wslDrive = normalized.match(/^\/mnt\/([a-z])(?:\/(.*))?$/i);
  if (wslDrive) return `${wslDrive[1].toUpperCase()}:/${wslDrive[2] || ""}`.replace(/\/$/, "");
  const windowsDrive = normalized.match(/^([a-z]):\/(.*)$/i);
  return windowsDrive ? `${windowsDrive[1].toUpperCase()}:/${windowsDrive[2]}` : normalized;
}


const posixShellQuote = value => `'${value.replaceAll("'", `'\\''`)}'`;

const windowsShellQuote = value => `"${formatCodexWindowsPath(value).replaceAll('"', '\\"')}"`;

// Pin an ABSOLUTE, validated Node interpreter into the generated hook commands
// instead of a bare `node` (run-5 security audit Med #5, src/codex-install.js):
// a bare `node` is resolved through PATH on EVERY lifecycle event, so an
// attacker who prepends a directory to PATH with a malicious `node` hijacks the
// interpreter on every hook fire. `process.execPath` is machine-specific --
// exactly like the hook SCRIPT path this same command already bakes (the reason
// .codex/hooks.json is gitignored, not tracked; see scripts/check-codex.mjs) --
// so pinning it stays consistent with the existing per-checkout, machine-baked
// trust model rather than introducing a new kind of machine dependence.

export function shellCommand(scriptPath, nodePath) {
  for (const value of [nodePath, scriptPath]) {
    if (/[\r\n\0]/.test(value)) throw new Error(`Codex hook path contains unsupported control characters: ${value}`);
  }
  return {
    command: `${posixShellQuote(nodePath)} ${posixShellQuote(scriptPath)}`,
    commandWindows: `${windowsShellQuote(nodePath)} ${windowsShellQuote(scriptPath)}`
  };
}

// Parse a hook command emitted by shellCommand back into its two pinned tokens.
// POSIX (`command`): single-quoted segments with '\'' escaping. Windows
// (`commandWindows`): double-quoted segments with \" escaping. Returns
// { interpreter, script } or null when the string is not the expected
// two-token shape -- used by `muster doctor --codex` to verify the persisted
// interpreter still exists, and by scripts/check-codex.mjs to coherence-check a
// materialized hooks.json against this checkout.

export function parseHookCommand(command, { windows = false } = {}) {
  if (typeof command !== "string" || /[\0\r\n]/.test(command)) return null;
  const tokens = typeof command === "string" ? (windows ? parseWindowsShellTokens(command) : parsePosixShellTokens(command)) : null;
  return tokens && tokens.length === 2 ? { interpreter: tokens[0], script: tokens[1] } : null;
}


export function parsePosixShellTokens(command) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && (command[index] === " " || command[index] === "\t")) index++;
    if (index >= command.length) break;
    let token = "";
    while (index < command.length && command[index] !== " " && command[index] !== "\t") {
      const char = command[index];
      if (";&|<>()`".includes(char) || char === "$") return null;
      if (char === "'") {
        index++;
        while (index < command.length && command[index] !== "'") token += command[index++];
        if (index >= command.length) return null;
        index++;
      } else if (char === '"') {
        index++;
        while (index < command.length && command[index] !== '"') {
          if ("$`".includes(command[index])) return null;
          if (command[index] === "\\" && index + 1 < command.length) {
            const escaped = command[index + 1];
            if ('$`"\\'.includes(escaped)) token += escaped;
            else token += `\\${escaped}`;
            index += 2;
          }
          else token += command[index++];
        }
        if (index >= command.length) return null;
        index++;
      } else if (char === "\\") {
        if (index + 1 >= command.length) return null;
        token += command[index + 1];
        index += 2;
      } else {
        token += char;
        index++;
      }
    }
    tokens.push(token);
  }
  return tokens;
}


export function parseWindowsShellTokens(command) {
  const tokens = [];
  let index = 0;
  while (index < command.length) {
    while (index < command.length && (command[index] === " " || command[index] === "\t")) index++;
    if (index >= command.length) break;
    if (command[index] !== '"') return null;
    index++;
    let token = "";
    while (index < command.length && command[index] !== '"') {
      if (command[index] === "\\" && command[index + 1] === '"') { token += '"'; index += 2; }
      else token += command[index++];
    }
    if (index >= command.length) return null;
    index++;
    tokens.push(token);
    if (index < command.length && command[index] !== " " && command[index] !== "\t") return null;
  }
  return tokens;
}
