import { spawn as spawnChild } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const UNKNOWN_CONFIG_FIELD_PATTERN = /unknown configuration field `([^`]+)`/;
// Root tables muster writes into, or that exist in the shared config only
// because muster acted: the thread-limit key and the agent declarations both
// live under [agents], `codex plugin marketplace add`/`plugin add` write
// [marketplaces.*] and [plugins.*], and muster reconciles [hooks.state]. An
// unknown field rooted in any of these could plausibly be muster's doing, so
// it is never disowned. See preexistingStrictFailure.
export const MUSTER_OWNED_CONFIG_ROOTS = new Set(["agents", "marketplaces", "plugins", "hooks"]);

// Reduce a native parser diagnostic to WHAT it objected to, dropping the parts
// that legitimately differ between the candidate and baseline runs: the
// per-run staging directory named in the PATH-alias WARNING, and the
// file:line:col position, which shifts when muster's edit changes the file.
export function normalizeStrictConfigDiagnostic(message) {
  return String(message || "")
    .split(/\r?\n/)
    .filter(line => !/^\s*WARNING\b/.test(line))
    .join(" ")
    .replace(/\S*[\\/]\S*/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
}

// Doctor reports the live config as it is, so a foreign unknown field stays a
// red check -- the config really does not strict-parse. Name the owner so the
// operator does not read it as muster's to fix, and say that install is not
// gated on it. Muster-owned roots are never attributed away.
export function foreignConfigFieldAttribution(message) {
  const field = String(message || "").match(UNKNOWN_CONFIG_FIELD_PATTERN)?.[1];
  if (!field || MUSTER_OWNED_CONFIG_ROOTS.has(field.split(".")[0])) return message;
  return `${message} (\`${field}\` is not written by muster: another Codex config writer owns it, and muster install no longer blocks on it)`;
}

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
      if (typeof message?.method === "string" && /^(?:thread|turn)[/._]/.test(message.method)) count++;
      else if (typeof message?.type === "string" && /^(?:thread|turn)[/._]/.test(message.type)) count++;
    } catch { /* Native diagnostics are not required to be JSON. */ }
  }
  return count;
}

async function stagedFileReceipt(path, expected) {
  if (!expected.exists) {
    try { await lstat(path); }
    catch (error) { if (error.code === "ENOENT") return { exists: false }; throw error; }
    throw new Error(`Codex strict config staging unexpectedly created ${path}`);
  }
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isFile()) throw new Error(`Codex strict config staging is not a regular file: ${path}`);
  const bytes = await readFile(path);
  if (!bytes.equals(expected.bytes)) throw new Error(`Codex strict config staging changed before parser acceptance: ${path}`);
  return { exists: true, dev: info.dev, ino: info.ino, bytes };
}

async function assertStagedFile(path, expected, receipt) {
  const current = await stagedFileReceipt(path, expected);
  if (current.exists !== receipt.exists
    || (current.exists && (current.dev !== receipt.dev || current.ino !== receipt.ino || !current.bytes.equals(receipt.bytes)))) {
    throw new Error(`Codex strict config staging changed during parser validation: ${path}`);
  }
}

function runOneStrictConfigCheck({
  cwd,
  codexHome,
  runtimeIdentity,
  spawn = spawnChild,
  timeoutMs = CODEX_STRICT_CONFIG_TIMEOUT_MS,
  terminationGraceMs = 1_000,
  env = process.env
} = {}) {
  if (!runtimeIdentity?.nativeCodex) {
    return Promise.reject(new Error("a trusted Codex runtime identity is required for strict config validation"));
  }
  return new Promise((resolveResult, reject) => {
    let child;
    const stdoutChunks = [], stderrChunks = [];
    let stdoutBytes = 0, stderrBytes = 0;
    let settled = false;
    let pendingFailure = null;
    let escalationTimer = null;
    let lifecycleTimer = null;
    const finish = error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(escalationTimer);
      clearTimeout(lifecycleTimer);
      if (error) reject(error);
      else resolveResult({ ok: true, modelTurnEvents: 0 });
    };
    const append = (chunks, chunk, stream) => {
      if (pendingFailure) return;
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const count = stream === "stdout" ? (stdoutBytes += bytes.length) : (stderrBytes += bytes.length);
      if (count > CODEX_STRICT_CONFIG_OUTPUT_CAP) {
        requestTermination(new Error(`Codex app-server strict config validation exceeded the ${CODEX_STRICT_CONFIG_OUTPUT_CAP}-byte ${stream} limit`));
        return;
      }
      chunks.push(bytes);
    };
    const signalTree = signal => {
      try {
        if (process.platform !== "win32" && Number.isInteger(child?.pid)) process.kill(-child.pid, signal);
        else child?.kill(signal);
      } catch { try { child?.kill(signal); } catch { /* best effort */ } }
    };
    const requestTermination = error => {
      if (!pendingFailure) pendingFailure = error;
      if (escalationTimer) return;
      signalTree("SIGTERM");
      escalationTimer = setTimeout(() => signalTree("SIGKILL"), 100);
      lifecycleTimer = setTimeout(() => finish(new Error(
        `${pendingFailure.message}; parser termination could not be confirmed after ${terminationGraceMs}ms`
      )), terminationGraceMs);
    };
    const timer = setTimeout(() => requestTermination(
      new Error(`Codex app-server strict config validation timed out after ${timeoutMs}ms`)
    ), timeoutMs);
    try {
      child = spawn(runtimeIdentity.nativeCodex, ["app-server", "--strict-config", "--listen", "stdio://"], {
        cwd,
        env: { ...env, ...(codexHome ? { CODEX_HOME: codexHome } : {}) },
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
        windowsHide: true
      });
    } catch (error) {
      finish(new Error(`Codex app-server strict config validation could not start: ${error.message}`));
      return;
    }
    child.stdout.on("data", chunk => { if (!settled) append(stdoutChunks, chunk, "stdout"); });
    child.stderr.on("data", chunk => { if (!settled) append(stderrChunks, chunk, "stderr"); });
    child.stdout.on("error", error => requestTermination(new Error(`Codex app-server strict config validation stdout failed: ${error.message}`)));
    child.stderr.on("error", error => requestTermination(new Error(`Codex app-server strict config validation stderr failed: ${error.message}`)));
    child.stdin.on("error", error => {
      if (error?.code !== "EPIPE") requestTermination(new Error(`Codex app-server strict config validation stdin failed: ${error.message}`));
    });
    child.on("error", error => {
      const failure = new Error(`Codex app-server strict config validation could not start: ${error.message}`);
      if (child?.pid) requestTermination(failure);
      else finish(failure);
    });
    child.on("close", (code, signal) => {
      if (settled) return;
      if (escalationTimer) clearTimeout(escalationTimer);
      if (pendingFailure) {
        finish(pendingFailure);
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8");
      const turns = modelTurnEventCount(`${stdout}\n${stderr}`);
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
    // EOF makes app-server parse config and exit without an initialize or
    // thread/start request. The `close` handler waits for both output streams.
    child.stdin.end();
  });
}

// A strict-config rejection is muster's to own only when muster's edit CAUSED
// it. The parser validates the whole candidate, so any key another writer put
// in the shared config blocked every install: OpenAI's primary runtime writes
// `[features] rmcp_client`, which is absent from the OSS Codex schema in
// 0.147.0 and 0.148.0-alpha.6 alike, so no release resolves it and the user is
// left hand-editing another vendor's file to install muster.
//
// Three conditions, all required, before a failure is disowned:
//   1. it is an `unknown configuration field` rejection -- every other kind
//      (malformed TOML, type errors, timeouts, model-turn events) stays a hard
//      block, because muster cannot argue it did not cause those;
//   2. the field's root table is not one muster writes into, so muster
//      demonstrably did not introduce the key; and
//   3. re-parsing the pre-edit bytes fails with the SAME objection, proving it
//      predates this run.
// A clean baseline keeps the original hard block in full.
//
// `configCandidateSources` is never rewritten (unlike `candidateSnapshots`,
// which the staged plugin registration replaces), so it is always the config
// as it was before muster touched anything.
//
// Accepted limitation: the native parser reports ONE diagnostic at a time,
// first in file order, so a muster-introduced fault LATER in the file stays
// hidden behind a pre-existing one. That is unreachable without a parser that
// reports every error, and in that state the config is already strict-unusable
// for reasons muster did not create.
export async function preexistingStrictConfigFailure(candidateError, {
  configParser, cwd, codexHome, runtimeIdentity, sharedPath, sharedSnapshot, projectPath, projectSnapshot
}) {
  const field = String(candidateError?.message || "").match(UNKNOWN_CONFIG_FIELD_PATTERN)?.[1];
  if (!configParser || !field || MUSTER_OWNED_CONFIG_ROOTS.has(field.split(".")[0])) return null;
  try {
    await configParser({
      cwd,
      codexHome,
      runtimeIdentity,
      baseline: true,
      configSnapshots: {
        shared: { path: sharedPath, ...sharedSnapshot },
        project: { path: projectPath, ...projectSnapshot }
      }
    });
  } catch (baselineError) {
    const normalized = normalizeStrictConfigDiagnostic(candidateError.message);
    return normalizeStrictConfigDiagnostic(baselineError.message) === normalized ? normalized : null;
  }
  return null;
}


export async function runCodexStrictConfigCheck(options = {}) {
  const { cwd = process.cwd(), codexHome, runtimeIdentity, spawn = spawnChild } = options;
  if (options.configSnapshots) {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "muster-codex-strict-stage-"));
    const stagedHome = join(temporaryRoot, "codex-home");
    const stagedProject = join(temporaryRoot, "project");
    const stagedProjectConfig = join(stagedProject, ".codex", "config.toml");
    const stagedSharedConfig = join(stagedHome, "config.toml");
    const mappings = [
      [stagedSharedConfig, options.configSnapshots.shared.path],
      [stagedProjectConfig, options.configSnapshots.project.path]
    ];
    const remap = error => {
      let message = error.message;
      for (const [staged, original] of mappings) message = message.replaceAll(staged, original);
      return new Error(message, { cause: error });
    };
    try {
      await mkdir(stagedHome, { recursive: true });
      await mkdir(join(stagedProject, ".codex"), { recursive: true });
      if (options.configSnapshots.shared.exists) {
        await writeFile(stagedSharedConfig, options.configSnapshots.shared.bytes);
        await chmod(stagedSharedConfig, 0o400);
      }
      if (options.configSnapshots.project.exists) {
        await writeFile(stagedProjectConfig, options.configSnapshots.project.bytes);
        await chmod(stagedProjectConfig, 0o400);
      }
      const stagedReceipts = new Map();
      for (const [staged, _original] of mappings) {
        const expected = staged === stagedSharedConfig ? options.configSnapshots.shared : options.configSnapshots.project;
        stagedReceipts.set(staged, await stagedFileReceipt(staged, expected));
      }
      const assertStaging = async () => {
        for (const [staged, _original] of mappings) {
          const expected = staged === stagedSharedConfig ? options.configSnapshots.shared : options.configSnapshots.project;
          await assertStagedFile(staged, expected, stagedReceipts.get(staged));
        }
      };
      try {
        await assertStaging();
        await runOneStrictConfigCheck({ ...options, cwd: stagedProject, codexHome: stagedHome, runtimeIdentity, spawn });
        await assertStaging();
        const trustHome = join(temporaryRoot, "trust-home");
        await mkdir(trustHome);
        await writeFile(join(trustHome, "config.toml"),
          `[projects.${JSON.stringify(resolve(stagedProject))}]\ntrust_level = "trusted"\n`);
        await assertStaging();
        const result = await runOneStrictConfigCheck({ ...options, cwd: stagedProject, codexHome: trustHome, runtimeIdentity, spawn });
        await assertStaging();
        return result;
      } catch (error) { throw remap(error); }
    } finally {
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }
  const shared = await runOneStrictConfigCheck({ ...options, cwd, codexHome, runtimeIdentity, spawn });

  // Codex deliberately skips project `.codex/config.toml` until the project
  // is trusted. Validate it in place with an ephemeral trust-only CODEX_HOME;
  // no persistent trust, session, thread, or turn is created.
  if (options.validateProjectConfig === false) return shared;
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
