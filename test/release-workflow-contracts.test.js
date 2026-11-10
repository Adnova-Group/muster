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
  const orchestrator = (await read("plugin/skills/orchestrator/SKILL.md")).replace(/\s+/g, " ");
  assert.match(orchestrator, /The base branch changes only after an explicit human choice/);
  assert.match(orchestrator, /unattended runs end at a PR/);
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
