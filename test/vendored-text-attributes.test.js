// Every merge-tracked verbatim item and every upstream base copy is checked by git blob hash
// (vendor-sync), so a Windows checkout must never convert its line endings. Families were once
// added to .gitattributes one at a time and one was missed (kdense, caught by the Windows smoke),
// so this checks every manifest path against git's own attribute resolution.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parse } from "yaml";

const root = fileURLToPath(new URL("..", import.meta.url));

function verbatimPaths() {
  const manifest = parse(readFileSync(new URL("../vendor/manifest.yaml", import.meta.url), "utf8"));
  const paths = new Set();
  for (const source of manifest.sources || []) {
    for (const item of source.items || []) {
      if (item.mode === "verbatim" && typeof item.to === "string") paths.add(item.to);
      if (item.mode && typeof item.from === "string" && source.id) paths.add(`vendor/upstream/${source.id}/${item.from}`);
    }
  }
  return [...paths];
}

test("every merge-tracked verbatim item and base copy is excluded from line-ending conversion", () => {
  const paths = verbatimPaths();
  assert.ok(paths.length > 100, `expected many tracked paths, found ${paths.length}`);
  const out = execFileSync("git", ["check-attr", "text", "--stdin"], { cwd: root, input: paths.join("\n") + "\n", encoding: "utf8" });
  const converted = out.trim().split("\n").filter((line) => !/: text: unset$/.test(line));
  assert.deepEqual(converted, [], "these tracked paths would be line-ending converted on Windows");
});
