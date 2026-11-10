// Preflight's candidate skills respect the project's detected stack: a language-specific builtin
// (wsh-python-*, go-*, the JS/TS/React family) is offered only when the project uses that language
// or the outcome names it. A live smoke offered wsh-python-design-patterns for a JavaScript task.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { trackedMkdtemp } from "../test-support/helpers.js";
import { skillLanguage, skillFitsStack, isUiSkill, outcomeNamesUi } from "../src/specialists.js";
import { runPreflight, projectShowsUi } from "../src/preflight.js";

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

// Live e2e 2026-11-10: a CLI-only outcome (`tally report --json`, a `stats` subcommand) on a
// JavaScript project with no UI was offered uupm-ui-ux-pro-max and emil-break-ui, and a pure
// library outcome was offered intent-fortify (UX edge-case hardening).
test("isUiSkill tags the UI and design families by id and leaves engineering skills alone", () => {
  for (const id of ["uupm-ui-ux-pro-max", "emil-break-ui", "intent-fortify", "impeccable-harden", "gsap-core", "jk-better-ui", "taste-minimalist-ui", "hallmark", "addy-frontend-ui-engineering", "anthropic-frontend-design", "wsh-responsive-design", "wsh-tailwind-design-system", "wsh-design-system-patterns", "wsh-react-state-management"]) {
    assert.equal(isUiSkill(id), true, id);
  }
  for (const id of ["sp-tdd", "wsh-nodejs-backend-patterns", "wsh-api-design-principles", "mp-codebase-design", "wsh-javascript-testing-patterns", "tob-property-based-testing", "go-testing"]) {
    assert.equal(isUiSkill(id), false, id);
  }
});

test("skillFitsStack: a UI skill drops only when the project shows no UI and the outcome names none", () => {
  const cli = "add a --json flag to tally report and a stats subcommand; handle an empty CSV";
  assert.equal(skillFitsStack("uupm-ui-ux-pro-max", ["javascript"], cli, { projectUi: false }), false);
  assert.equal(skillFitsStack("emil-break-ui", ["javascript"], cli, { projectUi: false }), false);
  assert.equal(skillFitsStack("sp-tdd", ["javascript"], cli, { projectUi: false }), true, "non-UI skills are untouched");
  assert.equal(skillFitsStack("emil-break-ui", ["javascript"], cli, { projectUi: true }), true, "a project with a UI keeps them");
  assert.equal(skillFitsStack("emil-break-ui", ["javascript"], cli), true, "unknown (greenfield) keeps them");
  for (const named of ["fix the UI of the report", "add a settings page", "a new Button component", "tidy the CSS", "rework the design of the summary"]) {
    assert.equal(outcomeNamesUi(named), true, named);
    assert.equal(skillFitsStack("uupm-ui-ux-pro-max", ["javascript"], named, { projectUi: false }), true, `conservative: ${named}`);
  }
});

test("projectShowsUi: frameworks, shape or a UI file in a conventional dir say yes; a plain CLI says no; greenfield is unknown", async () => {
  const cliProject = await tmp("pf-ui-cli");
  await writeFile(join(cliProject, "package.json"), JSON.stringify({ name: "tally", bin: { tally: "bin/tally.js" } }));
  await mkdir(join(cliProject, "src"));
  await writeFile(join(cliProject, "src", "cli.js"), "export {};\n");
  assert.equal(await projectShowsUi(cliProject, { frameworks: [], shape: "unknown" }), false);
  assert.equal(await projectShowsUi(cliProject, { frameworks: ["react"], shape: "frontend" }), true);
  const web = await tmp("pf-ui-web");
  await mkdir(join(web, "public"));
  await writeFile(join(web, "public", "index.html"), "<!doctype html>\n");
  assert.equal(await projectShowsUi(web, { frameworks: [], shape: "unknown" }), true, "a vanilla web project with no framework dependency");
  assert.equal(await projectShowsUi(await tmp("pf-ui-empty"), { greenfield: true }), undefined);
});

test("preflight on a CLI project offers no UI skill for the live run's CLI outcome, and keeps them for a UI outcome", async () => {
  const cwd = await tmp("pf-ui");
  await writeFile(join(cwd, "package.json"), JSON.stringify({ name: "tally", version: "1.0.0", bin: { tally: "bin/tally.js" } }));
  await mkdir(join(cwd, "src"));
  await writeFile(join(cwd, "src", "cli.js"), "export {};\n");
  const opts = async (runId) => ({ cwd, home: await tmp("pf-ui-home"), catalogDir: join(root, "catalog"), runId, now: NOW, env: { MUSTER_CACHE_DIR: await tmp("pf-ui-cache") } });
  const run1 = "Add a `--json` flag to `tally report` that prints {\"rows\":[{\"category\",\"total\"}],\"total\"} as JSON instead of the table, and a new `tally stats <file.csv>` subcommand that prints count, sum, mean, median, min and max of the amounts (also honouring `--json`). Acceptance: node:test tests cover both features including an empty CSV, `npm test` passes, and the README documents both commands.";
  const s = await runPreflight({ outcome: run1, ...(await opts("ui1")) });
  const offered = [...(s.skills || []), ...(s.skillCandidates || []).map((c) => c.id)];
  assert.ok(!offered.some(isUiSkill), `no UI skill for a CLI outcome: ${offered.join(", ")}`);
  const ui = await runPreflight({ outcome: "Add a stats page component with a responsive layout and UI polish that shows count, sum and median", ...(await opts("ui2")) });
  assert.ok((ui.skills || []).some(isUiSkill), `an outcome naming UI keeps them: ${(ui.skills || []).join(", ")}`);
});
