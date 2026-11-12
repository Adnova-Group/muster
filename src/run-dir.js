// Shared helpers for the stage-2 run directory `.muster/runs/<runId>/`
// (docs/strategy/stage-2-contracts.md). Used by preflight, merge-wave and `next --run`.
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { createContainedFile, ensureContainedDirectory, readContainedFile, sha256, updateContainedFile } from "./fs-safe.js";

const RUN_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,95}$/;

export function assertRunId(runId) {
  if (typeof runId !== "string" || !RUN_ID_RE.test(runId) || runId.includes("..")) {
    throw new Error(`invalid runId ${JSON.stringify(runId)} (letters, digits, . _ - only)`);
  }
  return runId;
}

export function runDir(cwd, runId) {
  return join(cwd, ".muster", "runs", assertRunId(runId));
}

export function slugRunId(outcome, date = new Date()) {
  const day = date.toISOString().slice(0, 10).replaceAll("-", "");
  const slug = String(outcome || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40).replace(/-+$/, "");
  return `${day}-${slug || "run"}`;
}

// Preflight writes preflight.json before plan/go's "refuse a dirty tree" check. In a project
// that does not ignore .muster/, that file alone made the tree dirty. This file hides the
// machine-local run files (preflight detail, build results and their earlier attempts, the merge
// refusal) and itself (the same patterns as muster's own .gitignore); the run
// record (CONTEXT.md, PLAN.md, STATE.md...) still shows and is committed with the branch.
// Created once and never overwritten, except that a copy muster wrote (its first line) gains the
// patterns added since; a user's own file is left alone.
const RUNS_GITIGNORE_HEADER = "# Written by muster: machine-local run files, never committed.\n";
const RUNS_GITIGNORE_PATTERNS = [".gitignore", "*/preflight.json", "*/build-result.json", "*/merge-refusal.json", "*/attempts/"];
export const RUNS_GITIGNORE = `${RUNS_GITIGNORE_HEADER}${RUNS_GITIGNORE_PATTERNS.join("\n")}\n`;

export async function ensureRunDir(cwd, runId) {
  const dir = runDir(cwd, runId);
  await ensureContainedDirectory(cwd, dir);
  const ignore = join(cwd, ".muster", "runs", ".gitignore");
  if (!(await createContainedFile(cwd, ignore, RUNS_GITIGNORE))) {
    await updateContainedFile(cwd, ignore, (current) => {
      const text = current ? current.toString("utf8") : "";
      if (!text.startsWith(RUNS_GITIGNORE_HEADER)) return current || "";
      const lines = new Set(text.split(/\r?\n/));
      const missing = RUNS_GITIGNORE_PATTERNS.filter((p) => !lines.has(p));
      return missing.length ? `${text.replace(/\n*$/, "\n")}${missing.join("\n")}\n` : current;
    });
  }
  return dir;
}

// merge-wave's record of a refused or partial merge (src/merge-wave.js). Machine-local like the
// build-result.json it judged: it names task branches and worktrees that exist only here.
// `next --run` acts on it only while the inputs it judged are unchanged: the bytes of the run's
// build-result.json and the digests in its build-args.json.
export const MERGE_REFUSAL = "merge-refusal.json";

// An earlier build attempt's result, moved aside by `muster build-args` when it starts a new
// attempt (a `--from-wave` rebuild or any re-run): left in place, the next build's verifier read
// it as the current attempt's record (live partial-merge run 7). Machine-local, like the result.
export const ATTEMPTS_DIR = "attempts";

// Moves the run's build-result.json to attempts/build-result-<k>.json (k counts from 1) and
// returns that run-relative path, or null when there is none. merge-refusal.json stays: it is
// the run's merge state (`next --run` and merge-wave's cleanup of superseded attempts read it).
export async function archiveBuildResult(cwd, runId) {
  const dir = runDir(cwd, runId);
  const from = join(dir, "build-result.json");
  const bytes = await readContainedFile(cwd, from, { allowMissing: true });
  if (!bytes) return null;
  await ensureRunDir(cwd, runId);
  for (let k = 1; k < 10000; k++) {
    const rel = `${ATTEMPTS_DIR}/build-result-${k}.json`;
    if (await createContainedFile(cwd, join(dir, rel), bytes)) {
      await rm(from);
      return rel;
    }
  }
  throw new Error(`.muster/runs/${runId}/${ATTEMPTS_DIR}/ has no free build-result-<k>.json name`);
}

export async function mergeInputs(cwd, runId) {
  const dir = runDir(cwd, runId);
  const read = (f) => readContainedFile(cwd, join(dir, f), { allowMissing: true }).catch(() => null);
  const result = await read("build-result.json");
  const argsBytes = await read("build-args.json");
  let digests = null;
  try { digests = JSON.parse(argsBytes ? argsBytes.toString("utf8") : "null")?.digests ?? null; } catch { digests = null; }
  return {
    resultDigest: result ? sha256(result) : null,
    digests: digests && typeof digests === "object" ? { plan: digests.plan ?? null, args: digests.args ?? null } : null,
  };
}

export const sameMergeInputs = (a, b) =>
  (a?.resultDigest ?? null) === (b?.resultDigest ?? null) &&
  (a?.digests?.plan ?? null) === (b?.digests?.plan ?? null) &&
  (a?.digests?.args ?? null) === (b?.digests?.args ?? null);

// Run ids never start with a dot, so `.gitignore` (above) is not a run.
export const isRunId = (name) => RUN_ID_RE.test(name) && !name.includes("..");

// STATE.md layout: a derived header (rewritten by `muster next --run`) above a
// `## Log` section that only ever grows (appended by `muster merge-wave`).
export const LOG_HEADING = "## Log";

function splitState(text) {
  const at = text.indexOf(`\n${LOG_HEADING}\n`);
  if (at === -1) return { head: text.trim() ? text : "", log: "" };
  return { head: text.slice(0, at + 1), log: text.slice(at + 1 + LOG_HEADING.length + 1) };
}

export async function readState(cwd, runId) {
  const bytes = await readContainedFile(cwd, join(runDir(cwd, runId), "STATE.md"), { allowMissing: true });
  return bytes ? bytes.toString("utf8") : "";
}

export async function appendStateLog(cwd, runId, lines) {
  const dir = await ensureRunDir(cwd, runId);
  await updateContainedFile(cwd, join(dir, "STATE.md"), (current) => {
    const { head, log } = splitState(current ? current.toString("utf8") : "");
    const top = head || `# Run ${runId}\n\n`;
    const body = lines.map((l) => `- ${l.replace(/\n/g, " ")}\n`).join("");
    return `${top.replace(/\n*$/, "\n\n")}${LOG_HEADING}\n${log}${body}`;
  });
}

export async function writeStateHead(cwd, runId, headText) {
  const dir = await ensureRunDir(cwd, runId);
  await updateContainedFile(cwd, join(dir, "STATE.md"), (current) => {
    const { log } = splitState(current ? current.toString("utf8") : "");
    return `${headText.replace(/\n*$/, "\n\n")}${LOG_HEADING}\n${log}`;
  });
}
