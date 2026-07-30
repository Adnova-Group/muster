import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const CLI_SOURCE = new URL("../src/cli.js", import.meta.url);
const REQUIRED_HANDLERS = [
  "handleKimiCommand",
  "handleCodexCommand",
  "handleChatgptCommand",
  "handleCoreCommand",
];

function functionLineCount(source, name) {
  const start = source.indexOf(`async function ${name}(`);
  assert.notEqual(start, -1, `${name} must be a named async function`);

  const bodyStart = source.indexOf("{", start);
  let depth = 0;
  for (let index = bodyStart; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") depth -= 1;
    if (depth === 0) {
      return source.slice(start, index + 1).split("\n").length;
    }
  }
  assert.fail(`${name} has no closing brace`);
}

test("CLI dispatch is split into bounded named domain handlers", async () => {
  const source = await readFile(CLI_SOURCE, "utf8");

  for (const name of REQUIRED_HANDLERS) {
    assert.match(source, new RegExp(`await ${name}\\(cmd, rest\\)`), `${name} must be wired into dispatch`);
  }

  const handlerNames = [...source.matchAll(/async function (handle\w+Command(?:Part\d+)?)\(/g)]
    .map((match) => match[1]);
  for (const name of handlerNames) {
    const lines = functionLineCount(source, name);
    assert.ok(lines <= 200, `${name} must not exceed 200 lines (got ${lines})`);
  }

  const mainLines = functionLineCount(source, "main");
  assert.ok(mainLines <= 40, `main must only orchestrate handlers (got ${mainLines} lines)`);
});
