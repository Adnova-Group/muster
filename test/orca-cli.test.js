import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const run = promisify(execFile);

// Until this group existed, every Orca module was unreachable from the `muster`
// binary: `manifest.js` and `sprint-waves.js` only validated Orca metadata a
// caller had already supplied, and nothing ever called the discovery adapter.
// These tests hold the surface to two rules -- it exists, and it never mutates.

const CLI = ["./src/cli.js"];

// These tests must not inherit a real Orca terminal's environment: if the suite
// itself runs inside Orca, ORCA_WORKTREE_ID names the developer's actual
// worktree and the adapter correctly fails the stub closed on identity
// mismatch. Scrub the whole ORCA_* namespace so the fixture is the only input.
function scrubbedEnv(extra = {}) {
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !key.startsWith("ORCA_")),
  );
  return { ...env, ...extra };
}

async function cli(args, options = {}) {
  const { env, ...rest } = options;
  try {
    const { stdout } = await run("node", [...CLI, ...args], {
      cwd: process.cwd(),
      env: env ?? scrubbedEnv(),
      ...rest,
    });
    return { code: 0, stdout };
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
  }
}

// A stub `orca` that answers the four read-only commands the adapter issues,
// so this suite never depends on a desktop app being installed.
async function stubOrca({ worktree }) {
  const dir = await mkdtemp(join(tmpdir(), "muster-orca-cli-"));
  const bin = join(dir, "orca");
  const payloads = {
    "agent-context": { schemaVersion: 1, commandCount: 1, commands: [{ command: "status" }] },
    status: { ok: true, result: { runtime: { state: "ready", reachable: true, runtimeId: "rt-1", appVersion: "1.4.177" }, graph: { state: "ready" } } },
    worktree: { ok: true, result: { worktree } },
    terminal: { ok: true, result: { terminals: [] } },
  };
  await writeFile(bin, [
    "#!/usr/bin/env node",
    `const payloads = ${JSON.stringify(payloads)};`,
    "const key = process.argv[2];",
    "process.stdout.write(JSON.stringify(payloads[key] ?? { ok: false, error: { message: 'unknown' } }));",
    "",
  ].join("\n"), { mode: 0o755 });
  return bin;
}

const LIVE_SHAPED_WORKTREE = {
  id: "repo-1::/workspace/worker",
  repoId: "repo-1",
  path: "/workspace/worker",
  branch: "refs/heads/feature/worker",
  head: "4444444444444444444444444444444444444444",
  hostId: "local",
  isMainWorktree: false,
};

test("muster orca reports usage and fails on an unknown subcommand", async () => {
  const result = await cli(["orca", "not-a-subcommand"]);
  assert.equal(result.code, 1);
  assert.match(result.stderr, /unknown subcommand/);
});

test("muster orca status degrades cleanly when no Orca runtime is reachable", async () => {
  const result = await cli(["orca", "status", "--command", "definitely-not-orca-binary"]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, false);
  assert.equal(payload.context, undefined);
  assert.ok(payload.reason, "an unavailable context must say why");
});

test("muster orca status surfaces the live-shaped identity fields", async () => {
  const bin = await stubOrca({ worktree: LIVE_SHAPED_WORKTREE });
  const result = await cli(["orca", "status", "--command", bin]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.worktree_id, "repo-1::/workspace/worker");
  assert.equal(payload.branch, "refs/heads/feature/worker");
  assert.equal(payload.remote_selector, "id:repo-1::/workspace/worker");
  assert.equal(payload.is_main_worktree, false);
});

test("muster orca status honors ORCA_CLI_COMMAND when no override is given", async () => {
  const bin = await stubOrca({ worktree: LIVE_SHAPED_WORKTREE });
  const result = await cli(["orca", "status"], { env: scrubbedEnv({ ORCA_CLI_COMMAND: bin }) });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, true);
  assert.equal(payload.worktree_id, "repo-1::/workspace/worker");
});

test("muster orca bridge stays read-only", async () => {
  const bin = await stubOrca({ worktree: LIVE_SHAPED_WORKTREE });
  const result = await cli(["orca", "bridge", "--profile", "codex", "--command", bin]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.readOnly, true);
  assert.equal(payload.availability, "available");
});

test("muster orca cleanup-plan is a dry run that exits 2 when it denies", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-orca-plan-"));
  const file = join(dir, "evidence.json");
  const identity = {
    worktreeId: "repo-1::/workspace/worker",
    repositoryId: "repo-1",
    path: "/workspace/worker",
    branch: "refs/heads/main",
    baseRef: "main",
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
    host: "local",
    environmentId: "local",
    remoteSelector: "id:repo-1::/workspace/worker",
  };
  await writeFile(file, JSON.stringify({
    identity,
    observedIdentity: { ...identity },
    approval: { approved: true, branchDeletion: true },
    terminalRelease: { released: true, active: false, observed: true },
    tree: { clean: true, statusPorcelain: "", observed: true },
    receipt: { id: "r", owner: "muster", status: "completed", durable: true },
    review: { verdict: "PASS" },
    ship: { approved: true, status: "merged" },
    merge: {
      merged: true,
      commitSha: "2222222222222222222222222222222222222222",
      targetSha: "3333333333333333333333333333333333333333",
      verified: true,
      isAncestor: true,
    },
  }));

  const denied = await cli(["orca", "cleanup-plan", file]);
  assert.equal(denied.code, 2, "a denied plan must be distinguishable by exit code");
  const payload = JSON.parse(denied.stdout);
  assert.equal(payload.dryRun, true);
  assert.equal(payload.executed, false);
  assert.equal(payload.reason, "protected-branch");
  assert.deepEqual(payload.operations, []);
});

test("an authorized cleanup-plan still only prints; it never executes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "muster-orca-plan-ok-"));
  const file = join(dir, "evidence.json");
  const identity = {
    worktreeId: "repo-1::/workspace/worker",
    repositoryId: "repo-1",
    path: "/workspace/worker",
    branch: "refs/heads/feature/worker",
    baseRef: "main",
    baseSha: "1111111111111111111111111111111111111111",
    headSha: "2222222222222222222222222222222222222222",
    host: "local",
    environmentId: "local",
    remoteSelector: "id:repo-1::/workspace/worker",
  };
  await writeFile(file, JSON.stringify({
    identity,
    observedIdentity: { ...identity },
    approval: { approved: true, branchDeletion: true },
    terminalRelease: { released: true, active: false, observed: true },
    tree: { clean: true, statusPorcelain: "", observed: true },
    receipt: { id: "r", owner: "muster", status: "completed", durable: true },
    review: { verdict: "PASS" },
    ship: { approved: true, status: "merged" },
    merge: {
      merged: true,
      commitSha: "2222222222222222222222222222222222222222",
      targetSha: "3333333333333333333333333333333333333333",
      verified: true,
      isAncestor: true,
    },
  }));

  const result = await cli(["orca", "cleanup-plan", file]);
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.authorized, true, payload.errors?.join("; "));
  assert.equal(payload.dryRun, true);
  assert.equal(payload.executed, false);
  assert.equal(payload.stateMutation, false);
  assert.deepEqual(payload.operations[0].args, [
    "worktree", "rm", "--worktree", "id:repo-1::/workspace/worker", "--force", "--json",
  ]);
});

// ORCA_WORKTREE_ID is real -- verified in a live Orca-launched terminal, where
// it holds the full `<repoId>::<path>` id. When it contradicts what the CLI
// reports, that is a genuine wrong-worktree signal and must fail closed rather
// than merge two identities.
test("an inherited ORCA_WORKTREE_ID that contradicts the CLI fails closed", async () => {
  const bin = await stubOrca({ worktree: LIVE_SHAPED_WORKTREE });
  const result = await cli(["orca", "status", "--command", bin], {
    env: scrubbedEnv({ ORCA_WORKTREE_ID: "repo-other::/workspace/somewhere-else" }),
  });
  assert.equal(result.code, 0);
  const payload = JSON.parse(result.stdout);
  assert.equal(payload.available, false);
  assert.equal(payload.reason, "identity-mismatch");
});

test("the CLI exposes no mutating Orca subcommand", async () => {
  for (const sub of ["cleanup", "cleanup-execute", "rm", "remove", "execute"]) {
    const result = await cli(["orca", sub]);
    assert.equal(result.code, 1, `orca ${sub} must not be a command`);
    assert.match(result.stderr, /unknown subcommand/);
  }
});
