import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

const execFileP = promisify(execFile);
const rootDir = fileURLToPath(new URL("../", import.meta.url));

test("the documented twelve-call MCP replay enforces byte parity and the p95 target", async () => {
  const { stdout } = await execFileP(process.execPath, [
    join(rootDir, "eval", "perf", "replay-mcp-pure-tools.mjs"),
    "--rounds=1",
  ], { cwd: rootDir, timeout: 30_000 });
  const report = JSON.parse(stdout);
  assert.equal(report.callsPerReplay, 12);
  assert.equal(report.byteEquivalent, true);
  assert.equal(report.targetPct, 50);
  assert.equal(report.targetMet, true);
  assert.ok(report.after.p95Ms < report.before.p95Ms);
});
