import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const root = new URL("../", import.meta.url);
const read = (path) => readFile(new URL(path, root), "utf8");

// Revival stage 2b: go-backlog folded into go and the manifest digest gave way to the committed
// build-args.json that merge-wave trusts, so these contracts pin the new go/plan prose.
test("remote issue text is byte-bounded and cannot close its data delimiter", async () => {
  for (const file of ["plugin/commands/plan.md", "plugin/commands/go.md"]) {
    const text = (await read(file)).replace(/\s+/g, " ");
    assert.match(text, /16 KiB/i, `${file} must bound remote issue text`);
    assert.match(text, /`<\/remote-text>` \(any case\) with `&lt;\/remote-text&gt;`/,
      `${file} must neutralize closing remote-text tags before interpolation`);
    assert.match(text, /UTF-8 code-point boundary/i, `${file} must not split UTF-8 while bounding text`);
  }
});

test("Approve & build continues the approved run; merge-wave trusts only the committed build args", async () => {
  const plan = (await read("plugin/commands/plan.md")).replace(/\s+/g, " ");
  assert.match(plan, /\*\*Approve & build:\*\* invoke the `muster:go` skill with `--run <runId>`/);
  const go = (await read("plugin/commands/go.md")).replace(/\s+/g, " ");
  assert.match(go, /Never re-plan an approved run/);
  assert.match(go, /merge-wave trusts only this committed file/);
  assert.match(go, /never merge task branches by hand/);
});

test("nothing but an explicit human choice merges into the base or pushes", async () => {
  const go = (await read("plugin/commands/go.md")).replace(/\s+/g, " ");
  assert.match(go, /Attended: AskUserQuestion/);
  assert.match(go, /never merge into the base or push to main/);
  // First live e2e: run 1 kept its branch unpushed, run 4 pushed; both were unattended. Pushing
  // is the attended Open PR choice, whatever the verdict.
  assert.match(go, /Only Open PR pushes/);
  assert.match(go, /Unattended: never merge into the base or push to main, nor push the branch: keep it and print its push and PR commands/);
  assert.doesNotMatch(go, /push the branch and open a PR/);
  const orchestrator = (await read("plugin/skills/orchestrator/SKILL.md")).replace(/\s+/g, " ");
  assert.match(orchestrator, /The base branch changes only after an explicit human choice/);
  assert.match(orchestrator, /pushing is an attended choice too/);
  assert.match(orchestrator, /unattended runs end at the kept branch and print its push and PR commands/);
});

test("go.md routes the build-side contracts from the first live run", async () => {
  const go = (await read("plugin/commands/go.md")).replace(/\s+/g, " ");
  // build-args stdout carries the task lines, workflow and args: no re-read of the file.
  assert.match(go, /Never read it: print its stdout `tasks` lines and keep `workflow`, `args`, `humanNeeded`/);
  assert.match(go, /Workflow\(\{name:"muster:build", args:<its args>\}\)/);
  // merge-wave takes the Workflow output file, so a truncated inline result costs no turn.
  assert.match(go, /`<f>` = the output file the build's completion names \(merge-wave saves `build-result\.json`; never read it\)/);
  // The escalation rule closes the laundering path merge-wave now refuses.
  assert.match(go, /never edit PLAN\.md or `build-args\.json` to get past a merge-wave failure/);
  // A zero-gap verification with judgment-only items reaches the merge decision.
  assert.match(go, /HUMAN_NEEDED \(zero gaps; its `human` items go to the merge decision\)/);
  assert.match(go, /its `human` items and `humanNeeded`/);
  const verifier = await read("plugin/agents/muster-verifier.md");
  assert.match(verifier, /`human_needed` → HUMAN_NEEDED/);
  assert.doesNotMatch(verifier, /`human_needed` → ABSTAIN/);
});

test("every worktree-isolated brief says how to verify when isolation refuses a compound command", async () => {
  // First live e2e: executors' heredocs, loops and chained git commands were refused as too
  // complex to prove they stay inside the worktree; merge-wave re-runs the planned command.
  const AsyncFunction = (async () => {}).constructor;
  const prompts = [];
  const agent = async (prompt, opts) => {
    prompts.push({ prompt, opts });
    const [kind, id] = opts.label.split(" ");
    const sha = `${id.toLowerCase()}${"0".repeat(39)}1`;
    if (kind === "red") return { taskId: id, status: "done", branch: "b", commit: sha, worktree: "/w", testFiles: ["t"], testsRun: ["t"], failingAsExpected: true, failures: [], deviations: [] };
    if (kind === "build") return { taskId: id, status: "done", branch: "b", commit: sha, worktree: "/w", filesChanged: ["f"], testsRun: ["t"], testsPassed: true, selfCheck: "PASSED", deviations: [] };
    if (kind === "review") return { taskId: id, verdict: "PASS", commitReviewed: sha, findings: [], testsRun: ["t"], testsPassed: true };
    return { verdict: "PASS", truths: [{ claim: "c", status: "VERIFIED", evidence: "e" }], gaps: [] };
  };
  for (const [file, waves] of [["build.js", [[{ taskId: "A", verify: ["a && b"] }]]], ["team.js", [[{ taskId: "R", tdd: true, verify: ["a && b"] }]]]]) {
    const src = await read(`plugin/workflows/${file}`);
    const fn = new AsyncFunction("agent", "parallel", "pipeline", "phase", "log", "args", src.replace(/^export const meta =/, "const meta ="));
    const pipeline = (items, ...stages) => Promise.all(items.map(async (item) => { let v = item; for (const st of stages) v = await st(v, item); return v; }));
    await fn(agent, (ts) => Promise.all(ts.map((t) => t())), pipeline, () => {}, () => {}, { runId: "r", waves });
  }
  const isolated = prompts.filter((p) => p.opts.isolation === "worktree");
  assert.deepEqual(isolated.map((p) => p.opts.label), ["build A", "red R"]);
  for (const p of isolated) assert.match(p.prompt, /\[Verify\] <command> refused by isolation; ran its parts/, p.opts.label);
});

test("executors write only in isolated worktrees; merge-wave refuses to run inside one", async () => {
  const orchestrator = (await read("plugin/skills/orchestrator/SKILL.md")).replace(/\s+/g, " ");
  assert.match(orchestrator, /During a run you do not edit product files/);
  assert.match(orchestrator, /isolation: "worktree"/);
  const mergeWave = await read("src/merge-wave.js");
  assert.match(mergeWave, /refusing to run inside a \.claude\/worktrees\/ checkout/);
});

test("the full CI suite fetches history required by pinned diff probes", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  const fullSuiteJob = workflow.split(/^  windows-smoke:/m)[0];
  assert.match(fullSuiteJob, /uses: actions\/checkout@v4\s+with:\s+(?:#[^\n]*\s+)*fetch-depth: 0/m);
});

test("CI explicitly gates checked backlog completion on release reachability", async () => {
  const workflow = await read(".github/workflows/ci.yml");
  assert.match(workflow, /Verify backlog completion receipts/);
  assert.match(workflow, /node scripts\/check-backlog-receipts\.mjs --release-ref/);

  const go = (await read("plugin/commands/go.md")).replace(/\s+/g, " ");
  assert.match(go, /\{merge: <its merge-wave sha>\}/);
  assert.match(go, /release-reachable/);
  assert.match(go, /backlog-publish <backlog file> --expect <sha256>/);

  const audit = await read("plugin/commands/audit.md");
  assert.match(audit, /tracked canonical/i);
  assert.doesNotMatch(audit, /\.muster\/backlog\.md` \(gitignored, run-local\)/i);
});

test("trusted PR receipt gate runs base verifier against HEAD-bound PR data before lifecycle code", async () => {
  const trusted = await read(".github/workflows/backlog-receipts.yml");
  assert.match(trusted, /pull_request_target:/);
  assert.match(trusted, /pull_request\.base\.sha/);
  assert.match(trusted, /pull_request\.head\.sha/);
  assert.match(trusted, /\.\.\/verifier\/scripts\/check-backlog-receipts\.mjs/);
  assert.doesNotMatch(trusted, /npm ci/);

  const ci = await read(".github/workflows/ci.yml");
  assert.ok(ci.indexOf("Verify backlog completion receipts") < ci.indexOf("npm ci"));
});
