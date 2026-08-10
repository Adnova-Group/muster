// Release guard for the accepted 0.7.0 legacy-alias retirement decision.
import { test } from "node:test";
import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");
const aliases = ["run", "autopilot", "sprint"];

test("0.7.0 retires every legacy Claude command", async () => {
  for (const alias of aliases) {
    await assert.rejects(access(new URL(`plugin/commands/${alias}.md`, root)), { code: "ENOENT" });
  }
});

test("0.7.0 retires every generated Codex alias skill", async () => {
  const source = await read("scripts/build-codex.mjs");
  for (const alias of aliases) {
    assert.doesNotMatch(source, new RegExp(`^\\s*${alias}: \\{`, "m"));
  }
  assert.doesNotMatch(source, /legacy run, autopilot, and sprint skills/i);
});

test("current public guidance no longer advertises retired aliases", async () => {
  const surfaces = [
    "README.md",
    "cowork/README.md",
    "cowork/mcp-server.mjs",
    "cowork/sprint-protocol.md",
    "docs/architecture.md",
    "mcp/codex-server.mjs",
    "plugin/hooks/guidance.js",
    "website/guides/codex.md",
    "website/guides/install.md",
    "website/guides/quickstart.md",
    "website/reference/modes.md",
  ];
  for (const path of surfaces) {
    const text = await read(path);
    assert.doesNotMatch(text, /legacy aliases still work|retiring in muster 0\.7\.0|retires in muster 0\.7\.0/i, path);
  }
});

test("the accepted decision records the completed release boundary", async () => {
  const text = await read("docs/decisions/legacy-alias-retirement-clock.md");
  assert.match(text, /first shipped 0\.7\.0 release will retire all three/i);
  assert.match(text, /must remove all three\s+aliases and their compatibility documentation together/i);
});
