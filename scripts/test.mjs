import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

// `--fast` (npm run test:fast) drops the slow, environment-heavy files: real
// installs, live Codex probes, large filesystem fixtures, many CLI spawns.
// The full `npm test` (and CI) still runs every file.
const SLOW_TEST_FILES = [
  "cli-wire.test.js",
  "codex-cache-package.test.js",
  "codex-doctor.test.js",
  "codex-hook-scope-collapse.test.js",
  "codex-hook-state.test.js",
  "codex-hook-trust.test.js",
  "codex-install-scopes.test.js",
  "codex-install.test.js",
  "codex-live-wave.test.js",
  "cowork.test.js",
  "init.test.js",
  "prompt-scan.test.js",
];

let args = process.argv.slice(2);
if (args[0] === "--fast") {
  const testDir = fileURLToPath(new URL("../test/", import.meta.url));
  const missing = SLOW_TEST_FILES.filter(name => !existsSync(join(testDir, name)));
  if (missing.length) throw new Error(`scripts/test.mjs SLOW_TEST_FILES lists missing files: ${missing.join(", ")}`);
  args = args.slice(1).filter(arg => !SLOW_TEST_FILES.includes(basename(arg)));
}

const testCodexHome = await mkdtemp(join(tmpdir(), "muster-test-codex-home-"));

try {
  const runtimeFlags = typeof WebSocket === "undefined"
    && process.allowedNodeEnvironmentFlags.has("--experimental-websocket")
    ? ["--experimental-websocket"]
    : [];
  // A per-test ceiling turns a hang into a named failure instead of a stalled run (a full-suite-only
  // hang in codex-release.test.js once spun a worker for 29 minutes). The slowest legitimate test
  // is ~90 s; override with MUSTER_TEST_TIMEOUT_MS.
  const timeoutMs = Number(process.env.MUSTER_TEST_TIMEOUT_MS) > 0 ? Number(process.env.MUSTER_TEST_TIMEOUT_MS) : 180_000;
  const child = spawn(process.execPath, [...runtimeFlags, "--test", `--test-timeout=${timeoutMs}`, ...args], {
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
