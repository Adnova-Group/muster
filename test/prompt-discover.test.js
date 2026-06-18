import { test } from "node:test";
import assert from "node:assert/strict";
import { discoverPrompts, isPromptFile } from "../src/prompt-discover.js";

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
