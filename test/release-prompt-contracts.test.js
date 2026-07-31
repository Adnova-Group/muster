import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

test("review advancement requires a recorded explicit PASS and human input cannot substitute", async () => {
  for (const file of [
    "plugin/skills/orchestrator/SKILL.md",
    "plugin/skills/review-gate/SKILL.md",
    "plugin/agents/muster-runner.md",
  ]) {
    const text = await read(file);
    assert.match(text, /recorded `VERDICT: PASS`/i, `${file} must require the recorded verdict`);
    assert.match(text, /human (?:approval|input).*acknowledg|acknowledg.*human (?:approval|input)/is,
      `${file} must classify human input as acknowledgment/decision only`);
    assert.match(text, /never (?:a )?(?:substitute|replacement).*review|never.*review substitute/is,
      `${file} must forbid treating human input as review`);
  }
});

test("security review fires on semantic risk independent of diff size", async () => {
  const text = await read("plugin/skills/review-gate/SKILL.md");
  assert.match(text, /semantic security/i);
  assert.match(text, /auth(?:entication|orization)|authorization/i);
  assert.match(text, /secret|credential/i);
  assert.match(text, /injection/i);
  assert.match(text, /path(?:name)?s? or (?:added |changed )?content|content or path(?:name)?s?/i);
  assert.match(text, /independent of (?:the )?changed-line count|regardless of diff size/i);
  assert.match(text, /always dispatch.*security-review/is);
});

test("parallel execution keeps liveness while Codex projects one visible in-progress item", async () => {
  const text = await read("plugin/skills/orchestrator/SKILL.md");
  assert.match(text, /parallel execution remains live|parallel work remains in flight/i);
  assert.match(text, /exactly one.*`in_progress`.*projection|project exactly one.*`in_progress`/is);
  assert.match(text, /remaining.*`pending`.*not.*queued|`pending`.*does not mean.*not running/is);
  assert.match(text, /inFlight.*STATE|STATE.*inFlight/is);
});

test("runner uses a focused item baseline and reserves the broad suite for the final barrier", async () => {
  const text = await read("plugin/agents/muster-runner.md");
  assert.match(text, /focused per-item baseline/i);
  assert.match(text, /affected tests|nearest relevant tests/i);
  assert.match(text, /broad (?:project |test )?suite.*final barrier/i);
  assert.doesNotMatch(text, /run the project's test command\. A green baseline/i);
});

test("prompt contracts resolve neutral profiles instead of embedding model/version catalogs", async () => {
  const orchestrator = await read("plugin/skills/orchestrator/SKILL.md");
  assert.match(orchestrator, /canonical `\{tier, effort\?\}` profile/i);
  assert.match(orchestrator, /captured capabilities.*resolved dispatch profile/is);
  assert.doesNotMatch(orchestrator, /observed live \d|current Claude Code builds|on \d+\.\d+\.\d+/i);

  const promptEngineer = await read("plugin/agents/wsh-prompt-engineer.md");
  assert.match(promptEngineer, /canonical `\{tier, effort\?\}` profile/i);
  assert.match(promptEngineer, /runtime capabilities/i);
  assert.doesNotMatch(promptEngineer, /GPT-\d|Claude (?:Opus|Sonnet|Haiku) \d|\d+K tokens/i);
  assert.doesNotMatch(promptEngineer, /#### (?:OpenAI Models|Anthropic Claude|Open Source Models)/i);
});
