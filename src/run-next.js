// `muster next --run <id>`: derive a run's position from which files exist in
// .muster/runs/<id>/ (gsd's next.md routing table: derive, don't narrate) and rewrite the
// derived head of STATE.md. The `## Log` section that merge-wave appends is preserved.
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { readState, runDir, writeStateHead } from "./run-dir.js";
import { parsePlan } from "./plan-lint.js";

// The Workflow tool returns `{summary, agentCount, logs, result}`; the main thread may save that
// envelope instead of the bare result (seen in the stage-3 content smoke).
const unwrap = (j) => (j && j.result && typeof j.result === "object" && !Array.isArray(j.tasks) && j.verdict === undefined ? j.result : j);

async function readOrNull(path) {
  try { return await readFile(path, "utf8"); } catch { return null; }
}

// Task ids in PLAN.md. The planner's exact format is owned by muster-planner, so accept
// the common shapes: `<task id="T1">`, `taskId: T1`, and frontmatter `- id: T1`. A plan with
// `<task>` elements (docs/plan-format.md) names its tasks only there: its frontmatter `- id:`
// lines are must_haves prohibitions (P-01...), which never get a SUMMARY. Counting them held a
// fully merged live run at "planned" and pointed `next` back at the build (e2e 2026-11-10).
export function planTaskIds(plan) {
  const ids = new Set();
  for (const m of plan.matchAll(/<task\b[^>]*\bid="([^"]+)"/g)) ids.add(m[1]);
  if (ids.size) return [...ids];
  for (const re of [/^\s*-?\s*taskId:\s*["']?([A-Za-z0-9._-]+)/gm, /^\s*-\s+id:\s*["']?([A-Za-z0-9._-]+)/gm]) {
    for (const m of plan.matchAll(re)) ids.add(m[1]);
  }
  return [...ids];
}

// muster-verifier writes gsd's frontmatter status (passed | gaps_found | human_needed); the
// live stage-2b smoke showed `human_needed` falling through to "no verdict".
const GSD_STATUS = { passed: "PASS", gaps_found: "GAPS", human_needed: "HUMAN_NEEDED" };

export function verificationVerdict(text) {
  const status = text.match(/^status:\s*(passed|gaps_found|human_needed)\b/m);
  if (status) return GSD_STATUS[status[1]];
  const m = text.match(/\b(?:verdict|status)\b[^A-Za-z\n]{0,6}\**\s*(PASS|GAPS|ABSTAIN)\b/i) || text.match(/\b(PASS|GAPS|ABSTAIN)\b/);
  return m ? m[1].toUpperCase() : null;
}

function mergedTasks(state) {
  const ids = new Set();
  for (const m of state.matchAll(/merge-wave: merged (\S+) /g)) ids.add(m[1]);
  return [...ids];
}

export async function nextForRun({ cwd, runId }) {
  const dir = runDir(cwd, runId);
  let files;
  try { files = await readdir(dir); } catch { files = null; }
  const has = (f) => !!files && files.includes(f);
  const plan = has("PLAN.md") ? await readOrNull(join(dir, "PLAN.md")) : null;
  const state = files ? await readState(cwd, runId) : "";
  // Checkpoint tasks are human stops (build-args lists them as humanNeeded); they never get a
  // SUMMARY, so they must not hold the run at "planned" forever.
  const checkpoints = new Set(plan ? parsePlan(plan).tasks.filter((t) => t.kind === "checkpoint" && t.id).map((t) => t.id) : []);
  const planned = plan ? planTaskIds(plan).filter((id) => !checkpoints.has(id)) : [];
  const summarized = (files || []).filter((f) => /^SUMMARY-.+\.md$/.test(f)).map((f) => f.slice(8, -3));
  const merged = mergedTasks(state);
  let built = [];
  if (has("build-result.json")) {
    try { built = (unwrap(JSON.parse(await readOrNull(join(dir, "build-result.json")))).tasks || []).map((t) => t.taskId); } catch { built = []; }
  }
  const verdict = has("VERIFICATION.md") ? verificationVerdict(await readOrNull(join(dir, "VERIFICATION.md")) || "") : null;
  const rel = `.muster/runs/${runId}`;

  // Content runs (muster:pipeline) have pipeline-args.json instead of PLAN.md.
  let pipelineVerdict = null;
  if (has("pipeline-result.json")) {
    try { pipelineVerdict = unwrap(JSON.parse(await readOrNull(join(dir, "pipeline-result.json")))).verdict || "ERROR"; } catch { pipelineVerdict = "ERROR"; }
  }

  let position, action, why;
  if (has("continue-here.md")) {
    [position, action, why] = ["paused", `resume: read ${rel}/continue-here.md, then continue from the step it names`, "continue-here.md exists"];
  } else if (has("pipeline-args.json") && !plan) {
    if (!pipelineVerdict) [position, action, why] = ["pipeline", `pipeline: Workflow({name:"muster:pipeline", args:<${rel}/pipeline-args.json>})`, "pipeline-args.json exists, pipeline-result.json does not"];
    else if (pipelineVerdict === "PASS") [position, action, why] = ["verified", "done: present the artifact, its score and the merge decision", "pipeline-result.json verdict PASS"];
    else [position, action, why] = ["inconclusive", "ask the human: the content gate did not pass (see pipeline-result.json halted and score)", `pipeline-result.json verdict ${pipelineVerdict}`];
  } else if (!plan && !has("CONTEXT.md")) {
    [position, action, why] = ["new", "discuss: run the interview to write CONTEXT.md (or plan directly when preflight says the outcome is clear)", "no CONTEXT.md and no PLAN.md"];
  } else if (!plan) {
    [position, action, why] = ["discussed", `plan: Workflow({name:"muster:make-plan", args:{runId:"${runId}", contextPath:"${rel}/CONTEXT.md", ...}})`, "CONTEXT.md exists, PLAN.md does not"];
  } else if (built.some((t) => !merged.includes(t))) {
    [position, action, why] = ["built", `merge: muster merge-wave ${runId} --result ${rel}/build-result.json`, `build-result.json has unmerged tasks: ${built.filter((t) => !merged.includes(t)).join(", ")}`];
  } else if (planned.length ? planned.some((t) => !summarized.includes(t)) : !summarized.length) {
    const pending = planned.filter((t) => !summarized.includes(t));
    [position, action, why] = ["planned", `build: Workflow({name:"muster:build", args:{runId:"${runId}", waves:[...], base:"<HEAD sha>"}})`, pending.length ? `no SUMMARY for: ${pending.join(", ")}` : "PLAN.md exists, no SUMMARY-*.md yet"];
  } else if (!verdict) {
    [position, action, why] = ["executed", "verify: run muster-verifier against the merged work", has("VERIFICATION.md") ? "VERIFICATION.md has no verdict" : "every task has a SUMMARY, no VERIFICATION.md"];
  } else if (verdict === "PASS") {
    [position, action, why] = ["verified", "done: present the branch and the human_needed list for the merge decision", "VERIFICATION.md verdict PASS"];
  } else if (verdict === "HUMAN_NEEDED") {
    [position, action, why] = ["human_needed", "done: present the merge decision with VERIFICATION.md's human-check items", "VERIFICATION.md status human_needed"];
  } else if (verdict === "GAPS") {
    [position, action, why] = ["gaps", "replan: run the muster:make-plan workflow with the gaps from VERIFICATION.md as the outcome", "VERIFICATION.md verdict GAPS"];
  } else {
    [position, action, why] = ["inconclusive", "ask the human: the verifier abstained", "VERIFICATION.md verdict ABSTAIN"];
  }

  const report = {
    runId, position, next: action, why,
    artifacts: {
      context: has("CONTEXT.md"), plan: !!plan, summaries: summarized, buildResult: has("build-result.json"),
      verification: verdict, paused: has("continue-here.md"), pipeline: has("pipeline-args.json") ? (pipelineVerdict || "pending") : null,
    },
    tasks: { planned, summarized, merged },
  };
  if (files) {
    const head = [
      `# Run ${runId}`,
      "",
      "<!-- Derived by `muster next --run`; do not edit above the Log. merge-wave appends to the Log. -->",
      `- position: ${position}`,
      `- next: ${action}`,
      `- why: ${why}`,
      `- tasks: ${planned.length} planned, ${summarized.length} summarized, ${merged.length} merged`,
    ].join("\n");
    await writeStateHead(cwd, runId, head);
  }
  return report;
}
