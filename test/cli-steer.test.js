import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

const pexec = promisify(execFile);
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));

// Integration test: spawn node src/cli.js steer "<msg>" and check the JSON output.

test("muster steer: approve message returns action:approve", async () => {
  const { stdout } = await pexec("node", [CLI, "steer", "approve"]);
  const result = JSON.parse(stdout);
  assert.equal(result.action, "approve", "approve message must yield action:approve");
});

test("muster steer: stop message returns action:stop", async () => {
  const { stdout } = await pexec("node", [CLI, "steer", "please stop the run"]);
  const result = JSON.parse(stdout);
  assert.equal(result.action, "stop");
});

test("muster steer: unknown message returns action:unknown", async () => {
  const { stdout } = await pexec("node", [CLI, "steer", "hello world"]);
  const result = JSON.parse(stdout);
  assert.equal(result.action, "unknown");
});

test("muster steer: output is valid JSON with an action field", async () => {
  const { stdout } = await pexec("node", [CLI, "steer", "lgtm"]);
  const result = JSON.parse(stdout);
  assert.ok(Object.hasOwn(result, "action"), "result must have an action field");
});

test("muster steer: multi-word message is passed as a single argument", async () => {
  const { stdout } = await pexec("node", [CLI, "steer", "do the billing task instead"]);
  const result = JSON.parse(stdout);
  assert.equal(result.action, "retarget");
});
