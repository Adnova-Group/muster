import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url).pathname;

// Evaluate a pure literal array expression (arrays, spreads, template
// literals, arrow-function .map -- no external references beyond `scope`)
// extracted from source text: from the first "[" after `marker` to the
// terminating ";" of the statement. The blocks this targets contain no ";"
// inside their string literals.
function evalArrayBlock(source, marker, scope = {}) {
  const open = source.indexOf("[", source.indexOf(marker));
  assert.notEqual(open, -1, `marker not found: ${marker}`);
  const end = source.indexOf(";", open);
  assert.notEqual(end, -1, `statement end not found after: ${marker}`);
  const names = Object.keys(scope);
  return new Function(...names, `"use strict"; return (${source.slice(open, end)});`)(...names.map(name => scope[name]));
}

test("installer ARTIFACT_PATHS and server artifactPaths are identical", async () => {
  // The installed server hard-fails startup on any artifact-set mismatch, so
  // the two lists must never drift; mcp/chatgpt-work-server.mjs cannot be
  // imported in-process (it validates the environment and exits), so both
  // lists are lifted from source and compared as evaluated values.
  const installerSource = await readFile(new URL("../src/chatgpt-work-install.js", import.meta.url), "utf8");
  const installer = evalArrayBlock(installerSource, "const ARTIFACT_PATHS =", {
    CATALOG_ARTIFACTS: evalArrayBlock(installerSource, "const CATALOG_ARTIFACTS ="),
    PIPELINE_ARTIFACTS: evalArrayBlock(installerSource, "const PIPELINE_ARTIFACTS ="),
  });
  const server = evalArrayBlock(
    await readFile(new URL("../mcp/chatgpt-work-server.mjs", import.meta.url), "utf8"),
    "const artifactPaths =",
  );
  assert.deepEqual([...server].sort(), [...installer].sort());
});
