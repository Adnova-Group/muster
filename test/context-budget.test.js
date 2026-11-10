// Always-on and post-compaction context budgets (docs/strategy/2026-11-revival-review.md, owner
// decisions: muster costs nothing until invoked; the orchestrator must fit the 5,000-token
// post-compaction budget). go.md and orchestrator/SKILL.md regrew twice before a CI budget
// existed (13.2K -> 26.4K and 13.8K -> 29.6K chars), so these are hard gates.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";

const root = fileURLToPath(new URL("../", import.meta.url));
const bytes = async (p) => (await stat(join(root, p))).size;

const KB = 1024;
const COMMAND_BUDGET = 8 * KB;
const ORCHESTRATOR_BUDGET = 18 * KB;
// Measured 3,670 bytes at revival stage 2b (18,116 before it); the result sits ~8% under the budget.
const DESCRIPTION_BUDGET = 4_000;

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return m ? parseYaml(m[1]) || {} : {};
}

async function listedFiles() {
  const files = [];
  for (const d of await readdir(join(root, "plugin/skills"))) files.push(`plugin/skills/${d}/SKILL.md`);
  for (const f of await readdir(join(root, "plugin/agents"))) if (f.endsWith(".md")) files.push(`plugin/agents/${f}`);
  for (const f of await readdir(join(root, "plugin/commands"))) if (f.endsWith(".md")) files.push(`plugin/commands/${f}`);
  return files;
}

test("plan.md and go.md stay within 8 KB", async () => {
  for (const f of ["plugin/commands/plan.md", "plugin/commands/go.md"]) {
    const size = await bytes(f);
    assert.ok(size <= COMMAND_BUDGET, `${f} is ${size} bytes, over the ${COMMAND_BUDGET}-byte budget`);
  }
});

test("the orchestrator skill stays within 18 KB and under 5,000 tokens (bytes/4 estimate)", async () => {
  const size = await bytes("plugin/skills/orchestrator/SKILL.md");
  assert.ok(size <= ORCHESTRATOR_BUDGET, `orchestrator/SKILL.md is ${size} bytes, over ${ORCHESTRATOR_BUDGET}`);
  assert.ok(size / 4 < 5000, `orchestrator/SKILL.md is ~${Math.round(size / 4)} tokens, over the post-compaction budget`);
});

test("total skill + agent + command descriptions stay within the measured budget, one line each", async () => {
  let total = 0;
  for (const f of await listedFiles()) {
    const description = String(frontmatter(await readFile(join(root, f), "utf8")).description || "");
    assert.ok(description.length > 0, `${f} needs a description`);
    assert.ok(!description.includes("\n"), `${f} description must be one line`);
    total += Buffer.byteLength(description, "utf8");
  }
  assert.ok(total <= DESCRIPTION_BUDGET, `descriptions total ${total} bytes, over the ${DESCRIPTION_BUDGET}-byte budget`);
});

test("internal skills are hidden from the slash menu", async () => {
  for (const d of await readdir(join(root, "plugin/skills"))) {
    const fm = frontmatter(await readFile(join(root, "plugin/skills", d, "SKILL.md"), "utf8"));
    assert.equal(fm["user-invocable"], false, `plugin/skills/${d} must set user-invocable: false`);
  }
});
