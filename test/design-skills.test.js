// Skill wiring for the Impeccable design workflows: every workflow follows a vendored impeccable-*
// playbook (primary) plus supporting skills; every mapped id resolves to a real builtin or agent;
// the precedence is stated once; pfd (CC BY-SA 4.0) is only ever named with its attribution; and the
// optional Mobbin MCP is detect-and-use, never bundled.
//
// The impeccable-* builtins are vendored here and must resolve now. The supporting builtins (uupm-*,
// typeui, intent-*, pfd, emil-*, gsap-*, taste-*, hallmark, anthropic-*, jk-*, elaya-*, addy-*) are
// vendored by sibling tracks; until those land the "supporting ... exists" tests fail by design. Do
// not soften them: they are how integration proves the ids.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse as parseYaml } from "yaml";
import { trackedMkdtemp as mkdtemp } from "../test-support/helpers.js";
import {
  DESIGN_PRECEDENCE,
  DESIGN_SUPPORT,
  DESIGN_WORKFLOWS,
  GENERATE_DIRECTIONS,
  IMPECCABLE_CORE,
  MOBBIN_SEARCH_TOOLS,
  PFD_ATTRIBUTION,
  UUPM_REFERENCE_FILES,
  UUPM_SEARCH_SCRIPT,
  UUPM_SKILL,
  runDesignWorkflow,
} from "../src/design.js";

const ROOT = new URL("..", import.meta.url).pathname;
const COMMAND = readFileSync(join(ROOT, "plugin/commands/design.md"), "utf8");
const REFERENCE_PATH = "plugin/references/design/supporting-skills.md";
const REFERENCE = readFileSync(join(ROOT, REFERENCE_PATH), "utf8");
const DESIGN_SRC = readFileSync(join(ROOT, "src/design.js"), "utf8");
const PRECEDENCE_LINE = `When sources disagree: ${DESIGN_PRECEDENCE.join(" > ")}.`;
const DESIGN = "# Design System\n\n<!-- muster:design-schema 1 -->\n\n## Direction\nPrecise and calm.\n";

const entries = () => Object.values(DESIGN_SUPPORT);
const unique = (ids) => [...new Set(ids)].sort();
const allIds = () => unique(entries().flatMap((entry) => [...entry.primary, ...entry.skills]));
const impeccableIds = () => allIds().filter((id) => id.startsWith("impeccable-"));
const supportingIds = () => allIds().filter((id) => !id.startsWith("impeccable-"));
const allAgents = () => unique(entries().flatMap((entry) => entry.agents));
const builtinExists = (id) => existsSync(join(ROOT, "plugin/builtins", id, "SKILL.md"));

test("every design workflow has an entry, and nothing else does", () => {
  assert.deepEqual(Object.keys(DESIGN_SUPPORT).sort(), DESIGN_WORKFLOWS.map(({ id }) => id).sort());
  for (const [id, entry] of Object.entries(DESIGN_SUPPORT)) {
    assert.ok(Array.isArray(entry.primary) && Array.isArray(entry.skills) && Array.isArray(entry.agents), id);
    assert.ok([null, "query", "checklist", "lookup"].includes(entry.uupm), `${id}: uupm mode`);
    assert.equal(typeof entry.mobbin, "boolean", `${id}: mobbin flag`);
    if (entry.uupm) assert.ok(entry.skills.includes(UUPM_SKILL), `${id}: a uupm mode needs ${UUPM_SKILL}`);
    assert.equal(new Set(entry.skills).size, entry.skills.length, `${id}: no duplicate skills`);
    assert.ok(!entry.skills.some((skill) => skill.startsWith("uis-")), `${id}: ibelick/ui-skills was dropped`);
  }
});

test("every workflow's primary playbook is impeccable-core plus its own vendored reference when one exists", () => {
  for (const [id, entry] of Object.entries(DESIGN_SUPPORT)) {
    assert.equal(entry.primary[0], IMPECCABLE_CORE, id);
    assert.ok(entry.primary.every((skill) => skill.startsWith("impeccable-")), id);
    if (builtinExists(`impeccable-${id}`)) assert.ok(entry.primary.includes(`impeccable-${id}`), `${id}: own reference`);
  }
  for (const id of ["generate", "live", "craft", "init"]) assert.ok(!builtinExists(`impeccable-${id}`), `${id}: not vendored`);
  for (const id of ["audit", "critique", "shape", "document", "init"]) {
    assert.ok(!DESIGN_SUPPORT[id].primary.includes("impeccable-craft-floor"), `${id} edits no UI`);
  }
  for (const direction of GENERATE_DIRECTIONS) assert.ok(builtinExists(`impeccable-${direction}`), direction);
});

test("the agreed uupm division holds: choice workflows query, review workflows run the checklist", () => {
  for (const id of ["init", "colorize", "typeset", "layout", "animate", "bolder", "quieter"]) {
    assert.equal(DESIGN_SUPPORT[id].uupm, "query", id);
  }
  for (const id of ["critique", "audit", "polish"]) assert.equal(DESIGN_SUPPORT[id].uupm, "checklist", id);
});

test("every impeccable-* id the design workflows reference is a vendored builtin", () => {
  const missing = impeccableIds().filter((id) => !builtinExists(id));
  assert.deepEqual(missing, []);
});

test("every vendored impeccable-* builtin is merge-tracked in the manifest with a byte-exact base copy", () => {
  const manifest = parseYaml(readFileSync(join(ROOT, "vendor/manifest.yaml"), "utf8"));
  const source = manifest.sources.find((entry) => entry.id === "impeccable");
  const vendored = readdirSync(join(ROOT, "plugin/builtins")).filter((id) => id.startsWith("impeccable-")).sort();
  const tracked = source.items.filter((item) => item.mode === "adapted").map((item) => item.id).sort();
  assert.deepEqual(tracked, vendored);
  for (const item of source.items.filter((entry) => entry.mode)) {
    assert.equal(item.to, `plugin/builtins/${item.id}/SKILL.md`, item.id);
    assert.ok(existsSync(join(ROOT, "vendor/upstream/impeccable", item.from)), `${item.id}: base copy`);
  }
  for (const id of impeccableIds()) assert.ok(vendored.includes(id), `${id} is vendored`);
});

test("every supporting skill id the design workflows reference exists in plugin/builtins/", () => {
  const missing = supportingIds().filter((id) => !builtinExists(id));
  assert.deepEqual(missing, [], `missing builtins (vendored by sibling tracks): ${missing.join(", ")}`);
});

test("every agent id the design workflows reference exists in plugin/agents/", () => {
  const missing = allAgents().filter((id) => !existsSync(join(ROOT, "plugin/agents", `${id}.md`)));
  assert.deepEqual(missing, [], `missing agents (vendored by the sibling track): ${missing.join(", ")}`);
});

test("the uupm search script and reference files the packets name exist in the vendored builtin", () => {
  const base = join(ROOT, "plugin/builtins", UUPM_SKILL);
  const missing = [UUPM_SEARCH_SCRIPT, ...UUPM_REFERENCE_FILES].filter((rel) => !existsSync(join(base, rel)));
  assert.deepEqual(missing, [], `missing under plugin/builtins/${UUPM_SKILL}/: ${missing.join(", ")}`);
});

test("the reference table matches DESIGN_SUPPORT row for row", () => {
  const rows = new Map();
  for (const line of REFERENCE.split("\n")) {
    if (!line.startsWith("| ")) continue;
    const cells = line.split("|").slice(1, -1).map((cell) => cell.trim());
    if (cells.length !== 6 || !/^[a-z]+$/.test(cells[0])) continue;
    const list = (cell) => (cell ? cell.split(/,\s*/) : []);
    rows.set(cells[0], { primary: list(cells[1]), skills: list(cells[2]), agents: list(cells[3]),
      uupm: cells[4] || null, mobbin: cells[5] === "yes" });
  }
  assert.deepEqual([...rows.keys()].sort(), Object.keys(DESIGN_SUPPORT).sort());
  for (const [id, entry] of Object.entries(DESIGN_SUPPORT)) {
    assert.deepEqual(rows.get(id), { primary: [...entry.primary], skills: [...entry.skills], agents: [...entry.agents],
      uupm: entry.uupm, mobbin: entry.mobbin }, id);
  }
});

test("design.md states the precedence exactly once and points at the reference file", () => {
  assert.equal(COMMAND.split(PRECEDENCE_LINE).length - 1, 1);
  assert.match(COMMAND, /references\/design\/supporting-skills\.md/);
  assert.ok(REFERENCE.includes(PRECEDENCE_LINE));
  assert.doesNotMatch(COMMAND + REFERENCE + DESIGN_SRC, /\buis-|ui-skills/);
});

test("Perception-First Design is only ever named with its attribution", () => {
  for (const [name, text] of [["design.md", COMMAND], [REFERENCE_PATH, REFERENCE], ["src/design.js", DESIGN_SRC]]) {
    const bare = text.split(PFD_ATTRIBUTION).join("");
    assert.doesNotMatch(bare, /Perception-First Design/i, `${name}: unattributed mention`);
  }
});

test("each workflow packet names its primary playbook, supporting skills, precedence and uupm role", async () => {
  const root = await mkdtemp(join(tmpdir(), "muster-design-skills-"));
  await writeFile(join(root, "DESIGN.md"), DESIGN);
  for (const { id } of DESIGN_WORKFLOWS) {
    const packet = await runDesignWorkflow(root, id, { args: "checkout" });
    const entry = DESIGN_SUPPORT[id];
    assert.deepEqual(packet.support, entry, id);
    assert.match(packet.prompt, new RegExp(`Primary playbook, read first[^\\n]*${entry.primary.join(", ")}`), id);
    for (const skill of [...entry.skills, ...entry.agents]) assert.ok(packet.prompt.includes(skill), `${id}: ${skill}`);
    assert.ok(packet.prompt.includes(PRECEDENCE_LINE), id);
    if (entry.skills.includes("pfd")) assert.ok(packet.prompt.includes(PFD_ATTRIBUTION), id);
    if (entry.uupm) assert.match(packet.prompt, /If Python 3 is unavailable/, id);
    if (entry.uupm === "query") assert.match(packet.prompt, /let the user confirm, and record the confirmed choice in DESIGN\.md/, id);
    if (entry.uupm === "checklist") assert.match(packet.prompt, /pre-delivery checklist/, id);
    if (entry.mobbin) {
      assert.ok(packet.prompt.includes("MCP server whose name matches /mobbin/i"), `${id}: Mobbin detect condition`);
      assert.match(packet.prompt, /Without those tools, skip this step and do not mention it/, id);
      assert.match(packet.prompt, /never copy proprietary assets or brand elements/, id);
      for (const tool of MOBBIN_SEARCH_TOOLS) assert.ok(packet.prompt.includes(tool), `${id}: ${tool}`);
    } else {
      assert.ok(!packet.prompt.includes("MCP server whose name matches /mobbin/i"), `${id}: no Mobbin step`);
    }
  }
  const generate = await runDesignWorkflow(root, "generate", { args: "3 bolder variants of the pricing cards" });
  assert.match(generate.prompt, /impeccable-<direction>/);
});

test("Mobbin is detect-and-use: the reference names the detect condition, the search tools and the copyright line", () => {
  assert.match(REFERENCE, /MCP server whose name matches `\/mobbin\/i`/);
  assert.match(REFERENCE, /skip the\s+step silently/);
  for (const tool of MOBBIN_SEARCH_TOOLS) assert.ok(REFERENCE.includes(`\`${tool}\``), tool);
  assert.match(REFERENCE, /third-party product screenshots used as reference only/);
  const marked = Object.entries(DESIGN_SUPPORT).filter(([, entry]) => entry.mobbin).map(([id]) => id).sort();
  assert.deepEqual(marked, ["bolder", "craft", "generate", "layout", "onboard", "overdrive", "shape"]);
});

// Mobbin is optional and never bundled: no MCP config muster ships may name it.
test("no plugin MCP configuration references Mobbin", () => {
  const found = [];
  const walk = (dir) => {
    if (!existsSync(dir)) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/mcp.*\.json$|^plugin\.json$|^marketplace\.json$|^manifest\.json$/i.test(entry.name)) found.push(path);
    }
  };
  for (const dir of ["plugin", ".agents", "cowork", "codex", ".claude-plugin"]) walk(join(ROOT, dir));
  const offenders = found.filter((path) => /mobbin/i.test(readFileSync(path, "utf8")));
  assert.deepEqual(offenders, []);
});
