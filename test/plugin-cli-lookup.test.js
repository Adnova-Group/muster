// Plugin prose reaches the CLI only through `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh" <verb>`
// (revival stage 3). The old `$MUSTER_CLI` resolver read `$CLAUDE_PLUGIN_ROOT` from the
// environment (empty inside Bash tool calls), fell back to a global `muster` that may be an
// older release or to an unpinned npx, and assumed a shell variable survives between Bash calls.
// Claude Code substitutes the braced `${CLAUDE_PLUGIN_ROOT}` into command and plugin-skill text
// before the model sees it; the unbraced form is never substituted.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
// The frozen Codex build consumes this reference verbatim (scripts/build-codex.mjs).
const EXEMPT = new Set(["plugin/skills/orchestrator/references/codex-dispatch.md"]);

async function mdFiles(dir) {
  const out = [];
  for (const e of await readdir(join(root, dir), { withFileTypes: true })) {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) out.push(...(await mdFiles(rel)));
    else if (e.name.endsWith(".md")) out.push(rel);
  }
  return out;
}

// muster's own prose: commands, skills and muster-* agents. Vendored builtins and wsh-* agents
// belong to the upstream-refresh track.
async function musterProse() {
  const files = [...(await mdFiles("plugin/commands")), ...(await mdFiles("plugin/skills"))];
  for (const f of await readdir(join(root, "plugin/agents"))) if (f.startsWith("muster-") && f.endsWith(".md")) files.push(`plugin/agents/${f}`);
  return files.filter((f) => !EXEMPT.has(f));
}

const RULES = [
  [/\$MUSTER_CLI\b/, "uses the removed $MUSTER_CLI resolver"],
  [/\$CLAUDE_PLUGIN_ROOT\b/, "uses unbraced $CLAUDE_PLUGIN_ROOT (never substituted, empty in Bash)"],
  // Braced paths for Read are fine (audit's hunt lists); executing anything else under the root is not.
  [/\b(?:node|sh|bash)\s+"?\$\{CLAUDE_PLUGIN_ROOT\}(?!\/runtime\/muster\.sh")/, 'executes ${CLAUDE_PLUGIN_ROOT}/<x> instead of `sh "${CLAUDE_PLUGIN_ROOT}/runtime/muster.sh"`'],
  [/npx -y @adnova-group\/muster\b/, "calls an npx release that is not pinned to this plugin"],
];

test("plugin prose calls the CLI only through runtime/muster.sh", async () => {
  const violations = [];
  for (const f of await musterProse()) {
    const lines = (await readFile(join(root, f), "utf8")).split("\n");
    lines.forEach((line, i) => {
      for (const [re, why] of RULES) if (re.test(line)) violations.push(`${f}:${i + 1}: ${why}: ${line.trim().slice(0, 140)}`);
    });
  }
  assert.deepEqual(violations, [], violations.join("\n"));
});

test("the lookup rule sees what it is meant to (scope sanity)", async () => {
  const files = await musterProse();
  for (const f of ["plugin/commands/init.md", "plugin/commands/capture.md", "plugin/skills/advisor/SKILL.md", "plugin/skills/interview/SKILL.md"]) {
    assert.ok(files.includes(f), `${f} is in scope`);
    assert.match(await readFile(join(root, f), "utf8"), /sh "\$\{CLAUDE_PLUGIN_ROOT\}\/runtime\/muster\.sh"|`M` below means/, f);
  }
  assert.ok(!files.some((f) => EXEMPT.has(f)));
  assert.equal(relative(root, join(root, "plugin")), "plugin");
});
