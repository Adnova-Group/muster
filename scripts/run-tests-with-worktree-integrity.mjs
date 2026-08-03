#!/usr/bin/env node
import { spawn } from "node:child_process";
import { access, realpath } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { constants } from "node:fs";
import { pathToFileURL } from "node:url";
import { inspectRepository, verifyRepositoryState } from "./check-worktree-root-integrity.mjs";

async function resolveExecutable(name) {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, name);
    try {
      await access(candidate, constants.X_OK);
      return realpath(candidate);
    } catch {}
  }
  throw new Error(`cannot resolve trusted ${name} executable before the full gate`);
}

function runNpmTest(npmCli, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [npmCli, "test"], {
      cwd,
      env: { ...process.env },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("close", (status, signal) => resolve({ status, signal }));
  });
}

export async function runWithWorktreeIntegrity({
  cwd = process.cwd(),
  runGate,
} = {}) {
  const baseline = await inspectRepository(cwd);
  const gate = runGate ?? (() => resolveExecutable("npm").then((npmCli) => runNpmTest(npmCli, cwd)));
  let gateResult;
  let gateError;
  try { gateResult = await gate(); }
  catch (error) { gateError = error; }

  let integrityError;
  try { verifyRepositoryState(await inspectRepository(cwd), baseline); }
  catch (error) { integrityError = error; }
  if (integrityError) throw integrityError;
  if (gateError) throw gateError;
  return gateResult ?? { status: 0, signal: null };
}

async function main() {
  const result = await runWithWorktreeIntegrity();
  if (result.signal) throw new Error(`npm test terminated by signal ${result.signal}`);
  process.exitCode = Number.isInteger(result.status) ? result.status : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    process.stderr.write(`full gate integrity wrapper failed: ${error.message}\n`);
    process.exitCode = 1;
  });
}
