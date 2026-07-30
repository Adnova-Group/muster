import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { scaffoldProject } from "../src/setup.js";
import { tmpProject } from "../test-support/helpers.js";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("root instructions have one authority and a thin Claude pointer", async () => {
  const [agents, claude] = await Promise.all([read("AGENTS.md"), read("CLAUDE.md")]);

  assert.match(agents, /^# Agents$/m);
  assert.match(agents, /managed with muster/i);
  assert.doesNotMatch(agents, /@CLAUDE\.md/);
  assert.equal(claude, "# Claude Code\n\n@AGENTS.md\n");
});

test("documentation index declares the public precedence order", async () => {
  const index = await read("docs/README.md");
  const code = index.indexOf("Code, schemas, and executable prompts");
  const website = index.indexOf("Website user contract");
  const architecture = index.indexOf("Architecture rationale");
  const history = index.indexOf("Research and history");

  assert.ok(code >= 0, "must name executable authority");
  assert.ok(code < website && website < architecture && architecture < history);
  assert.match(index, /conflict[\s\S]{0,160}higher/i);
});

test("shared architecture is harness-neutral and adapters are explicitly scoped", async () => {
  const architecture = await read("docs/architecture.md");
  const lines = architecture.split("\n");
  let h2 = "";
  let h3 = "";
  for (const [index, line] of lines.entries()) {
    if (line.startsWith("## ")) {
      h2 = line;
      h3 = "";
    } else if (line.startsWith("### ")) {
      h3 = line;
    }
    if (/\b(?:Claude Code|Codex|Kimi|Cowork)\b/.test(line)) {
      assert.match(
        `${h2} ${h3}`,
        /(?:Harness-specific bindings|adapter)/i,
        `line ${index + 1} contains harness-specific prose outside an adapter scope`,
      );
    }
  }
  assert.match(architecture, /active harness/i);
  assert.match(architecture, /## Claude Code adapter: session hooks/);
});

test("legacy scaffold preserves the AGENTS authority and Claude pointer", async () => {
  const dir = await tmpProject({});
  await scaffoldProject(dir);

  assert.equal(
    await readFile(join(dir, "AGENTS.md"), "utf8"),
    "# Agents\n\nThis repository is managed with muster.\n",
  );
  assert.equal(await readFile(join(dir, "CLAUDE.md"), "utf8"), "# Claude Code\n\n@AGENTS.md\n");
});

test("native init handoff requires the same one-authority pair", async () => {
  const command = await read("plugin/commands/init.md");

  assert.match(command, /--expect AGENTS\.md,CLAUDE\.md/g);
  assert.match(command, /AGENTS\.md[\s\S]{0,180}authoritative/i);
  assert.match(command, /CLAUDE\.md[\s\S]{0,180}@AGENTS\.md/);
  assert.doesNotMatch(command, /--expect (?:AGENTS|CLAUDE)\.md(?:`|\s|$)/);
  for (const example of command.matchAll(/"artifacts":\[(.*?)\]/g)) {
    assert.match(example[1], /"AGENTS\.md"/, "every paired proof example must attest AGENTS.md");
    assert.match(example[1], /"CLAUDE\.md"/, "every paired proof example must attest CLAUDE.md");
  }
  assert.ok([...command.matchAll(/"artifacts":\[(.*?)\]/g)].length >= 2);
});
