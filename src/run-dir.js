// Shared helpers for the stage-2 run directory `.muster/runs/<runId>/`
// (docs/strategy/stage-2-contracts.md). Used by preflight, merge-wave and `next --run`.
import { join } from "node:path";
import { ensureContainedDirectory, readContainedFile, updateContainedFile } from "./fs-safe.js";

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

export async function ensureRunDir(cwd, runId) {
  const dir = runDir(cwd, runId);
  await ensureContainedDirectory(cwd, dir);
  return dir;
}

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
