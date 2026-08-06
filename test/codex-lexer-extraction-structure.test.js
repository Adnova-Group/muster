import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

// Structural ratchet for hooks-lexer-extraction (2026-08-06): the generic
// config.toml line lexer and the POSIX/Windows shell tokenizer/quoter used to
// live only inside codex-install-hooks.js (a hook-named module), so every
// other consumer either duplicated them (codex-thread-limits.js's own
// decodeTomlKey + escape table) or paid for the whole ~20-module
// install-family closure just to reach one pure string function
// (scripts/check-codex.mjs's parseHookCommand import). This guards both
// fixes staying in place, mirroring codex-install-structure.test.js's
// approach of asserting source shape rather than only behavior.

const tomlLexerUrl = new URL("../src/toml-lexer.js", import.meta.url);
const shellCommandUrl = new URL("../src/shell-command.js", import.meta.url);
const hooksUrl = new URL("../src/codex-install-hooks.js", import.meta.url);
const threadLimitsUrl = new URL("../src/codex-thread-limits.js", import.meta.url);
const checkCodexUrl = new URL("../scripts/check-codex.mjs", import.meta.url);

test("src/toml-lexer.js exports the generic TOML lexer primitives", async () => {
  const source = await readFile(tomlLexerUrl, "utf8");
  for (const name of ["decodeTomlQuotedKey", "inspectTomlHeader", "scanTomlLine", "splitTomlLines"]) {
    assert.match(source, new RegExp(`export function ${name}\\(`), `toml-lexer.js must export ${name}`);
  }
});

test("src/shell-command.js exports the generic shell tokenizer/quoter primitives", async () => {
  const source = await readFile(shellCommandUrl, "utf8");
  for (const name of ["formatCodexWindowsPath", "shellCommand", "parseHookCommand", "parsePosixShellTokens", "parseWindowsShellTokens"]) {
    assert.match(source, new RegExp(`export function ${name}\\(`), `shell-command.js must export ${name}`);
  }
});

test("codex-install-hooks.js no longer redefines the moved lexer/tokenizer primitives", async () => {
  const source = await readFile(hooksUrl, "utf8");
  for (const name of [
    "decodeTomlQuotedKey", "inspectTomlHeader", "scanTomlLine", "splitTomlLines",
    "formatCodexWindowsPath", "parseHookCommand", "parsePosixShellTokens", "parseWindowsShellTokens"
  ]) {
    assert.doesNotMatch(source, new RegExp(`\\bfunction ${name}\\(`), `codex-install-hooks.js must import ${name}, not redefine it`);
  }
  assert.match(source, /from ["']\.\/toml-lexer\.js["']/, "codex-install-hooks.js must import the shared TOML lexer");
  assert.match(source, /from ["']\.\/shell-command\.js["']/, "codex-install-hooks.js must import the shared shell tokenizer");
});

test("codex-thread-limits.js's decodeTomlKey consumes the shared TOML lexer instead of hand-rolling its own escape table", async () => {
  const source = await readFile(threadLimitsUrl, "utf8");
  assert.match(source, /from ["']\.\/toml-lexer\.js["']/, "codex-thread-limits.js must import decodeTomlQuotedKey from the shared lexer");
  assert.doesNotMatch(source, /"\\\\":\s*"\\\\"/, "decodeTomlKey must not hand-roll its own escape table anymore");
});

test("scripts/check-codex.mjs imports parseHookCommand directly, without loading the codex-install.js facade", async () => {
  const source = await readFile(checkCodexUrl, "utf8");
  assert.doesNotMatch(source, /parseHookCommand.*from ["']\.\.\/src\/codex-install\.js["']/,
    "check-codex.mjs must not import parseHookCommand through the install-family facade");
  assert.match(source, /import\s*\{\s*parseHookCommand\s*\}\s*from\s*["']\.\.\/src\/shell-command\.js["']/,
    "check-codex.mjs must import parseHookCommand directly from shell-command.js");
});
