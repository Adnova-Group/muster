import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const sourcePath = fileURLToPath(new URL("../src/codex-doctor.js", import.meta.url));

function functionSpans(source) {
  const starts = [...source.matchAll(/^(?:export )?(?:async )?function ([A-Za-z0-9_]+)\s*\(/gm)];
  return starts.map((match, index) => ({
    name: match[1],
    lines: source.slice(match.index, starts[index + 1]?.index ?? source.length).split("\n").length
  }));
}

test("Codex doctor orchestration is decomposed into bounded per-concern helpers", async () => {
  const source = await readFile(sourcePath, "utf8");
  const spans = functionSpans(source);
  const names = new Set(spans.map(item => item.name));

  for (const required of ["discoverScopes", "checkMcp", "checkHooks", "assembleReport"]) {
    assert.ok(names.has(required), `missing per-concern helper ${required}`);
  }
  const doctorHelpers = new Set([
    "preparePluginChecks",
    "discoverScopes",
    "checkMcp",
    "checkInstallGeneration",
    "checkHooks",
    "assembleHookChecks",
    "checkPluginCacheHooks",
    "assembleReport",
    "runCodexDoctor"
  ]);
  for (const { name, lines } of spans.filter(item => doctorHelpers.has(item.name))) {
    assert.ok(lines <= 150, `${name} is ${lines} lines; helpers must not exceed 150`);
  }
});
