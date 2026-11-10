// Preflight's candidate skills respect the project's detected stack: a language-specific builtin
// (wsh-python-*, go-*, the JS/TS/React family) is offered only when the project uses that language
// or the outcome names it. A live smoke offered wsh-python-design-patterns for a JavaScript task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { trackedMkdtemp } from "../test-support/helpers.js";
import { skillLanguage, skillFitsStack } from "../src/specialists.js";
import { runPreflight } from "../src/preflight.js";

const root = fileURLToPath(new URL("..", import.meta.url));
const tmp = (p) => trackedMkdtemp(join(tmpdir(), `muster-${p}-`));
const NOW = new Date("2026-11-10T12:00:00Z");

test("skillLanguage tags language-specific builtins and leaves general ones untagged", () => {
  assert.equal(skillLanguage("wsh-python-design-patterns"), "python");
  assert.equal(skillLanguage("wsh-async-python-patterns"), "python");
  assert.equal(skillLanguage("go-testing"), "go");
  assert.equal(skillLanguage("wsh-typescript-advanced-types"), "javascript");
  assert.equal(skillLanguage("wsh-react-state-management"), "javascript");
  assert.equal(skillLanguage("gsap-react"), "javascript");
  assert.equal(skillLanguage("sp-tdd"), null);
  assert.equal(skillLanguage("impeccable-critique"), null);
});

test("skillFitsStack: unknown stack keeps everything; a mismatched language drops unless the outcome names it", () => {
  assert.equal(skillFitsStack("wsh-python-design-patterns", [], "refactor the design patterns"), true, "no detected languages: keep");
  assert.equal(skillFitsStack("wsh-python-design-patterns", ["javascript"], "refactor the design patterns"), false);
  assert.equal(skillFitsStack("wsh-python-design-patterns", ["javascript"], "port the Python design patterns"), true, "outcome names the language");
  assert.equal(skillFitsStack("wsh-typescript-advanced-types", ["typescript"], "x"), true, "typescript counts as the javascript family");
  assert.equal(skillFitsStack("go-testing", ["python", "go"], "x"), true);
  assert.equal(skillFitsStack("sp-tdd", ["javascript"], "x"), true, "general skills always fit");
});

test("preflight on a JavaScript project offers no Python-only skill for a generic outcome", async () => {
  const cwd = await tmp("pf-stack");
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "x", version: "1.0.0" }));
  await writeFile(join(cwd, "index.js"), "export const x = 1;\n");
  const s = await runPreflight({
    outcome: "refactor the module to cleaner design patterns and add tests",
    cwd, home: await tmp("pf-stack-home"), catalogDir: join(root, "catalog"), runId: "stack1", now: NOW,
    env: { MUSTER_CACHE_DIR: await tmp("pf-stack-cache") },
  });
  const offered = [...(s.skills || []), ...(s.skillCandidates || []).map((c) => c.id)];
  assert.ok(!offered.some((id) => skillLanguage(id) === "python"), `no python skill offered: ${offered.join(", ")}`);
  assert.ok(!offered.some((id) => skillLanguage(id) === "go"), `no go skill offered: ${offered.join(", ")}`);
});
