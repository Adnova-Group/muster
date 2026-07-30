import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
const LIMIT = 1_048_576;

function runWithStdin(bytes) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "citation-check", "-"], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.stdin.on("error", (error) => {
      if (error.code !== "EPIPE") reject(error);
    });
    child.on("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
    child.stdin.end(bytes);
  });
}

test("CLI stdin accepts the exact 1 MiB boundary", async () => {
  const result = await runWithStdin(Buffer.alloc(LIMIT, "x"));
  assert.equal(result.signal, null);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

test("CLI stdin rejects input one byte over 1 MiB", async () => {
  const result = await runWithStdin(Buffer.alloc(LIMIT + 1, "x"));
  assert.equal(result.signal, null);
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, new RegExp(`stdin exceeds ${LIMIT} byte limit`));
  assert.equal(result.stdout, "");
});
