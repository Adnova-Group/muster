// `muster next --run <id>`: derive a run's position from which files exist in
// .muster/runs/<id>/ (gsd's next.md routing table: derive, don't narrate) and rewrite the
// derived head of STATE.md. The `## Log` section that merge-wave appends is preserved.
import { spawnSync } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { MERGE_REFUSAL, mergeInputs, readState, runDir, sameMergeInputs, writeStateHead } from "./run-dir.js";
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

// plan-check.json holds the make-plan result `{verdict, escalated, issues}` (or the Workflow
// envelope around it). Anything unreadable is a record of nothing: never a pass.
export function planCheckRecord(text) {
  let j;
  try { j = unwrap(JSON.parse(text || "")); } catch { return { verdict: "UNREADABLE", escalated: null, blockers: 0 }; }
  if (!j || typeof j !== "object") return { verdict: "UNREADABLE", escalated: null, blockers: 0 };
  const verdict = typeof j.verdict === "string" ? j.verdict.toUpperCase() : "UNREADABLE";
  const escalated = typeof j.escalated === "string" && j.escalated ? j.escalated : null;
  const blockers = Array.isArray(j.issues) ? j.issues.filter((i) => /^blocker$/i.test(String(i?.severity || ""))).length : 0;
  return { verdict: escalated && verdict === "PASS" ? "ISSUES" : verdict, escalated, blockers };
}

// merge-refusal.json (src/merge-wave.js). Anything unreadable is a refusal, never a pass.
export function mergeRefusalRecord(text) {
  let j;
  try { j = JSON.parse(text || ""); } catch { j = null; }
  if (!j || typeof j !== "object") return { kind: "refused", problems: [`${MERGE_REFUSAL} is unreadable`], wavesMerged: [], failedWave: null, unreadable: true };
  const problems = (Array.isArray(j.problems) ? j.problems : []).map(String);
  const failedWave = Number.isInteger(j.failedWave) && j.failedWave > 0 ? j.failedWave : null;
  return {
    kind: j.kind === "partial" && failedWave ? "partial" : "refused",
    problems, failedWave,
    wavesMerged: Array.isArray(j.wavesMerged) ? j.wavesMerged.filter(Number.isInteger) : [],
    resultDigest: j.resultDigest ?? null, digests: j.digests ?? null,
  };
}

const clip = (s, n = 900) => (s.length > n ? `${s.slice(0, n)}...` : s);

function mergedTasks(state) {
  const ids = new Set();
  for (const m of state.matchAll(/merge-wave: merged (\S+) /g)) ids.add(m[1]);
  return [...ids];
}

// A backlog-origin run (build-args.json `backlogItem`, written by `build-args --item`) whose work
// is merged and verified names its backlog tick, so a `--run` resume ticks the item too (live
// run 8: a resumed item merged and verified but stayed `- [ ]`; only go.md Backlog step 5 ticked).
// The receipt is the run's last merge-wave merge, resolved to the full sha CI checks. Null when
// the run has no item, the item is already ticked or missing, or git cannot resolve the merge.
const ITEM_LINE_RE = /^- \[( |x|X)\] (.*)$/;
const SAFE_BACKLOG_RE = /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9._\/-]{1,200}\.md$/;

export function backlogLine(text, id) {
  const lines = String(text).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(ITEM_LINE_RE);
    if (!m) continue;
    const ann = m[2].match(/\{\s*id\s*:\s*([^}]*?)\s*\}/);
    if ((ann ? ann[1] : `item-${i + 1}`) === id) return { line: i + 1, ticked: m[1] !== " " };
  }
  return null;
}

async function backlogTick(cwd, dir, state) {
  let item;
  try { item = JSON.parse(await readFile(join(dir, "build-args.json"), "utf8"))?.backlogItem; } catch { return null; }
  if (!item || typeof item.id !== "string" || typeof item.file !== "string" || !SAFE_BACKLOG_RE.test(item.file)) return null;
  const text = await readOrNull(join(cwd, item.file));
  const found = text === null ? null : backlogLine(text, item.id);
  if (!found || found.ticked) return null;
  const merges = [...state.matchAll(/merge-wave: merged \S+ \S+ as ([0-9a-f]{7,40})\b/g)];
  if (!merges.length) return null;
  const r = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${merges[merges.length - 1][1]}^{commit}`], { cwd, encoding: "utf8" });
  const merge = r.status === 0 ? r.stdout.trim() : "";
  return /^[0-9a-f]{40}$/.test(merge) ? { file: item.file, id: item.id, line: found.line, merge } : null;
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
  // The plan gate's record: the main thread writes every muster:make-plan result to
  // plan-check.json (orchestrator rule 6). Workflow scripts cannot write files, so without it a
  // stalled plan looked exactly like a passed one, and `next` pointed a resume at the build of a
  // plan that never passed the checker (live e2e 2026-11-10, runs 2 and 3).
  const planCheck = has("plan-check.json") ? planCheckRecord(await readOrNull(join(dir, "plan-check.json"))) : null;
  const rel = `.muster/runs/${runId}`;
  // merge-wave's refusal record binds only while the build result and build-args digests it
  // judged are unchanged: re-running merge-wave on the same inputs can only fail the same way.
  // A partial merge stays open until a new build result arrives: new build args alone (the
  // `--from-wave` rebuild's, before its build ran) still leave the failed waves to build, and
  // re-running build-args then is harmless. build-args moves the judged build-result.json to
  // attempts/, so no build result at all also means the rebuild has not run yet.
  const refusal = has(MERGE_REFUSAL) ? mergeRefusalRecord(await readOrNull(join(dir, MERGE_REFUSAL))) : null;
  const refusalInputs = refusal && !refusal.unreadable ? await mergeInputs(cwd, runId) : null;
  const refusalCurrent = !!refusal && (refusal.unreadable || sameMergeInputs(refusal, refusalInputs) ||
    (refusal.kind === "partial" && (refusalInputs.resultDigest === null || refusal.resultDigest === refusalInputs.resultDigest)));

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
  } else if (refusalCurrent && refusal.kind === "refused") {
    [position, action, why] = ["merge-refused", `escalate: merge-wave refused the whole build result; show these problems to the user and stop (re-run merge-wave only after a new build result or new build-args digests): ${clip(refusal.problems.join("; "))}`, `${rel}/${MERGE_REFUSAL} records a refusal, and build-result.json and the build-args digests are unchanged since`];
  } else if (refusalCurrent) {
    const n = refusal.failedWave;
    const done = refusal.wavesMerged.length ? `wave(s) ${refusal.wavesMerged.join(", ")} merged` : "no wave merged";
    [position, action, why] = ["merge-partial", `rebuild: muster build-args ${runId} --from-wave ${n}, commit it (go step 4), then build and merge-wave; ${done}, so verification is not PASS until wave ${n} and later merge`, `${rel}/${MERGE_REFUSAL}: wave ${n} not merged: ${clip(refusal.problems.join("; "))}`];
  } else if (built.some((t) => !merged.includes(t))) {
    [position, action, why] = ["built", `merge: muster merge-wave ${runId} --result ${rel}/build-result.json`, `build-result.json has unmerged tasks: ${built.filter((t) => !merged.includes(t)).join(", ")}`];
  } else if (!has("build-args.json") && !has("build-result.json") && !summarized.length && !merged.length && planCheck?.verdict !== "PASS") {
    // build-args.json is written only after the gate passes (go step 4), so its absence plus a
    // missing or non-PASS gate record means this plan was never approved.
    if (planCheck) {
      const reason = planCheck.escalated ? `escalated: ${planCheck.escalated}` : `verdict ${planCheck.verdict}`;
      [position, action, why] = ["plan-escalated", `escalate: the plan never passed the checker (${reason}); show the issues in ${rel}/plan-check.json and offer Revise (record the answer as a D-NN in CONTEXT.md, then re-run muster:make-plan) or Abort; never build it`, `plan-check.json ${reason}${planCheck.blockers ? `, ${planCheck.blockers} blocker(s)` : ""}`];
    } else {
      [position, action, why] = ["plan-unchecked", `plan: Workflow({name:"muster:make-plan", args:{runId:"${runId}", ...}}) gates the existing PLAN.md (the planner keeps a plan that covers the outcome); build only after a PASS`, "PLAN.md exists but no checker verdict is on record (no plan-check.json) and no build-args.json"];
    }
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

  // Done (merged, verified PASS or HUMAN_NEEDED): a backlog item still unticked is ticked first.
  const tick = (position === "verified" || position === "human_needed") && plan ? await backlogTick(cwd, dir, state) : null;
  if (tick) action = `tick backlog item ${tick.id} first: mark line ${tick.line} of ${tick.file} "- [x]" with {merge: ${tick.merge}} through backlog-publish (go.md Backlog step 5), commit it; then ${action}`;
  const report = {
    runId, position, next: action, why,
    ...(tick ? { backlog: tick } : {}),
    ...(refusalCurrent ? { problems: refusal.problems, ...(refusal.kind === "partial" ? { wavesMerged: refusal.wavesMerged, failedWave: refusal.failedWave } : {}) } : {}),
    artifacts: {
      context: has("CONTEXT.md"), plan: !!plan, planCheck: planCheck ? planCheck.verdict : null, summaries: summarized, buildResult: has("build-result.json"),
      mergeRefusal: refusal ? (refusalCurrent ? refusal.kind : "superseded") : null,
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
      ...(refusalCurrent ? [`- verification: not PASS: ${refusal.kind === "partial" ? `partial merge, wave ${refusal.failedWave} and later not merged` : "merge-wave refused the build result"}`] : []),
    ].join("\n");
    await writeStateHead(cwd, runId, head);
  }
  return report;
}
