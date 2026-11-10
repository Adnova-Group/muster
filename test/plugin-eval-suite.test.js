// The plugin eval suite (eval/plugin/, run by `npm run eval:plugin` through `claude plugin eval`)
// costs money and needs credentials, so CI never runs it. This test keeps it loadable: every case
// parses, uses only the fields `claude plugin eval` accepts (an unknown key fails the case), points
// at plugin/, stays cheap, and every grader regex compiles as the JavaScript regex Claude Code runs.
// Format reference: https://code.claude.com/docs/en/plugin-evals.md (eval suite reference).
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const casesDir = join(root, "eval", "plugin", "cases");

// The behaviors F17 (docs/research/2026-11-claude-code-findings.md) asks the suite to pin, by case.
const REQUIRED_CASES = [
  "plan-runs-command", // /muster:plan runs the command (preflight first, orchestrator invoked), CLI prefix, JS gets no Python skill
  "skills-list-compact",
  "pm-check-spec",
  "content-routes-pipeline",
  "fence-denies-in-run",
  "fence-allows-outside-run",
  "idle-no-hook-output",
];

const TOP_KEYS = new Set(["schema_version", "name", "description", "tags", "plugins", "runs", "expected_outcome", "context", "execution", "graders"]);
const EXECUTION_KEYS = new Set(["model", "max_turns", "timeout_seconds", "allowed_tools", "append_system_prompt", "env", "prompt"]);
const CONTEXT_KEYS = new Set(["scaffold_script", "history_file", "add_dirs"]);
const GRADER_KEYS = {
  regex: ["pattern", "flags", "match", "target"],
  tool_used: ["tool", "input_match", "min", "max"],
  tool_order: ["before", "after"],
  file_exists: ["path", "exists"],
  llm: ["criteria", "focus"],
  baseline: ["baseline_file", "criteria"],
};
const COMMON_GRADER_KEYS = ["name", "type", "weight", "arm"];
// Read-only tools a case may list; anything else needs the runner's --allow-tools grant.
const READ_ONLY_TOOLS = new Set(["Read", "Glob", "Grep", "NotebookRead", "Skill", "AskUserQuestion", "Agent", "TodoWrite", "TaskCreate", "TaskGet", "TaskList", "TaskUpdate", "TaskStop"]);

function loadCases() {
  return readdirSync(casesDir, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => {
      const dir = join(casesDir, e.name);
      const file = join(dir, "case.yaml");
      return { dir, dirName: e.name, file, data: existsSync(file) ? parseYaml(readFileSync(file, "utf8")) : null };
    });
}

function compiles(source, flags, where) {
  assert.doesNotThrow(() => new RegExp(source, flags || ""), `${where}: ${source} must compile as a JavaScript regex`);
  assert.ok(!/\(\?[a-z]+\)/.test(source), `${where}: inline flags like (?i) are not supported; use flags:`);
}

test("every case directory holds a case.yaml with the required fields and only known keys", () => {
  const cases = loadCases();
  assert.ok(cases.length > 0, "eval/plugin/cases has cases");
  for (const c of cases) {
    assert.ok(c.data, `${c.dirName}: case.yaml exists`);
    assert.ok(!existsSync(join(c.dir, "prompt.md")), `${c.dirName}: keep the whole case in case.yaml`);
    const d = c.data;
    for (const k of Object.keys(d)) assert.ok(TOP_KEYS.has(k), `${c.dirName}: unknown top-level key ${k}`);
    assert.equal(d.schema_version, "1.1", `${c.dirName}: schema_version "1.1"`);
    assert.equal(d.name, c.dirName, `${c.dirName}: name matches the directory`);
    assert.ok(typeof d.description === "string" && d.description.length > 20, `${c.dirName}: says what it pins`);
    assert.ok(Array.isArray(d.tags) && d.tags.includes("smoke"), `${c.dirName}: tagged smoke`);
    for (const k of Object.keys(d.execution || {})) assert.ok(EXECUTION_KEYS.has(k), `${c.dirName}: unknown execution key ${k}`);
    for (const k of Object.keys(d.context || {})) assert.ok(CONTEXT_KEYS.has(k), `${c.dirName}: unknown context key ${k}`);
    assert.ok(typeof d.execution?.prompt === "string" && d.execution.prompt.trim(), `${c.dirName}: has a prompt`);
  }
});

test("every case loads plugin/ and stays cheap", () => {
  for (const c of loadCases()) {
    const d = c.data;
    assert.deepEqual(d.plugins?.map((p) => resolve(c.dir, p)), [join(root, "plugin")], `${c.dirName}: plugins points at plugin/`);
    assert.equal(d.runs, 1, `${c.dirName}: one run per case (raise with --runs when investigating)`);
    assert.equal(d.execution.model, "haiku", `${c.dirName}: haiku unless the case depends on model quality`);
    assert.ok(Number.isInteger(d.execution.max_turns) && d.execution.max_turns <= 40, `${c.dirName}: max_turns set, at most 40`);
    assert.ok(Number.isInteger(d.execution.timeout_seconds) && d.execution.timeout_seconds <= 900, `${c.dirName}: timeout_seconds set, at most 900`);
    for (const t of d.execution.allowed_tools || []) {
      assert.ok(READ_ONLY_TOOLS.has(t), `${c.dirName}: ${t} is not read-only; grant it in scripts/plugin-eval.mjs instead`);
    }
    for (const g of d.graders) {
      assert.ok(!["llm", "baseline"].includes(g.type), `${c.dirName}/${g.name}: prefer free graders; a judge adds cost and noise`);
    }
  }
});

test("every grader is well formed and its regexes compile", () => {
  for (const c of loadCases()) {
    const graders = c.data.graders;
    assert.ok(Array.isArray(graders) && graders.length > 0, `${c.dirName}: at least one grader`);
    const names = new Set();
    for (const g of graders) {
      const where = `${c.dirName}/${g.name}`;
      assert.ok(typeof g.name === "string" && /^[a-z0-9-]+$/.test(g.name), `${where}: kebab-case name`);
      assert.ok(!names.has(g.name), `${where}: unique name`);
      names.add(g.name);
      assert.ok(GRADER_KEYS[g.type], `${where}: known type ${g.type}`);
      const allowed = new Set([...COMMON_GRADER_KEYS, ...GRADER_KEYS[g.type]]);
      for (const k of Object.keys(g)) assert.ok(allowed.has(k), `${where}: unknown key ${k} for ${g.type}`);
      if (g.arm !== undefined) assert.ok(["with-only", "both"].includes(g.arm), `${where}: arm`);
      if (g.type === "regex") {
        assert.ok(typeof g.pattern === "string", `${where}: pattern`);
        if (g.flags !== undefined) assert.match(g.flags, /^[dgimsuvy]*$/, `${where}: flags`);
        compiles(g.pattern, g.flags, where);
        if (g.match !== undefined) assert.match(g.match, /^(?:contains|not_contains|count:\d+)$/, `${where}: match`);
        if (g.target !== undefined) assert.ok(["last_message", "trace", "files", "mock_calls"].includes(g.target) || g.target?.source === "file", `${where}: target`);
      }
      if (g.type === "tool_used") {
        assert.ok(typeof g.tool === "string" && g.tool, `${where}: tool`);
        if (g.input_match !== undefined) compiles(g.input_match, "", where);
        for (const k of ["min", "max"]) if (g[k] !== undefined) assert.ok(Number.isInteger(g[k]) && g[k] >= 0, `${where}: ${k}`);
        if (g.min === 0 && g.max === 0) assert.equal(g.arm, "both", `${where}: a must-not-call check is scored in both arms`);
      }
      if (g.type === "tool_order") {
        for (const side of ["before", "after"]) {
          const s = g[side];
          assert.ok(typeof s === "string" || (s && typeof s.tool === "string"), `${where}: ${side}`);
          if (s?.input_match) compiles(s.input_match, "", `${where}.${side}`);
        }
      }
    }
  }
});

test("scaffold scripts exist beside their case and fail fast", () => {
  for (const c of loadCases()) {
    const script = c.data.context?.scaffold_script;
    if (!script) continue;
    const p = join(c.dir, script);
    assert.ok(existsSync(p) && statSync(p).isFile(), `${c.dirName}: ${script} exists`);
    const src = readFileSync(p, "utf8");
    assert.match(src, /^#!\/usr\/bin\/env bash\n/, `${c.dirName}: ${script} is a bash script`);
    assert.match(src, /^set -euo pipefail$/m, `${c.dirName}: ${script} fails fast`);
  }
});

test("the suite covers every behavior F17 asks for", () => {
  const names = new Set(loadCases().map((c) => c.dirName));
  for (const n of REQUIRED_CASES) assert.ok(names.has(n), `case ${n} exists`);
  const plan = loadCases().find((c) => c.dirName === "plan-runs-command").data.graders.map((g) => g.name);
  for (const g of ["orchestrator-invoked", "preflight-ran", "orchestrator-before-preflight", "plan-workflow-not-launched", "plan-skill-not-called", "cli-prefix-handed-to-agents", "no-bare-muster", "no-python-skill"]) {
    assert.ok(plan.includes(g), `plan-runs-command grades ${g}`);
  }
});

test("npm run eval:plugin runs the wrapper, results stay out of git, and the suite is not packed", () => {
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  assert.equal(pkg.scripts["eval:plugin"], "node scripts/plugin-eval.mjs");
  assert.ok(existsSync(join(root, "scripts", "plugin-eval.mjs")));
  const ignore = readFileSync(join(root, ".gitignore"), "utf8").split(/\r?\n/);
  assert.ok(ignore.includes("eval/plugin/results/"), ".gitignore lists eval/plugin/results/");
  // eval/ is maintainer-only: the npm `files` allowlist must never pull it into the package.
  assert.ok(!pkg.files.some((f) => /^(?:\.\/)?eval(?:\/|$)/.test(f)), "package.json files excludes eval/");
});
