import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { computeSprintWaves } from "../src/sprint-waves.js";

const pexecFile = promisify(execFile);
const repoRoot = new URL("../", import.meta.url).pathname;
const cli = join(repoRoot, "src", "cli.js");

const backlog = [
  "- [ ] Open a PR {id: pr-item} {deps: none} {disposition: pr}",
  "- [ ] Merge locally {id: local-item} {deps: none} {disposition: merge-local}",
  "- [ ] Merge and push {id: push-item} {deps: none} {disposition: merge-push}",
  "- [ ] Keep the branch {id: keep-item} {deps: none} {disposition: keep}",
].join("\n");

test("schedule makes every ready disposition build/review eligible before ordered integration", () => {
  const result = computeSprintWaves(backlog, { parallelLimit: 3 });

  assert.equal(result.ok, true);
  assert.deepEqual(result.waves, [["pr-item", "local-item", "push-item", "keep-item"]]);
  assert.deepEqual(result.schedule.integration.dispositions, ["pr", "keep", "merge-local", "merge-push"]);
  assert.deepEqual(result.schedule.waves[0], {
    wave: 1,
    buildReview: {
      mode: "concurrent-isolated",
      itemIds: ["pr-item", "local-item", "push-item", "keep-item"],
      batches: [["pr-item", "local-item", "push-item"], ["keep-item"]],
    },
    barrier: "all-build-review-complete",
    integration: {
      mode: "sequential-backlog-order",
      itemIds: ["pr-item", "local-item", "push-item", "keep-item"],
    },
  });
});

test("sprint-waves CLI emits the effective cap, explicit build batches, and integration order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-wave-schedule-"));
  try {
    const codexHome = join(dir, "codex-home");
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      "[agents]\nmax_concurrent_threads_per_session = 2\n",
    );
    await writeFile(join(dir, "backlog.md"), backlog);
    const { stdout } = await pexecFile(process.execPath, [cli, "sprint-waves", "backlog.md"], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: codexHome, MUSTER_SPRINT_PARALLEL: "9" },
    });
    const result = JSON.parse(stdout);

    assert.equal(result.schedule.buildReview.maxConcurrency, 2);
    assert.deepEqual(result.schedule.waves[0].buildReview.batches, [
      ["pr-item", "local-item"],
      ["push-item", "keep-item"],
    ]);
    assert.deepEqual(result.schedule.waves[0].integration.itemIds, ["pr-item", "local-item", "push-item", "keep-item"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("sprint-waves CLI accepts the effective higher-precedence Codex ceiling explicitly", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-wave-effective-ceiling-"));
  try {
    const codexHome = join(dir, "codex-home");
    await mkdir(codexHome);
    await writeFile(
      join(codexHome, "config.toml"),
      "[agents]\nmax_concurrent_threads_per_session = 2\n",
    );
    await writeFile(join(dir, "backlog.md"), backlog);
    const { stdout } = await pexecFile(process.execPath, [
      cli,
      "sprint-waves",
      "backlog.md",
      "--max-concurrent-threads-per-session",
      "3",
    ], {
      cwd: dir,
      env: { ...process.env, CODEX_HOME: codexHome, MUSTER_SPRINT_PARALLEL: "9" },
    });
    assert.equal(JSON.parse(stdout).schedule.buildReview.maxConcurrency, 3);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("schedule preserves a named sequential degradation without changing dependency or integration order", () => {
  const result = computeSprintWaves(backlog);

  assert.deepEqual(result.schedule.degradation, {
    when: "parallel-dispatch-unavailable",
    buildReviewMode: "sequential-isolated",
    dependencyOrder: "preserved",
    integrationOrder: "preserved",
  });
  assert.deepEqual(result.schedule.waves[0].integration.itemIds, ["pr-item", "local-item", "push-item", "keep-item"]);
});

test("schedule items expose resolved dependencies for fail-closed runtime dispatch", () => {
  const result = computeSprintWaves([
    "- [ ] Root {id: root} {deps: none} {disposition: pr}",
    "- [ ] Sibling {id: sibling} {deps: none} {disposition: keep}",
    "- [ ] Dependent {id: dependent} {deps: root} {disposition: merge-local}",
  ].join("\n"));

  assert.deepEqual(result.items.root.deps, []);
  assert.deepEqual(result.items.sibling.deps, []);
  assert.deepEqual(result.items.dependent.deps, ["root"]);
});

test("schedule applies the documented default and hard ceiling to build concurrency", () => {
  assert.equal(computeSprintWaves(backlog, { parallelLimit: 0 }).schedule.buildReview.maxConcurrency, 5);
  assert.equal(computeSprintWaves(backlog, { parallelLimit: "invalid" }).schedule.buildReview.maxConcurrency, 5);
  assert.equal(computeSprintWaves(backlog, { parallelLimit: 99 }).schedule.buildReview.maxConcurrency, 10);
});

test("go-backlog contract dispatches every ready disposition before the barrier and disposes every item afterward", async () => {
  const text = await readFile(join(repoRoot, "plugin", "commands", "go-backlog.md"), "utf8");
  const waveMode = text.slice(text.indexOf("**Wave mode**"), text.indexOf("**Unattended (Routine) mode**"));

  assert.match(waveMode, /every ready item regardless of disposition/i);
  assert.match(waveMode, /build \+ review barrier/i);
  assert.match(waveMode, /build-review-only/i);
  assert.match(waveMode, /`pr`\/`keep`\/`merge-local`\/`merge-push`.*integration/i);
  assert.doesNotMatch(waveMode, /\(a\) `pr`\/`keep` items/);
  assert.match(waveMode, /cannot dispatch parallel runners.*same build\/review schedule sequentially/i);
  assert.match(waveMode, /failed.*omit.*disposition.*integration/i);
  assert.match(waveMode, /preserv(?:e|ing).*emitted order/i);
  assert.match(waveMode, /dependent.*escalat(?:e|es).*immediately.*never build/i);
  assert.doesNotMatch(text.slice(0, text.indexOf("**Wave mode**")), /full go lifecycle sequentially over every item/i);
  assert.match(
    text,
    /--max-concurrent-threads-per-session <effective agents\.max_concurrent_threads_per_session>/,
  );
});
