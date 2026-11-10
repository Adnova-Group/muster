// Two invocation contracts the plugin surface must keep (live smoke on Claude Code 2.1.319):
// 1. A workflow's `meta.name` is invoked as `muster:<name>`, the same namespace as commands and
//    skills. When `plugin/workflows/plan.js` was named `plan`, typing `/muster:plan` (and
//    `Skill("muster:plan")`) launched the Workflow with the raw text and never ran the command.
// 2. `muster` is not on PATH in a user's project, so an agent told to run `muster plan-lint`
//    fails with "command not found". Agents and workflow briefs use the absolute CLI prefix
//    preflight returns as `cli` (`<cli> <verb>` in prose), never a bare `muster <verb>`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const read = (p) => readFile(join(root, p), "utf8");

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? parseYaml(m[1]) || {} : {};
}

async function walk(dir) {
  const out = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...await walk(p));
    else out.push(p);
  }
  return out;
}

async function workflowNames() {
  const names = new Map();
  for (const f of await readdir(join(root, "plugin/workflows"))) {
    if (!f.endsWith(".js")) continue;
    const src = await read(`plugin/workflows/${f}`);
    if (!/^export const meta = \{/m.test(src)) continue; // schema modules are not workflows
    const m = src.match(/^export const meta = \{\s*\n\s*name: '([^']+)'/);
    assert.ok(m, `${f}: meta must open with a literal name`);
    names.set(m[1], `plugin/workflows/${f}`);
  }
  return names;
}

async function commandAndSkillNames() {
  const names = new Map();
  for (const f of await readdir(join(root, "plugin/commands"))) {
    if (!f.endsWith(".md")) continue;
    const p = `plugin/commands/${f}`;
    names.set(f.replace(/\.md$/, ""), p);
    const fm = frontmatter(await read(p));
    if (fm.name) names.set(String(fm.name), p);
  }
  for (const d of await readdir(join(root, "plugin/skills"))) {
    const p = `plugin/skills/${d}/SKILL.md`;
    names.set(d, p);
    const fm = frontmatter(await read(p));
    if (fm.name) names.set(String(fm.name), p);
  }
  return names;
}

test("no plugin workflow shares its muster:<name> with a command or skill", async () => {
  const workflows = await workflowNames();
  const taken = await commandAndSkillNames();
  assert.ok(workflows.size >= 7, `expected the plugin workflows, found ${[...workflows.keys()].join(", ")}`);
  assert.ok(taken.has("plan") && taken.has("go"), "the command scan must see plan and go");
  const clashes = [...workflows].filter(([name]) => taken.has(name)).map(([name, file]) => `muster:${name}: ${file} vs ${taken.get(name)}`);
  assert.deepEqual(clashes, [], "a workflow named like a command or skill hijacks /muster:<name>");
  assert.equal(workflows.get("make-plan"), "plugin/workflows/make-plan.js", "the planning workflow is muster:make-plan");
});

// Claude Code registers every .md under commands/ as a command, subfolders included:
// plugin/commands/audit/references/audit-pattern-architecture.md loaded as
// /muster:audit:references:audit-pattern-architecture. Reference files live in plugin/references/.
test("plugin/commands holds only top-level command files, no subfolders", async () => {
  const entries = await readdir(join(root, "plugin/commands"), { withFileTypes: true });
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => `plugin/commands/${e.name}`);
  assert.deepEqual(dirs, [], "every .md under a commands/ subfolder loads as a slash command; move references to plugin/references/");
  for (const e of entries) assert.ok(e.name.endsWith(".md"), `plugin/commands/${e.name} is not a command file`);
});

// CLI verbs, read from the usage string so a new verb is covered without editing this test.
async function cliVerbs() {
  const src = await read("src/cli.js");
  const start = src.indexOf("const USAGE = [");
  const usage = [...src.slice(start, src.indexOf('].join("")', start)).matchAll(/"([^"]*)"/g)].map((m) => m[1]).join("").replace(/^Usage: muster </, "");
  const segs = [];
  let depth = 0;
  let cur = "";
  for (const ch of usage) {
    if ("<[".includes(ch)) depth++;
    if (">]".includes(ch)) depth--;
    if (ch === "|" && depth === 0) { segs.push(cur); cur = ""; } else cur += ch;
  }
  segs.push(cur);
  return [...new Set(segs.map((s) => s.trim().split(/[\s<[]/)[0]).filter((v) => /^[a-z][a-z-]+$/.test(v)))];
}

// What an agent reads: the body without YAML frontmatter or HTML comments (maintainer notes), and
// for a workflow script everything except whole-line `//` comments (briefs, meta and error text
// all reach a model).
function agentVisible(path, text) {
  if (path.endsWith(".js")) return text.split("\n").map((l) => (/^\s*\/\//.test(l) ? "" : l)).join("\n");
  return text.replace(/^---\r?\n[\s\S]*?\r?\n---/, "").replace(/<!--[\s\S]*?-->/g, "");
}

test("no plugin agent, workflow script or muster builtin instructs a bare `muster <verb>` CLI call", async () => {
  const verbs = (await cliVerbs()).sort((a, b) => b.length - a.length);
  assert.ok(verbs.includes("plan-lint") && verbs.includes("spec-lint") && verbs.includes("book"), "verb scan must see the CLI's verbs");
  // A command form: in a code span, or after "run". Prose like "a muster book run" is not a call.
  const bare = new RegExp(`(\`|\\brun\\s+)muster (${verbs.join("|")})(?![\\w-])`, "gi");
  const files = [
    ...(await readdir(join(root, "plugin/agents"))).filter((f) => f.endsWith(".md")).map((f) => `plugin/agents/${f}`),
    ...(await readdir(join(root, "plugin/workflows"))).filter((f) => f.endsWith(".js")).map((f) => `plugin/workflows/${f}`),
  ];
  for (const d of await readdir(join(root, "plugin/builtins"))) {
    if (d.startsWith("muster-") || d === "book-run") files.push(...(await walk(`plugin/builtins/${d}`)).filter((f) => f.endsWith(".md")));
  }
  const hits = [];
  for (const f of files) {
    const visible = agentVisible(f, await read(f));
    for (const m of visible.matchAll(bare)) hits.push(`${f}: ${visible.slice(Math.max(0, m.index - 30), m.index + m[0].length + 20).replace(/\n/g, " ")}`);
  }
  assert.deepEqual(hits, [], "use the brief's CLI prefix (`<cli> <verb>`); bare `muster` is not on PATH in a user's project");
});

test("the plan agents take the CLI prefix from the brief", async () => {
  for (const f of ["plugin/agents/muster-planner.md", "plugin/agents/muster-plan-checker.md"]) {
    const text = agentVisible(f, await read(f));
    assert.match(text, /`<cli> plan-lint <planPath>`/, `${f} runs plan-lint through the prefix`);
    assert.match(text, /never (a )?bare `muster`/, `${f} forbids bare muster`);
  }
});

test("musterCli: an absolute, double-quoted runtime/muster.sh path with sh's in-quote specials escaped", async () => {
  const { musterCli, PLUGIN_ROOT } = await import("../src/specialists.js");
  assert.equal(musterCli("/opt/plug in"), 'sh "/opt/plug in/runtime/muster.sh"');
  assert.equal(musterCli('/x/a"b$c`d', "linux"), 'sh "/x/a\\"b\\$c\\`d/runtime/muster.sh"');
  assert.equal(musterCli("C:\\Users\\me\\muster", "win32").replace(/\\\\/g, "/"), 'sh "C:/Users/me/muster/runtime/muster.sh"');
  assert.match(musterCli(), new RegExp(`^sh ".*${PLUGIN_ROOT.split(/[\\/]/).pop()}/runtime/muster\\.sh"$`));
});
