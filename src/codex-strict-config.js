import { spawn as spawnChild } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const CODEX_STRICT_CONFIG_TIMEOUT_MS = 2_500;
export const CODEX_STRICT_CONFIG_OUTPUT_CAP = 64 * 1024;

function diagnostic(text) {
  return String(text || "")
    .replace(/\0/g, "")
    .replace(/[^\P{C}\n\r\t]/gu, "?")
    .trim();
}

function modelTurnEventCount(text) {
  let count = 0;
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const message = JSON.parse(line);
      if (typeof message?.method === "string" && /^(?:thread|turn)[/.](?:start|started|complete|completed|fail|failed)$/.test(message.method)) count++;
      else if (typeof message?.type === "string" && /^(?:thread|turn)[._/](?:start|started|complete|completed|fail|failed)$/.test(message.type)) count++;
    } catch { /* app-server diagnostics need not be JSON; stderr supplies parser failures */ }
  }
  return count;
}

function runOneStrictConfigCheck({
  cwd,
  codexHome,
  spawn = spawnChild,
  timeoutMs = CODEX_STRICT_CONFIG_TIMEOUT_MS,
  env = process.env
} = {}) {
  return new Promise((resolve, reject) => {
    let child;
    const stdoutChunks = [], stderrChunks = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let settled = false;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ ok: true, modelTurnEvents: 0 });
    };
    const append = (chunks, chunk, stream) => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const count = stream === "stdout" ? (stdoutBytes += bytes.length) : (stderrBytes += bytes.length);
      if (count > CODEX_STRICT_CONFIG_OUTPUT_CAP) {
        try { child?.kill("SIGKILL"); } catch { /* best effort */ }
        finish(new Error(`Codex app-server strict config validation exceeded the ${CODEX_STRICT_CONFIG_OUTPUT_CAP}-byte ${stream} limit`));
        return;
      }
      chunks.push(bytes);
    };
    const timer = setTimeout(() => {
      try { child?.kill("SIGKILL"); } catch { /* best effort */ }
      finish(new Error(`Codex app-server strict config validation timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();
    try {
      child = spawn("codex", ["app-server", "--strict-config", "--listen", "stdio://"], {
        cwd,
        env: { ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true
      });
    } catch (error) {
      finish(new Error(`Codex app-server strict config validation could not start: ${error.message}`));
      return;
    }
    child.stdout.on("data", chunk => { if (!settled) append(stdoutChunks, chunk, "stdout"); });
    child.stderr.on("data", chunk => { if (!settled) append(stderrChunks, chunk, "stderr"); });
    child.stdout.on("error", error => finish(new Error(`Codex app-server strict config validation stdout failed: ${error.message}`)));
    child.stderr.on("error", error => finish(new Error(`Codex app-server strict config validation stderr failed: ${error.message}`)));
    child.stdin.on("error", error => {
      if (error?.code !== "EPIPE") finish(new Error(`Codex app-server strict config validation stdin failed: ${error.message}`));
    });
    child.on("error", error => finish(new Error(`Codex app-server strict config validation could not start: ${error.message}`)));
    // `exit` can precede the final stdout/stderr data. `close` is the Node
    // boundary that guarantees the stdio streams have closed and drained.
    child.on("close", (code, signal) => {
      if (settled) return;
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const turns = modelTurnEventCount(stdout);
      if (turns) {
        finish(new Error(`Codex app-server strict config validation emitted ${turns} model-turn event(s); parser validation must remain non-billable`));
        return;
      }
      if (code === 0) {
        finish();
        return;
      }
      const detail = diagnostic(stderr) || diagnostic(stdout) || `process exited with ${signal || code || "unknown status"}`;
      finish(new Error(`Codex app-server strict config validation failed: ${detail}`));
    });
    // No initialize request and no thread/start request: EOF asks app-server to
    // parse the complete effective config and exit without creating a model turn.
    child.stdin.end();
  });
}

export async function runCodexStrictConfigCheck(options = {}) {
  const { cwd = process.cwd(), codexHome, spawn = spawnChild } = options;
  const first = await runOneStrictConfigCheck({ ...options, cwd, codexHome, spawn });

  // Codex deliberately skips a project's `.codex/config.toml` until that
  // project is trusted. Muster does not mutate the user's trust table, so a
  // second parser-only pass uses an ephemeral CODEX_HOME containing only a
  // trust record for this cwd. This validates the real project file in place
  // without persisting trust or starting a thread/turn. The first pass already
  // validated the real shared CODEX_HOME config.
  if (options.validateProjectConfig === false) return first;
  const temporaryRoot = await mkdtemp(join(tmpdir(), "muster-codex-strict-"));
  const validationHome = join(temporaryRoot, "codex-home");
  try {
    await mkdir(validationHome);
    await writeFile(join(validationHome, "config.toml"),
      `[projects.${JSON.stringify(resolve(cwd))}]\ntrust_level = "trusted"\n`);
    return await runOneStrictConfigCheck({ ...options, cwd, codexHome: validationHome, spawn });
  } finally {
    await rm(temporaryRoot, { recursive: true, force: true });
  }
}
