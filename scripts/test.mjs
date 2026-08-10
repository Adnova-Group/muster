import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const testCodexHome = await mkdtemp(join(tmpdir(), "muster-test-codex-home-"));

try {
  const runtimeFlags = typeof WebSocket === "undefined"
    && process.allowedNodeEnvironmentFlags.has("--experimental-websocket")
    ? ["--experimental-websocket"]
    : [];
  const child = spawn(process.execPath, [...runtimeFlags, "--test", ...process.argv.slice(2)], {
    env: { ...process.env, CODEX_HOME: testCodexHome },
    stdio: "inherit"
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", code => resolve(code ?? 1));
  });
  process.exitCode = exitCode;
} finally {
  await rm(testCodexHome, { recursive: true, force: true });
}
