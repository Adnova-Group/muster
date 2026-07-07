import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, access, readdir } from "node:fs/promises";

// Contract tests for docs/binding-interface.md -- the harness binding-interface doc
// (backlog item `binding-interface`). Keeps the doc's central claim falsifiable rather
// than a one-time snapshot: the grep-audit test re-scans the same "plugin prose" scope
// the doc claims to cover and asserts the doc's own stated counts still match, so a
// future AskUserQuestion/Agent-tool/hook/worktree mention added to plugin prose without
// updating the doc fails this suite instead of silently going stale.

const root = new URL("../", import.meta.url);
const read = (p) => readFile(new URL(p, root), "utf8");
const exists = (p) => access(new URL(p, root)).then(() => true, () => false);

const DOC = "docs/binding-interface.md";

// The doc's own declared scope for "plugin prose": muster's own mode commands, core
// skills, muster's own agents (not the vendored wsh-* personas), and the output style --
// the model-facing orchestration surface, not vendored specialist payload content (see
// the doc's "Scope of the audit" section for the false-positive evidence that excluded
// plugin/builtins/* and plugin/agents/wsh-*.md).
async function proseFiles() {
  const files = [];
  for (const f of await readdir(new URL("plugin/commands/", root))) {
    if (f.endsWith(".md")) files.push(`plugin/commands/${f}`);
  }
  for (const dir of await readdir(new URL("plugin/skills/", root))) {
    const p = `plugin/skills/${dir}/SKILL.md`;
    if (await exists(p)) files.push(p);
  }
  for (const f of await readdir(new URL("plugin/agents/", root))) {
    if (f.startsWith("muster-") && f.endsWith(".md")) files.push(`plugin/agents/${f}`);
  }
  for (const f of await readdir(new URL("plugin/output-styles/", root))) {
    if (f.endsWith(".md")) files.push(`plugin/output-styles/${f}`);
  }
  return files;
}

// Mirrors `grep -n <pattern> <files> | wc -l` (mentions, i.e. matching lines) and
// `grep -rl <pattern> <files> | wc -l` (fileCount, i.e. files with >=1 match).
async function grepAudit(files, re) {
  let mentions = 0;
  let fileCount = 0;
  for (const f of files) {
    const lines = (await read(f)).split("\n");
    const hits = lines.filter((l) => re.test(l)).length;
    if (hits > 0) { mentions += hits; fileCount += 1; }
  }
  return { mentions, fileCount };
}

// Same patterns as the doc's own "Grep audit" section commands (case-sensitive, no -i,
// matching grep's BRE "\|" alternation with plain JS alternation).
const TERMS = {
  AskUserQuestion: /AskUserQuestion/,
  "dispatch (Agent/Task tool)": /Task tool|Agent tool|Task\/Agent|subagent_type|dispatch a subagent|dispatch subagents|dispatches a subagent|dispatch.*worker|Task or Agent/,
  "hook (PreToolUse/SessionStart/UserPromptSubmit)": /\bhook\b|hooks\.json|PreToolUse|SessionStart|UserPromptSubmit/,
  worktree: /worktree/,
};

test("docs/binding-interface.md exists", async () => {
  assert.equal(await exists(DOC), true, "docs/binding-interface.md must exist");
});

test("names all six harness primitives with a heading", async () => {
  const text = await read(DOC);
  for (const primitive of ["dispatch", "ask", "enforce", "isolate", "receipts", "capability scan"]) {
    assert.match(
      text,
      new RegExp(`^#{2,3}[^\\n]*\\b${primitive}\\b`, "im"),
      `missing a heading naming primitive "${primitive}"`
    );
  }
});

test("every primitive cites a real src/ or plugin/ file as its Claude Code binding", async () => {
  const text = await read(DOC);
  const fileRefs = text.match(/`(?:src|plugin)\/[^`]+`/g) || [];
  assert.ok(fileRefs.length >= 6, `expected at least 6 file references, found ${fileRefs.length}`);
  for (const ref of fileRefs) {
    const p = ref.slice(1, -1).split(":")[0].split("#")[0];
    assert.equal(await exists(p), true, `${DOC} references ${p}, which does not exist`);
  }
});

test("degradation ladder names a no-subagent no-hook harness", async () => {
  const text = await read(DOC);
  assert.match(text, /no-subagent/i, "must name the no-subagent case");
  assert.match(text, /no-hook|no hook/i, "must name the no-hook case");
});

test("AGENTS.md adapter is recorded as a parked follow-up, not built", async () => {
  const text = await read(DOC);
  assert.match(text, /AGENTS\.md/, "must mention AGENTS.md");
  assert.match(text, /parked/i, "must say the adapter is parked");
  assert.match(text, /not built/i, "must say the adapter is not built");
});

test("doc-only: no em-dash (humanizer rule, same discipline as GATED_PROSE)", async () => {
  const text = await read(DOC);
  assert.ok(!text.includes("—"), "docs/binding-interface.md must be em-dash free");
});

test("docs/architecture.md points at the binding-interface doc", async () => {
  const text = await read("docs/architecture.md");
  assert.match(text, /binding-interface/);
});

for (const [label, re] of Object.entries(TERMS)) {
  test(`grep audit stays live: doc's stated ${label} counts match a re-scan of plugin prose`, async () => {
    const files = await proseFiles();
    assert.ok(files.length >= 25, `sanity: expected ~30 prose files in scope, found ${files.length}`);
    const { mentions, fileCount } = await grepAudit(files, re);

    const text = await read(DOC);
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const row = new RegExp(`${escaped}\\s+files=(\\d+)\\s+mentions=(\\d+)`);
    const m = text.match(row);
    assert.ok(m, `docs/binding-interface.md must carry a "${label} files=N mentions=N" audit line`);
    assert.equal(Number(m[1]), fileCount, `${label}: doc says files=${m[1]}, live re-scan found ${fileCount}`);
    assert.equal(Number(m[2]), mentions, `${label}: doc says mentions=${m[2]}, live re-scan found ${mentions}`);
  });
}
