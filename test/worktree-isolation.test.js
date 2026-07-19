// test/worktree-isolation.test.js — per-harness native worktree isolation +
// base-SHA receipts (backlog item `worktree-isolation-native`,
// docs/strategy/native-delegation.md #10, stacked on task-board-authoritative).
//
// Claude Code CLI already rides the Agent tool's own `isolation: "worktree"` parameter
// (orchestrator/SKILL.md's "Parallel isolation" bullet -- landed under
// harness-native-delegation #47). This item names the OTHER three harnesses' native
// mechanisms concretely (Desktop's automatic <root>/.claude/worktrees/, Hermes's
// `hermes -w` / kanban worktree workspaces) and the one harness with no native mechanism
// at all (Codex: no cwd field on `collaboration.spawn_agent`, docs/research/codex-cli.md
// sec 6's `skill-adapter` citation) -- then records the SAME base-SHA receipt on every
// harness alike, since none of the four self-report a fork point back to the
// orchestrator. None of the four native mechanisms are invocable from a unit test; what's
// fixture-driven and testable here is the pure per-harness SELECTION (which mechanism
// string a harness resolves to, failing loud on an unrecognized one) and the receipt
// BUILDER (which refuses to build a receipt over a missing/non-hex baseSha -- a receipt
// that isn't provably a real fork point is worse than none), proven against a REAL git
// SHA captured from this very checkout, not a fixture string.
//
// base-SHA receipt VERIFICATION (backlog item `base-sha-receipt-verification`,
// respecified 2026-07-18 after a spec-gate escalation on the first attempt found format
// validation alone "proves nothing" -- a fabricated-but-well-formed SHA passed the same
// regex a real commit does). buildBaseShaReceipt now takes an optional injected `verify`
// function so the receipt can carry an honest `verified`/`verificationMechanism` pair
// instead of just a shape check; `makeGitShaVerifier` is the git-backed default
// ("reachable" == resolves to a real commit object at an EXPLICIT cwd via
// `git rev-parse --verify --quiet <sha>^{commit}`, never `process.cwd()` -- Codex's
// `spawn_agent` has no cwd field, so the caller must always state the repo). The tests
// below cover the injected-verifier contract hermetically (a fake `verify`, no shell-out)
// AND against real git state from this checkout (a fabricated well-formed SHA that is
// provably not an object here, and this checkout's own live HEAD).

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  WORKTREE_ISOLATION_MECHANISMS,
  resolveWorktreeIsolation,
  buildBaseShaReceipt,
  makeGitShaVerifier,
} from "../src/wave-dispatch.js";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const CLI = fileURLToPath(new URL("../src/cli.js", import.meta.url));
// A well-formed 40-hex SHA that is (overwhelmingly, deterministically-for-practical-
// purposes) never a real object in this repository -- the exact "fabricated-but-
// well-formed SHA" shape the spec-gate escalation named as proving nothing under
// format validation alone.
const FABRICATED_SHA = "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef";

function realHeadSha() {
  return execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO_ROOT, encoding: "utf8" }).trim();
}

function runReceiptVerify(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, "receipt-verify", ...args], { encoding: "utf8" });
    return { status: 0, stdout };
  } catch (e) {
    return { status: e.status, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

// ── per-harness mechanism selection ────────────────────────────────────────

test("resolveWorktreeIsolation: Claude Code CLI selects the Agent tool's isolation:\"worktree\" parameter", () => {
  const r = resolveWorktreeIsolation({ harness: "claude-code" });
  assert.equal(r.mechanism, WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL);
  assert.equal(r.harness, "claude-code");
  assert.equal(r.receiptRequired, true);
});

test("resolveWorktreeIsolation: Claude Code Desktop selects the automatic per-session worktree", () => {
  const r = resolveWorktreeIsolation({ harness: "claude-desktop" });
  assert.equal(r.mechanism, WORKTREE_ISOLATION_MECHANISMS.DESKTOP_AUTO);
  assert.equal(r.receiptRequired, true);
});

test("resolveWorktreeIsolation: Hermes selects hermes -w / kanban worktree workspaces", () => {
  const r = resolveWorktreeIsolation({ harness: "hermes" });
  assert.equal(r.mechanism, WORKTREE_ISOLATION_MECHANISMS.HERMES_W);
  assert.equal(r.receiptRequired, true);
});

test("resolveWorktreeIsolation: Codex has no native mechanism -- selects the receipts-only floor", () => {
  const r = resolveWorktreeIsolation({ harness: "codex" });
  assert.equal(r.mechanism, WORKTREE_ISOLATION_MECHANISMS.RECEIPTS_ONLY);
  // Even (especially) with no native mechanism, the receipt is still required -- this is
  // the whole point of the item's Codex criterion: receipts-verified, not aspirational.
  assert.equal(r.receiptRequired, true);
});

test("resolveWorktreeIsolation: every mechanism is a distinct string -- no two harnesses silently collapse onto the same one", () => {
  const harnesses = ["claude-code", "claude-desktop", "hermes", "codex"];
  const mechanisms = harnesses.map((harness) => resolveWorktreeIsolation({ harness }).mechanism);
  assert.equal(new Set(mechanisms).size, harnesses.length);
});

test("resolveWorktreeIsolation: an unrecognized harness fails loud, never silently guesses a mechanism", () => {
  assert.throws(() => resolveWorktreeIsolation({ harness: "cowork" }), /unrecognized harness "cowork"/);
});

test("resolveWorktreeIsolation: Object.prototype keys are never treated as known harnesses", () => {
  for (const harness of ["constructor", "__proto__", "prototype"]) {
    assert.throws(() => resolveWorktreeIsolation({ harness }), /unrecognized harness/);
  }
});

test("resolveWorktreeIsolation: a missing harness fails loud rather than defaulting to one", () => {
  assert.throws(() => resolveWorktreeIsolation({}), /harness is required/);
  assert.throws(() => resolveWorktreeIsolation(), /harness is required/);
});

// ── base-SHA receipt builder ───────────────────────────────────────────────

test("buildBaseShaReceipt: records taskId/mechanism/baseSha/worktreePath together", () => {
  const receipt = buildBaseShaReceipt({
    taskId: "task-1",
    mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL,
    baseSha: "abc1234",
    worktreePath: "/repo/.claude/worktrees/agent-x",
  });
  // No `verify` passed -- format validation alone NEVER claims verified.
  assert.deepEqual(receipt, {
    taskId: "task-1",
    mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL,
    baseSha: "abc1234",
    worktreePath: "/repo/.claude/worktrees/agent-x",
    verified: false,
    verificationMechanism: "none",
  });
});

test("buildBaseShaReceipt: worktreePath is optional (Codex has no cwd field to record)", () => {
  const receipt = buildBaseShaReceipt({
    taskId: "task-2",
    mechanism: WORKTREE_ISOLATION_MECHANISMS.RECEIPTS_ONLY,
    baseSha: "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef",
  });
  assert.equal(receipt.worktreePath, null);
  assert.equal(receipt.baseSha, "deadbeefdeadbeefdeadbeefdeadbeefdeadbeef");
});

test("buildBaseShaReceipt: rejects unsupported isolation mechanisms", () => {
  for (const mechanism of ["worktree", "constructor", "__proto__", "receipts_only"]) {
    assert.throws(
      () => buildBaseShaReceipt({ taskId: "task-unsupported", mechanism, baseSha: "deadbeef" }),
      /supported isolation mechanism/i
    );
  }
});

test("buildBaseShaReceipt: rejects surrounding whitespace instead of returning a padded SHA", () => {
  assert.throws(
    () => buildBaseShaReceipt({ taskId: "task-padded", mechanism: WORKTREE_ISOLATION_MECHANISMS.RECEIPTS_ONLY, baseSha: " deadbeef " }),
    /hex git SHA/i
  );
});

test("buildBaseShaReceipt: proven against a REAL git SHA from this checkout, not a fixture string", () => {
  const realSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: new URL("../", import.meta.url), encoding: "utf8" }).trim();
  const receipt = buildBaseShaReceipt({
    taskId: "task-real",
    mechanism: WORKTREE_ISOLATION_MECHANISMS.HERMES_W,
    baseSha: realSha,
  });
  assert.equal(receipt.baseSha, realSha);
  assert.match(receipt.baseSha, /^[0-9a-f]{40}$/);
});

test("buildBaseShaReceipt: fails loud on a missing baseSha -- never records an unproven receipt", () => {
  assert.throws(
    () => buildBaseShaReceipt({ taskId: "task-3", mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL }),
    /baseSha must be a hex git SHA/
  );
});

test("buildBaseShaReceipt: fails loud on a non-hex baseSha (a branch name or path is not a receipt)", () => {
  for (const bad of ["main", "not-a-sha", "", "  ", "12345"]) {
    assert.throws(
      () => buildBaseShaReceipt({ taskId: "task-4", mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL, baseSha: bad }),
      /baseSha must be a hex git SHA/,
      `expected "${bad}" to be rejected`
    );
  }
});

test("buildBaseShaReceipt: fails loud on a missing taskId or mechanism -- every field is load-bearing", () => {
  assert.throws(() => buildBaseShaReceipt({ mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL, baseSha: "abc1234" }), /taskId is required/);
  assert.throws(() => buildBaseShaReceipt({ taskId: "task-5", baseSha: "abc1234" }), /mechanism is required/);
});

// ── base-SHA receipt VERIFICATION: injected verifier contract (hermetic) ───────────

test("buildBaseShaReceipt: no verify function -- verified:false, verificationMechanism:\"none\" (format validation alone never claims verified)", () => {
  const receipt = buildBaseShaReceipt({ taskId: "task-v0", mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL, baseSha: FABRICATED_SHA });
  assert.equal(receipt.verified, false);
  assert.equal(receipt.verificationMechanism, "none");
});

test("buildBaseShaReceipt: an injected verify function that accepts the SHA records verified:true", () => {
  const verify = (sha) => sha === "cafefeed";
  const receipt = buildBaseShaReceipt({ taskId: "task-v1", mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL, baseSha: "cafefeed", verify });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.verificationMechanism, "custom");
});

test("buildBaseShaReceipt: an injected verify function that rejects the SHA records verified:false", () => {
  const verify = () => false;
  const receipt = buildBaseShaReceipt({ taskId: "task-v2", mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL, baseSha: FABRICATED_SHA, verify });
  assert.equal(receipt.verified, false);
  assert.equal(receipt.verificationMechanism, "custom");
});

test("buildBaseShaReceipt: honors the verify function's own .mechanism label when present (e.g. makeGitShaVerifier tags \"git-object\")", () => {
  const verify = (sha) => sha.startsWith("ca");
  verify.mechanism = "git-object";
  const receipt = buildBaseShaReceipt({ taskId: "task-v3", mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL, baseSha: "cafefeed", verify });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.verificationMechanism, "git-object");
});

test("buildBaseShaReceipt: verify must be a function when provided -- fails loud on a non-function", () => {
  assert.throws(
    () => buildBaseShaReceipt({ taskId: "task-v4", mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL, baseSha: "deadbeef", verify: "yes" }),
    /verify must be a function/
  );
});

test("buildBaseShaReceipt: a malformed SHA still fails loud exactly as today, even with a verify function passed (format check runs first)", () => {
  const verify = () => true;
  assert.throws(
    () => buildBaseShaReceipt({ taskId: "task-v5", mechanism: WORKTREE_ISOLATION_MECHANISMS.AGENT_TOOL, baseSha: "not-a-sha", verify }),
    /baseSha must be a hex git SHA/
  );
});

// ── makeGitShaVerifier: the git-backed default verifier factory ────────────────────

test("makeGitShaVerifier: requires an explicit cwd -- never defaults to process.cwd()", () => {
  assert.throws(() => makeGitShaVerifier({}), /cwd is required/);
  assert.throws(() => makeGitShaVerifier(), /cwd is required/);
});

test("makeGitShaVerifier: injected exec is honored -- hermetic, no real git shell-out", () => {
  let called = null;
  const fakeExec = (cmd, args, opts) => { called = { cmd, args, opts }; return ""; };
  const verify = makeGitShaVerifier({ cwd: "/fake/repo", exec: fakeExec });
  assert.equal(verify("deadbeef"), true);
  assert.equal(called.cmd, "git");
  assert.deepEqual(called.args, ["rev-parse", "--verify", "--quiet", "deadbeef^{commit}"]);
  assert.equal(called.opts.cwd, "/fake/repo");
});

test("makeGitShaVerifier: an injected exec that throws (simulated git rejection) resolves false", () => {
  const fakeExec = () => { throw new Error("not a valid object name"); };
  const verify = makeGitShaVerifier({ cwd: "/fake/repo", exec: fakeExec });
  assert.equal(verify("deadbeef"), false);
});

test("makeGitShaVerifier: tags its returned function with mechanism \"git-object\"", () => {
  const verify = makeGitShaVerifier({ cwd: "/fake/repo", exec: () => "" });
  assert.equal(verify.mechanism, "git-object");
});

test("makeGitShaVerifier: a REAL SHA from this checkout resolves to a commit object -- verified:true end to end", () => {
  const realSha = realHeadSha();
  const verify = makeGitShaVerifier({ cwd: REPO_ROOT });
  assert.equal(verify(realSha), true);
  const receipt = buildBaseShaReceipt({ taskId: "task-real-verify", mechanism: WORKTREE_ISOLATION_MECHANISMS.HERMES_W, baseSha: realSha, verify });
  assert.equal(receipt.verified, true);
  assert.equal(receipt.verificationMechanism, "git-object");
});

test("makeGitShaVerifier: a fabricated well-formed SHA that is not a real object here resolves false -- verified:false end to end (the gate's finding: format alone proves nothing)", () => {
  const verify = makeGitShaVerifier({ cwd: REPO_ROOT });
  assert.equal(verify(FABRICATED_SHA), false);
  const receipt = buildBaseShaReceipt({ taskId: "task-fabricated-verify", mechanism: WORKTREE_ISOLATION_MECHANISMS.RECEIPTS_ONLY, baseSha: FABRICATED_SHA, verify });
  assert.equal(receipt.verified, false);
  assert.equal(receipt.verificationMechanism, "git-object");
});

// ── executable consumer: `muster receipt-verify <sha> --cwd <repo>` CLI ────────────

test("receipt-verify CLI: a REAL SHA from this checkout verifies true and exits 0", () => {
  const realSha = realHeadSha();
  const { status, stdout } = runReceiptVerify([realSha, "--cwd", REPO_ROOT]);
  assert.equal(status, 0);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed, { sha: realSha, cwd: REPO_ROOT, verified: true, mechanism: "git-object" });
});

test("receipt-verify CLI: a fabricated well-formed SHA fails verification and exits 2", () => {
  const { status, stdout } = runReceiptVerify([FABRICATED_SHA, "--cwd", REPO_ROOT]);
  assert.equal(status, 2);
  const parsed = JSON.parse(stdout);
  assert.deepEqual(parsed, { sha: FABRICATED_SHA, cwd: REPO_ROOT, verified: false, mechanism: "git-object" });
});

test("receipt-verify CLI: a malformed sha argument still fails verification (exits 2, not a crash) -- no behavior regression on the not-a-real-object path", () => {
  const { status, stdout } = runReceiptVerify(["not-a-sha", "--cwd", REPO_ROOT]);
  assert.equal(status, 2);
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.verified, false);
});

test("receipt-verify CLI: missing sha is a usage error (exit 1)", () => {
  const { status } = runReceiptVerify([]);
  assert.equal(status, 1);
});

test("receipt-verify CLI: missing --cwd is a usage error (exit 1) -- never silently defaults to process.cwd()", () => {
  const { status } = runReceiptVerify([realHeadSha()]);
  assert.equal(status, 1);
});
