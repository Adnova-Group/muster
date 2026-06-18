import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverPrompts, isPromptFile, stripFrontmatter } from "../src/prompt-discover.js";

test("stripFrontmatter removes a leading YAML block, leaving the body", () => {
  const body = stripFrontmatter("---\nname: x\ndescription: y\n---\nYou are a bot. Do the thing.");
  assert.equal(body.trim(), "You are a bot. Do the thing.");
  assert.equal(stripFrontmatter("no frontmatter here"), "no frontmatter here");
});

test("discovers a markdown prompt by its name+description frontmatter (agent/skill convention)", () => {
  const files = [{
    path: "plugin/agents/reviewer.md",
    content: "---\nname: reviewer\ndescription: reviews code\n---\nYou are a strict reviewer. Report one finding per line.",
  }];
  const found = discoverPrompts(files);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "prompt-doc");
  // frontmatter is stripped — the lint sees the instruction body, not the YAML header
  assert.doesNotMatch(found[0].text, /name:/);
  assert.match(found[0].text, /strict reviewer/);
});

test("discovers markdown under conventional prompt dirs (agents/commands/skills/prompts)", () => {
  const files = [
    { path: "src/commands/run.md", content: "Plan the work and show the crew before acting." },
    { path: ".claude/skills/build/SKILL.md", content: "Build one cohesive slice across the files it needs." },
  ];
  assert.equal(discoverPrompts(files).length, 2);
});

test("does NOT pick up ordinary docs (README/CHANGELOG/website) as prompts", () => {
  const files = [
    { path: "README.md", content: "# Project\n\nThis explains the project. Mentions {{VARIABLE}} in passing." },
    { path: "website/reference/commands.md", content: "# Commands\n\n`prompt eval <suite>` grades outputs." },
    { path: "docs/architecture.md", content: "# Architecture\n\nThe router resolves roles." },
  ];
  assert.equal(discoverPrompts(files).length, 0, "plain docs must not be misread as prompts");
});

test("extracts a backtick system-prompt assignment from code", () => {
  const files = [{
    path: "src/agent.js",
    content: 'const systemPrompt = `You are a helpful research assistant. Cite your sources.`;',
  }];
  const found = discoverPrompts(files);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "system-prompt");
  assert.match(found[0].text, /helpful research assistant/);
  assert.equal(found[0].file, "src/agent.js");
});

test("treats a .prompt file's whole content as a prompt", () => {
  const files = [{ path: "prompts/classify.prompt", content: "You are a classifier.\nReturn JSON." }];
  const found = discoverPrompts(files);
  assert.equal(found.length, 1);
  assert.equal(found[0].kind, "prompt-file");
  assert.match(found[0].text, /classifier/);
});

test("picks up files under a prompts/ directory regardless of extension", () => {
  assert.equal(isPromptFile("prompts/system.txt"), true);
  assert.equal(isPromptFile("app/prompts/agent.md"), true);
  assert.equal(isPromptFile("src/agent.js"), false);
  assert.equal(isPromptFile("notes/prompting-guide.md"), false);
  // A singular `prompt/` utility folder is NOT a prompt-asset directory.
  assert.equal(isPromptFile("src/prompt/utils.js"), false);
});

test("ignores trivial/short string assignments (noise filter)", () => {
  const files = [{ path: "src/x.js", content: 'const prompt = `hi`;\nconst label = `ok`;' }];
  assert.equal(discoverPrompts(files).length, 0);
});

test("ignores files with no prompt markers", () => {
  const files = [{ path: "src/util.js", content: "export const add = (a, b) => a + b;" }];
  assert.equal(discoverPrompts(files).length, 0);
});

test("captures multiple prompts and the identifier that held each", () => {
  const files = [{
    path: "src/agents.js",
    content:
      'const system = `You are agent one. Do the first thing carefully and thoroughly.`;\n' +
      'const instructions = `You are agent two. Always validate inputs before acting on them.`;',
  }];
  const found = discoverPrompts(files);
  assert.equal(found.length, 2);
  assert.ok(found.every(f => f.kind === "system-prompt"));
});
